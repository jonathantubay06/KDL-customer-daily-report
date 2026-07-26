// Supervised launcher: keeps the worker AND the Cloudflare Quick Tunnel alive.
// If either process dies, it is automatically respawned (with backoff). When the
// tunnel respawns it gets a new URL, which is written to frontend/config.js and
// pushed so Netlify redeploys.
//
// Worker runs on port 3003 — distinct from Intac (3001) and V3 (3002).
// Usage: node launch.js   (or double-click launch.bat). Ctrl+C to stop.

import { spawn, execSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(ROOT, 'frontend', 'config.js');
const WORKER_PORT = process.env.PORT || '3003';
const CLOUDFLARED = process.env.CLOUDFLARED_PATH
  || 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';
const TUNNEL_URL_RE = /(https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com)/;

const BACKOFF_MIN = 2000;
const BACKOFF_MAX = 30000;

let shuttingDown = false;
let worker = null;
let cf = null;
let currentUrl = null;

function log(tag, msg) {
  const t = new Date().toTimeString().slice(0, 8);
  process.stdout.write(`[${t}] [${tag}] ${msg.endsWith('\n') ? msg : msg + '\n'}`);
}

function startWorker(attempt = 0) {
  if (shuttingDown) return;
  log('launch', `starting kingdomland worker (node server.js) on :${WORKER_PORT}...`);
  worker = spawn(process.execPath, ['server.js'], {
    cwd: path.join(ROOT, 'worker'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  worker.stdout.on('data', d => process.stdout.write(`[worker] ${d}`));
  worker.stderr.on('data', d => process.stderr.write(`[worker] ${d}`));
  worker.on('exit', (code) => {
    if (shuttingDown) return;
    const delay = Math.min(BACKOFF_MIN * 2 ** attempt, BACKOFF_MAX);
    log('launch', `worker exited (code ${code}) — restarting in ${Math.round(delay/1000)}s`);
    setTimeout(() => startWorker(attempt + 1), delay);
  });
  setTimeout(() => { if (worker && !worker.killed) attempt = 0; }, 15000);
}

function startTunnel(attempt = 0) {
  if (shuttingDown) return;
  log('launch', 'starting Cloudflare Quick Tunnel...');
  let captured = false;
  cf = spawn(CLOUDFLARED, ['tunnel', '--url', `http://localhost:${WORKER_PORT}`, '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const onData = (data) => {
    const s = data.toString();
    process.stdout.write(`[tunnel] ${s}`);
    if (captured) return;
    const m = s.match(TUNNEL_URL_RE);
    if (m) {
      captured = true;
      updateAndPush(m[1]).catch(err => log('launch', `update failed: ${err.message}`));
    }
  };
  cf.stdout.on('data', onData);
  cf.stderr.on('data', onData);

  cf.on('exit', (code) => {
    if (shuttingDown) return;
    const delay = Math.min(BACKOFF_MIN * 2 ** attempt, BACKOFF_MAX);
    log('launch', `tunnel exited (code ${code}) — restarting in ${Math.round(delay/1000)}s`);
    setTimeout(() => startTunnel(attempt + 1), delay);
  });
  setTimeout(() => { if (cf && !cf.killed) attempt = 0; }, 15000);
}

async function updateAndPush(url) {
  if (url === currentUrl) {
    log('launch', 'tunnel URL unchanged — nothing to push');
    return;
  }
  currentUrl = url;
  log('launch', `>>> tunnel URL captured: ${url}`);
  const existing = await readFile(CONFIG_PATH, 'utf8');
  const next = existing.replace(
    /window\.__WORKER_URL__\s*=\s*'[^']*';/,
    `window.__WORKER_URL__ = '${url}';`
  );
  if (next === existing) {
    log('launch', 'config.js already up to date (no change to push)');
    return;
  }
  await writeFile(CONFIG_PATH, next);
  log('launch', 'wrote frontend/config.js, committing + pushing...');
  try {
    execSync('git add frontend/config.js', { cwd: ROOT, stdio: 'inherit' });
    execSync(
      'git -c user.email=launcher@local -c user.name=Launcher commit -m "Update tunnel URL"',
      { cwd: ROOT, stdio: 'inherit' }
    );
    execSync('git push', { cwd: ROOT, stdio: 'inherit' });
    log('launch', '>>> pushed. Netlify will redeploy in ~30-60s.');
  } catch (err) {
    log('launch', `git push failed: ${err.message}`);
    log('launch', 'tunnel is still running; paste the URL into the Worker URL field manually.');
  }
}

function shutdown() {
  shuttingDown = true;
  log('launch', 'shutting down...');
  try { worker && worker.kill(); } catch {}
  try { cf && cf.kill(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (e) => log('launch', `uncaught exception (continuing): ${e && e.stack || e}`));
process.on('unhandledRejection', (e) => log('launch', `unhandled rejection (continuing): ${e && e.stack || e}`));

startWorker();
startTunnel();
