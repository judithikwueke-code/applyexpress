/**
 * background.js — AutoApply
 *
 * Uses chrome.scripting.executeScript directly for all page interaction.
 * No content script message passing — everything is injected and awaited step by step.
 */

let state = {
  isRunning:    false,
  jobs:         [],
  currentIndex: 0,
  stats:        { applied: 0, failed: 0, queue: 0 },
  serverUrl:    '',
  apiKey:       '',
  delaySeconds: 10,
  statusText:   '',
  activeTabId:  null,
};

// ── Message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_STATE')      sendResponse({ isRunning: state.isRunning, statusText: state.statusText });
  if (msg.type === 'START_APPLYING') { handleStart(msg); sendResponse({ ok: true }); }
  if (msg.type === 'STOP_APPLYING')  { state.isRunning = false; sendResponse({ ok: true }); }
  if (msg.type === 'SYNC_SESSIONS')  { syncSessions(msg.serverUrl, msg.apiKey).then(sendResponse); return true; }
  if (msg.type === 'CONFIGURE') {
    chrome.storage.local.set({ serverUrl: msg.serverUrl, apiKey: msg.apiKey }, () => {
      state.serverUrl = msg.serverUrl;
      state.apiKey    = msg.apiKey;
      sendResponse({ ok: true });
    });
    return true;
  }
  return true;
});


// ── Auto-apply alarm ──────────────────────────────────────────────────────────
// Fires every 15 minutes. Checks server for pending jobs — if found and we're
// not already running, fetches CV (if not cached) and auto-starts the apply loop.

const AUTO_ALARM = 'applyexpress-auto';

function setupAlarm() {
  chrome.alarms.get(AUTO_ALARM, existing => {
    if (!existing) {
      chrome.alarms.create(AUTO_ALARM, { periodInMinutes: 15 });
      log('[auto] Alarm registered — checking for jobs every 15 min');
    }
  });
}

chrome.runtime.onInstalled.addListener(setupAlarm);
chrome.runtime.onStartup.addListener(setupAlarm);

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === AUTO_ALARM) autoApplyCheck();
});

// Also sync sessions on install and startup so the server always has fresh cookies
chrome.runtime.onInstalled.addListener(() => { setupAlarm(); _autoSyncSessions(); });
chrome.runtime.onStartup.addListener(_autoSyncSessions);

async function _autoSyncSessions() {
  const stored = await chrome.storage.local.get(['serverUrl', 'apiKey']);
  const serverUrl = stored.serverUrl || '';
  const apiKey    = stored.apiKey    || '';
  if (!serverUrl || !apiKey) return;
  try {
    const results = await syncSessions(serverUrl, apiKey);
    const connected = Object.entries(results).filter(([, r]) => r.ok).map(([p]) => p);
    if (connected.length > 0) log('[sessions] Auto-synced: ' + connected.join(', '));
  } catch (_) {}
}

async function autoApplyCheck() {
  const stored = await chrome.storage.local.get(['serverUrl', 'apiKey', 'autoApplyEnabled']);

  if (stored.autoApplyEnabled === false) {
    log('[auto] Auto-apply disabled by user — skip');
    return;
  }

  const serverUrl = stored.serverUrl || '';
  const apiKey    = stored.apiKey    || '';
  if (!serverUrl || !apiKey) {
    log('[auto] No server config — skip');
    return;
  }

  // Only job: sync platform sessions so the server always has fresh cookies.
  // Actual job applications run server-side via systemd — no tabs opened here.
  syncSessions(serverUrl, apiKey).then(results => {
    const connected = Object.entries(results).filter(([, r]) => r.ok).map(([p]) => p);
    if (connected.length > 0) log('[sessions] Synced: ' + connected.join(', '));
    else log('[sessions] No platforms connected — make sure you are logged in to Reed/Indeed/LinkedIn in Chrome');
  }).catch(() => {});
}


// ── Start ─────────────────────────────────────────────────────────────────────

async function handleStart(msg) {
  state.isRunning    = true;
  state.jobs         = msg.jobs || [];
  state.serverUrl    = msg.serverUrl;
  state.apiKey       = msg.apiKey;
  state.delaySeconds = msg.delaySeconds || 10;
  state.stats        = { applied: 0, failed: 0, queue: state.jobs.filter(j => j._state === 'pending').length };
  state.currentIndex = 0;

  log('=== AutoApply started ===');
  broadcastStatus('running', `${state.stats.queue} jobs queued`);

  // Fetch candidate profile (name, email, phone) from server — one time per session
  state.profile = { name: '', email: '', phone: '' };
  try {
    const pr = await fetch(`${state.serverUrl}/api/profile`, {
      headers: { 'X-API-Key': state.apiKey }
    });
    const pd = await pr.json();
    state.profile = {
      name:  pd.fullName || '',
      email: pd.email    || '',
      phone: pd.phone    || '',
    };
    log(`Profile loaded: ${state.profile.name} <${state.profile.email}>`);
  } catch (_) {
    log('Could not fetch profile — name/email/phone will be blank');
  }

  // Step 1 — Pre-flight session check across all platforms
  broadcastStatus('running', 'Checking platform sessions…');
  await preflightSessionCheck();

  // Step 2 — Log into Reed first (one time)
  const hasReed = state.jobs.some(j => j._state === 'pending' && j.url?.includes('reed.co.uk'));
  if (hasReed) {
    broadcastStatus('running', 'Step 1: Logging into Reed.co.uk…');
    const loggedIn = await reedLogin();
    if (loggedIn) {
      log('✓ Reed login successful');
    } else {
      log('✗ Reed login failed — will try anyway');
    }
  }

  await processNextJob();
}


// ── Pre-flight session check ──────────────────────────────────────────────────
// Opens a hidden tab for each platform that has jobs queued, checks login state,
// broadcasts a warning for any expired sessions so the user can re-login before
// the batch runs. Non-blocking — we warn but don't stop the run.

async function preflightSessionCheck() {
  const pending = state.jobs.filter(j => j._state === 'pending');
  const platforms = {
    reed:     pending.some(j => j.url?.includes('reed.co.uk')),
    linkedin: pending.some(j => j.url?.includes('linkedin.com')),
    indeed:   pending.some(j => j.url?.includes('indeed.co.uk') || j.url?.includes('gb.indeed.com')),
  };

  const checks = {
    reed: {
      url:   'https://www.reed.co.uk/',
      check: () => {
        // Logged in if there's a My Reed / profile / sign out link visible
        const all = Array.from(document.querySelectorAll('a, button'));
        return !!(all.find(el => /my reed|sign out|logout|my account/i.test(el.textContent) && el.offsetParent !== null));
      },
    },
    linkedin: {
      url:   'https://www.linkedin.com/feed/',
      check: () => {
        // Redirects to /login if not authenticated
        return !window.location.href.includes('/login') && !window.location.href.includes('/authwall');
      },
    },
    indeed: {
      url:   'https://www.indeed.co.uk/myjobs',
      check: () => {
        return !window.location.href.includes('/login') && !window.location.href.includes('/auth');
      },
    },
  };

  const expired = [];

  for (const [platform, needed] of Object.entries(platforms)) {
    if (!needed) continue;
    const cfg = checks[platform];
    log(`Pre-flight: checking ${platform} session…`);
    let tab;
    try {
      tab = await createBgTab(cfg.url);
      await waitForLoad(tab.id);
      await sleep(3000);
      const loggedIn = await exec(tab.id, cfg.check);
      log(`Pre-flight ${platform}: ${loggedIn ? '✓ logged in' : '✗ session expired'}`);
      if (!loggedIn) expired.push(platform);
    } catch (e) {
      log(`Pre-flight ${platform} check error: ${e.message}`);
    } finally {
      if (tab) { try { await closeBgTab(tab); } catch (_) {} }
    }
  }

  if (expired.length > 0) {
    const names = expired.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(', ');
    chrome.runtime.sendMessage({
      type:    'PREFLIGHT_WARNING',
      expired,
      message: `⚠ Session expired: ${names}. The extension will try to log in automatically using your stored credentials. If 2FA is required, those jobs will be skipped.`,
    });
    log(`⚠ Expired sessions: ${names} — will attempt autonomous login per job`);
  } else {
    log('Pre-flight: all sessions active ✓');
  }
}


// ── Reed Login — fully scripted ───────────────────────────────────────────────

async function reedLogin() {
  let creds;
  try {
    const r = await fetch(`${state.serverUrl}/api/credentials`, { headers: { 'X-API-Key': state.apiKey } });
    creds = await r.json();
  } catch (e) { log('Cannot fetch credentials: ' + e.message); return false; }

  const email    = creds.reed?.email    || '';
  const password = creds.reed?.password || '';
  if (!email || !password) { log('No Reed credentials in .env'); return false; }

  log(`Logging in as: ${email}`);

  // Open Reed homepage first — clicking Sign In from here generates a valid state token
  const tab = await createBgTab('https://www.reed.co.uk/');
  state.activeTabId = tab.id;
  await waitForLoad(tab.id);
  await sleep(2000);

  // Accept cookies
  await exec(tab.id, () => {
    const btn = document.querySelector('#onetrust-accept-btn-handler') ||
                Array.from(document.querySelectorAll('button')).find(b => /accept all|accept cookies/i.test(b.textContent));
    if (btn) { btn.click(); return 'accepted cookies'; }
    return 'no cookie banner';
  });
  await sleep(1000);

  // Click the Sign In link on Reed homepage
  const signInClick = await exec(tab.id, () => {
    // Reed's sign in is usually a link in the nav
    const all = Array.from(document.querySelectorAll('a, button'));
    const btn = all.find(el => {
      const t = el.textContent.trim().toLowerCase();
      return (t === 'sign in' || t === 'log in' || t === 'signin') && el.offsetParent !== null;
    });
    if (btn) { btn.click(); return 'clicked: ' + btn.textContent.trim(); }
    // Log all links for debugging
    return 'NOT_FOUND — links: ' + all.slice(0,20).map(a=>a.textContent.trim().slice(0,15)).filter(Boolean).join(', ');
  });
  log('Homepage Sign In: ' + signInClick);

  // Wait for Reed's login page to load with valid state token
  await waitForLoad(tab.id);
  await sleep(2000);

  // Use the same robust Auth0 login helper
  log('Filling Reed/Auth0 login form…');
  await fillReedLoginOnPage(tab.id, email, password);

  log('Credentials submitted — waiting for redirect…');

  // Wait for login redirect
  await sleep(6000);

  // Verify login success
  const loginCheck = await exec(tab.id, () => {
    const url = window.location.href;
    const hasPasswordField = !!document.querySelector('input[type="password"]');
    return { url, hasPasswordField };
  });

  log('After login — URL: ' + loginCheck?.url);
  const success = !loginCheck?.hasPasswordField;

  try { await closeBgTab(tab); } catch (_) {}
  state.activeTabId = null;
  await sleep(1000);
  return success;
}


