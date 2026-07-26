// Renders Stripe-style line charts as PNGs, entirely offline: we build plain
// SVG ourselves and screenshot it with Playwright. No Chart.js bundle, no
// third-party service — everything stays on this machine except the Stripe
// API call for the numbers themselves.

import { chromium } from 'playwright';

function fmtMoney(n) {
  return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

// Evenly-spaced label indices (always includes first + last), so labels
// never bunch up at the end regardless of how many points there are.
function pickLabelIndices(n, maxLabels) {
  const count = Math.min(maxLabels, n);
  if (count <= 1) return new Set([0]);
  const idx = new Set();
  for (let k = 0; k < count; k++) {
    idx.add(Math.round((k * (n - 1)) / (count - 1)));
  }
  return idx;
}

function buildSvg({
  labels, current, previous, accent = '#635bff',
  width = 640, height = 260, showGrid = true, maxLabels = 7,
}) {
  const pad = showGrid
    ? { top: 20, right: 16, bottom: 28, left: 56 }
    : { top: 10, right: 10, bottom: 20, left: 10 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const all = [...current, ...previous].filter(n => Number.isFinite(n));
  const max = Math.max(1, ...all);
  const n = Math.max(current.length, previous.length, 1);

  const x = (i) => pad.left + (innerW * i) / Math.max(1, n - 1);
  const y = (v) => pad.top + innerH - (innerH * v) / max;

  const path = (series) => series
    .map((v, i) => (Number.isFinite(v) ? `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}` : ''))
    .filter(Boolean)
    .join(' ');

  const gridLines = showGrid ? [0, 0.25, 0.5, 0.75, 1].map(f => {
    const v = max * f;
    const yy = y(v).toFixed(1);
    return `<line x1="${pad.left}" y1="${yy}" x2="${width - pad.right}" y2="${yy}" stroke="#eef0f3" stroke-width="1"/>
      <text x="${pad.left - 8}" y="${(+yy + 4)}" font-size="11" fill="#8792a2" text-anchor="end" font-family="Arial,Helvetica,sans-serif">${fmtMoney(v)}</text>`;
  }).join('') : '';

  const labelIdx = pickLabelIndices(n, maxLabels);
  const xLabels = showGrid ? labels
    .map((l, i) => labelIdx.has(i)
      ? `<text x="${x(i).toFixed(1)}" y="${height - 8}" font-size="11" fill="#8792a2" text-anchor="middle" font-family="Arial,Helvetica,sans-serif">${l}</text>`
      : '')
    .join('') : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#ffffff"/>
    ${gridLines}
    <path d="${path(previous)}" fill="none" stroke="#c4c9d4" stroke-width="2" stroke-dasharray="4 4"/>
    <path d="${path(current)}" fill="none" stroke="${accent}" stroke-width="2.5"/>
    ${xLabels}
  </svg>`;
}

async function renderSvgPng(svg, width, height) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.setContent(`<!doctype html><html><body style="margin:0;padding:0;">${svg}</body></html>`);
    const el = await page.$('svg');
    const png = await el.screenshot({ type: 'png' });
    return `data:image/png;base64,${png.toString('base64')}`;
  } finally {
    await browser.close();
  }
}

export async function renderComparisonChartPng({ labels, current, previous, accent, width = 640, height = 260 }) {
  const svg = buildSvg({ labels, current, previous, accent, width, height, showGrid: true });
  return renderSvgPng(svg, width, height);
}

// Compact sparkline for the "Today" panel — no gridlines/$ labels, just the
// two curves. Matches Stripe's minimalist intraday widget.
export async function renderSparklinePng({ current, previous, accent, width = 640, height = 120 }) {
  const svg = buildSvg({
    labels: [], current, previous, accent, width, height, showGrid: false,
  });
  return renderSvgPng(svg, width, height);
}
