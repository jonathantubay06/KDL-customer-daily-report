import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { gzipSync } from 'node:zlib';
import { config } from './config.js';
import { fetchStripeSection } from './stripe.js';
import { fetchKingdomlandSection } from './kingdomland.js';
import { buildHtmlEmail, buildEml, buildSubject } from './email.js';
import { transactionLog, REPORT_TZ } from './request-log.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors({ origin: config.allowedOrigins, credentials: false }));
// One log line per request (see request-log.js): UTC + Philippine time, user, timings, size, errors.
app.use(transactionLog('kdl'));

function requireTeamPassword(req, res, next) {
  const token = req.headers['x-team-password'];
  if (!token || token !== config.teamPassword) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/generate/:scope', requireTeamPassword, async (req, res) => {
  const scope = req.params.scope;
  if (scope !== 'daily') {
    return res.status(400).json({ error: 'scope must be daily' });
  }
  req.ctx.extra = { scope };
  const start = Date.now();

  try {
    // Stripe (API) and Kingdomland (Playwright) are independent — run in parallel.
    // Both use US Central (Stripe's own account timezone); see request-log.js.
    const [stripeSection, kingdomlandSection] = await Promise.all([
      fetchStripeSection(),
      fetchKingdomlandSection(REPORT_TZ),
    ]);
    req.ctx.buildMs = Date.now() - start;

    const report = {
      generatedAt: new Date().toISOString(),
      timeZone: REPORT_TZ,
      stripe: stripeSection,
      kingdomland: kingdomlandSection,
    };

    const subject = buildSubject({ scope, report });
    const html = buildHtmlEmail({ scope, report });
    const eml = buildEml({ scope, report, html });

    // Reply carries large inline screenshots: gzip it (only when the client accepts gzip) so it downloads faster.
    const payload = Buffer.from(JSON.stringify({ scope, generatedAt: report.generatedAt, requestId: req.ctx.id, subject, html, eml }));
    res.set('Content-Type', 'application/json; charset=utf-8');
    if (/gzip/.test(req.headers['accept-encoding'] || '')) {
      res.set('Content-Encoding', 'gzip');
      res.send(gzipSync(payload));
    } else {
      res.send(payload);
    }
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