// ── Process jobs one by one ───────────────────────────────────────────────────

async function processNextJob() {
  if (!state.isRunning) { broadcastDone(); return; }

  const job = state.jobs.slice(state.currentIndex).find(j => j._state === 'pending');
  if (!job) { log('All jobs processed'); broadcastDone(); return; }

  const idx = state.jobs.indexOf(job);
  state.currentIndex     = idx;
  state.jobs[idx]._state = 'current';
  log(`\n--- Job ${idx + 1}: ${job.title} @ ${job.company} ---`);
  log(`URL: ${job.url}`);

  // Pre-flight: check deduplication + blacklist before opening any tab
  try {
    const checkResp = await fetch(
      `${state.serverUrl}/api/check_job?url=${encodeURIComponent(job.url)}&company=${encodeURIComponent(job.company || '')}`,
      { headers: { 'X-API-Key': state.apiKey } }
    );
    const checkData = await checkResp.json();
    if (checkData.duplicate) {
      log(`Skipping duplicate: already applied to ${job.url}`);
      await finishJob(idx, false, 'Duplicate — already applied');
      return;
    }
    if (checkData.blacklisted) {
      log(`Skipping blacklisted company: ${job.company}`);
      await finishJob(idx, false, 'Blacklisted company');
      return;
    }
  } catch (e) {
    log(`Pre-check error (continuing anyway): ${e.message}`);
  }

  broadcastStatus('running', `Applying: ${job.title} @ ${job.company}`);

  // Load credentials
  let reedEmail = '', reedPassword = '', linkedinEmail = '', linkedinPassword = '',
      indeedEmail = '', indeedPassword = '', twocaptchaKey = '';
  try {
    const r = await fetch(`${state.serverUrl}/api/credentials`, { headers: { 'X-API-Key': state.apiKey } });
    const c = await r.json();
    reedEmail      = c.reed?.email      || '';  reedPassword      = c.reed?.password      || '';
    linkedinEmail  = c.linkedin?.email  || '';  linkedinPassword  = c.linkedin?.password  || '';
    indeedEmail    = c.indeed?.email    || '';  indeedPassword    = c.indeed?.password    || '';
    twocaptchaKey  = c.twocaptcha_key   || '';
  } catch (_) {}

  // Load CV — use per-job tailored CV if available, otherwise fall back to stored CV
  const stored = await chrome.storage.local.get(['cvBase64', 'cvName', 'cvMime']);
  let cvBase64 = stored.cvBase64 || '';
  let cvName   = stored.cvName   || 'cv.docx';
  const cvMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  if (job.cv_url) {
    try {
      const cvResp = await fetch(`${state.serverUrl}${job.cv_url}`, { headers: { 'X-API-Key': state.apiKey } });
      const cvBlob = await cvResp.blob();
      cvBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(cvBlob);
      });
      cvName = job.cv_name || cvName;
      log(`Loaded tailored CV: ${cvName}`);
    } catch (e) {
      log(`Failed to load tailored CV, using stored CV: ${e.message}`);
    }
  }

  const payload = {
    title:       job.title,
    company:     job.company,
    url:         job.url,
    coverLetter: job.cover_letter || '',
    name:        state.profile?.name  || '',
    email:       state.profile?.email || '',
    phone:       state.profile?.phone || '',
    cvBase64,
    cvName,
    cvMime,
    reedEmail,      reedPassword,
    linkedinEmail,  linkedinPassword,
    indeedEmail,    indeedPassword,
    twocaptchaKey,
  };

  // Route to correct ATS handler
  let result;
  try {
    if (job.url.includes('reed.co.uk'))         result = await applyReed(job.url, payload);
    else if (job.url.includes('greenhouse.io'))  result = await applyGreenhouse(job.url, payload);
    else if (job.url.includes('lever.co'))       result = await applyLever(job.url, payload);
    else if (job.url.includes('indeed.co.uk') || job.url.includes('gb.indeed.com'))
                                                 result = await applyIndeed(job.url, payload);
    else if (job.url.includes('totaljobs.com'))  result = await applyTotaljobs(job.url, payload);
    else if (job.url.includes('linkedin.com'))   result = await applyLinkedIn(job.url, payload);
    else if (job.url.includes('workable.com'))   result = await applyWorkable(job.url, payload);
    else if (job.url.includes('ashbyhq.com'))    result = await applyAshby(job.url, payload);
    else result = { success: false, reason: 'Unsupported: ' + new URL(job.url).hostname };
  } catch (e) {
    result = { success: false, reason: 'Exception: ' + e.message };
  }

  log(`Result: ${result.success ? '✓ APPLIED' : '✗ ' + result.reason}`);
  await finishJob(idx, result.success, result.reason || '');
}


// ── Reed Apply ────────────────────────────────────────────────────────────────

