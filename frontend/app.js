function getWorkerUrl() {
  const sessionOverride = sessionStorage.getItem('workerUrl');
  return sessionOverride || window.__WORKER_URL__ || 'http://localhost:3003';
}

const $ = (sel) => document.querySelector(sel);
const els = {
  loginView: $('#login-view'),
  dashView: $('#dash-view'),
  userName: $('#user-name'),
  teamPw: $('#team-pw'),
  workerUrl: $('#worker-url'),
  loginBtn: $('#login-btn'),
  loginErr: $('#login-err'),
  whoamiName: $('#whoami-name'),
  switchUser: $('#switch-user'),
  status: $('#status'),
  preview: $('#preview'),
  previewFrame: $('#preview-frame'),
  previewSubject: $('#preview-subject'),
  copySubject: $('#copy-subject'),
  copyHtml: $('#copy-html'),
  downloadEml: $('#download-eml'),
  generatedAgo: $('#generated-ago'),
};

els.workerUrl.value = window.__WORKER_URL__ || '';
localStorage.removeItem('workerUrl');

let userName = localStorage.getItem('userName') || '';
els.userName.value = userName;

els.switchUser.addEventListener('click', (e) => {
  e.preventDefault();
  sessionStorage.removeItem('teamPw');
  teamPassword = '';
  showLogin();
  els.userName.focus();
});

const themeToggle = $('#theme-toggle');
themeToggle.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
});

let teamPassword = sessionStorage.getItem('teamPw') || '';
let lastResult = null;
let stageTimer = null;

if (teamPassword) showDash();

els.loginBtn.addEventListener('click', async () => {
  const name = els.userName.value.trim();
  const pw = els.teamPw.value.trim();
  if (!name) { els.loginErr.textContent = 'Please enter your name.'; els.userName.focus(); return; }
  if (!pw) return;

  const typed = els.workerUrl.value.trim().replace(/\/+$/, '');
  const def = (window.__WORKER_URL__ || '').replace(/\/+$/, '');
  if (typed && typed !== def) sessionStorage.setItem('workerUrl', typed);
  else sessionStorage.removeItem('workerUrl');

  const workerUrl = getWorkerUrl();
  els.loginErr.textContent = '';
  els.loginBtn.disabled = true;
  try {
    const r = await fetch(`${workerUrl}/health`);
    if (!r.ok) throw new Error('worker unreachable');
    teamPassword = pw;
    userName = name;
    sessionStorage.setItem('teamPw', pw);
    localStorage.setItem('userName', name);
    showDash();
  } catch (err) {
    els.loginErr.textContent = `Cannot reach worker at ${workerUrl}`;
  } finally {
    els.loginBtn.disabled = false;
  }
});

document.querySelectorAll('[data-scope]').forEach(btn => {
  btn.addEventListener('click', () => generate(btn.dataset.scope));
});

els.copySubject.addEventListener('click', async () => {
  if (!lastResult?.subject) return;
  try {
    await navigator.clipboard.writeText(lastResult.subject);
    flashCopied(els.copySubject, 'Subject copied');
  } catch (err) {
    setStatus(els.status, `Copy failed: ${err.message}`, 'error');
  }
});

els.copyHtml.addEventListener('click', async () => {
  if (!lastResult) return;
  const blob = new Blob([lastResult.html], { type: 'text/html' });
  const textBlob = new Blob([htmlToText(lastResult.html)], { type: 'text/plain' });
  try {
    await navigator.clipboard.write([
      new ClipboardItem({ 'text/html': blob, 'text/plain': textBlob }),
    ]);
    flashCopied(els.copyHtml, 'Copied — paste into Outlook');
  } catch (err) {
    await navigator.clipboard.writeText(lastResult.html);
    flashCopied(els.copyHtml, 'Copied (HTML source)');
  }
});

