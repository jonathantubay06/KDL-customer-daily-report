# Kingdomland Kids — Daily Report Generator

One-click generator combining two data sources into a single daily email:

1. **Stripe** — Today's gross volume/balance/next payout, plus a Month-to-Date overview (payments breakdown + gross volume vs. previous period, with a locally-rendered comparison chart).
2. **Kingdomland Kids analytics dashboard** — Top videos by Views, Completions, Completion Rate, and Watch Time (Hours), 3 pages (30 rows) each, for the current month.

Patterned on the Intac and V3 report generators. Runs on port **3003**.

## Architecture

```
You ──browser──▶ Netlify (frontend) ──fetch──▶ Caddy (HTTPS, kdl.23-137-105-53.sslip.io) ──▶ Advin VPS :3003
                                                                              │
                                                                    ┌─────────┴─────────┐
                                                                    ▼                   ▼
                                                          Stripe API (read-only)   Kingdomland dashboard
                                                          + local chart render     (Playwright login + scrape)
                                                          (no data leaves the      
                                                           machine except the      
                                                           Stripe API call)
```

- **`worker/stripe.js`** — calls Stripe's API with a **restricted, read-only key** (see `.env.example`). Computes today's numbers, the MTD payments breakdown, and gross-volume-vs-previous-period. The comparison chart is rendered **locally** as plain SVG, screenshotted via Playwright — no Chart.js bundle, no third-party charting service.
- **`worker/kingdomland.js`** — Playwright login (name + password) to the Kingdomland dashboard, sets the range to Month-to-Date, and for each of 4 metrics sorts descending and captures 3 pages of the video performance table.
- **`worker/email.js`** — combines both sections into one HTML email + `.eml` file.
- **`worker/server.js`** — Express worker: `/health`, `POST /generate/daily`, `GET /eml/:id` (download on demand).
- **`worker/ops.js`** — shared with Intac/V3: time zones, transaction log, alerts, team-password limit, .eml stash.
- **Hosting** — runs on the Advin VPS as systemd service `report-kdl` (`/opt/reporttools/kdl/worker`, user `reportsvc`). Caddy serves `https://kdl.23-137-105-53.sslip.io` and passes only `/health`, `/generate/*`, `/eml/*`. The old Tailscale Funnel address is a slow fallback only.

## Setup

1. **Stripe**: Dashboard → Developers → API keys → **Create restricted key** → grant **Read** access to Balance, Charges, Balance Transactions, Payouts only. Nothing else.
2. **Kingdomland**: use a dedicated reporting login (email + password) if possible, rather than a personal admin account.
3. Copy `worker/.env.example` → `worker/.env` and fill in both sets of credentials, the team password, and recipients.

```bash
cd worker
npm install
npx playwright install chromium
```

Local test: `cd worker && node server.js` (port 3003), then point the page's worker URL box at `http://localhost:3003`. Production: copy changed worker files to `/opt/reporttools/kdl/worker` on the VPS and `systemctl restart report-kdl`.

## Status

v0 scaffold. Selectors in [`worker/kingdomland.js`](worker/kingdomland.js) are **best-guess placeholders** — the real login form and video-analytics table markup haven't been inspected yet. Set `DEBUG_DUMP=1` in `worker/.env`, run a Generate, and inspect the resulting `worker/debug-kingdomland.html` to pin down the real selectors (same process used for Intac and V3).

The Stripe module (`worker/stripe.js`) is untested against a live account — needs a real restricted API key to verify the numbers and chart come out correctly.

## Logs, time zones and safety (since 2026-11-24)

All of this lives in `worker/ops.js` (the same file in the Intac, V3 BOL and Kingdomland workers).

- **Time zones.** Dates the client sees (report "today", date ranges, email subject and body) use US Central (`REPORT_TIMEZONE`, default `America/Chicago`); the headless browser runs in that zone too. Log times are Philippine time (`LOG_TIMEZONE`, default `Asia/Manila`) for debugging.
- **Transaction log.** `worker/access.log` gets one JSON line per request (not `/health`): `ts` (UTC), `logTime`, `id`, `status`, `event` (`finish` or `aborted`), `user`, `userTz`, scope/range, `buildMs`, `totalMs`, `bytes`, `gzip`, `ip`, `ua`, `warnings`, `error`. The same `id` is returned as the `X-Request-Id` header and shown in page errors as "(ref ...)". On the VPS: `tail -f /opt/reporttools/<tool>/worker/access.log` or `journalctl -u report-<tool> -f`. The file is rotated weekly by `/etc/logrotate.d/reporttools`.
- **Alerts.** A failed report, a report that was built but never reached the page, a report with suspiciously small screenshots, and a blocked password guesser are sent to Jojo's alert hub on the VPS (`ALERT_HUB_KEY` in the worker `.env`); the hub handles muting and repeats.
- **Team password.** Checked in constant time; an address with 10 wrong passwords in an hour gets HTTP 429 for the rest of that hour (`LOGIN_FAIL_LIMIT`).
- **Smaller replies.** The web page sends `X-Eml-On-Demand: 1`, so the reply leaves out the `.eml` (and V3's raw images), which repeat every screenshot; Download fetches `GET /eml/<id>` (kept 30 minutes). Scripted callers without that header, such as Emmi's GitHub flow, still get the full reply. Replies are gzipped when the caller accepts gzip.
