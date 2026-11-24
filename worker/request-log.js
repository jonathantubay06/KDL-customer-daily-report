// Transaction log + timezones, same file in the Intac, V3 BOL and Kingdomland workers.
//
// Two clocks, on purpose (Jojo, 2026-11-24):
//  - REPORT_TZ: every date a US client sees (report "today", date ranges, email subject and body).
//    America/Chicago (US Central) unless REPORT_TIMEZONE is set in .env.
//  - LOG_TZ: the readable time in the log, for debugging from the Philippines. Asia/Manila unless
//    LOG_TIMEZONE is set. The log also keeps UTC (ts) and the caller's own browser timezone (userTz).
//
// Every request except /health and CORS preflights writes ONE JSON line to access.log (and stdout, so
// `journalctl -u report-<tool>` shows it) when the response finishes or the client goes away:
//   ts · logTime · id · status · event (finish|aborted) · user · userTz · scope/mode/range
//   · buildMs · totalMs · bytes · gzip · ip · ua · error
// The id is also returned as the X-Request-Id header so a failed run can be matched to its log line.
import { appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export const REPORT_TZ = process.env.REPORT_TIMEZONE || 'America/Chicago';
export const LOG_TZ = process.env.LOG_TIMEZONE || 'Asia/Manila';

const pad = (n) => String(n).padStart(2, '0');

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

async function writeLine(entry) {
  const line = JSON.stringify(entry);
  try { await appendFile('access.log', line + '\n'); } catch {}
  console.log('[tx]', line);
}

// Express middleware. Mount after express.json() and before the routes.
// Handlers add detail through req.ctx: req.ctx.extra.scope = ..., req.ctx.buildMs = ..., req.ctx.error = ...
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
      error: null,
    };
    req.ctx = ctx;
    res.set('X-Request-Id', ctx.id);
    res.set('Access-Control-Expose-Headers', 'X-Request-Id');

    let logged = false;
    const done = (event) => {
      if (logged) return;
      logged = true;
      const status = res.statusCode;
      const totalMs = Date.now() - started.getTime();
      writeLine({
        ts: started.toISOString(),
        logTime: logTimeString(started),
        id: ctx.id,
        tool,
        method: req.method,
        path: req.path,
        status,
        event,
        ok: event === 'finish' && status < 400,
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
        ip: req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip,
        ua: req.headers['user-agent'] || '',
        error: ctx.error || undefined,
      });
    };
    res.on('finish', () => done('finish'));
    res.on('close', () => done(res.writableFinished ? 'finish' : 'aborted'));
    next();
  };
}
