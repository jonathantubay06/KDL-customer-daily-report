// Operations helpers shared by the Intac, V3 BOL and Kingdomland report workers (same file in all three).
// Contents: timezones, the per-request transaction log, failure alerts, the team-password guard,
// the short-lived .eml cache, and the screenshot sanity check.
//
// Timezones, two clocks on purpose (Jojo, 2026-11-24):
//  - REPORT_TZ: every date a US client sees (report "today", date ranges, email subject and body).
//    America/Chicago (US Central) unless REPORT_TIMEZONE is set in .env.
//  - LOG_TZ: the readable time in the log, for debugging from the Philippines. Asia/Manila unless
//    LOG_TIMEZONE is set. The log also keeps UTC (ts) and the caller's browser timezone (userTz).
//
// Transaction log: every request except /health and CORS preflights writes ONE JSON line to access.log
// (and stdout, so `journalctl -u report-<tool>` shows it) when the response finishes or the client goes
// away: ts · logTime · id · status · event (finish|aborted) · user · userTz · scope/mode/range · buildMs ·
// totalMs · bytes · gzip · ip · ua · warnings · error. The id is returned as the X-Request-Id header and
// shown in page errors as "(ref <id>)".
//
// Alerts: a failed report (status 500), a report the caller never received (aborted), a report with
// suspicious screenshots (warnings) and a locked-out password guesser are sent to Jojo's alert hub on the
// VPS (http://127.0.0.1:8792/send, key ALERT_HUB_KEY in .env; the hub owns muting, de-duplication and
// backoff). Without the key, alerts are only logged.
import { appendFile } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';

export const REPORT_TZ = process.env.REPORT_TIMEZONE || 'America/Chicago';
export const LOG_TZ = process.env.LOG_TIMEZONE || 'Asia/Manila';
const ALERT_URL = process.env.ALERT_HUB_URL || 'http://127.0.0.1:8792/send';

const pad = (n) => String(n).padStart(2, '0');

// ---------- timezones ----------

// Valid IANA zone name or null.
function validTimeZone(value) {
  const tz = String(value || '').trim();
  if (!tz || tz.length > 64) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

// Calendar parts of an instant as seen in `tz` (numbers; month is 1-12).
export function zonedParts(date, tz = REPORT_TZ) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(date));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mi: +p.minute, ss: +p.second };
}

// "MM/DD/YYYY" for an instant, in US report time by default.
export function fmtDateInTz(date, tz = REPORT_TZ) {
  const p = zonedParts(date, tz);
  return `${pad(p.m)}/${pad(p.d)}/${p.y}`;
}

