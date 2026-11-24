import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { appendFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { config } from './config.js';
import { fetchStripeSection } from './stripe.js';
import { fetchKingdomlandSection } from './kingdomland.js';
import { buildHtmlEmail, buildEml, buildSubject } from './email.js';

async function logUsage(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  try { await appendFile('access.log', line); } catch {}
  console.log('[usage]', line.trim());
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors({ origin: config.allowedOrigins, credentials: false }));

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
  const start = Date.now();
  const ua = req.headers['user-agent'] || '';
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;
  const user = (req.headers['x-user-name'] || 'Unknown').toString().slice(0, 60);

  try {
    // Stripe (API) and Kingdomland (Playwright) are independent — run in parallel.
    const [stripeSection, kingdomlandSection] = await Promise.all([
      fetchStripeSection(),
      fetchKingdomlandSection(),
    ]);

    const report = {
      generatedAt: new Date().toISOString(),
      stripe: stripeSection,
      kingdomland: kingdomlandSection,
    };

    const subject = buildSubject({ scope, report });
    const html = buildHtmlEmail({ scope, report });
    const eml = buildEml({ scope, report, html });

    // Reply carries large inline screenshots: gzip it (only when the client accepts gzip) so it downloads faster.
    const payload = Buffer.from(JSON.stringify({ scope, generatedAt: report.generatedAt, subject, html, eml }));
    res.set('Content-Type', 'application/json; charset=utf-8');
    if (/gzip/.test(req.headers['accept-encoding'] || '')) {
      res.set('Content-Encoding', 'gzip');
      res.send(gzipSync(payload));
    } else {
      res.send(payload);
    }
    logUsage({ scope, user, ok: true, durationMs: Date.now() - start, ip, ua });
  } catch (err) {
    console.error(`[generate/${scope}] failed:`, err);
    res.status(500).json({ error: err.message || 'generation failed' });
    logUsage({ scope, user, ok: false, durationMs: Date.now() - start, ip, ua, error: err.message });
  }
});

const port = process.env.PORT || 3003;
app.listen(port, () => {
  console.log(`kingdomland worker listening on :${port}`);
});
