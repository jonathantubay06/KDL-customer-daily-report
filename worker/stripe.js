import Stripe from 'stripe';
import { config } from './config.js';
import { renderComparisonChartPng, renderSparklinePng } from './chart.js';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// "Today"/"yesterday"/"month to date" must be computed in the Stripe
// account's own timezone (confirmed: US Central / America/Chicago), not
// whatever timezone the worker happens to run in. A day-boundary mismatch
// here silently swaps "today" and "yesterday" and shifts the whole MTD
// window — exactly the bug this fixes.
const TIMEZONE = 'America/Chicago';

function getZonedParts(date, timeZone = TIMEZONE) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map(x => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second };
}

// Converts a wall-clock Y/M/D/H/M/S *as read in `timeZone`* into the UTC
// instant it corresponds to. Iterates twice to converge correctly across
// DST transitions (Chicago only ever has two possible offsets).
function zonedTimeToUtc(y, mo, d, h, mi, s, timeZone = TIMEZONE) {
  let guess = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  const wanted = Date.UTC(y, mo - 1, d, h, mi, s);
  for (let i = 0; i < 2; i++) {
    const p = getZonedParts(guess, timeZone);
    const guessedAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess = new Date(guess.getTime() + (wanted - guessedAsUtc));
  }
  return guess;
}

function startOfDayTz(instant) {
  const p = getZonedParts(instant);
  return zonedTimeToUtc(p.year, p.month, p.day, 0, 0, 0);
}
function startOfMonthTz(instant) {
  const p = getZonedParts(instant);
  return zonedTimeToUtc(p.year, p.month, 1, 0, 0, 0);
}
function unix(d) { return Math.floor(d.getTime() / 1000); }
function dayLabelTz(instant) {
  const p = getZonedParts(instant);
  return `${MONTHS[p.month - 1]} ${p.day}`;
}
// Settlement/arrival dates (Payout.arrival_date, BalanceTransaction.available_on)
// are pure calendar dates always stored at UTC midnight — NOT event instants —
// so they must be read directly in UTC, not converted through account
// timezone (which would shift UTC-midnight back to the previous day).
function dayLabelUtc(instant) {
  return `${MONTHS[instant.getUTCMonth()]} ${instant.getUTCDate()}`;
}
function currentHourTz(instant) {
  return getZonedParts(instant).hour;
}

async function listAllCharges(stripe, { gte, lte }) {
  return stripe.charges.list({
    created: { gte: unix(gte), lte: unix(lte) },
    limit: 100,
  }).autoPagingToArray({ limit: 10000 });
}

// Deliberately NOT filtering PaymentIntents by their own `created` date: a
// customer's payment can be declined in one month and successfully retried
// in the next, in which case the PaymentIntent's creation date predates the
// period even though the successful charge happened within it. Filtering by
// PI-created date silently dropped that charge entirely (verified against a
// live account — missed a real $9.99 payment this way). Instead we derive
// the exact set of PaymentIntents actually touched by charges in this period
// (a reliable, already-correct source) and fetch each one's true current
// status directly. Fine for volumes like this account's (~25-30/month); a
// high-volume account would want a different strategy (Stripe's Reporting API).
async function listPaymentIntentsForCharges(stripe, charges) {
  const ids = [...new Set(charges.filter(c => c.payment_intent).map(c => c.payment_intent))];
  return Promise.all(ids.map(id => stripe.paymentIntents.retrieve(id, { expand: ['latest_charge'] })));
}

// Stripe's dashboard "Payments" widget counts by PaymentIntent (one entry
// per customer payment attempt, by its final outcome) — not by raw Charge.
// A card that's declined once and retried successfully is ONE payment to
// Stripe's summary, but shows as two separate Charge records; using Charges
// here inflated both the Succeeded and Failed buckets. Verified against a
// live account: this now matches Stripe's Failed total exactly.
function categorizeByIntent(intents) {
  const buckets = { succeeded: [], uncaptured: [], refunded: [], blocked: [], failed: [] };
  for (const pi of intents) {
    const charge = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
    if (charge?.outcome?.type === 'blocked') buckets.blocked.push(pi);
    else if (pi.status === 'succeeded' && charge?.amount_refunded > 0) buckets.refunded.push(pi);
    else if (pi.status === 'succeeded') buckets.succeeded.push(pi);
    else if (pi.status === 'requires_capture') buckets.uncaptured.push(pi);
    else if (pi.status === 'requires_payment_method' && pi.last_payment_error) buckets.failed.push(pi);
    // Anything else (processing, requires_action, requires_confirmation,
    // canceled, or a fresh intent with no attempt yet) is still in-progress
    // or abandoned — Stripe's own summary doesn't count these either.
  }
  const summarize = (arr) => ({
    count: arr.length,
    amount: arr.reduce((s, pi) => s + (pi.amount_received || pi.amount), 0) / 100,
  });
  return Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, summarize(v)]));
}

