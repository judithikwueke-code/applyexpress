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
  return true;
});


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

  // Step 1 — Log into Reed first (one time)
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
  const tab = await chrome.tabs.create({ url: 'https://www.reed.co.uk/', active: true });
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

  try { await chrome.tabs.remove(tab.id); } catch (_) {}
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
  broadcastStatus('running', `Applying: ${job.title} @ ${job.company}`);
  log(`\n--- Job ${idx + 1}: ${job.title} @ ${job.company} ---`);
  log(`URL: ${job.url}`);

  // Load CV and credentials+profile from server (multi-user: no hardcoded values)
  const stored = await chrome.storage.local.get(['cvBase64', 'cvName', 'cvMime']);
  let profile = { firstName: '', lastName: '', email: '', phone: '', location: 'United Kingdom' };
  let reedEmail = '', reedPassword = '';
  try {
    const r = await fetch(`${state.serverUrl}/api/credentials`, { headers: { 'X-API-Key': state.apiKey } });
    const c = await r.json();
    profile      = c.profile      || profile;
    reedEmail    = c.reed?.email    || '';
    reedPassword = c.reed?.password || '';
  } catch (_) {}

  const payload = {
    title:       job.title,
    company:     job.company,
    url:         job.url,
    coverLetter: job.cover_letter || '',
    firstName:   profile.firstName,
    lastName:    profile.lastName,
    name:        `${profile.firstName} ${profile.lastName}`.trim(),
    email:       profile.email,
    phone:       profile.phone,
    location:    profile.location || 'United Kingdom',
    cvBase64:    stored.cvBase64 || '',
    cvName:      stored.cvName   || 'cv.docx',
    cvMime:      stored.cvMime   || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    reedEmail,
    reedPassword,
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
    else result = { success: false, reason: 'Unsupported job site' };
  } catch (e) {
    result = { success: false, reason: 'Exception: ' + e.message };
  }

  log(`Result: ${result.success ? '✓ APPLIED' : '✗ ' + result.reason}`);
  await finishJob(idx, result.success, result.reason || '');
}


// ── Reed Apply ────────────────────────────────────────────────────────────────