// "YYYY-MM-DD" for an instant, in US report time by default.
export function ymdInTz(date, tz = REPORT_TZ) {
  const p = zonedParts(date, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

function logTimeString(date) {
  const p = zonedParts(date, LOG_TZ);
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.hh)}:${pad(p.mi)}:${pad(p.ss)} ${LOG_TZ}`;
}

// ---------- caller address ----------

// Caddy (and the Funnel proxy) put the real client address last in X-Forwarded-For; anything before it
// came from the client and cannot be trusted.
export function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : req.ip;
}

// ---------- alerts ----------

export async function sendAlert(tool, text, kind = 'alert') {
  const key = process.env.ALERT_HUB_KEY;
  console.log(`[alert:${kind}] ${text}`);
  if (!key) return;
  try {
    await fetch(ALERT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alert-key': key },
      body: JSON.stringify({ text, source: `report-${tool}`, kind }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error('[alert] hub unreachable:', err.message);
  }
}

function alertFor(tool, entry) {
  if (!entry.path.startsWith('/generate')) return;
  const who = `${entry.user}, ref ${entry.id}`;
  if (entry.status >= 500) {
    sendAlert(tool, `${tool} report failed (${who}): ${entry.error || 'HTTP ' + entry.status}`, 'alert');
  } else if (entry.event === 'aborted' && entry.status < 400) {
    sendAlert(tool, `${tool} report was built but the page closed or the download stalled before it arrived (${who}).`, 'notify');
  } else if (entry.warnings?.length) {
    sendAlert(tool, `${tool} report looks off (${who}): ${entry.warnings.join('; ')}`, 'alert');
  }
}

// ---------- transaction log ----------

async function writeLine(entry) {
  const line = JSON.stringify(entry);
  try { await appendFile('access.log', line + '\n'); } catch {}
  console.log('[tx]', line);
}

// Express middleware. Mount after express.json() and before the routes.
// Handlers add detail through req.ctx: req.ctx.extra.scope = ..., req.ctx.buildMs = ..., req.ctx.error = ...,
// req.ctx.warnings.push(...).
export function transactionLog(tool) {
  return (req, res, next) => {
    if (req.path === '/health' || req.method === 'OPTIONS') return next();
    const started = new Date();
    const ctx = {
      id: randomUUID().slice(0, 8),
      user: (req.headers['x-user-name'] || 'Unknown').toString().slice(0, 60),
      userTz: validTimeZone(req.headers['x-user-timezone'] || req.body?.timeZone),
      extra: {},
      buildMs: null,
      warnings: [],
      error: null,
    };
    req.ctx = ctx;
    res.set('X-Request-Id', ctx.id);
    res.set('Access-Control-Expose-Headers', 'X-Request-Id');

    let logged = false;
    const done = (event) => {
      if (logged) return;
      logged = true;
      const totalMs = Date.now() - started.getTime();
      const entry = {
        ts: started.toISOString(),
        logTime: logTimeString(started),
        id: ctx.id,
        tool,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        event,
        ok: event === 'finish' && res.statusCode < 400,
        user: ctx.user,
        userTz: ctx.userTz || undefined,
        reportTz: REPORT_TZ,
        ...ctx.extra,
        buildMs: ctx.buildMs,
        // Kept for the usage report, which reads durationMs.
        durationMs: ctx.buildMs ?? totalMs,
        totalMs,
        bytes: Number(res.getHeader('content-length')) || null,
        gzip: res.getHeader('content-encoding') === 'gzip',
        ip: clientIp(req),
        ua: req.headers['user-agent'] || '',
        warnings: ctx.warnings.length ? ctx.warnings : undefined,
        error: ctx.error || undefined,
      };
      writeLine(entry);
      alertFor(tool, entry);
    };
    res.on('finish', () => done('finish'));
    res.on('close', () => done(res.writableFinished ? 'finish' : 'aborted'));
    next();
  };
}

// ---------- team password guard ----------

const FAIL_LIMIT = Number(process.env.LOGIN_FAIL_LIMIT || 10);
const FAIL_WINDOW_MS = 60 * 60 * 1000;
const failures = new Map(); // ip -> [timestamps of wrong passwords in the last hour]

function samePassword(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

// Replaces the old requireTeamPassword: constant-time compare, and an address that sends FAIL_LIMIT wrong
// passwords within an hour is refused (429) until the hour passes. Correct passwords clear the count.
export function teamPasswordGuard(tool, expected) {
  return (req, res, next) => {
    const ip = clientIp(req);
    const now = Date.now();
    const recent = (failures.get(ip) || []).filter((t) => now - t < FAIL_WINDOW_MS);
    if (recent.length >= FAIL_LIMIT) {
      failures.set(ip, recent);
      res.set('Retry-After', String(Math.ceil((recent[0] + FAIL_WINDOW_MS - now) / 1000)));
      return res.status(429).json({ error: 'too many wrong passwords, try again later' });
    }
    if (!samePassword(req.headers['x-team-password'], expected)) {
      recent.push(now);
      failures.set(ip, recent);
      if (recent.length === FAIL_LIMIT) {
        sendAlert(tool, `${tool}: ${FAIL_LIMIT} wrong team passwords from ${ip} within an hour; that address is blocked for an hour.`, 'security');
      }
      return res.status(401).json({ error: 'unauthorized' });
    }
    failures.delete(ip);
    next();
  };
}

// Keep the failure map small: drop addresses with nothing in the last hour.
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of failures) {
    if (!list.some((t) => now - t < FAIL_WINDOW_MS)) failures.delete(ip);
  }
}, 10 * 60 * 1000).unref();

// ---------- one report at a time ----------
// Each report starts its own Chromium; two at once double the memory and (Intac) race on the saved CRM
// session. Later requests wait their turn instead of failing.

let queue = Promise.resolve();

export function runExclusive(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// ---------- .eml on demand ----------
// The web page asks with X-Eml-On-Demand: 1, gets the report without the .eml (which repeats every
// screenshot) and fetches GET /eml/<id> only when someone clicks Download. Other callers (Emmi's flow)
// still get the .eml inline. Entries live 30 minutes, at most 30 at a time.

const EML_TTL_MS = 30 * 60 * 1000;
const EML_MAX = 30;
const emlCache = new Map(); // id -> { eml, expires }

export function stashEml(id, eml) {
  const now = Date.now();
  for (const [k, v] of emlCache) if (v.expires < now) emlCache.delete(k);
  while (emlCache.size >= EML_MAX) emlCache.delete(emlCache.keys().next().value);
  emlCache.set(id, { eml, expires: now + EML_TTL_MS });
}

export function emlRoute(req, res) {
  const hit = emlCache.get(req.params.id);
  if (!hit || hit.expires < Date.now()) {
    return res.status(404).json({ error: 'expired, please generate the report again' });
  }
  res.json({ eml: hit.eml });
}

export const wantsEmlOnDemand = (req) => req.headers['x-eml-on-demand'] === '1';

// ---------- screenshot sanity check ----------
// A section screenshot far smaller than usual usually means the page changed (blank area, spinner,
// error banner). Returns warnings for the log and the alert; the report still goes out.

export function checkImages(images, minBytes = 5000) {
  const warnings = [];
  for (const [name, uri] of Object.entries(images || {})) {
    if (!uri) continue;
    const approxBytes = Math.floor((String(uri).length - String(uri).indexOf(',') - 1) * 0.75);
    if (approxBytes < minBytes) warnings.push(`${name} screenshot is only ${Math.round(approxBytes / 1024)} KB`);
  }
  return warnings;
}
