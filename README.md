# Kingdomland Kids — Daily Report Generator

One-click generator combining two data sources into a single daily email:

1. **Stripe** — Today's gross volume/balance/next payout, plus a Month-to-Date overview (payments breakdown + gross volume vs. previous period, with a locally-rendered comparison chart).
2. **Kingdomland Kids analytics dashboard** — Top videos by Views, Completions, Completion Rate, and Watch Time (Hours), 3 pages (30 rows) each, for the current month.

Patterned on the Intac and V3 report generators. Runs on port **3003**.

## Architecture

```
You ──browser──▶ Netlify (frontend) ──fetch──▶ Cloudflare Quick Tunnel ──▶ Local PC :3003
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
- **`launch.js` / `launch.bat`** — same supervised worker+tunnel pattern as Intac/V3 (auto-respawn on crash, auto-pushes new tunnel URL to Netlify).

## Setup

1. **Stripe**: Dashboard → Developers → API keys → **Create restricted key** → grant **Read** access to Balance, Charges, Balance Transactions, Payouts only. Nothing else.
2. **Kingdomland**: use a dedicated reporting login (email + password) if possible, rather than a personal admin account.
3. Copy `worker/.env.example` → `worker/.env` and fill in both sets of credentials, the team password, and recipients.

```bash
cd worker
npm install
npx playwright install chromium
```

Then from the repo root: `node launch.js` (or double-click `launch.bat`).

## Status

v0 scaffold. Selectors in [`worker/kingdomland.js`](worker/kingdomland.js) are **best-guess placeholders** — the real login form and video-analytics table markup haven't been inspected yet. Set `DEBUG_DUMP=1` in `worker/.env`, run a Generate, and inspect the resulting `worker/debug-kingdomland.html` to pin down the real selectors (same process used for Intac and V3).

The Stripe module (`worker/stripe.js`) is untested against a live account — needs a real restricted API key to verify the numbers and chart come out correctly.