async function applyReed(url, p) {
  const tab = await chrome.tabs.create({ url, active: true });
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
      if (/you.ve already applied|already applied|edit.*application|view.*application/i.test(bodyText)) return 'ALREADY_APPLIED';
      // Check if already on apply form
      if (window.location.href.includes('/apply')) return 'ON_APPLY_FORM';
      // Find apply button
      const applyBtn = Array.from(document.querySelectorAll('button, a'))
        .find(el => /apply now|apply for this job|quick apply/i.test(el.textContent.trim()) && el.offsetParent !== null);
      if (applyBtn) return 'HAS_APPLY_BUTTON:' + applyBtn.tagName + ':' + applyBtn.textContent.trim().slice(0, 30);
      return 'NO_APPLY_BUTTON — ' + document.title.slice(0, 50);
    });

    log('Reed page state: ' + pageState);

    if (pageState === 'EXPIRED' || pageState === 'UNAVAILABLE') {
      await chrome.tabs.remove(tab.id);
      return { success: false, reason: pageState };
    }
    if (pageState === 'ALREADY_APPLIED') {
      await chrome.tabs.remove(tab.id);
      return { success: false, reason: 'Already applied to this job' };
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
          await chrome.tabs.remove(tab.id);
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

    // Submit — target button inside modal/dialog only
    await sleep(1000);
    const submitted = await exec(tab.id, () => {
      // First try inside dialog/modal
      const dialog = document.querySelector('[role="dialog"], [role="modal"], .modal, .drawer, [class*="apply"]');
      if (dialog) {
        const btn = dialog.querySelector('button[type="submit"]') ||
                    Array.from(dialog.querySelectorAll('button')).find(b => {
                      const t = b.textContent.trim().toLowerCase();
                      return !t.includes('search') && !t.includes('close') && !t.includes('cancel') &&
                             !t.includes('back') && b.offsetParent !== null;
                    });
        if (btn) { btn.click(); return 'modal-btn: ' + btn.textContent.trim(); }
      }
      // Log all visible buttons so we can debug
      const visible = Array.from(document.querySelectorAll('button'))
        .filter(b => b.offsetParent !== null)
        .map(b => b.textContent.trim().slice(0,25));
      return 'NOT_FOUND — visible buttons: ' + visible.join(' | ');
    });
    log('Submit: ' + submitted);

    if (submitted === 'NOT_FOUND') {
      await chrome.tabs.remove(tab.id);
      return { success: false, reason: 'Submit button not found' };
    }

    await sleep(4000);

    // Check for confirmation
    const confirmed = await exec(tab.id, () => {
      const body = document.body.innerText.toLowerCase();
      if (/application.*sent|thank you|successfully applied|application received/i.test(body)) return true;
      if (document.querySelector('.confirmation, .success, [class*="success"]')) return true;
      return false;
    });

    await chrome.tabs.remove(tab.id);
    return { success: confirmed, reason: confirmed ? '' : 'No confirmation detected — may have submitted' };

  } catch (e) {
    try { await chrome.tabs.remove(tab.id); } catch (_) {}
    return { success: false, reason: e.message };
  } finally {
    state.activeTabId = null;
  }
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

  // Click Continue (email step) — avoid social login buttons
  const emailBtnResult = await exec(tabId, () => {
    const allBtns = Array.from(document.querySelectorAll('button'));
    // Avoid "Continue with Apple/Google" — find plain "Continue" or submit
    const btn = allBtns.find(b => {
      const t = b.textContent.trim().toLowerCase();
      return b.type === 'submit' && !/(apple|google|facebook|twitter|github)/i.test(t);
    }) || allBtns.find(b => {
      const t = b.textContent.trim().toLowerCase();
      return t === 'continue' || t === 'next' || t === 'sign in';
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

  // Click Continue/Sign In for password step
  const passBtnResult = await exec(tabId, () => {
    const allBtns = Array.from(document.querySelectorAll('button'));
    const btn = allBtns.find(b => {
      const t = b.textContent.trim().toLowerCase();
      return b.type === 'submit' && !/(apple|google|facebook|twitter|github)/i.test(t);
    }) || allBtns.find(b => {
      const t = b.textContent.trim().toLowerCase();
      return t === 'continue' || t === 'sign in' || t === 'log in' || t === 'next';
    });
    if (!btn) return 'NO_SUBMIT_BTN';
    btn.click();
    return 'clicked: ' + btn.textContent.trim();
  });
  log('Auth0 pass-step btn: ' + passBtnResult);
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


// ── Greenhouse Apply ──────────────────────────────────────────────────────────

async function applyGreenhouse(url, p) {
  const tab = await chrome.tabs.create({ url, active: true });
  state.activeTabId = tab.id;
  try {
    await waitForLoad(tab.id);
    await sleep(3000);

    // Check for CAPTCHA
    const hasCaptcha = await exec(tab.id, () => !!document.querySelector('iframe[src*="recaptcha"], .g-recaptcha'));
    if (hasCaptcha) {
      await chrome.tabs.remove(tab.id);
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
      await chrome.tabs.remove(tab.id);
      return { success: false, reason: 'Greenhouse submit button not found' };
    }

    await sleep(4000);
    const confirmed = await exec(tab.id, () => /thank you|application received|successfully/i.test(document.body.innerText));
    await chrome.tabs.remove(tab.id);
    return { success: !!confirmed, reason: confirmed ? '' : 'No confirmation page' };

  } catch (e) {
    try { await chrome.tabs.remove(tab.id); } catch (_) {}
    return { success: false, reason: e.message };
  } finally {
    state.activeTabId = null;
  }
}


// ── Lever Apply ───────────────────────────────────────────────────────────────

async function applyLever(url, p) {
  const tab = await chrome.tabs.create({ url, active: true });
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
    await chrome.tabs.remove(tab.id);
    return { success: !!confirmed, reason: submitted === 'NOT_FOUND' ? 'Submit not found' : '' };

  } catch (e) {
    try { await chrome.tabs.remove(tab.id); } catch (_) {}
    return { success: false, reason: e.message };
  } finally {
    state.activeTabId = null;
  }
}


// ── Indeed Easy Apply ─────────────────────────────────────────────────────────

async function applyIndeed(url, p) {
  const tab = await chrome.tabs.create({ url, active: true });
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
      await chrome.tabs.remove(tab.id);
      return { success: false, reason: 'Indeed login required — open indeed.co.uk and log in first' };
    }
    if (pageState === 'EXPIRED') {
      await chrome.tabs.remove(tab.id);
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

    await chrome.tabs.remove(tab.id);
    return { success: applied, reason: applied ? '' : 'No confirmation detected after ' + step + ' steps' };

  } catch (e) {
    try { await chrome.tabs.remove(tab.id); } catch (_) {}
    return { success: false, reason: e.message };
  } finally {
    state.activeTabId = null;
  }
}


// ── LinkedIn Easy Apply ───────────────────────────────────────────────────────

async function applyLinkedIn(url, p) {
  const normUrl = url.replace(/^https?:\/\/[a-z]{2}\.linkedin\.com/, 'https://www.linkedin.com');
  const tab = await chrome.tabs.create({ url: normUrl, active: true });
  state.activeTabId = tab.id;
  try {
    await waitForLoad(tab.id);
    await sleep(3000);

    const pageState = await exec(tab.id, () => {
      if (/authwall|sign.*in/i.test(document.title) || document.querySelector('.authwall-join-form')) return 'LOGIN_WALL';
      if (/no longer available|job not found/i.test(document.body.innerText)) return 'EXPIRED';
      return 'OK';
    });
    if (pageState === 'LOGIN_WALL') {
      await chrome.tabs.remove(tab.id);
      return { success: false, reason: 'LinkedIn: please sign in to LinkedIn in Chrome first' };
    }
    if (pageState === 'EXPIRED') {
      await chrome.tabs.remove(tab.id);
      return { success: false, reason: 'Job no longer available on LinkedIn' };
    }

    // Dismiss cookie banner
    await exec(tab.id, () => {
      document.querySelector('button[action-type="ACCEPT"]')?.click();
    });
    await sleep(1000);

    // Click "Easy Apply" only — never plain "Apply" (external ATS)
    const clicked = await exec(tab.id, () => {
      const btns = Array.from(document.querySelectorAll(
        'button.jobs-apply-button, button[aria-label*="Easy Apply" i]'
      ));
      for (const b of btns) {
        const label = (b.getAttribute('aria-label') || b.textContent || '').toLowerCase();
        if (label.includes('easy apply')) { b.click(); return label; }
      }
      return 'NOT_FOUND';
    });
    if (clicked === 'NOT_FOUND') {
      await chrome.tabs.remove(tab.id);
      return { success: false, reason: 'No Easy Apply button — external ATS, skip' };
    }
    log('LinkedIn Easy Apply clicked: ' + clicked);
    await sleep(2500);

    // Multi-step modal loop
    let step = 0, applied = false;
    while (step < 10 && !applied) {
      step++;
      log(`LinkedIn step ${step}`);

      const confirmed = await exec(tab.id, () =>
        !!(document.querySelector('.jobs-post-apply-thank-you, [data-test-job-apply-success]') ||
           /application submitted|you.ve applied/i.test(document.body.innerText))
      );
      if (confirmed) { applied = true; break; }

      // Fill contact fields — only if empty
      await exec(tab.id, (p) => {
        function setIfEmpty(el, val) {
          if (!el || el.value?.trim()) return;
          const proto = el.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, val); else el.value = val;
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const m = document.querySelector('.jobs-easy-apply-modal, [role="dialog"]');
        if (!m) return;
        setIfEmpty(m.querySelector('input[id*="firstName" i], input[placeholder*="First name" i]'), p.firstName);
        setIfEmpty(m.querySelector('input[id*="lastName" i], input[placeholder*="Last name" i]'),  p.lastName);
        setIfEmpty(m.querySelector('input[type="tel"], input[id*="phone" i]'), p.phone);
        setIfEmpty(m.querySelector('input[id*="city" i], input[placeholder*="City" i]'), p.location);
      }, [p]);

      // CV upload via DataTransfer
      const cvUp = await exec(tab.id, (p) => {
        const m = document.querySelector('.jobs-easy-apply-modal, [role="dialog"]');
        const fi = m?.querySelector('input[type="file"]');
        if (!fi || !p.cvBase64) return false;
        try {
          const src = p.cvBase64.includes(',') ? p.cvBase64.split(',')[1] : p.cvBase64;
          const bin = atob(src), ab = new ArrayBuffer(bin.length), ia = new Uint8Array(ab);
          for (let i = 0; i < bin.length; i++) ia[i] = bin.charCodeAt(i);
          const dt = new DataTransfer();
          dt.items.add(new File([ab], p.cvName, { type: p.cvMime }));
          fi.files = dt.files;
          fi.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        } catch { return false; }
      }, [p]);
      if (cvUp) { log('CV uploaded'); await sleep(2000); }

      // Radio buttons — Yes to work auth, No to sponsorship
      await exec(tab.id, () => {
        const m = document.querySelector('.jobs-easy-apply-modal, [role="dialog"]');
        m?.querySelectorAll('fieldset').forEach(fs => {
          const leg = (fs.querySelector('legend, span[class*="label"]')?.innerText || '').toLowerCase();
          const wantNo = /sponsor|visa/i.test(leg);
          const target = wantNo ? /^no$/i : /^yes$/i;
          const lbl = Array.from(fs.querySelectorAll('label')).find(l => target.test(l.textContent.trim()));
          (lbl?.querySelector('input') || document.getElementById(lbl?.htmlFor))?.click();
        });
      });

      // Dropdowns — pick first valid option
      await exec(tab.id, () => {
        const m = document.querySelector('.jobs-easy-apply-modal, [role="dialog"]');
        m?.querySelectorAll('select').forEach(sel => {
          if (sel.value && !/select|choose|please/i.test(sel.options[sel.selectedIndex]?.text || '')) return;
          const opt = Array.from(sel.options).find(o => o.value && !/select|choose|please/i.test(o.text));
          if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
        });
      });

      // Text / textarea screening questions
      await exec(tab.id, (p) => {
        function setIfEmpty(el, val) {
          if (!el || el.value?.trim()) return;
          const proto = el.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, val); else el.value = val;
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const m = document.querySelector('.jobs-easy-apply-modal, [role="dialog"]');
        if (!m) return;
        m.querySelectorAll('input[type="text"]:not([readonly]), input[type="number"]:not([readonly]), textarea:not([readonly])').forEach(el => {
          if (el.value?.trim()) return;
          const lbl = (document.querySelector(`label[for="${el.id}"]`)?.innerText || el.placeholder || '').toLowerCase();
          let val = '5';
          if (/cover|why|motivat/i.test(lbl) && p.coverLetter) val = p.coverLetter;
          else if (/salary|compensat/i.test(lbl)) val = '50000';
          else if (/notice|availab/i.test(lbl)) val = '1 month';
          else if (/years|experience/i.test(lbl)) val = '10';
          setIfEmpty(el, val);
        });
      }, [p]);

      await sleep(500);

      // Click Next / Review / Submit
      const btn = await exec(tab.id, () => {
        const m = document.querySelector('.jobs-easy-apply-modal, [role="dialog"]');
        if (!m) return 'NO_MODAL';
        const b = m.querySelector(
          'button[aria-label*="Submit application" i], button[aria-label*="Continue to next step" i], ' +
          'button[aria-label*="Review your application" i], button[aria-label*="Next" i]'
        ) || Array.from(m.querySelectorAll('button[type="button"], button[type="submit"]'))
               .filter(b => b.offsetParent && !b.disabled)
               .find(b => /submit|continue|next|review/i.test(b.textContent.trim()));
        if (!b) return 'NO_BUTTON';
        const label = b.getAttribute('aria-label') || b.textContent.trim();
        b.click();
        return label;
      });
      log('LinkedIn btn: ' + btn);
      if (btn === 'NO_BUTTON' || btn === 'NO_MODAL') break;
      await sleep(2500);
    }

    if (!applied) {
      applied = !!(await exec(tab.id, () =>
        document.querySelector('.jobs-post-apply-thank-you, [data-test-job-apply-success]') ||
        /application submitted|you.ve applied/i.test(document.body.innerText)
      ));
    }

    await chrome.tabs.remove(tab.id);
    return { success: applied, reason: applied ? '' : `No confirmation after ${step} steps` };
  } catch (e) {
    try { await chrome.tabs.remove(tab.id); } catch (_) {}
    return { success: false, reason: e.message };
  } finally {
    state.activeTabId = null;
  }
}


// ── Totaljobs Apply ───────────────────────────────────────────────────────────

async function applyTotaljobs(url, p) {
  const tab = await chrome.tabs.create({ url, active: true });
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
      await chrome.tabs.remove(tab.id);
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

    await chrome.tabs.remove(tab.id);
    return { success: applied, reason: applied ? '' : 'No confirmation detected after ' + step + ' steps' };

  } catch (e) {
    try { await chrome.tabs.remove(tab.id); } catch (_) {}
    return { success: false, reason: e.message };
  } finally {
    state.activeTabId = null;
  }
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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
