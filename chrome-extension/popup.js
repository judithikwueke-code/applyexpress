/**
 * popup.js — AutoApply Chrome Extension Popup (simplified, reliable)
 */

// ── DOM refs ──────────────────────────────────────────────────────────────────

const $statusDot   = document.getElementById('status-dot');
const $statusText  = document.getElementById('status-text');
const $statApplied = document.getElementById('stat-applied');
const $statFailed  = document.getElementById('stat-failed');
const $statQueue   = document.getElementById('stat-queue');
const $jobList     = document.getElementById('job-list');
const $log         = document.getElementById('log');
const $cvName      = document.getElementById('cv-name');
const $cvInput     = document.getElementById('cv-file-input');
const $serverUrl   = document.getElementById('server-url');
const $apiKey      = document.getElementById('api-key');
const $delaySlider = document.getElementById('delay-slider');
const $delayValue  = document.getElementById('delay-value');

const $btnFetch        = document.getElementById('btn-fetch');
const $btnStart        = document.getElementById('btn-start');
const $btnStop         = document.getElementById('btn-stop');
const $btnLoadCv       = document.getElementById('btn-load-cv');
const $btnSaveConfig   = document.getElementById('btn-save-config');
const $btnTestConn     = document.getElementById('btn-test-conn');
const $btnSyncSessions = document.getElementById('btn-sync-sessions');

let jobs = [];

// ── Feedback — always shown in the visible status bar ─────────────────────────

function showStatus(text, type = 'idle') {
  $statusText.textContent = text;
  $statusDot.className = 'status-dot ' + (type === 'running' ? 'running' : type === 'error' ? 'error' : 'idle');
  // Also log
  addLog(text, type === 'error' ? 'error' : type === 'running' ? 'info' : 'success');
}

function addLog(text, level = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;
  const time = new Date().toTimeString().slice(0, 8);
  entry.textContent = `[${time}] ${text}`;
  $log.appendChild(entry);
  $log.scrollTop = $log.scrollHeight;
  while ($log.children.length > 50) $log.removeChild($log.firstChild);
}


// ── Init ──────────────────────────────────────────────────────────────────────

// ── Auto-apply toggle ─────────────────────────────────────────────────────────

const $autoToggle = document.getElementById('auto-apply-toggle');
const $autoTrack  = document.getElementById('auto-apply-track');
const $autoThumb  = document.getElementById('auto-apply-thumb');
const $autoLabel  = document.getElementById('auto-apply-label');

function setAutoToggleUI(enabled) {
  $autoToggle.checked = enabled;
  $autoTrack.style.background = enabled ? '#1a5c34' : '#334155';
  $autoThumb.style.left = enabled ? '21px' : '3px';
  $autoLabel.textContent = enabled ? 'On' : 'Off';
  $autoLabel.style.color = enabled ? '#a0e0c0' : '#64748b';
}

$autoToggle.addEventListener('change', async () => {
  const enabled = $autoToggle.checked;
  await chrome.storage.local.set({ autoApplyEnabled: enabled });
  setAutoToggleUI(enabled);
  showStatus(enabled ? 'Auto-apply enabled — checks every 15 min' : 'Auto-apply disabled');
});

$autoTrack.addEventListener('click', () => $autoToggle.click());


// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  try {
    // Auto-configure: search ALL open tabs for an ApplyExpress connect URL.
    // The token is in the URL path — no scripting or content script needed.
    try {
      const allTabs = await chrome.tabs.query({});
      const connectTab = allTabs.find(t => t.url && t.url.includes('/connect/'));
      if (connectTab) {
        const urlObj  = new URL(connectTab.url);
        const token   = urlObj.pathname.replace(/^\/connect\//, '');
        const srvUrl  = urlObj.origin;
        if (token && srvUrl) {
          await chrome.storage.local.set({ serverUrl: srvUrl, apiKey: token });
          $serverUrl.value = srvUrl;
          $apiKey.value    = token;
          // Update the connect tab to show success
          chrome.scripting.executeScript({
            target: { tabId: connectTab.id },
            func: () => {
              document.body.innerHTML = `
                <div style="font-family:-apple-system,sans-serif;display:flex;flex-direction:column;
                            align-items:center;justify-content:center;height:100vh;background:#f0fdf4;
                            text-align:center;padding:40px">
                  <div style="font-size:72px;margin-bottom:24px">✅</div>
                  <h1 style="font-size:28px;font-weight:800;color:#065f46;margin-bottom:12px">
                    Extension connected!
                  </h1>
                  <p style="font-size:16px;color:#374151;margin-bottom:8px">
                    Server and API key saved automatically.
                  </p>
                  <p style="font-size:14px;color:#6b7280">You can close this tab.</p>
                </div>`;
            },
          }).catch(() => {});
          showStatus('Extension configured ✓ — you can close the connect tab');
        }
      }
    } catch (_) {}

    const stored = await chrome.storage.local.get([
      'serverUrl', 'apiKey', 'cvName', 'delaySeconds', 'jobs', 'stats', 'autoApplyEnabled'
    ]);

    $serverUrl.value  = stored.serverUrl  || '';
    $apiKey.value     = stored.apiKey     || '';

    const delay = stored.delaySeconds || 5;
    $delaySlider.value = delay;
    $delayValue.textContent = `${delay}s`;

    // Auto-apply toggle — default ON
    setAutoToggleUI(stored.autoApplyEnabled !== false);

    if (stored.cvName) {
      $cvName.textContent = stored.cvName;
      $cvName.classList.add('loaded');
    }

    if (stored.jobs && stored.jobs.length > 0) {
      jobs = stored.jobs;
      renderJobList();
      $btnStart.disabled = false;
    }

    if (stored.stats) {
      $statApplied.textContent = stored.stats.applied || 0;
      $statFailed.textContent  = stored.stats.failed  || 0;
      $statQueue.textContent   = stored.stats.queue   || 0;
    }

    showStatus('Ready — configure server and load CV');
  } catch (e) {
    showStatus('Init error: ' + e.message, 'error');
  }

  chrome.runtime.onMessage.addListener(handleBgMessage);

  // Silently sync sessions on popup open to show fresh status
  const stored2 = await chrome.storage.local.get(['serverUrl', 'apiKey']);
  if (stored2.serverUrl && stored2.apiKey) {
    runSessionSync().catch(() => {});
  }
}

init();


// ── Background messages ───────────────────────────────────────────────────────

function handleBgMessage(msg) {
  if (msg.type === 'STATUS_UPDATE') {
    showStatus(msg.text, msg.state);
    if (msg.stats) {
      $statApplied.textContent = msg.stats.applied || 0;
      $statFailed.textContent  = msg.stats.failed  || 0;
      $statQueue.textContent   = msg.stats.queue   || 0;
    }
    if (msg.jobs) { jobs = msg.jobs; renderJobList(); }
  }
  if (msg.type === 'LOG') addLog(msg.text, msg.level);
  if (msg.type === 'DONE') {
    setRunningState(false);
    showStatus(`Done — ${msg.stats?.applied || 0} applied, ${msg.stats?.failed || 0} need review`);
    if (msg.jobs) { jobs = msg.jobs; renderJobList(); }
  }
  if (msg.type === 'PREFLIGHT_WARNING') {
    // Show a dismissible banner above the job list
    showPreflightWarning(msg.expired, msg.message);
  }
}

function showPreflightWarning(expired, message) {
  // Remove any existing banner
  const existing = document.getElementById('preflight-banner');
  if (existing) existing.remove();

  const banner = document.createElement('div');
  banner.id = 'preflight-banner';
  banner.style.cssText = [
    'background:#fff8e1', 'border:1px solid #f59e0b', 'border-radius:8px',
    'padding:10px 14px', 'margin-bottom:12px', 'font-size:12px',
    'color:#92400e', 'line-height:1.5', 'position:relative',
  ].join(';');

  const platformLinks = {
    reed:     'https://www.reed.co.uk/account/sign-in',
    linkedin: 'https://www.linkedin.com/login',
    indeed:   'https://secure.indeed.com/auth',
  };

  const links = expired.map(p => {
    const url  = platformLinks[p] || '#';
    const name = p.charAt(0).toUpperCase() + p.slice(1);
    return `<a href="${url}" target="_blank" style="color:#b45309;font-weight:600">${name}</a>`;
  }).join(', ');

  banner.innerHTML = `
    <strong>⚠ Session check:</strong> ${links} may need re-login.
    <br>Extension will attempt autonomous login — if 2FA is needed, those jobs will be skipped.
    <button id="preflight-dismiss" style="position:absolute;top:6px;right:8px;background:none;
      border:none;cursor:pointer;font-size:14px;color:#92400e;padding:0">✕</button>`;

  $jobList.parentNode.insertBefore(banner, $jobList);
  document.getElementById('preflight-dismiss')?.addEventListener('click', () => banner.remove());
}