async function applyReed(url, p) {
  const tab = await createBgTab(url);
  state.activeTabId = tab.id;
  try {
    await waitForLoad(tab.id);
    await sleep(3000);

    // Dismiss cookies
    await exec(tab.id, () => {
      const btn = document.querySelector('#onetrust-accept-btn-handler') ||
                  Array.from(document.querySelectorAll('button')).find(b => /accept all/i.test(b.textContent));
      if (btn) btn.click();
    });
    await sleep(1000);

    // Check page state
    const pageState = await exec(tab.id, () => {
      const bodyText = document.body.innerText;
      if (/this job has expired/i.test(bodyText)) return 'EXPIRED';
      if (/no longer available/i.test(bodyText))   return 'UNAVAILABLE';
      if (/you.ve already applied|already applied/i.test(bodyText) ||
          Array.from(document.querySelectorAll('button, a'))
            .some(el => /edit (my )?application/i.test(el.textContent.trim()) && el.offsetParent !== null))
        return 'ALREADY_APPLIED';
      // Check if already on apply form
      if (window.location.href.includes('/apply')) return 'ON_APPLY_FORM';
      // Find apply button
      const applyBtn = Array.from(document.querySelectorAll('button, a'))
        .find(el => /apply now|apply for this job/i.test(el.textContent.trim()) && el.offsetParent !== null);
      if (applyBtn) return 'HAS_APPLY_BUTTON:' + applyBtn.tagName + ':' + applyBtn.textContent.trim().slice(0, 30);
      return 'NO_APPLY_BUTTON — ' + document.title.slice(0, 50);
    });

    log('Reed page state: ' + pageState);

    if (pageState === 'ALREADY_APPLIED') {
      await closeBgTab(tab);
      return { success: true, reason: 'Already applied (Reed detected)' };
    }
    if (pageState === 'EXPIRED' || pageState === 'UNAVAILABLE') {
      await closeBgTab(tab);
      return { success: false, reason: pageState };
    }
    if (pageState.startsWith('NO_APPLY_BUTTON')) {
      await closeBgTab(tab);
      return { success: false, reason: pageState };
    }

    // Upload tailored CV to Reed profile before applying
    if (p.cvBase64 && p.cvName) {
      const uploadOk = await uploadCvToReedProfile(tab.id, p);
      log('Tailored CV upload: ' + uploadOk);
      // Navigate back to job after CV upload
      await chrome.tabs.update(tab.id, { url });
      await waitForLoad(tab.id);
      await sleep(3000);
    }

    // Click Apply button
    await exec(tab.id, () => {
      const btn = Array.from(document.querySelectorAll('button, a'))
        .find(el => /apply now|apply for this job/i.test(el.textContent.trim()) && el.offsetParent !== null);
      if (btn) btn.click();
    });
    log('Clicked Apply — waiting for modal/form…');
    await sleep(4000);

    // Check if redirected to login
    const applyUrl = await exec(tab.id, () => window.location.href);
    log('Apply form URL: ' + applyUrl);

    if (applyUrl && applyUrl.includes('secure.reed.co.uk')) {
      log('Reed OAuth page — attempting login…');
      await sleep(2500);

      // First: try just clicking Continue — if Auth0 has an active session it will redirect automatically
      const sessionCheck = await exec(tab.id, () => {
        // Look for a "Continue as [name]" button or already-authenticated indicator
        const allBtns = Array.from(document.querySelectorAll('button'));
        const continueAs = allBtns.find(b => /continue as/i.test(b.textContent));
        if (continueAs) { continueAs.click(); return 'found-continue-as: ' + continueAs.textContent.trim(); }
        return 'no-session-btn';
      });
      log('Session check: ' + sessionCheck);

      if (!sessionCheck.startsWith('no-session-btn')) {
        await sleep(4000);
      }

      // Check if we're still on OAuth page
      const urlNow = await exec(tab.id, () => window.location.href);
      if (urlNow && urlNow.includes('secure.reed.co.uk')) {
        log('No active session — filling credentials…');
        await fillReedLoginOnPage(tab.id, p.reedEmail, p.reedPassword);

        await sleep(6000);

        const postLoginUrl = await exec(tab.id, () => window.location.href);
        log('Post-login URL: ' + postLoginUrl);

        if (postLoginUrl && postLoginUrl.includes('secure.reed.co.uk')) {
          // Check if there's an error message
          const errMsg = await exec(tab.id, () => {
            const err = document.querySelector('[class*="error"], [class*="alert"], [role="alert"]');
            return err ? err.textContent.trim().slice(0, 100) : 'no error element';
          });
          log('Auth0 error: ' + errMsg);
          await closeBgTab(tab);
          return { success: false, reason: 'Reed OAuth login failed: ' + errMsg };
        }
      }

      // Re-click Apply after login redirect back to reed.co.uk
      await sleep(2000);
      const reApply = await exec(tab.id, () => {
        const btn = Array.from(document.querySelectorAll('button, a'))
          .find(el => /apply now|apply for this job/i.test(el.textContent.trim()) && el.offsetParent !== null);
        if (btn) { btn.click(); return 're-clicked apply'; }
        return 'no-apply-btn-after-login';
      });
      log('Re-apply: ' + reApply);
      await sleep(3000);
    }

    // Inspect what appeared after clicking Apply — modal, drawer, or form
    const modalInfo = await exec(tab.id, () => {
      // Look for a modal/drawer/overlay that appeared
      const modal = document.querySelector(
        '[role="dialog"], [role="modal"], .modal, .drawer, .overlay, ' +
        '[class*="apply-modal"], [class*="application-modal"], [class*="apply-drawer"], ' +
        '[id*="apply-modal"], [data-testid*="apply"]'
      );
      if (modal) {
        const btns = Array.from(modal.querySelectorAll('button')).map(b => b.textContent.trim().slice(0,30));
        const inputs = Array.from(modal.querySelectorAll('input, textarea')).map(i => i.type + ':' + (i.name||i.id||'?'));
        return { found: true, tag: modal.tagName, class: modal.className.slice(0,60), buttons: btns, inputs };
      }
      // No modal — log all visible buttons
      const allBtns = Array.from(document.querySelectorAll('button'))
        .filter(b => b.offsetParent !== null)
        .map(b => b.textContent.trim().slice(0,30));
      return { found: false, allButtons: allBtns };
    });
    log('Modal info: ' + JSON.stringify(modalInfo));

    // Fill form fields in the modal
    const formResult = await fillReedForm(tab.id, p);
    log('Form fill: ' + JSON.stringify(formResult));

    // Submit — look inside modal first, then full page for Reed Quick Apply buttons
    await sleep(2000);
    const submitted = await exec(tab.id, () => {
      const allVisible = Array.from(document.querySelectorAll('button'))
        .filter(b => b.offsetParent !== null);

      // 1. Try inside dialog/modal
      const dialog = document.querySelector('[role="dialog"], [role="modal"], .modal, .drawer, [class*="apply"]');
      if (dialog) {
        // Try submit button first, then any non-cancel button (including icon-only buttons with no text)
        const btn = dialog.querySelector('button[type="submit"]') ||
                    Array.from(dialog.querySelectorAll('button')).find(b => {
                      const t = b.textContent.trim().toLowerCase();
                      return !t.includes('search') && !t.includes('close') && !t.includes('cancel') &&
                             !t.includes('back') && !t.includes('save') && b.offsetParent !== null;
                    }) ||
                    // Fallback: first button in modal regardless of visibility (handles icon-only buttons)
                    Array.from(dialog.querySelectorAll('button')).find(b => {
                      const t = b.textContent.trim().toLowerCase();
                      return !t.includes('close') && !t.includes('cancel') && !t.includes('back');
                    });
        if (btn) { btn.click(); return 'modal-btn: ' + btn.textContent.trim(); }
      }

      // 2. Reed Quick Apply: "Submit application" or "Continue" anywhere on page
      const submitBtn = allVisible.find(b => /submit application/i.test(b.textContent.trim()))
        || allVisible.find(b => /^continue$/i.test(b.textContent.trim()))
        || allVisible.find(b => /send application|apply now/i.test(b.textContent.trim()) && b.type === 'submit');
      if (submitBtn) { submitBtn.click(); return 'page-btn: ' + submitBtn.textContent.trim(); }

      // Log all visible buttons so we can debug
      const visible = allVisible.map(b => b.textContent.trim().slice(0,25));
      return 'NOT_FOUND — visible buttons: ' + visible.join(' | ');
    });
    log('Submit: ' + submitted);

    if (submitted.startsWith('NOT_FOUND')) {
      await closeBgTab(tab);
      return { success: false, reason: 'Submit button not found in modal or page' };
    }

    await sleep(5000);

    // Multi-step loop — some Reed Quick Apply forms have questionnaire steps after the first click
    for (let step = 0; step < 8; step++) {
      await sleep(3000);

      const stepResult = await exec(tab.id, () => {
        const body = document.body.innerText;
        // Confirmation check first
        if (/application.*sent|thank you for applying|successfully applied|you.ve applied|application submitted|application received/i.test(body))
          return 'confirmed';
        if (/confirm|success|applied|thankyou/i.test(window.location.href))
          return 'confirmed';
        const appliedEl = Array.from(document.querySelectorAll('button,a,[class*="applied"]'))
          .find(el => /you.ve applied|already applied|application sent/i.test(el.textContent));
        if (appliedEl) return 'confirmed';

        // Auto-answer yes/no radio questions
        const radios = Array.from(document.querySelectorAll('input[type="radio"]'))
          .filter(r => r.offsetParent !== null);
        if (radios.length > 0) {
          const yesRadio = radios.find(r => /yes|true/i.test(r.value || r.labels?.[0]?.textContent || ''));
          if (yesRadio && !yesRadio.checked) yesRadio.click();
          else if (!document.querySelector('input[type="radio"]:checked')) radios[0].click();
        }

        // Find next/continue/submit button
        const allBtns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null);
        const btn = allBtns.find(b => /submit application|send application/i.test(b.textContent))
          || allBtns.find(b => /^(continue|next|proceed)$/i.test(b.textContent.trim()));
        if (btn) { btn.click(); return 'clicked: ' + btn.textContent.trim(); }
        return 'no-btn';
      });

      log(`Reed step ${step + 1}: ${stepResult}`);
      if (stepResult === 'confirmed' || stepResult === 'no-btn') break;
    }

    // Final confirmation check
    const confirmed = await exec(tab.id, () => {
      const body = document.body.innerText;
      if (/application.*sent|thank you for applying|successfully applied|application received|you.ve applied|application submitted/i.test(body)) return 'text-match';
      if (/confirm|success|applied|thankyou/i.test(window.location.href)) return 'url-match';
      const applied = Array.from(document.querySelectorAll('button, a, [class*="applied"]'))
        .find(el => /you.ve applied|already applied|application sent/i.test(el.textContent));
      if (applied) return 'applied-indicator';
      return null;
    });
    log('Confirmation check: ' + confirmed);

    await closeBgTab(tab);
    return { success: !!confirmed, reason: confirmed ? '' : 'No confirmation detected after submit click' };

  } catch (e) {
    try { await closeBgTab(tab); } catch (_) {}
    return { success: false, reason: e.message };
  } finally {
    state.activeTabId = null;
  }
}

async function uploadCvToReedProfile(tabId, p) {
  await chrome.tabs.update(tabId, { url: 'https://www.reed.co.uk/my/cv' });
  await waitForLoad(tabId);
  await sleep(4000);

  // Check if we're on the CV page (not redirected to login)
  const currentUrl = await exec(tabId, () => window.location.href);
  if (!currentUrl || !currentUrl.includes('reed.co.uk/my')) {
    return 'skipped — not on Reed my-cv page: ' + currentUrl;
  }

  // Inspect the page for file inputs and upload buttons
  const pageInfo = await exec(tabId, () => {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'))
      .map(i => i.accept + '|' + (i.name || i.id || '?'));
    const btns = Array.from(document.querySelectorAll('button'))
      .filter(b => b.offsetParent !== null)
      .map(b => b.textContent.trim().slice(0, 30));
    return { inputs, btns: btns.slice(0, 15), title: document.title };
  });
  log('Reed CV page: ' + JSON.stringify(pageInfo));

  // Upload the file
  const uploadResult = await exec(tabId, (p) => {
    const fileInput = document.querySelector('input[type="file"]');
    if (!fileInput) return 'NO_FILE_INPUT';

    try {
      const mime = p.cvMime || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      const byteStr = atob(p.cvBase64.split(',')[1]);
      const ab = new ArrayBuffer(byteStr.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < byteStr.length; i++) ia[i] = byteStr.charCodeAt(i);
      const blob = new Blob([ab], { type: mime });
      const file = new File([blob], p.cvName, { type: mime });
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      fileInput.dispatchEvent(new Event('input', { bubbles: true }));
      return 'file-set: ' + p.cvName;
    } catch (e) {
      return 'error: ' + e.message;
    }
  }, [p]);
  log('Reed CV file set: ' + uploadResult);

  if (uploadResult === 'NO_FILE_INPUT') return 'no-file-input';

  // Wait for upload processing then click Save/Upload/Confirm button
  await sleep(4000);
  const saveResult = await exec(tabId, () => {
    const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null);
    const saveBtn = btns.find(b => /upload|save|update|confirm|replace/i.test(b.textContent.trim()))
      || btns.find(b => b.type === 'submit');
    if (saveBtn) { saveBtn.click(); return 'clicked: ' + saveBtn.textContent.trim(); }
    return 'NO_SAVE_BTN — btns: ' + btns.map(b => b.textContent.trim().slice(0, 20)).join('|');
  });
  log('Reed CV save btn: ' + saveResult);

  await sleep(3000);
  return uploadResult + ' / ' + saveResult;
}