els.downloadEml.addEventListener('click', () => {
  if (!lastResult?.eml) return;
  const { filename, content } = lastResult.eml;
  const bytes = Uint8Array.from(atob(content), c => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: 'message/rfc822' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  flashCopied(els.downloadEml, 'Downloaded');
});

async function generate(scope) {
  els.preview.classList.add('hidden');
  startStageSimulation();
  try {
    const r = await fetch(`${getWorkerUrl()}/generate/${scope}`, {
      method: 'POST',
      headers: {
        'X-Team-Password': teamPassword,
        'X-User-Name': userName || 'Unknown',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    if (r.status === 401) {
      sessionStorage.removeItem('teamPw');
      teamPassword = '';
      showLogin();
      els.loginErr.textContent = 'Bad team password';
      stopStageSimulation();
      return;
    }
    if (!r.ok) {
      const t = await r.text();
      throw new Error(t || r.statusText);
    }
    lastResult = await r.json();
    els.previewFrame.srcdoc = lastResult.html;
    if (lastResult.subject) {
      els.previewSubject.innerHTML = `<span class="subject-label">Subject</span><span class="subject-value"></span>`;
      els.previewSubject.querySelector('.subject-value').textContent = lastResult.subject;
    } else {
      els.previewSubject.innerHTML = '';
    }
    els.preview.classList.remove('hidden');
    stopStageSimulation();
    setStatus(els.status, `✓ Report ready`, 'success');
    startGeneratedAgo(lastResult.generatedAt);
  } catch (err) {
    stopStageSimulation();
    setStatus(els.status, friendlyError(err.message), 'error');
  }
}

function friendlyError(raw) {
  if (!raw) return 'Generation failed.';
  if (/timeout/i.test(raw)) return 'Timed out reaching a data source. Try again in a moment.';
  if (/STRIPE_SECRET_KEY/.test(raw)) return 'Stripe API key missing — check the worker .env file.';
  if (/KINGDOMLAND_EMAIL|KINGDOMLAND_PASSWORD/.test(raw)) return 'Kingdomland login missing — check the worker .env file.';
  if (/unreachable/i.test(raw) || /Failed to fetch/i.test(raw)) return 'Cannot reach the worker. The launcher may not be running.';
  return `Failed: ${raw}`;
}

const STAGES = [
  { at: 0,     label: 'Pulling Stripe data + rendering chart…' },
  { at: 4000,  label: 'Logging in to Kingdomland analytics…' },
  { at: 10000, label: 'Capturing video performance tables…' },
  { at: 20000, label: 'Building email…' },
];
function startStageSimulation() {
  stopStageSimulation();
  const start = Date.now();
  const tick = () => {
    const elapsed = Date.now() - start;
    const current = [...STAGES].reverse().find(s => elapsed >= s.at) || STAGES[0];
    setStatus(els.status, `<span class="spinner"></span> ${current.label}`, '');
  };
  tick();
  stageTimer = setInterval(tick, 400);
}
function stopStageSimulation() {
  if (stageTimer) { clearInterval(stageTimer); stageTimer = null; }
}

let agoTimer = null;
function startGeneratedAgo(iso) {
  if (agoTimer) clearInterval(agoTimer);
  const update = () => {
    const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    let text;
    if (secs < 60) text = `Generated ${secs}s ago`;
    else if (secs < 3600) text = `Generated ${Math.floor(secs/60)}m ago`;
    else text = `Generated ${Math.floor(secs/3600)}h ago`;
    els.generatedAgo.textContent = text;
  };
  update();
  agoTimer = setInterval(update, 5_000);
}

function setStatus(el, html, kind) {
  el.innerHTML = html;
  el.classList.remove('success', 'error');
  if (kind) el.classList.add(kind);
}

function flashCopied(btn, statusText) {
  btn.classList.add('copied');
  setTimeout(() => btn.classList.remove('copied'), 600);
  setStatus(els.status, `✓ ${statusText}`, 'success');
}

function showLogin() {
  els.dashView.classList.add('hidden');
  els.loginView.classList.remove('hidden');
}
function showDash() {
  els.loginView.classList.add('hidden');
  els.dashView.classList.remove('hidden');
  els.whoamiName.textContent = userName || 'Unknown';
}
function htmlToText(html) {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.innerText;
}