// ── Button handlers ───────────────────────────────────────────────────────────

$btnSaveConfig.addEventListener('click', async () => {
  const url = $serverUrl.value.trim();
  const key = $apiKey.value.trim();
  await chrome.storage.local.set({ serverUrl: url, apiKey: key });
  showStatus('Config saved ✓');
});

$btnTestConn.addEventListener('click', async () => {
  const url = $serverUrl.value.trim();
  const key = $apiKey.value.trim();
  showStatus('Testing connection…', 'running');
  try {
    const resp = await fetch(`${url}/api/health`, { headers: { 'X-API-Key': key } });
    const data = await resp.json();
    if (data.status === 'ok') {
      showStatus('Connected to server ✓');
    } else {
      showStatus('Server error: ' + JSON.stringify(data), 'error');
    }
  } catch (e) {
    showStatus('Connection failed: ' + e.message, 'error');
  }
});

// ── Session sync ──────────────────────────────────────────────────────────────

function updateSessionBadge(platform, state) {
  const el = document.getElementById(`sess-${platform}`);
  if (!el) return;
  const label = platform.charAt(0).toUpperCase() + platform.slice(1);
  if (state === 'ok') {
    el.textContent = `${label} ✓`;
    el.style.background = '#14532d';
    el.style.color = '#4ade80';
  } else if (state === 'checking') {
    el.textContent = `${label} ·· syncing`;
    el.style.background = '#1e293b';
    el.style.color = '#94a3b8';
  } else {
    el.textContent = `${label} ✗ not logged in`;
    el.style.background = '#1e293b';
    el.style.color = '#64748b';
  }
}

async function runSessionSync() {
  const url = $serverUrl.value.trim();
  const key = $apiKey.value.trim();
  if (!url || !key) { showStatus('Save server config first', 'error'); return null; }
  ['reed', 'indeed', 'linkedin'].forEach(p => updateSessionBadge(p, 'checking'));
  try {
    const results = await chrome.runtime.sendMessage({ type: 'SYNC_SESSIONS', serverUrl: url, apiKey: key });
    for (const [platform, res] of Object.entries(results || {})) {
      updateSessionBadge(platform, res.ok ? 'ok' : 'fail');
    }
    const connected = Object.entries(results || {}).filter(([, r]) => r.ok).map(([p]) => p);
    return connected;
  } catch (e) {
    ['reed', 'indeed', 'linkedin'].forEach(p => updateSessionBadge(p, 'fail'));
    return null;
  }
}

$btnSyncSessions.addEventListener('click', async () => {
  $btnSyncSessions.disabled = true;
  $btnSyncSessions.textContent = 'Syncing…';
  const connected = await runSessionSync();
  $btnSyncSessions.disabled = false;
  $btnSyncSessions.textContent = 'Sync Sessions Now';
  if (connected !== null) {
    showStatus(connected.length > 0
      ? `Sessions synced: ${connected.join(', ')} ✓`
      : 'No sessions found — log in to Reed/Indeed/LinkedIn in Chrome first');
  }
});

$btnLoadCv.addEventListener('click', async () => {
  const url = $serverUrl.value.trim();
  const key = $apiKey.value.trim();
  if (!url || !key) { showStatus('Save server config first', 'error'); return; }

  showStatus('Loading CV from server…', 'running');
  try {
    const resp = await fetch(`${url}/api/cv`, { headers: { 'X-API-Key': key } });
    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    await chrome.storage.local.set({
      cvBase64: data.data,
      cvName:   data.filename,
      cvMime:   data.mime,
    });
    $cvName.textContent = data.filename;
    $cvName.classList.add('loaded');
    showStatus(`CV loaded: ${data.filename} (${(data.size/1024).toFixed(0)}KB) ✓`);
  } catch (e) {
    showStatus('CV load failed: ' + e.message, 'error');
  }
});

