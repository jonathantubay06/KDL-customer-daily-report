import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { gzipSync } from 'node:zlib';
import { config } from './config.js';
import { fetchStripeSection } from './stripe.js';
import { fetchKingdomlandSection } from './kingdomland.js';
import { buildHtmlEmail, buildEml, buildSubject } from './email.js';
import {
  transactionLog, teamPasswordGuard, REPORT_TZ,
  stashEml, emlRoute, wantsEmlOnDemand, checkImages, runExclusive,
} from './ops.js';

const TOOL = 'kdl';
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors({ origin: config.allowedOrigins, credentials: false }));
// One log line per request, alerts on failures (see ops.js).
app.use(transactionLog(TOOL));
const requireTeamPassword = teamPasswordGuard(TOOL, config.teamPassword);

// Large replies (screenshots): gzip when the client accepts it.
function sendJson(req, res, obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  res.set('Content-Type', 'application/json; charset=utf-8');
  if (/gzip/.test(req.headers['accept-encoding'] || '')) {
    res.set('Content-Encoding', 'gzip');
    return res.send(gzipSync(payload));
  }
  return res.send(payload);
}

// Every dashboard screenshot inside the Kingdomland section, keyed by where it was found.
function screenshotsOf(section) {
  const found = {};
  const walk = (value, path) => {
    if (typeof value === 'string') {
      if (value.startsWith('data:image')) found[path] = value;
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(section?.metrics, 'metrics');
  return found;
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/eml/:id', requireTeamPassword, emlRoute);

app.post('/generate/:scope', requireTeamPassword, async (req, res) => {
  const scope = req.params.scope;
  if (scope !== 'daily') {
    return res.status(400).json({ error: 'scope must be daily' });
  }
  req.ctx.extra = { scope };
  const start = Date.now();

  try {
    // Stripe (API) and Kingdomland (Playwright) are independent: run in parallel.
    // Both use US Central (Stripe's own account timezone); see ops.js.
    // One report at a time per worker; a second request waits for the first.
    const [stripeSection, kingdomlandSection] = await runExclusive(() => Promise.all([
      fetchStripeSection(),
      fetchKingdomlandSection(REPORT_TZ),
    ]));
    req.ctx.buildMs = Date.now() - start;
    req.ctx.warnings.push(...checkImages(screenshotsOf(kingdomlandSection)));

    const report = {
      generatedAt: new Date().toISOString(),
      timeZone: REPORT_TZ,
      stripe: stripeSection,
      kingdomland: kingdomlandSection,
    };

    const subject = buildSubject({ scope, report });
    const html = buildHtmlEmail({ scope, report });
    const eml = buildEml({ scope, report, html });
    const reply = { scope, generatedAt: report.generatedAt, requestId: req.ctx.id, warnings: req.ctx.warnings, subject, html };
    if (wantsEmlOnDemand(req)) {
      stashEml(req.ctx.id, eml);
      reply.emlId = req.ctx.id;
    } else {
      reply.eml = eml;
    }
    sendJson(req, res, reply);
  } catch (err) {
    console.error(`[generate/${scope}] ${req.ctx.id} failed:`, err);
    req.ctx.buildMs = Date.now() - start;
    req.ctx.error = err.message || 'generation failed';
    res.status(500).json({ error: req.ctx.error, requestId: req.ctx.id });
  }
});

const port = process.env.PORT || 3003;
app.listen(port, () => {
  console.log(`kingdomland worker listening on :${port}`);
});
