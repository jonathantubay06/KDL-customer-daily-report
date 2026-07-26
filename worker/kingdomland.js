import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { config } from './config.js';

// Set DEBUG_DUMP=1 in .env to dump the dashboard DOM on next Generate —
// use this to pin down the real selectors below (same approach used for
// the Intac CRM and V3 Logistics dashboards).
const DEBUG = process.env.DEBUG_DUMP === '1';
const NAV_TIMEOUT = 30_000;

// TODO: confirm every selector below against debug-kingdomland.html — these
// are best-guess placeholders based on the screenshots, not yet verified
// against the live DOM.
const SEL = {
  loginEmail: 'input[type="email"], input[name="email"]',
  loginPassword: 'input[type="password"]',
  loginSubmit: 'button[type="submit"], button:has-text("Sign In"), button:has-text("Log In")',

  // The sidebar ALSO has a "Videos" link (to /videos, a separate content-mgmt
  // page) — role=tab distinguishes the Analytics page's inner tab from it.
  videosTab: 'role=tab[name="Videos"]',
  quickRangeMtd: 'button:has-text("MTD")',

  // The whole "Video Performance" card — title + table + pagination footer —
  // scoped to the active tab panel so it can't match a stale/inactive tab.
  tableContainer: '[role="tabpanel"][data-state="active"] [data-slot="card"]',
  columnHeader: (label) => `th:has-text("${label}")`,
  sortIcon: (label) => `th:has-text("${label}") svg`,
  nextPageBtn: 'button[aria-label="Next page"]',
};

const METRICS = ['Views', 'Completions', 'Completion Rate', 'Watch Time (Hours)'];

export async function fetchKingdomlandSection() {
  if (!config.kingdomlandEmail || !config.kingdomlandPassword) {
    throw new Error('KINGDOMLAND_EMAIL / KINGDOMLAND_PASSWORD not set');
  }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  try {
    await login(page);
    await page.goto(`${config.kingdomlandUrl}/analytics`, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });

    // Dump right after landing on the page — before any fragile clicks —
    // so we always have a DOM snapshot even if a later selector fails.
    if (DEBUG) await dump(page, 'debug-kingdomland.html');

    await page.locator(SEL.videosTab).first().click();
    await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {});

    // Set range to Month-to-Date
    await page.locator(SEL.quickRangeMtd).first().click();
    await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {});
    await page.waitForTimeout(500);

    if (DEBUG) await dump(page, 'debug-kingdomland-videos-mtd.html');

    const metrics = {};
    for (const metric of METRICS) {
      metrics[metric] = await captureMetricPages(page, metric);
    }

    return { generatedAt: new Date().toISOString(), metrics };
  } catch (err) {
    // Always leave a DOM snapshot on failure, regardless of DEBUG_DUMP,
    // so a failed run is immediately debuggable without re-running.
    await dump(page, 'debug-kingdomland-error.html').catch(() => {});
    throw err;
  } finally {
    await ctx.close();
    await browser.close();
  }
}

async function dump(page, filename) {
  const html = await page.content();
  await writeFile(filename, html, 'utf8');
  console.log(`[debug] wrote ${filename} (${html.length} bytes)`);
}

async function login(page) {
  // This is a Next.js/React app — waiting for 'networkidle' (not just
  // domcontentloaded) gives it time to hydrate before we touch the form.
  // Filling/clicking before hydration completes is a real race: React can
  // still be attaching its onChange/onClick handlers, so a pre-hydration
  // fill gets silently wiped and a pre-hydration click is a no-op.
  await page.goto(`${config.kingdomlandUrl}/login`, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT })
    .catch(() => page.goto(config.kingdomlandUrl, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT }));
  await page.waitForTimeout(1000); // hydration buffer

  const emailEl = page.locator(SEL.loginEmail).first();
  const passwordEl = page.locator(SEL.loginPassword).first();

  // Fill, then verify the value actually stuck (React may reset it if we
  // filled before hydration); retry once if it didn't.
  await emailEl.fill(config.kingdomlandEmail);
  await passwordEl.fill(config.kingdomlandPassword);
  if ((await emailEl.inputValue()) !== config.kingdomlandEmail) {
    await page.waitForTimeout(800);
    await emailEl.fill(config.kingdomlandEmail);
    await passwordEl.fill(config.kingdomlandPassword);
  }

  await page.locator(SEL.loginSubmit).click();

  // Success = URL moves off /login. Give it the full nav timeout since this
  // also covers the app's own auth round-trip.
  await page.waitForURL((u) => !/\/login/i.test(u.toString()), { timeout: NAV_TIMEOUT });
}

// Sorting/paginating re-renders the table (React remounts it), which can
// detach the exact element Playwright resolved mid-action. Retrying with a
// short backoff absorbs that transient window instead of failing on it.
async function screenshotWithRetry(page, selector, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const el = page.locator(selector).first();
      await el.scrollIntoViewIfNeeded();
      return await el.screenshot({ type: 'png' });
    } catch (err) {
      lastErr = err;
      await page.waitForTimeout(500);
    }
  }
  throw lastErr;
}

// Column headers show a lucide icon reflecting current sort state:
// "arrow-down" = descending, "arrow-up" = ascending, "arrow-up-down" = unsorted.
// Click (up to twice) until it reads descending, rather than assuming which
// direction a single click lands on — self-corrects regardless of convention.
async function ensureSortedDescending(page, metric) {
  const header = page.locator(SEL.columnHeader(metric)).first();
  for (let i = 0; i < 3; i++) {
    const cls = await page.locator(SEL.sortIcon(metric)).first().getAttribute('class').catch(() => '');
    if (cls && cls.includes('lucide-arrow-down') && !cls.includes('lucide-arrow-up-down')) return;
    await header.click();
    await page.waitForTimeout(600);
  }
}

async function captureMetricPages(page, metric) {
  await ensureSortedDescending(page, metric);
  await page.waitForTimeout(700); // let the re-render settle before touching the table

  const images = [];
  for (let pageNum = 1; pageNum <= 3; pageNum++) {
    const buf = await screenshotWithRetry(page, SEL.tableContainer);
    images.push(`data:image/png;base64,${buf.toString('base64')}`);

    if (pageNum < 3) {
      const next = page.locator(SEL.nextPageBtn).first();
      if (await next.isEnabled().catch(() => false)) {
        await next.click();
        await page.waitForTimeout(700);
      } else {
        break; // fewer than 3 pages of data
      }
    }
  }
  return images;
}