async function fillReedLoginOnPage(tabId, email, password) {
  // Inspect exact inputs on the page first
  const pageInfo = await exec(tabId, () => {
    const inputs = Array.from(document.querySelectorAll('input')).map(i => ({
      type: i.type, name: i.name, id: i.id, placeholder: i.placeholder
    }));
    const btns = Array.from(document.querySelectorAll('button')).map(b => ({
      type: b.type, text: b.textContent.trim().slice(0, 40), name: b.name, value: b.value
    }));
    return { inputs, btns, url: window.location.href };
  });
  log('Auth0 page detail: ' + JSON.stringify(pageInfo));

  // Find and fill email — Auth0 uses name="signin_email", "email", or "username"
  const emailResult = await exec(tabId, (email) => {
    function typeInto(el, text) {
      el.focus();
      el.click();
      // Clear field
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      // Try execCommand (works in many JS frameworks)
      try {
        if (document.execCommand) {
          document.execCommand('selectAll', false);
          document.execCommand('insertText', false, text);
        }
      } catch (_) {}
      // If execCommand didn't work, set directly with React setter
      if (!el.value || el.value !== text) {
        const proto = window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, text); else el.value = text;
        // Fire complete sequence of events
        el.dispatchEvent(new Event('focus',  { bubbles: true }));
        el.dispatchEvent(new InputEvent('input',  { inputType: 'insertText', data: text, bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }
    // Auth0-specific selectors (priority order)
    const el = document.querySelector(
      'input[name="signin_email"], input[name="email"], input[name="username"], ' +
      'input[id="email"], input[type="email"]'
    );
    if (!el) {
      const allInputs = Array.from(document.querySelectorAll('input')).map(i => i.name + '/' + i.type + '/' + i.id);
      return 'EMAIL_NOT_FOUND: ' + allInputs.join(', ');
    }
    typeInto(el, email);
    return 'email_filled:' + (el.name || el.id || el.type) + ':value_len=' + el.value.length;
  }, [email]);

  log('Auth0 email fill: ' + emailResult);
  await sleep(800);

  // Click Continue (email step) — avoid social login buttons AND OTP "Verify Code" button
  const emailBtnResult = await exec(tabId, () => {
    const allBtns = Array.from(document.querySelectorAll('button'));
    // First: exact match for "Continue" (email/password form button, not OTP form)
    const btn = allBtns.find(b => b.textContent.trim() === 'Continue')
      || allBtns.find(b => {
        const t = b.textContent.trim().toLowerCase();
        // Exclude social logins AND OTP verify buttons
        return b.type === 'submit'
          && !/(apple|google|facebook|twitter|github|verify|otp)/i.test(t)
          && (t === 'continue' || t === 'next' || t === 'sign in' || t === 'log in');
      });
    if (!btn) return 'NO_CONTINUE_BTN: ' + allBtns.map(b => b.textContent.trim().slice(0,20)).join('|');
    btn.click();
    return 'clicked: ' + btn.textContent.trim();
  });
  log('Auth0 email-step btn: ' + emailBtnResult);

  await sleep(2500);

  // Fill password — Auth0 uses name="signin_password" or type="password"
  const passResult = await exec(tabId, (password) => {
    function typeInto(el, text) {
      el.focus();
      el.click();
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      try {
        if (document.execCommand) {
          document.execCommand('selectAll', false);
          document.execCommand('insertText', false, text);
        }
      } catch (_) {}
      if (!el.value || el.value !== text) {
        const proto = window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, text); else el.value = text;
        el.dispatchEvent(new Event('focus',  { bubbles: true }));
        el.dispatchEvent(new InputEvent('input',  { inputType: 'insertText', data: text, bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }
    const el = document.querySelector(
      'input[name="signin_password"], input[name="password"], input[type="password"]'
    );
    if (!el) return 'PASSWORD_NOT_FOUND';
    typeInto(el, password);
    return 'pass_filled:' + (el.name || el.id) + ':len=' + el.value.length;
  }, [password]);

  log('Auth0 pass fill: ' + passResult);
  await sleep(800);

  // Click Continue/Sign In for password step — exclude OTP "Verify Code"
  const passBtnResult = await exec(tabId, () => {
    const allBtns = Array.from(document.querySelectorAll('button'));
    // First: exact match for "Continue" or "Sign In", explicitly skip "Verify Code"
    const btn = allBtns.find(b => b.textContent.trim() === 'Continue')
      || allBtns.find(b => b.textContent.trim() === 'Sign In')
      || allBtns.find(b => {
        const t = b.textContent.trim().toLowerCase();
        return b.type === 'submit'
          && !/(apple|google|facebook|twitter|github|verify|otp)/i.test(t)
          && (t === 'continue' || t === 'sign in' || t === 'log in' || t === 'next');
      });
    if (!btn) return 'NO_SUBMIT_BTN';
    btn.click();
    return 'clicked: ' + btn.textContent.trim();
  });
  log('Auth0 pass-step btn: ' + passBtnResult);

  // Check for OTP step (Reed sometimes sends email verification)
  await sleep(3000);
  await handleOtpIfPresent(tabId, 'reed');
}

async function fillReedForm(tabId, p) {
  return await exec(tabId, (p) => {
    function set(el, val) {
      if (!el || !val) return false;
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const s = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (s) s.call(el, val); else el.value = val;
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    const results = {};

    // Cover letter / message
    const coverEl = document.querySelector('textarea[name*="cover"], textarea[id*="cover"], textarea[name*="message"], textarea');
    if (coverEl) { set(coverEl, p.coverLetter); results.coverLetter = true; }

    // Phone
    const phoneEl = document.querySelector('input[type="tel"], input[name*="phone"], input[id*="phone"]');
    if (phoneEl) { set(phoneEl, p.phone); results.phone = true; }

    // CV upload
    const fileInput = document.querySelector('input[type="file"]');
    if (fileInput && p.cvBase64) {
      try {
        const byteStr = atob(p.cvBase64.split(',')[1]);
        const ab = new ArrayBuffer(byteStr.length);
        const ia = new Uint8Array(ab);
        for (let i = 0; i < byteStr.length; i++) ia[i] = byteStr.charCodeAt(i);
        const blob = new Blob([ab], { type: p.cvMime });
        const file = new File([blob], p.cvName, { type: p.cvMime });
        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        results.cv = true;
      } catch (e) { results.cvError = e.message; }
    }

    results.found = true;
    results.detail = JSON.stringify(results);
    return results;
  }, [p]);
}


// ── LinkedIn Easy Apply ───────────────────────────────────────────────────────

async function applyLinkedIn(url, p) {
  const tab = await createBgTab(url);
  state.activeTabId = tab.id;
  try {
    await waitForLoad(tab.id);
    await sleep(3000);

    // Check page state
    let pageState = await exec(tab.id, () => {
      if (document.querySelector('input#session_key, input[name="session_key"]')) return 'LOGIN_WALL';
      const btn = Array.from(document.querySelectorAll('button'))
        .find(b => /easy apply/i.test(b.textContent) && b.offsetParent !== null);
      if (btn) return 'HAS_EASY_APPLY';
      if (/no longer accepting/i.test(document.body.innerText)) return 'CLOSED';
      return 'NO_EASY_APPLY — ' + document.title.slice(0, 50);
    });
    log('LinkedIn page state: ' + pageState);

    if (pageState === 'LOGIN_WALL') {
      if (!p.linkedinEmail || !p.linkedinPassword) {
        await closeBgTab(tab);
        return { success: false, reason: 'LinkedIn: no credentials configured in profile' };
      }
      log('Logging into LinkedIn…');
      await chrome.tabs.update(tab.id, { url: 'https://www.linkedin.com/login' });
      await waitForLoad(tab.id);
      await sleep(2000);

      // Solve CAPTCHA if present on login page
      const liCaptchaSolved = await solveCaptchaIfPresent(tab.id, p.twocaptchaKey);
      if (liCaptchaSolved) { await sleep(3000); await waitForLoad(tab.id); await sleep(2000); }

      await exec(tab.id, (p) => {
        function typeInto(el, val) {
          el.focus();
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(el, val); else el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const emailEl = document.querySelector('#username');
        const passEl  = document.querySelector('#password');
        if (emailEl) typeInto(emailEl, p.linkedinEmail);
        if (passEl)  typeInto(passEl,  p.linkedinPassword);
        document.querySelector('button[type="submit"]')?.click();
      }, [p]);

      await sleep(4000);

      // Handle OTP / verification code if LinkedIn sent one by email
      await handleOtpIfPresent(tab.id, 'linkedin');
      await sleep(2000);

      const loginUrl = await exec(tab.id, () => window.location.href);
      log('LinkedIn post-login URL: ' + loginUrl);

      if (loginUrl.includes('/login') || loginUrl.includes('/checkpoint')) {
        await closeBgTab(tab);
        return { success: false, reason: 'LinkedIn login failed — check credentials or 2FA required' };
      }

      // Navigate back to job
      await chrome.tabs.update(tab.id, { url });
      await waitForLoad(tab.id);
      await sleep(3000);

      pageState = await exec(tab.id, () => {
        const btn = Array.from(document.querySelectorAll('button'))
          .find(b => /easy apply/i.test(b.textContent) && b.offsetParent !== null);
        return btn ? 'HAS_EASY_APPLY' : 'NO_EASY_APPLY_AFTER_LOGIN';
      });
      log('LinkedIn post-login page state: ' + pageState);
    }

    if (pageState === 'CLOSED' || !pageState.startsWith('HAS')) {
      await closeBgTab(tab);
      return { success: false, reason: 'LinkedIn: ' + pageState };
    }

    // Click Easy Apply
    await exec(tab.id, () => {
      Array.from(document.querySelectorAll('button'))
        .find(b => /easy apply/i.test(b.textContent) && b.offsetParent !== null)?.click();
    });
    log('Clicked LinkedIn Easy Apply — waiting for modal…');
    await sleep(3000);

    // Multi-step loop (max 10 steps)
    for (let step = 0; step < 10; step++) {
      const stepResult = await exec(tab.id, (p) => {
        if (/application was sent|successfully applied/i.test(document.body.innerText))
          return 'confirmed';

        function set(el, val) {
          if (!el || !val) return;
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, val); else el.value = val;
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }

        const [first, ...rest] = (p.name || '').split(' ');
        const firstEl = document.querySelector('input[id*="firstName"], input[id*="first-name"]');
        const lastEl  = document.querySelector('input[id*="lastName"],  input[id*="last-name"]');
        const phoneEl = document.querySelector('input[id*="phoneNumber"], input[id*="phone"]');
        if (firstEl && !firstEl.value) set(firstEl, first);
        if (lastEl  && !lastEl.value)  set(lastEl,  rest.join(' ') || first);
        if (phoneEl && !phoneEl.value) set(phoneEl, p.phone);

        const coverEl = document.querySelector('textarea[id*="cover"], textarea');
        if (coverEl && !coverEl.value && p.coverLetter) set(coverEl, p.coverLetter);

        // CV upload
        const fileInput = document.querySelector('input[type="file"]');
        if (fileInput && p.cvBase64) {
          try {
            const mime = p.cvMime || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
            const byteStr = atob(p.cvBase64.split(',')[1]);
            const ab = new ArrayBuffer(byteStr.length);
            const ia = new Uint8Array(ab);
            for (let i = 0; i < byteStr.length; i++) ia[i] = byteStr.charCodeAt(i);
            const file = new File([new Blob([ab], { type: mime })], p.cvName || 'cv.docx', { type: mime });
            const dt = new DataTransfer(); dt.items.add(file);
            fileInput.files = dt.files;
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          } catch (_) {}
        }

        // Auto-answer dropdowns (select Yes where available)
        Array.from(document.querySelectorAll('select')).filter(s => !s.value && s.offsetParent).forEach(sel => {
          const yesOpt = Array.from(sel.options).find(o => /yes|true/i.test(o.text));
          const opt = yesOpt || sel.options[1];
          if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
        });
        // Auto-answer radios
        Array.from(document.querySelectorAll('input[type="radio"]'))
          .filter(r => r.offsetParent && !document.querySelector(`input[name="${r.name}"]:checked`))
          .forEach(r => { if (/yes|true/i.test(r.value || r.labels?.[0]?.textContent || '')) r.click(); });
        // Fill blank numeric fields with 5
        Array.from(document.querySelectorAll('input[type="number"]'))
          .filter(el => el.offsetParent && !el.value)
          .forEach(el => set(el, '5'));

        const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent && !b.disabled);
        const btn = btns.find(b => /submit application/i.test(b.textContent))
          || btns.find(b => /review/i.test(b.textContent))
          || btns.find(b => /^(next|continue)$/i.test(b.textContent.trim()));
        if (btn) { btn.click(); return 'clicked: ' + btn.textContent.trim(); }
        return 'no-btn';
      }, [p]);

      log(`LinkedIn step ${step + 1}: ${stepResult}`);
      if (stepResult === 'confirmed' || stepResult === 'no-btn') break;
      await sleep(2500);
    }

    await sleep(3000);
    const confirmed = await exec(tab.id, () =>
      /application was sent|successfully applied/i.test(document.body.innerText));
    log('LinkedIn confirmation: ' + confirmed);
    await closeBgTab(tab);
    return { success: !!confirmed, reason: confirmed ? '' : 'No confirmation detected' };

  } catch (e) {
    try { await closeBgTab(tab); } catch (_) {}
    return { success: false, reason: e.message };
  } finally { state.activeTabId = null; }
}


// ── Workable Apply ────────────────────────────────────────────────────────────

async function applyWorkable(url, p) {
  const applyUrl = url.includes('/apply') ? url : url.replace(/\/?$/, '/apply');
  const tab = await createBgTab(applyUrl);
  state.activeTabId = tab.id;
  try {
    await waitForLoad(tab.id);
    await sleep(3000);

    for (let step = 0; step < 6; step++) {
      const stepResult = await exec(tab.id, (p) => {
        if (/thank you|application.*received|successfully submitted/i.test(document.body.innerText))
          return 'confirmed';

        function set(el, val) {
          if (!el || !val) return;
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, val); else el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }

        const [first, ...rest] = (p.name || '').split(' ');
        set(document.querySelector('input[name="firstname"], input[id*="first"]'), first);
        set(document.querySelector('input[name="lastname"],  input[id*="last"]'),  rest.join(' ') || first);
        set(document.querySelector('input[name="email"],     input[type="email"]'), p.email);
        set(document.querySelector('input[name="phone"],     input[type="tel"]'),   p.phone);

        const coverEl = document.querySelector('textarea[name*="cover"], textarea[id*="cover"], textarea');
        if (coverEl && !coverEl.value && p.coverLetter) set(coverEl, p.coverLetter);

        const fileInput = document.querySelector('input[type="file"]');
        if (fileInput && p.cvBase64) {
          try {
            const mime = p.cvMime || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
            const byteStr = atob(p.cvBase64.split(',')[1]);
            const ab = new ArrayBuffer(byteStr.length);
            const ia = new Uint8Array(ab);
            for (let i = 0; i < byteStr.length; i++) ia[i] = byteStr.charCodeAt(i);
            const file = new File([new Blob([ab], { type: mime })], p.cvName || 'cv.docx', { type: mime });
            const dt = new DataTransfer(); dt.items.add(file);
            fileInput.files = dt.files;
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          } catch (_) {}
        }

        const allBtns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null);
        const btn = allBtns.find(b => /submit|apply/i.test(b.textContent))
          || allBtns.find(b => /next|continue/i.test(b.textContent));
        if (btn) { btn.click(); return 'clicked: ' + btn.textContent.trim(); }
        return 'no-btn';
      }, [p]);

      log(`Workable step ${step + 1}: ${stepResult}`);
      if (stepResult === 'confirmed' || stepResult === 'no-btn') break;
      await sleep(3000);
      await waitForLoad(tab.id);
    }

    const confirmed = await exec(tab.id, () =>
      /thank you|application.*received|successfully submitted/i.test(document.body.innerText));
    await closeBgTab(tab);
    return { success: !!confirmed, reason: confirmed ? '' : 'No confirmation on Workable' };

  } catch (e) {
    try { await closeBgTab(tab); } catch (_) {}
    return { success: false, reason: e.message };
  } finally { state.activeTabId = null; }
}


// ── Ashby Apply ───────────────────────────────────────────────────────────────

async function applyAshby(url, p) {
  const applyUrl = url.includes('/application') ? url : url.replace(/\/?$/, '/application');
  const tab = await createBgTab(applyUrl);
  state.activeTabId = tab.id;
  try {
    await waitForLoad(tab.id);
    await sleep(3000);

    const fillResult = await exec(tab.id, (p) => {
      function set(el, val) {
        if (!el || !val) return false;
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, val); else el.value = val;
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      const [first, ...rest] = (p.name || '').split(' ');
      const r = {};
      r.firstName = set(document.querySelector('input[name="firstName"], input[placeholder*="First" i]'), first);
      r.lastName  = set(document.querySelector('input[name="lastName"],  input[placeholder*="Last" i]'),  rest.join(' ') || first);
      r.email     = set(document.querySelector('input[name="email"],     input[type="email"]'), p.email);
      r.phone     = set(document.querySelector('input[name="phone"],     input[type="tel"]'),   p.phone);
      const coverEl = document.querySelector('textarea[name*="cover"], textarea[placeholder*="cover" i], textarea');
      if (coverEl && p.coverLetter) { set(coverEl, p.coverLetter); r.cover = true; }
      const fileInput = document.querySelector('input[type="file"]');
      if (fileInput && p.cvBase64) {
        try {
          const mime = p.cvMime || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
          const byteStr = atob(p.cvBase64.split(',')[1]);
          const ab = new ArrayBuffer(byteStr.length);
          const ia = new Uint8Array(ab);
          for (let i = 0; i < byteStr.length; i++) ia[i] = byteStr.charCodeAt(i);
          const file = new File([new Blob([ab], { type: mime })], p.cvName || 'cv.docx', { type: mime });
          const dt = new DataTransfer(); dt.items.add(file);
          fileInput.files = dt.files;
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          r.cv = true;
        } catch (e) { r.cvError = e.message; }
      }
      return r;
    }, [p]);
    log('Ashby fill: ' + JSON.stringify(fillResult));

    await sleep(1500);
    const submitted = await exec(tab.id, () => {
      const btn = Array.from(document.querySelectorAll('button'))
        .filter(b => b.offsetParent !== null)
        .find(b => /submit|apply/i.test(b.textContent));
      if (btn) { btn.click(); return 'clicked: ' + btn.textContent.trim(); }
      return 'NOT_FOUND';
    });
    log('Ashby submit: ' + submitted);

    if (submitted === 'NOT_FOUND') {
      await closeBgTab(tab);
      return { success: false, reason: 'Ashby submit button not found' };
    }

    await sleep(4000);
    const confirmed = await exec(tab.id, () =>
      /thank you|application.*received|successfully submitted/i.test(document.body.innerText));
    await closeBgTab(tab);
    return { success: !!confirmed, reason: confirmed ? '' : 'No confirmation on Ashby' };

  } catch (e) {
    try { await closeBgTab(tab); } catch (_) {}
    return { success: false, reason: e.message };
  } finally { state.activeTabId = null; }
}


// ── Greenhouse Apply ──────────────────────────────────────────────────────────

async function applyGreenhouse(url, p) {
  const tab = await createBgTab(url);
  state.activeTabId = tab.id;
  try {
    await waitForLoad(tab.id);
    await sleep(3000);

    // Check for CAPTCHA
    const hasCaptcha = await exec(tab.id, () => !!document.querySelector('iframe[src*="recaptcha"], .g-recaptcha'));
    if (hasCaptcha) {
      await closeBgTab(tab);
      return { success: false, reason: 'CAPTCHA detected on Greenhouse' };
    }

    // Fill form
    await exec(tab.id, (p) => {
      function set(el, val) {
        if (!el || !val) return;
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const s = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (s) s.call(el, val); else el.value = val;
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const [first, ...rest] = p.name.split(' ');
      set(document.querySelector('#first_name, input[name="first_name"]'), first);
      set(document.querySelector('#last_name,  input[name="last_name"]'),  rest.join(' ') || first);
      set(document.querySelector('#email, input[name="email"], input[type="email"]'), p.email);
      set(document.querySelector('#phone, input[name="phone"], input[type="tel"]'),   p.phone);

      const coverEl = document.querySelector('#cover_letter_text, textarea[name="cover_letter"], textarea');
      if (coverEl) set(coverEl, p.coverLetter);

      const fileInput = document.querySelector('#resume, input[name="resume"], input[type="file"]');
      if (fileInput && p.cvBase64) {
        try {
          const byteStr = atob(p.cvBase64.split(',')[1]);
          const ab = new ArrayBuffer(byteStr.length);
          const ia = new Uint8Array(ab);
          for (let i = 0; i < byteStr.length; i++) ia[i] = byteStr.charCodeAt(i);
          const blob = new Blob([ab], { type: p.cvMime });
          const file = new File([blob], p.cvName, { type: p.cvMime });
          const dt = new DataTransfer();
          dt.items.add(file);
          fileInput.files = dt.files;
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (_) {}
      }
    }, [p]);

    await sleep(1500);

    const submitted = await exec(tab.id, () => {
      const btn = document.querySelector('#submit_app, button[type="submit"], input[type="submit"]');
      if (!btn) return 'NOT_FOUND';
      btn.click();
      return 'clicked';
    });

    if (submitted === 'NOT_FOUND') {
      await closeBgTab(tab);
      return { success: false, reason: 'Greenhouse submit button not found' };
    }

    await sleep(4000);
    const confirmed = await exec(tab.id, () => /thank you|application received|successfully/i.test(document.body.innerText));
    await closeBgTab(tab);
    return { success: !!confirmed, reason: confirmed ? '' : 'No confirmation page' };

  } catch (e) {
    try { await closeBgTab(tab); } catch (_) {}
    return { success: false, reason: e.message };
  } finally {
    state.activeTabId = null;
  }
}


// ── Lever Apply ───────────────────────────────────────────────────────────────

async function applyLever(url, p) {
  const tab = await createBgTab(url);
  state.activeTabId = tab.id;
  try {
    await waitForLoad(tab.id);
    await sleep(3000);

    await exec(tab.id, (p) => {
      function set(el, val) {
        if (!el || !val) return;
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (s) s.call(el, val); else el.value = val;
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      set(document.querySelector('input[name="name"]'),  p.name);
      set(document.querySelector('input[name="email"]'), p.email);
      set(document.querySelector('input[name="phone"]'), p.phone);
      const ta = document.querySelector('textarea[name="comments"], textarea');
      if (ta) { ta.value = p.coverLetter; ta.dispatchEvent(new Event('input', { bubbles: true })); }
    }, [p]);

    await sleep(1000);
    const submitted = await exec(tab.id, () => {
      const btn = document.querySelector('button[type="submit"]');
      if (!btn) return 'NOT_FOUND';
      btn.click();
      return 'clicked';
    });

    await sleep(3000);
    const confirmed = await exec(tab.id, () => /thank you|application received/i.test(document.body.innerText));
    await closeBgTab(tab);
    return { success: !!confirmed, reason: submitted === 'NOT_FOUND' ? 'Submit not found' : '' };

  } catch (e) {
    try { await closeBgTab(tab); } catch (_) {}
    return { success: false, reason: e.message };
  } finally {
    state.activeTabId = null;
  }
}


// ── Indeed Easy Apply ─────────────────────────────────────────────────────────

async function applyIndeed(url, p) {
  const tab = await createBgTab(url);
  state.activeTabId = tab.id;
  try {
    await waitForLoad(tab.id);
    await sleep(3000);

    // Dismiss cookies banner if present
    await exec(tab.id, () => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find(b => /accept|accept all/i.test(b.textContent));
      if (btn) btn.click();
    });
    await sleep(1000);

    // Check page is a job listing (not login wall)
    const pageState = await exec(tab.id, () => {
      if (/sign in|log in/i.test(document.title) && window.location.href.includes('login')) return 'LOGIN_WALL';
      if (/no longer available|job expired/i.test(document.body.innerText)) return 'EXPIRED';
      const btn = document.querySelector(
        'button[data-testid="jobsearch-IndeedApplyButton-newDesignButton"], ' +
        'button[id*="apply"], span[data-testid*="apply"] button, ' +
        '[class*="ia-IndeedApplyButton"], button[class*="applyButton"]'
      );
      if (btn) return 'HAS_APPLY:' + btn.textContent.trim().slice(0, 30);
      return 'NO_APPLY — ' + document.title.slice(0, 50);
    });
    log('Indeed page state: ' + pageState);

    if (pageState === 'LOGIN_WALL') {
      if (!p.indeedEmail || !p.indeedPassword) {
        await closeBgTab(tab);
        return { success: false, reason: 'Indeed: no credentials configured in profile' };
      }
      log('Logging into Indeed…');
      await chrome.tabs.update(tab.id, { url: 'https://secure.indeed.com/auth?hl=en_GB&co=GB' });
      await waitForLoad(tab.id);
      await sleep(3000);

      // Solve CAPTCHA if Cloudflare/hCaptcha is blocking the login page
      const captchaSolved = await solveCaptchaIfPresent(tab.id, p.twocaptchaKey);
      if (captchaSolved) { await sleep(3000); await waitForLoad(tab.id); await sleep(2000); }

      // Email step
      const emailStep = await exec(tab.id, (p) => {
        function typeInto(el, val) {
          el.focus();
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(el, val); else el.value = val;
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const emailEl = document.querySelector('#login-email-input, input[type="email"]');
        if (!emailEl) return 'NO_EMAIL_FIELD — title: ' + document.title;
        typeInto(emailEl, p.indeedEmail);
        const btn = document.querySelector('button[type="submit"]') ||
                    Array.from(document.querySelectorAll('button')).find(b => /continue|sign in/i.test(b.textContent));
        if (btn) btn.click();
        return 'email-submitted';
      }, [p]);
      log('Indeed email step: ' + emailStep);
      await sleep(3000);

      // Password step
      const passStep = await exec(tab.id, (p) => {
        function typeInto(el, val) {
          el.focus();
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(el, val); else el.value = val;
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const passEl = document.querySelector('#login-password-input, input[type="password"]');
        if (!passEl) return 'NO_PASS_FIELD — title: ' + document.title;
        typeInto(passEl, p.indeedPassword);
        const btn = document.querySelector('button[type="submit"]') ||
                    Array.from(document.querySelectorAll('button')).find(b => /sign in|continue/i.test(b.textContent));
        if (btn) btn.click();
        return 'password-submitted';
      }, [p]);
      log('Indeed pass step: ' + passStep);
      await sleep(4000);

      // Handle OTP if Indeed sent an email verification code
      await handleOtpIfPresent(tab.id, 'indeed');
      await sleep(2000);

      const postLoginUrl = await exec(tab.id, () => window.location.href);
      log('Indeed post-login URL: ' + postLoginUrl);
      if (postLoginUrl.includes('/auth') || postLoginUrl.includes('/login')) {
        await closeBgTab(tab);
        return { success: false, reason: 'Indeed login failed — check credentials or 2FA' };
      }

      // Navigate back to job
      await chrome.tabs.update(tab.id, { url });
      await waitForLoad(tab.id);
      await sleep(3000);
    }
    if (pageState === 'EXPIRED') {
      await closeBgTab(tab);
      return { success: false, reason: 'Job no longer available' };
    }

    // Click the Apply / Easily Apply button
    await exec(tab.id, () => {
      const btn = document.querySelector(
        'button[data-testid="jobsearch-IndeedApplyButton-newDesignButton"], ' +
        'button[id*="apply"], span[data-testid*="apply"] button, ' +
        '[class*="ia-IndeedApplyButton"], button[class*="applyButton"]'
      ) || Array.from(document.querySelectorAll('button'))
             .find(b => /apply now|easily apply|apply/i.test(b.textContent.trim()) && b.offsetParent !== null);
      if (btn) btn.click();
    });
    log('Clicked Indeed Apply button — waiting for drawer…');
    await sleep(3000);

    // Indeed multi-step application drawer — loop up to 10 steps
    let step = 0;
    const maxSteps = 10;
    let applied = false;

    while (step < maxSteps && !applied) {
      step++;
      log(`Indeed step ${step}…`);

      // Check for confirmation
      const confirmed = await exec(tab.id, () => {
        return !!(
          document.querySelector('[data-testid="postApply-thankYou"]') ||
          /application submitted|application sent|you have applied/i.test(document.body.innerText)
        );
      });
      if (confirmed) { applied = true; break; }

      // Fill any visible text fields
      await exec(tab.id, (p) => {
        function set(el, val) {
          if (!el || !val) return;
          const tag = el.tagName;
          const proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, val); else el.value = val;
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        // Name fields
        set(document.querySelector('input[name="applicant.name.first"], input[id*="first"][id*="ame"]'), p.name.split(' ')[0]);
        set(document.querySelector('input[name="applicant.name.last"],  input[id*="last"][id*="ame"]'),  p.name.split(' ').slice(1).join(' '));
        // Phone
        set(document.querySelector('input[name="applicant.phoneNumber"], input[type="tel"], input[id*="phone"]'), p.phone);
      }, [p]);

      // Upload CV if file input is present
      const cvUploaded = await exec(tab.id, (p) => {
        const fileInput = document.querySelector('input[type="file"]');
        if (!fileInput || !p.cvBase64) return false;
        try {
          const byteStr = atob(p.cvBase64.split(',')[1]);
          const ab = new ArrayBuffer(byteStr.length);
          const ia = new Uint8Array(ab);
          for (let i = 0; i < byteStr.length; i++) ia[i] = byteStr.charCodeAt(i);
          const blob = new Blob([ab], { type: p.cvMime });
          const file = new File([blob], p.cvName, { type: p.cvMime });
          const dt = new DataTransfer();
          dt.items.add(file);
          fileInput.files = dt.files;
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        } catch (e) { return false; }
      }, [p]);
      if (cvUploaded) { log('CV uploaded on step ' + step); await sleep(1500); }

      // Click "Yes" on any work authorisation / radio questions
      await exec(tab.id, () => {
        document.querySelectorAll('input[type="radio"][value="Yes"], input[type="radio"][value="yes"]')
          .forEach(r => { if (!r.checked) r.click(); });
        // Also look for Yes labels
        Array.from(document.querySelectorAll('label'))
          .filter(l => /^yes$/i.test(l.textContent.trim()))
          .forEach(l => { const inp = l.querySelector('input') || document.getElementById(l.htmlFor); if (inp) inp.click(); });
      });

      // Fill numeric experience fields with 5 if empty
      await exec(tab.id, () => {
        document.querySelectorAll('input[type="number"], input[inputmode="numeric"]').forEach(el => {
          if (!el.value) { el.value = '5'; el.dispatchEvent(new Event('input', { bubbles: true })); }
        });
      });

      await sleep(500);

      // Click Continue / Next / Submit
      const clicked = await exec(tab.id, () => {
        const btn = document.querySelector(
          'button[data-testid="continue-button"], ' +
          'button[data-testid="submit-button"], ' +
          'button[data-testid="ia-continueButton"]'
        ) || Array.from(document.querySelectorAll('button'))
               .find(b => /continue|next|submit application|submit/i.test(b.textContent.trim()) && b.offsetParent !== null && !b.disabled);
        if (!btn) return 'NO_BUTTON';
        const text = btn.textContent.trim();
        btn.click();
        return text;
      });
      log('Clicked: ' + clicked);

      if (clicked === 'NO_BUTTON') { log('No next button — stopping'); break; }
      await sleep(2500);
    }

    // Final confirmation check
    if (!applied) {
      applied = !!(await exec(tab.id, () =>
        document.querySelector('[data-testid="postApply-thankYou"]') ||
        /application submitted|application sent|you have applied/i.test(document.body.innerText)
      ));
    }

    await closeBgTab(tab);
    return { success: applied, reason: applied ? '' : 'No confirmation detected after ' + step + ' steps' };

  } catch (e) {
    try { await closeBgTab(tab); } catch (_) {}
    return { success: false, reason: e.message };
  } finally {
    state.activeTabId = null;
  }
}


// ── Totaljobs Apply ───────────────────────────────────────────────────────────

async function applyTotaljobs(url, p) {
  const tab = await createBgTab(url);
  state.activeTabId = tab.id;
  try {
    await waitForLoad(tab.id);
    await sleep(3000);

    // Dismiss cookies
    await exec(tab.id, () => {
      const btn = document.querySelector('#ccmgt_explicit_accept') ||
                  Array.from(document.querySelectorAll('button')).find(b => /accept all|accept cookies/i.test(b.textContent));
      if (btn) btn.click();
    });
    await sleep(1000);

    // Check page state
    const pageState = await exec(tab.id, () => {
      if (/this job is no longer available|expired/i.test(document.body.innerText)) return 'EXPIRED';
      const btn = document.querySelector(
        'a[data-automation="btn-apply"], a[data-ga-event*="apply"], ' +
        'button[data-automation="btn-apply"], [class*="apply-button"]'
      ) || Array.from(document.querySelectorAll('a, button'))
             .find(el => /quick apply|apply now|apply$/i.test(el.textContent.trim()) && el.offsetParent !== null);
      if (btn) return 'HAS_APPLY:' + btn.textContent.trim().slice(0, 30);
      return 'NO_APPLY — ' + document.title.slice(0, 50);
    });
    log('Totaljobs page state: ' + pageState);

    if (pageState === 'EXPIRED') {
      await closeBgTab(tab);
      return { success: false, reason: 'Job no longer available' };
    }

    // Click Apply / Quick Apply button
    await exec(tab.id, () => {
      const btn = document.querySelector(
        'a[data-automation="btn-apply"], a[data-ga-event*="apply"], ' +
        'button[data-automation="btn-apply"], [class*="apply-button"]'
      ) || Array.from(document.querySelectorAll('a, button'))
             .find(el => /quick apply|apply now|apply$/i.test(el.textContent.trim()) && el.offsetParent !== null);
      if (btn) btn.click();
    });
    log('Clicked Totaljobs Apply — waiting for form…');
    await sleep(4000);
    await waitForLoad(tab.id);
    await sleep(2000);

    // Multi-step or single form — loop up to 8 steps
    let step = 0;
    const maxSteps = 8;
    let applied = false;

    while (step < maxSteps && !applied) {
      step++;
      log(`Totaljobs step ${step}…`);

      // Check for confirmation
      const confirmed = await exec(tab.id, () => {
        return !!(
          document.querySelector('.application-confirmation, [class*="confirmationPage"]') ||
          /application sent|successfully applied|thank you for applying/i.test(document.body.innerText)
        );
      });
      if (confirmed) { applied = true; break; }

      // Fill text fields
      await exec(tab.id, (p) => {
        function set(el, val) {
          if (!el || !val) return;
          const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, val); else el.value = val;
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        set(document.querySelector('input[name*="firstName"], input[id*="firstName"]'), p.name.split(' ')[0]);
        set(document.querySelector('input[name*="lastName"],  input[id*="lastName"]'),  p.name.split(' ').slice(1).join(' '));
        set(document.querySelector('input[type="email"], input[name*="email"]'), p.email);
        set(document.querySelector('input[type="tel"], input[name*="phone"], input[id*="phone"]'), p.phone);
        const coverEl = document.querySelector('textarea[name*="coverLetter"], textarea[id*="cover"], textarea[name*="message"]');
        if (coverEl) set(coverEl, p.coverLetter);
      }, [p]);

      // Upload CV
      const cvUploaded = await exec(tab.id, (p) => {
        const fileInput = document.querySelector(
          'input[type="file"][name*="cv"], input[type="file"][accept*=".doc"], input[type="file"]'
        );
        if (!fileInput || !p.cvBase64) return false;
        try {
          const byteStr = atob(p.cvBase64.split(',')[1]);
          const ab = new ArrayBuffer(byteStr.length);
          const ia = new Uint8Array(ab);
          for (let i = 0; i < byteStr.length; i++) ia[i] = byteStr.charCodeAt(i);
          const blob = new Blob([ab], { type: p.cvMime });
          const file = new File([blob], p.cvName, { type: p.cvMime });
          const dt = new DataTransfer();
          dt.items.add(file);
          fileInput.files = dt.files;
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        } catch (e) { return false; }
      }, [p]);
      if (cvUploaded) { log('CV uploaded on step ' + step); await sleep(1500); }

      await sleep(500);

      // Click Continue / Next / Send application
      const clicked = await exec(tab.id, () => {
        const btn = document.querySelector(
          'button[type="submit"], input[type="submit"], ' +
          '[data-automation="btn-submit"], [data-automation="btn-next"]'
        ) || Array.from(document.querySelectorAll('button, input[type="submit"]'))
               .find(b => /send application|continue|next|submit/i.test((b.textContent || b.value || '').trim()) &&
                          b.offsetParent !== null && !b.disabled);
        if (!btn) return 'NO_BUTTON';
        const text = (btn.textContent || btn.value || '').trim();
        btn.click();
        return text;
      });
      log('Clicked: ' + clicked);

      if (clicked === 'NO_BUTTON') { log('No next button — stopping'); break; }
      await waitForLoad(tab.id);
      await sleep(2500);
    }

    // Final confirmation check
    if (!applied) {
      applied = !!(await exec(tab.id, () =>
        document.querySelector('.application-confirmation, [class*="confirmationPage"]') ||
        /application sent|successfully applied|thank you for applying/i.test(document.body.innerText)
      ));
    }

    await closeBgTab(tab);
    return { success: applied, reason: applied ? '' : 'No confirmation detected after ' + step + ' steps' };

  } catch (e) {
    try { await closeBgTab(tab); } catch (_) {}
    return { success: false, reason: e.message };
  } finally {
    state.activeTabId = null;
  }
}


// ── IMAP OTP reader ───────────────────────────────────────────────────────────
// If a tab shows an OTP/verification-code input after login, polls /api/read_otp
// and injects the code + submits. Returns true if OTP was found and injected.

async function handleOtpIfPresent(tabId, fromPlatform) {
  // Detect OTP input on the current page
  const hasOtp = await exec(tabId, () => {
    const inp = document.querySelector(
      'input[name*="otp"], input[name*="code"], input[id*="otp"], input[id*="code"], ' +
      'input[inputmode="numeric"], input[autocomplete="one-time-code"]'
    );
    if (inp && inp.offsetParent !== null) return true;
    // Also check page text for OTP prompts
    return /verification code|one-time code|check your email|enter the code|sent you a code/i
      .test(document.body.innerText.slice(0, 1000));
  });

  if (!hasOtp) return false;
  log(`OTP input detected on ${fromPlatform} — polling server for code…`);

  // Poll /api/read_otp up to 12 times at 5s intervals (60s total)
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    try {
      const resp = await fetch(
        `${state.serverUrl}/api/read_otp?from=${encodeURIComponent(fromPlatform)}`,
        { headers: { 'X-API-Key': state.apiKey } }
      );
      const data = await resp.json();
      if (data.code) {
        log(`OTP received: ${data.code} — injecting…`);
        const injected = await exec(tabId, (code) => {
          const inp = document.querySelector(
            'input[name*="otp"], input[name*="code"], input[id*="otp"], input[id*="code"], ' +
            'input[inputmode="numeric"], input[autocomplete="one-time-code"]'
          );
          if (!inp) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(inp, code); else inp.value = code;
          inp.dispatchEvent(new Event('input',  { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          // Submit
          const btn = document.querySelector('button[type="submit"]')
            || Array.from(document.querySelectorAll('button'))
                     .find(b => /verify|continue|submit|confirm/i.test(b.textContent) && b.offsetParent !== null);
          if (btn) btn.click();
          return true;
        }, [data.code]);
        if (injected) { await sleep(4000); return true; }
      }
    } catch (e) {
      log(`OTP poll error: ${e.message}`);
    }
  }
  log(`OTP not found within 60s for ${fromPlatform}`);
  return false;
}


// ── 2captcha solver ───────────────────────────────────────────────────────────
// Detects hCaptcha or Cloudflare Turnstile on a tab and solves via 2captcha API.
// Returns true if solved+injected, false if no CAPTCHA found or solving failed.

async function solveCaptchaIfPresent(tabId, twocaptchaKey) {
  if (!twocaptchaKey) return false;

  const captchaInfo = await exec(tabId, () => {
    const hc = document.querySelector('.h-captcha, iframe[src*="hcaptcha.com"]');
    const cf = document.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare.com"]');
    const el = hc || cf;
    if (!el) return null;
    const sitekey = el.dataset?.sitekey
      || el.querySelector?.('[data-sitekey]')?.dataset?.sitekey
      || null;
    return { type: hc ? 'hcaptcha' : 'turnstile', sitekey, pageUrl: window.location.href };
  });

  if (!captchaInfo || !captchaInfo.sitekey) return false;
  log(`2captcha: detected ${captchaInfo.type}, sitekey=${captchaInfo.sitekey.slice(0, 12)}…`);

  try {
    // Submit to 2captcha
    const method  = captchaInfo.type === 'hcaptcha' ? 'hcaptcha' : 'turnstile';
    const inResp  = await fetch(
      `https://2captcha.com/in.php?key=${twocaptchaKey}&method=${method}` +
      `&sitekey=${captchaInfo.sitekey}&pageurl=${encodeURIComponent(captchaInfo.pageUrl)}&json=1`
    );
    const inData  = await inResp.json();
    if (inData.status !== 1) { log('2captcha submit error: ' + inData.request); return false; }
    const captchaId = inData.request;
    log('2captcha: submitted, id=' + captchaId);

    // Poll for result — up to 120s
    for (let i = 0; i < 24; i++) {
      await sleep(5000);
      const outResp = await fetch(
        `https://2captcha.com/res.php?key=${twocaptchaKey}&action=get&id=${captchaId}&json=1`
      );
      const outData = await outResp.json();
      if (outData.status === 1) {
        const token = outData.request;
        log('2captcha: solved ✓, injecting token…');
        await exec(tabId, (token, type) => {
          // Inject into hidden response fields
          ['h-captcha-response', 'cf-turnstile-response', 'g-recaptcha-response'].forEach(name => {
            document.querySelectorAll(`[name="${name}"], textarea[name="${name}"]`).forEach(el => {
              el.value = token;
              el.dispatchEvent(new Event('change', { bubbles: true }));
            });
          });
          // Call hCaptcha callback if available
          if (type === 'hcaptcha' && window.hcaptcha) {
            try { window.hcaptcha.execute(); } catch (_) {}
          }
          // Cloudflare Turnstile callback
          if (type === 'turnstile' && window.turnstile) {
            try { window.turnstile.execute(); } catch (_) {}
          }
        }, [token, captchaInfo.type]);
        await sleep(2000);
        return true;
      }
      if (outData.request !== 'CAPCHA_NOT_READY') {
        log('2captcha error: ' + outData.request);
        return false;
      }
    }
    log('2captcha: timed out waiting for solution');
  } catch (e) {
    log('2captcha exception: ' + e.message);
  }
  return false;
}


// ── Helpers ───────────────────────────────────────────────────────────────────

// Execute a function in a tab and return the result
async function exec(tabId, func, args = []) {
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    return results?.[0]?.result;
  } catch (e) {
    log('exec error: ' + e.message);
    return null;
  }
}

function waitForLoad(tabId) {
  return new Promise(resolve => {
    function check(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(check);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(check);
    setTimeout(resolve, 20000); // safety
  });
}

async function finishJob(idx, success, notes) {
  const job = state.jobs[idx];
  if (!job) return;
  job._state = success ? 'applied' : 'failed';
  if (success) state.stats.applied++; else state.stats.failed++;
  state.stats.queue = state.jobs.filter(j => j._state === 'pending').length;
  broadcastStatus('running', `Applied: ${state.stats.applied} | Skipped: ${state.stats.failed}`);
  broadcastJobs();

  if (job.row && state.serverUrl) {
    try {
      await fetch(`${state.serverUrl}/api/update_status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': state.apiKey },
        body: JSON.stringify({ row: job.row, status: success ? 'Applied' : 'Needs Review', notes, title: job.title, company: job.company, url: job.url }),
      });
    } catch (_) {}
  }

  state.currentIndex = idx + 1;
  if (state.isRunning && state.jobs.slice(idx + 1).some(j => j._state === 'pending')) {
    await sleep(state.delaySeconds * 1000);
    await processNextJob();
  } else {
    broadcastDone();
  }
}

function broadcastStatus(s, text) {
  state.statusText = text;
  chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', state: s, text, stats: state.stats, jobs: state.jobs }).catch(() => {});
}
function broadcastJobs() {
  chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', state: state.isRunning ? 'running' : 'idle', text: state.statusText, stats: state.stats, jobs: state.jobs }).catch(() => {});
}
function broadcastDone() {
  state.isRunning = false;
  chrome.runtime.sendMessage({ type: 'DONE', stats: state.stats, jobs: state.jobs }).catch(() => {});
}
function log(text, level = 'info') {
  console.log('[AutoApply] ' + text);
  chrome.runtime.sendMessage({ type: 'LOG', text, level }).catch(() => {});
  // Also send to server so we can read logs from terminal
  if (state.serverUrl && state.apiKey) {
    fetch(`${state.serverUrl}/api/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': state.apiKey },
      body: JSON.stringify({ message: text, level }),
    }).catch(() => {});
  }
}

// ── Background tab helpers ────────────────────────────────────────────────────
// Opens each application in a separate MINIMIZED popup window so the user's
// browser is never touched. Content scripts and executeScript work identically
// on minimized windows — the tab is loaded and interactive, just not visible.

async function createBgTab(url) {
  const win = await chrome.windows.create({
    url,
    type: 'popup',
    focused: false,
    state: 'minimized',
  });
  const tab = win.tabs[0];
  tab._bgWinId = win.id;  // stash so closeBgTab can remove the whole window
  return tab;
}

async function closeBgTab(tab) {
  try {
    if (tab && tab._bgWinId) await chrome.windows.remove(tab._bgWinId);
    else if (tab && tab.id)  await chrome.tabs.remove(tab.id);
  } catch (_) {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Session sync ──────────────────────────────────────────────────────────────
// Reads cookies directly from Chrome for each job platform and posts them to
// the server. User just needs to be logged into the site in Chrome — no manual
// export/paste needed.

async function syncSessions(serverUrl, apiKey) {
  const platforms = [
    { key: 'reed',     domains: ['reed.co.uk', 'secure.reed.co.uk'] },
    { key: 'indeed',   domains: ['indeed.com', 'indeed.co.uk', 'secure.indeed.com'] },
    { key: 'linkedin', domains: ['linkedin.com', 'www.linkedin.com'] },
  ];

  const results = {};

  for (const { key, domains } of platforms) {
    // Collect cookies from all domains for this platform
    const allCookies = [];
    for (const domain of domains) {
      try {
        const cookies = await chrome.cookies.getAll({ domain });
        allCookies.push(...cookies);
      } catch (_) {}
    }

    if (allCookies.length === 0) {
      results[key] = { ok: false, reason: 'not logged in' };
      continue;
    }

    // Convert Chrome cookie format → Playwright addCookies format
    const playwrightCookies = allCookies.map(c => ({
      name:     c.name,
      value:    c.value,
      domain:   c.domain,
      path:     c.path,
      expires:  c.expirationDate || -1,
      httpOnly: c.httpOnly,
      secure:   c.secure,
      sameSite: c.sameSite === 'no_restriction' ? 'None'
              : c.sameSite === 'lax'            ? 'Lax'
              : c.sameSite === 'strict'         ? 'Strict'
              : 'None',
    }));

    try {
      const fd = new FormData();
      fd.append('platform', key);
      fd.append('cookies', JSON.stringify(playwrightCookies));
      const resp = await fetch(`${serverUrl}/profile/save-session`, {
        method: 'POST',
        headers: { 'X-API-Key': apiKey },
        body: fd,
      });
      const data = await resp.json();
      results[key] = data.ok
        ? { ok: true, count: data.count }
        : { ok: false, reason: data.error || 'server error' };
    } catch (e) {
      results[key] = { ok: false, reason: e.message };
    }
  }

  return results;
}
