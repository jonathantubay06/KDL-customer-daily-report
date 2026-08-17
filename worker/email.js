import { config } from './config.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  }[c]));
}

function fmtDate(iso) {
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}

function money(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pct(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

const FONT = 'font-family:Arial,Helvetica,sans-serif;';

// Table-based stat row — Outlook's compose/paste engine (Word) ignores
// display:flex/inline-block sizing entirely, so anything meant to sit
// side-by-side has to be actual <td>s.
function statsRow(stats) {
  const cells = stats.filter(Boolean).map(s => `
    <td valign="top" style="padding:0 32px 16px 0;${FONT}">
      <div style="font-size:12px;color:#697386;${FONT}">${escapeHtml(s.label)}</div>
      <div style="font-size:${s.big ? '26px' : '16px'};font-weight:700;color:#1a1f36;margin-top:2px;${FONT}">${escapeHtml(s.value)}</div>
      ${s.sub ? `<div style="font-size:12px;color:#697386;margin-top:2px;${FONT}">${escapeHtml(s.sub)}</div>` : ''}
    </td>`).join('');
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>${cells}</tr></table>`;
}

function img(dataUri, alt, maxWidth = '100%') {
  if (!dataUri) return '';
  return `<img src="${dataUri}" alt="${escapeHtml(alt)}" width="${parseInt(maxWidth, 10) || ''}" style="max-width:${maxWidth};width:100%;height:auto;display:block;margin:8px 0;border:0;outline:none;"/>`;
}

// A <table bgcolor> rather than a styled <div>: Outlook's paste sanitizer has
// been observed stripping CSS background-color from divs while leaving the
// HTML bgcolor attribute alone, so the attribute is the one that actually
// survives into the compose window.
function card(innerHtml) {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#ffffff" style="background-color:#ffffff;border:1px solid #e3e8ee;border-radius:8px;"><tr><td style="padding:20px;">${innerHtml}</td></tr></table>`;
}

// Horizontal stacked proportion bar + colored-dot legend, matching Stripe's
// own "Payments" widget style. Legend rows are tables, not flex divs, for
// the same Outlook reason as statsRow above.
function paymentsBreakdown(payments) {
  const rows = [
    ['Succeeded', payments.succeeded, '#635bff'],
    ['Uncaptured', payments.uncaptured, '#3d4eac'],
    ['Refunded', payments.refunded, '#0ea5e9'],
    ['Blocked', payments.blocked, '#f97316'],
    ['Failed', payments.failed, '#e11d48'],
  ];
  const total = Math.max(1, rows.reduce((s, [, v]) => s + v.amount, 0));

  const segments = rows
    .filter(([, v]) => v.amount > 0)
    .map(([, v, color]) => `<td width="${Math.max(1, (v.amount / total) * 100)}%" style="background-color:${color};height:8px;font-size:0;line-height:0;">&nbsp;</td>`)
    .join('');
  const bar = `<table role="presentation" cellspacing="0" cellpadding="0" width="100%" style="border-collapse:collapse;"><tr>${segments || `<td style="background-color:#e3e8ee;height:8px;font-size:0;">&nbsp;</td>`}</tr></table>`;

  // One <table> with N <tr>s, not N sibling <table>s — Outlook inserts a
  // paragraph-sized gap between consecutive top-level tables, which is what
  // was blowing up the spacing between legend rows.
  const legendRows = rows.map(([label, v, color]) => `
    <tr>
      <td style="padding:5px 0;color:#1a1f36;">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background-color:${color};margin-right:8px;line-height:8px;">&nbsp;</span>${escapeHtml(label)}
      </td>
      <td align="right" style="padding:5px 0;font-weight:600;color:#1a1f36;">${money(v.amount)}</td>
    </tr>`).join('');
  const legend = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="${FONT}font-size:13px;">${legendRows}</table>`;

  return card(`
    <div style="font-size:13px;color:#697386;margin-bottom:8px;${FONT}">Payments</div>
    ${bar}
    <div style="margin-top:12px;">${legend}</div>
  `);
}

function section(title) {
  return `<h3 style="color:#1a1f36;border-bottom:2px solid #635bff;padding-bottom:6px;margin-top:32px;margin-bottom:16px;${FONT}">${escapeHtml(title)}</h3>`;
}

export function buildSubject({ scope, report }) {
  return config.recipients[scope].subject(report.generatedAt);
}

export function buildHtmlEmail({ scope, report }) {
  const { stripe, kingdomland } = report;

  const overviewHtml = stripe ? `
    ${section('Stripe — Today')}
    ${statsRow([
      { label: 'Gross volume today', value: money(stripe.today.grossVolumeToday), big: true },
      { label: 'Yesterday', value: money(stripe.today.grossVolumeYesterday), big: true },
    ])}
    ${img(stripe.today.sparklineImg, 'Today vs yesterday, by hour', '640px')}
    <div style="margin-top:8px;">
      ${statsRow([
        { label: 'Balance', value: money(stripe.today.balance) },
        stripe.today.nextPayoutAmount !== null
          ? { label: 'Next USD payout', value: money(stripe.today.nextPayoutAmount), sub: `Expected ${stripe.today.nextPayoutDate}` }
          : { label: 'Pending', value: money(stripe.today.pendingBalance), sub: 'Not yet available for payout' },
      ])}
    </div>

    ${section(`Stripe — Overview (${stripe.overview.rangeLabel})`)}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
      <td valign="top" width="260" style="padding:0 24px 24px 0;">${paymentsBreakdown(stripe.overview.payments)}</td>
      <td valign="top" style="padding:0 0 24px;">
        ${card(`
          <div style="font-size:13px;color:#697386;margin-bottom:4px;${FONT}">Gross volume</div>
          <div style="font-size:22px;font-weight:700;color:#1a1f36;${FONT}">${money(stripe.overview.grossVolume)}
            <span style="font-size:13px;font-weight:600;color:${(stripe.overview.percentChange ?? 0) >= 0 ? '#16a34a' : '#e11d48'};margin-left:6px;">${pct(stripe.overview.percentChange)}</span>
          </div>
          <div style="font-size:12px;color:#697386;${FONT}">vs ${money(stripe.overview.grossVolumePrevPeriod)} previous period</div>
          ${img(stripe.overview.chartImg, 'Gross volume vs previous period', '100%')}
        `)}
      </td>
    </tr></table>
  ` : '';

  // Video engagement is always All Time (Boss Dawg call, Slack 2026-07-27:
  // monthly numbers are too low to be meaningful) — no date range shown
  // since it doesn't apply here.
  const videoHtml = kingdomland ? `
    ${section('Kingdomland Kids — Video Analytics — All Time')}
    ${Object.entries(kingdomland.metrics).map(([metric, images]) => `
      <h4 style="color:#1a1f36;margin:20px 0 6px;${FONT}">Top videos by ${escapeHtml(metric)}</h4>
      ${images.map((uri) => img(uri, `Top videos by ${metric}`, '900px')).join('')}
    `).join('')}
  ` : '';

  // Explicit color-scheme meta + bgcolor everywhere: without these, Outlook's
  // dark-mode auto-invert treats this as a themeable email and flips the
  // near-black text to near-white on a forced black background, which also
  // washes out the light-gray card borders. Pinning to "light only" plus
  // real bgcolor attributes (not just CSS) stops that from happening.
  // Width is fluid (no fixed px card) so it fills whatever compose pane it's
  // pasted into instead of floating as a narrow column with big side gutters.
  //
  // The white bgcolor is deliberately NOT on the outermost table: on paste,
  // Outlook strips <html>/<body> and the sanitizer appears to force-clear
  // background specifically on whatever ends up as the root pasted element,
  // regardless of its own bgcolor/style — that's why a card nested a few
  // levels deep kept its white fill in testing but a bgcolor'd root table
  // didn't. Wrapping in one extra neutral shell keeps the real white table
  // from ever being that root element.
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>Kingdomland Kids — Daily Report</title>
</head>
<body bgcolor="#ffffff" style="margin:0;padding:0;background-color:#ffffff;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0">
<tr><td>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#ffffff" style="background-color:#ffffff;">
<tr><td style="padding:20px 20px 24px;color:#1a1f36;font-size:14px;line-height:1.5;${FONT}">
  <p style="margin:0 0 16px;">Hi Team,</p>
  <p style="margin:0 0 8px;">Sharing today's Report below.</p>
  ${overviewHtml}
  ${videoHtml}
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

// ---------- .eml builder ----------
function b64(buf) {
  return Buffer.from(buf).toString('base64').match(/.{1,76}/g).join('\r\n');
}
function dataUriToBuffer(uri) {
  const m = /^data:(.+?);base64,(.+)$/.exec(uri);
  if (!m) return null;
  return { mime: m[1], buf: Buffer.from(m[2], 'base64') };
}

export function buildEml({ scope, report, html }) {
  const recip = config.recipients[scope];
  const date = fmtDate(report.generatedAt);
  const subject = buildSubject({ scope, report });
  const boundary = `----=_Part_${Date.now()}`;
  const altBoundary = `----=_Alt_${Date.now()}`;

  const attachments = [];
  const cidHtml = html.replace(/src="(data:image\/[^"]+)"/g, (_, uri) => {
    const parsed = dataUriToBuffer(uri);
    if (!parsed) return `src=""`;
    const cid = `img${attachments.length}@kingdomland.report`;
    attachments.push({ cid, mime: parsed.mime, buf: parsed.buf, filename: `image${attachments.length}.png` });
    return `src="cid:${cid}"`;
  });

  const headers = [
    `From: ${config.from}`,
    recip.to.length ? `To: ${recip.to.join(', ')}` : null,
    recip.cc.length ? `Cc: ${recip.cc.join(', ')}` : null,
    `Subject: ${subject}`,
    `Date: ${new Date(report.generatedAt).toUTCString()}`,
    `MIME-Version: 1.0`,
    attachments.length
      ? `Content-Type: multipart/related; boundary="${boundary}"; type="multipart/alternative"`
      : `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
  ].filter(Boolean).join('\r\n');

  const altPart =
`--${altBoundary}\r
Content-Type: text/plain; charset="utf-8"\r
Content-Transfer-Encoding: 7bit\r
\r
See HTML version.\r
\r
--${altBoundary}\r
Content-Type: text/html; charset="utf-8"\r
Content-Transfer-Encoding: 8bit\r
\r
${cidHtml}\r
\r
--${altBoundary}--\r
`;

  let body;
  if (attachments.length) {
    const imgParts = attachments.map(a =>
`--${boundary}\r
Content-Type: ${a.mime}; name="${a.filename}"\r
Content-Transfer-Encoding: base64\r
Content-ID: <${a.cid}>\r
Content-Disposition: inline; filename="${a.filename}"\r
\r
${b64(a.buf)}\r
`).join('');
    body =
`--${boundary}\r
Content-Type: multipart/alternative; boundary="${altBoundary}"\r
\r
${altPart}\r
${imgParts}--${boundary}--\r
`;
  } else {
    body = altPart;
  }

  return {
    filename: `kingdomland-daily-${date.replace(/\//g, '-')}.eml`,
    content: Buffer.from(`${headers}\r\n\r\n${body}`).toString('base64'),
    mime: 'message/rfc822',
  };
}