$delaySlider.addEventListener('input', async () => {
  const v = $delaySlider.value;
  $delayValue.textContent = `${v}s`;
  await chrome.storage.local.set({ delaySeconds: parseInt(v) });
});

$btnFetch.addEventListener('click', async () => {
  const url = $serverUrl.value.trim();
  const key = $apiKey.value.trim();

  if (!url) { showStatus('Enter server URL first', 'error'); return; }
  if (!key) { showStatus('Enter API key first', 'error'); return; }

  showStatus('Fetching jobs from Google Sheets…', 'running');
  $btnFetch.disabled = true;

  try {
    const resp = await fetch(`${url}/api/jobs?status=Pending+Review&limit=20`, {
      headers: { 'X-API-Key': key }
    });
    const data = await resp.json();

    if (data.error) throw new Error(data.error);

    jobs = (data.jobs || []).map(j => ({ ...j, _state: 'pending' }));
    await chrome.storage.local.set({ jobs });
    renderJobList();

    $statQueue.textContent   = jobs.length;
    $statApplied.textContent = 0;
    $statFailed.textContent  = 0;

    if (jobs.length > 0) {
      $btnStart.disabled = false;
      showStatus(`✓ ${jobs.length} jobs loaded — click Start Applying`);
    } else {
      showStatus('No pending jobs found in Google Sheets');
    }
  } catch (e) {
    showStatus('Fetch failed: ' + e.message, 'error');
  } finally {
    $btnFetch.disabled = false;
  }
});

$btnStart.addEventListener('click', async () => {
  const stored = await chrome.storage.local.get(['cvBase64', 'serverUrl', 'apiKey', 'delaySeconds']);

  if (!jobs.some(j => j._state === 'pending')) { showStatus('No pending jobs — click Fetch Jobs first', 'error'); return; }

  setRunningState(true);
  showStatus('Starting…', 'running');

  chrome.runtime.sendMessage({
    type:         'START_APPLYING',
    serverUrl:    stored.serverUrl || $serverUrl.value.trim(),
    apiKey:       stored.apiKey    || $apiKey.value.trim(),
    delaySeconds: stored.delaySeconds || 5,
    jobs,
  }, response => {
    if (chrome.runtime.lastError) {
      showStatus('Start failed: ' + chrome.runtime.lastError.message, 'error');
      setRunningState(false);
    }
  });
});

$btnStop.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_APPLYING' }, () => {
    setRunningState(false);
    showStatus('Stopped');
  });
});

// ── Render ────────────────────────────────────────────────────────────────────

function renderJobList() {
  if (!jobs || jobs.length === 0) {
    $jobList.innerHTML = '<div class="empty-state">No jobs. Click "Fetch Jobs" to load from Google Sheets.</div>';
    return;
  }

  $jobList.innerHTML = jobs.map(job => {
    const state = job._state || 'pending';
    const icons = { pending: '○', current: '▶', applied: '✓', failed: '✗' };
    const ats = detectAts(job.url);
    return `
      <div class="job-item" id="job-${job.row}">
        <div class="job-status-icon ${state}">${icons[state] || '○'}</div>
        <div class="job-info">
          <div class="job-title">${esc(job.title)} @ ${esc(job.company)}</div>
          <div class="job-company">${esc(job.location || '')}</div>
        </div>
        <div class="job-ats">${ats}</div>
      </div>`;
  }).join('');
}

function detectAts(url = '') {
  if (url.includes('greenhouse.io')) return 'GH';
  if (url.includes('lever.co'))      return 'LV';
  if (url.includes('reed.co.uk'))    return 'RD';
  if (url.includes('workable.com'))  return 'WK';
  if (url.includes('ashbyhq.com'))   return 'AB';
  return '?';
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function setRunningState(running) {
  $btnStart.disabled = running;
  $btnStop.disabled  = !running;
  $btnFetch.disabled = running;
}