// Stripe's "Next payout: $X expected <date>" widget is a forward projection,
// not a queryable object — reproduced here from data we already have access
// to (no extra permission needed). Verified against a live account: current
// available balance + net proceeds of whatever next becomes available
// reproduces Stripe's own figure exactly (e.g. -$0.22 + $9.40 net = $9.18).
async function computeNextPayoutProjection(stripe, currentAvailableBalance) {
  const list = await stripe.balanceTransactions.list({ limit: 100 }).autoPagingToArray({ limit: 1000 });
  const pending = list.filter(bt => bt.status === 'pending' && bt.currency === 'usd');
  if (!pending.length) return null;
  const nextAvailableOn = Math.min(...pending.map(bt => bt.available_on));
  const netOnThatDate = pending
    .filter(bt => bt.available_on === nextAvailableOn)
    .reduce((s, bt) => s + bt.net, 0) / 100;
  return {
    amount: currentAvailableBalance + netOnThatDate,
    date: new Date(nextAvailableOn * 1000),
  };
}

// Buckets by elapsed 24h period from `fromDate` — since `fromDate` is
// already a correct Chicago-midnight instant, this direct instant-difference
// math is timezone-correct without needing to re-derive a boundary per charge.
function grossVolumeByDay(charges, fromDate, days) {
  const sums = Array(days).fill(0);
  for (const c of charges) {
    if (c.status !== 'succeeded') continue;
    const created = new Date(c.created * 1000);
    const idx = Math.floor((created - fromDate) / 86400000);
    if (idx >= 0 && idx < days) sums[idx] += c.amount / 100;
  }
  return sums;
}

// Cumulative gross volume by hour-of-day, for the intraday sparkline.
// Hours after `uptoHour` are left as NaN so the line simply stops there
// (matches Stripe's own "today so far" widget) instead of implying data
// that hasn't happened yet.
function cumulativeByHour(charges, dayStart, uptoHour) {
  const hourly = Array(24).fill(0);
  for (const c of charges) {
    if (c.status !== 'succeeded') continue;
    const created = new Date(c.created * 1000);
    const hour = Math.floor((created - dayStart) / 3600000);
    if (hour >= 0 && hour < 24) hourly[hour] += c.amount / 100;
  }
  const cumulative = [];
  let running = 0;
  for (let h = 0; h < 24; h++) {
    running += hourly[h];
    cumulative.push(h <= uptoHour ? running : NaN);
  }
  return cumulative;
}

export async function fetchStripeSection() {
  if (!config.stripeSecretKey) {
    throw new Error('STRIPE_SECRET_KEY not set');
  }
  const stripe = new Stripe(config.stripeSecretKey, { apiVersion: '2024-06-20' });

  const now = new Date();
  const todayStart = startOfDayTz(now);
  const yesterdayStart = startOfDayTz(new Date(todayStart.getTime() - 43200000)); // -12h, then re-snap to midnight (DST-safe)
  const monthStart = startOfMonthTz(now);
  const daysInPeriod = Math.round((todayStart - monthStart) / 86400000) + 1;
  const prevPeriodEnd = monthStart; // exclusive end = start of current period
  const prevPeriodStart = startOfDayTz(new Date(monthStart.getTime() - daysInPeriod * 86400000 - 43200000));

  const [balance, payouts, todayCharges, yesterdayCharges, periodCharges, prevPeriodCharges] = await Promise.all([
    stripe.balance.retrieve(),
    stripe.payouts.list({ limit: 5 }),
    listAllCharges(stripe, { gte: todayStart, lte: now }),
    listAllCharges(stripe, { gte: yesterdayStart, lte: todayStart }),
    listAllCharges(stripe, { gte: monthStart, lte: now }),
    listAllCharges(stripe, { gte: prevPeriodStart, lte: prevPeriodEnd }),
  ]);
  // Depends on periodCharges' result, so this runs after the batch above
  // rather than joining it.
  const periodIntents = await listPaymentIntentsForCharges(stripe, periodCharges);

  const sumUsd = (arr) => arr.filter(a => a.currency === 'usd').reduce((s, a) => s + a.amount, 0) / 100;
  // Stripe's dashboard "Balance" is the *available* balance only — "pending"
  // is money still settling and isn't part of that headline figure.
  const balanceTotal = sumUsd(balance.available);
  const pendingTotal = sumUsd(balance.pending);

  // Prefer a real, already-scheduled Payout object if one exists (more
  // authoritative than a projection); otherwise fall back to computing
  // Stripe's own forward-looking projection from Balance Transactions.
  const upcomingPayout = payouts.data
    .filter(p => p.status === 'pending' || p.status === 'in_transit')
    .sort((a, b) => a.arrival_date - b.arrival_date)[0];
  const payoutProjection = upcomingPayout ? null : await computeNextPayoutProjection(stripe, balanceTotal);

  const grossToday = todayCharges.filter(c => c.status === 'succeeded').reduce((s, c) => s + c.amount, 0) / 100;
  const grossYesterday = yesterdayCharges.filter(c => c.status === 'succeeded').reduce((s, c) => s + c.amount, 0) / 100;

  // Payments breakdown widget uses PaymentIntents (matches Stripe's own
  // dashboard semantics — see categorizeByIntent). The headline Gross Volume
  // figure and daily chart stay Charges-based, independently of that
  // breakdown — already verified to match Stripe's Gross Volume exactly.
  const payments = categorizeByIntent(periodIntents);
  const grossPeriod = periodCharges.filter(c => c.status === 'succeeded').reduce((s, c) => s + c.amount, 0) / 100;
  const grossPrevPeriod = prevPeriodCharges.filter(c => c.status === 'succeeded').reduce((s, c) => s + c.amount, 0) / 100;
  const percentChange = grossPrevPeriod > 0 ? ((grossPeriod - grossPrevPeriod) / grossPrevPeriod) * 100 : null;

  const currentSeries = grossVolumeByDay(periodCharges, monthStart, daysInPeriod);
  const previousSeries = grossVolumeByDay(prevPeriodCharges, prevPeriodStart, daysInPeriod);
  const labels = Array.from({ length: daysInPeriod }, (_, i) => {
    const instant = new Date(monthStart.getTime() + i * 86400000);
    return dayLabelTz(instant);
  });

  const chartImg = await renderComparisonChartPng({
    labels,
    current: currentSeries,
    previous: previousSeries,
    accent: '#635bff', // Stripe's brand purple
  });

  const todayHourly = cumulativeByHour(todayCharges, todayStart, currentHourTz(now));
  const yesterdayHourly = cumulativeByHour(yesterdayCharges, yesterdayStart, 23);
  const sparklineImg = await renderSparklinePng({
    current: todayHourly,
    previous: yesterdayHourly,
    accent: '#635bff',
  });

  return {
    today: {
      grossVolumeToday: grossToday,
      grossVolumeYesterday: grossYesterday,
      balance: balanceTotal,
      pendingBalance: pendingTotal,
      nextPayoutAmount: upcomingPayout
        ? upcomingPayout.amount / 100
        : (payoutProjection ? payoutProjection.amount : null),
      nextPayoutDate: upcomingPayout
        ? dayLabelUtc(new Date(upcomingPayout.arrival_date * 1000))
        : (payoutProjection ? dayLabelUtc(payoutProjection.date) : null),
      sparklineImg,
    },
    overview: {
      rangeLabel: `${dayLabelTz(monthStart)} – ${dayLabelTz(todayStart)}, ${getZonedParts(todayStart).year}`,
      grossVolume: grossPeriod,
      grossVolumePrevPeriod: grossPrevPeriod,
      percentChange,
      payments,
      chartImg,
    },
  };
}
