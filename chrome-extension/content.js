/**
 * content.js — AutoApply Form Filler
 *
 * Runs on Greenhouse, Lever, Reed, Workable, Ashby job pages.
 * Receives FILL_AND_SUBMIT message from background.js, fills all fields, submits.
 *
 * Key capability: uploads CV file directly using DataTransfer (no security restriction
 * when running as a content script in the user's own browser).
 */

// ── Auto-connect: detect /connect/<api_key> page ──────────────────────────────
(function autoConnect() {
  const meta = document.querySelector('meta[name="applyexpress-connect"]');
  if (!meta) return;
  const serverUrl = meta.getAttribute('data-server-url');
  const apiKey    = meta.getAttribute('data-api-key');
  if (!serverUrl || !apiKey) return;

  function showSuccess() {
    // Guard: only replace if we're still on the connect page
    if (!document.querySelector('meta[name="applyexpress-connect"]')) return;
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
  }

  // Chrome MV3 service workers can be dormant — retry up to 4 times if sendMessage
  // fails to wake the background. Show success on first successful response.
  function trySend(attempt) {
    try {
      chrome.runtime.sendMessage({ type: 'CONFIGURE', serverUrl, apiKey }, () => {
        const err = chrome.runtime.lastError;
        if (err) {
          if (attempt < 4) {
            setTimeout(() => trySend(attempt + 1), 1200);
          } else {
            // Show success anyway — token validated by server; extension will pick up
            // config on next alarm tick when the service worker wakes.
            showSuccess();
          }
          return;
        }
        showSuccess();
      });
    } catch (_) {
      if (attempt < 4) setTimeout(() => trySend(attempt + 1), 1200);
      else showSuccess();
    }
  }

  trySend(1);
})();

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'FILL_AND_SUBMIT') {
    fillAndSubmit(msg.payload)
      .then(result => sendResponse(result))
      .catch(err  => sendResponse({ success: false, reason: err.message }));
    return true; // async
  }
});


// ── Main orchestrator ─────────────────────────────────────────────────────────

async function fillAndSubmit(payload) {
  const url = window.location.href;
  log(`Starting form fill on: ${url}`);

  // Dismiss cookie consent banners first
  await dismissCookieBanner();

  // Detect expired / unavailable job page first
  const bodyText = document.body.innerText.toLowerCase();
  if (bodyText.includes('this job has expired') ||
      bodyText.includes('job has expired') ||
      bodyText.includes('no longer available') ||
      bodyText.includes('this role has been filled') ||
      bodyText.includes('position has been closed')) {
    return { success: false, reason: 'Job has expired or is no longer available' };
  }

  // Detect CAPTCHA before doing anything
  if (hasCaptcha()) {
    return { success: false, reason: 'CAPTCHA detected — cannot auto-submit' };
  }

  // Route to ATS-specific handler
  if (url.includes('greenhouse.io') || url.includes('boards.greenhouse.io')) {
    return await fillGreenhouse(payload);
  }
  if (url.includes('lever.co')) {
    return await fillLever(payload);
  }
  if (url.includes('reed.co.uk')) {
    return await fillReed(payload);
  }
  if (url.includes('workable.com')) {
    return await fillWorkable(payload);
  }
  if (url.includes('ashbyhq.com')) {
    return await fillAshby(payload);
  }

  // Generic fallback
  return await fillGeneric(payload);
}


// ── Greenhouse ────────────────────────────────────────────────────────────────

async function fillGreenhouse(payload) {
  log('ATS: Greenhouse');

  // Wait for the application form
  await waitFor('#application-form, form[action*="apply"], .application-form', 15000);

  // Detect redirect to expired/listing page
  if (document.querySelector('.jobs-container, .job-list, [data-view="job-list"]')) {
    return { success: false, reason: 'Job expired or redirected to listing page' };
  }

  // Check for CAPTCHA again after page fully loads
  if (hasCaptcha()) {
    return { success: false, reason: 'CAPTCHA detected on Greenhouse form' };
  }

  // Fill name fields
  await fillField(['#first_name', 'input[name="first_name"]', 'input[id*="first"][id*="name"]'],
    payload.name.split(' ')[0]);
  await fillField(['#last_name', 'input[name="last_name"]', 'input[id*="last"][id*="name"]'],
    payload.name.split(' ').slice(1).join(' ') || payload.name);

  // Email and phone
  await fillField(['#email', 'input[name="email"]', 'input[type="email"]'], payload.email);
  await fillField(['#phone', 'input[name="phone"]', 'input[type="tel"]'],   payload.phone);

  // CV file upload
  const cvUploaded = await uploadFile(
    ['#resume', 'input[name="resume"]', 'input[type="file"][name*="resume"]', 'input[type="file"]'],
    payload.cvBase64, payload.cvName, payload.cvMime
  );
  if (!cvUploaded) log('Warning: CV upload failed — continuing anyway');

  // Cover letter (text field or file upload)
  const clField = document.querySelector('#cover_letter_text, textarea[name="cover_letter"], #cover-letter-text');
  if (clField) {
    await setTextarea(clField, payload.coverLetter);
  } else {
    // Try file upload for cover letter
    await uploadFile(
      ['input[name="cover_letter"]'],
      textToDataUrl(payload.coverLetter, 'text/plain'),
      'cover_letter.txt',
      'text/plain'
    );
  }

  // Handle extra questions (dropdowns etc.)
  await fillGreenhouseExtras();

  // Small pause before submitting
  await sleep(1000);

  // Submit
  const submitted = await clickSubmit([
    '#submit_app',
    'button[type="submit"]',
    'input[type="submit"]',
    'button:contains("Submit")',
    '.btn-primary[type="submit"]',
  ]);

  if (!submitted) {
    return { success: false, reason: 'Submit button not found on Greenhouse form' };
  }

  // Wait for confirmation
  await sleep(3000);
  const confirmed = await waitForConfirmation([
    '.application-confirmation',
    '#confirmation',
    '[data-testid="confirmation"]',
    'h1:contains("received")',
    'h2:contains("received")',
    '.thank-you',
  ], 10000);

  if (confirmed) {
    return { success: true };
  }

  // Check if we got an error
  const error = document.querySelector('.error-message, .field-error, [data-error]');
  if (error) {
    return { success: false, reason: `Form error: ${error.textContent.trim().slice(0, 100)}` };
  }

  // Assume submitted if no error (some forms redirect immediately)
  return { success: true };
}


// Fill Greenhouse extra required questions
async function fillGreenhouseExtras() {
  const selects = document.querySelectorAll('select');
  for (const sel of selects) {
    const label = getFieldLabel(sel).toLowerCase();

    // Work authorisation
    if (matchesAny(label, ['authoris', 'authoriz', 'right to work', 'eligible to work', 'sponsorship', 'visa'])) {
      await selectOption(sel, ['Yes', 'I am authorised', 'No sponsorship required', 'Authorised']);
      continue;
    }

    // Location
    if (matchesAny(label, ['location', 'city', 'where are you'])) {
      await selectOption(sel, ['London', 'UK', 'United Kingdom']);
      continue;
    }

    // Identity / diversity — always decline
    if (matchesAny(label, ['gender', 'race', 'ethnic', 'veteran', 'disability', 'sexual', 'pronouns'])) {
      await selectOption(sel, ['Decline', 'Prefer not', 'Do not wish', 'I do not wish']);
      continue;
    }

    // How did you hear
    if (matchesAny(label, ['how did you hear', 'referral', 'source'])) {
      await selectOption(sel, ['LinkedIn', 'Job Board', 'Online', 'Internet']);
      continue;
    }
  }

  // Text inputs for salary expectations
  const inputs = document.querySelectorAll('input[type="text"], input[type="number"]');
  for (const inp of inputs) {
    const label = getFieldLabel(inp).toLowerCase();
    if (matchesAny(label, ['salary', 'expected', 'compensation', 'expectation'])) {
      // Skip — we don't want to commit to a number without knowing
      continue;
    }
    // Current location text fields
    if (matchesAny(label, ['current location', 'your location', 'city'])) {
      if (!inp.value) inp.value = 'London, UK';
    }
  }
}


// ── Lever ─────────────────────────────────────────────────────────────────────

async function fillLever(payload) {
  log('ATS: Lever');

  await waitFor('.application-form, form[class*="application"], [data-qa="application-form"]', 15000);

  if (hasCaptcha()) {
    return { success: false, reason: 'CAPTCHA detected on Lever form' };
  }

  // Some Lever URLs have /apply suffix
  const applyBtn = document.querySelector('a[href*="/apply"], .template-btn-submit, button[data-qa="btn-apply-lever"]');
  if (applyBtn && !document.querySelector('input[name="name"]')) {
    applyBtn.click();
    await sleep(2000);
  }

  // Fill fields
  await fillField([
    'input[name="name"]',
    '#name',
    'input[placeholder*="name" i]',
    'input[data-qa="name-field"]',
  ], payload.name);

  await fillField([
    'input[name="email"]',
    '#email',
    'input[type="email"]',
    'input[data-qa="email-field"]',
  ], payload.email);

  await fillField([
    'input[name="phone"]',
    '#phone',
    'input[type="tel"]',
    'input[data-qa="phone-field"]',
  ], payload.phone);

  // CV file upload
  await uploadFile(
    ['input[name="resume"]', 'input[type="file"][name*="resume"]', '.resume-upload input[type="file"]', 'input[type="file"]'],
    payload.cvBase64, payload.cvName, payload.cvMime
  );

  // Cover letter / comments
  await fillField([
    'textarea[name="comments"]',
    'textarea[name="coverLetter"]',
    'textarea[name="cover_letter"]',
    '#comments',
    'textarea[data-qa="comments-field"]',
    'textarea',
  ], payload.coverLetter);

  await sleep(1000);

  const submitted = await clickSubmit([
    'button[type="submit"]',
    'input[type="submit"]',
    '.template-btn-submit',
    'button[data-qa="btn-submit"]',
    'button:contains("Submit Application")',
    'button:contains("Apply")',
  ]);

  if (!submitted) {
    return { success: false, reason: 'Submit button not found on Lever form' };
  }

  await sleep(3000);

  // Check for success
  const confirmed = await waitForConfirmation([
    '.application-confirmation',
    '.confirmation-message',
    'h2:contains("Thank you")',
    'h1:contains("Application received")',
    '.success-message',
  ], 10000);

  return { success: confirmed || !hasFatalError() };
}


// ── Reed ──────────────────────────────────────────────────────────────────────

async function fillReed(payload) {
  log('ATS: Reed.co.uk — URL: ' + window.location.href);

  // If we're on the login page, session expired
  if (document.querySelector('input[type="password"]') && document.querySelector('input[type="email"]') &&
      (window.location.href.includes('/login') || window.location.href.includes('/signin'))) {
    return { success: false, reason: 'Reed session expired — not logged in' };
  }

  // If we're on a job listing page (not an apply form), click the Apply button
  const isApplyPage = window.location.href.includes('/apply') ||
                      !!document.querySelector('.application-form, form[class*="apply"], [data-testid="application-form"]');

  if (!isApplyPage) {
    // We're on the job detail page — find and click Apply
    const applyBtn = Array.from(document.querySelectorAll('button, a'))
      .find(el => /apply now|apply for/i.test(el.textContent) && el.offsetParent !== null);

    if (applyBtn) {
      log('Clicking Apply button — page will navigate');
      applyBtn.click();
      // Return navigating:true so background.js waits for the new page to load
      return { navigating: true };
    }

    // No apply button found
    return { success: false, reason: 'No Apply button found on Reed job page' };
  }

  // We're on the actual application form page
  await waitFor('form, .application-form', 10000);

  if (hasCaptcha()) {
    return { success: false, reason: 'CAPTCHA detected on Reed form' };
  }

  // Fill name fields
  await fillField(['input[name="firstName"]', '#firstName', 'input[placeholder*="First name" i]'], payload.name.split(' ')[0]);
  await fillField(['input[name="lastName"]', '#lastName', 'input[placeholder*="Last name" i]'], payload.name.split(' ').slice(1).join(' '));
  await fillField(['input[name="email"]', '#email', 'input[type="email"]'], payload.email);
  await fillField(['input[name="phone"]', '#phone', 'input[type="tel"]'], payload.phone);

  // Cover letter textarea
  await fillField([
    'textarea[name="coveringLetter"]',
    'textarea[name="coverLetter"]',
    'textarea[id*="cover"]',
    'textarea',
  ], payload.coverLetter);

  // CV upload
  await uploadFile(['input[type="file"]'], payload.cvBase64, payload.cvName, payload.cvMime);

  await sleep(1000);

  const submitted = await clickSubmit([
    'button[type="submit"]',
    'input[type="submit"]',
    'button:contains("Apply")',
    'button:contains("Submit")',
    '.apply-button[type="submit"]',
  ]);

  if (!submitted) {
    return { success: false, reason: 'Submit button not found on Reed form' };
  }

  await sleep(3000);
  return { success: !hasFatalError() };
}


// ── Workable ──────────────────────────────────────────────────────────────────

async function fillWorkable(payload) {
  log('ATS: Workable');

  await waitFor('form.application-form, #application-form, [data-ui="application-form"]', 15000);

  if (hasCaptcha()) {
    return { success: false, reason: 'CAPTCHA detected on Workable form' };
  }

  await fillField(['input[name="firstname"]', 'input[placeholder*="First" i]'], payload.name.split(' ')[0]);
  await fillField(['input[name="lastname"]',  'input[placeholder*="Last" i]'],  payload.name.split(' ').slice(1).join(' '));
  await fillField(['input[name="email"]',     'input[type="email"]'],            payload.email);
  await fillField(['input[name="phone"]',     'input[type="tel"]'],              payload.phone);
  await fillField(['textarea[name="cover_letter"]', 'textarea'],                 payload.coverLetter);

  await uploadFile(['input[type="file"]'], payload.cvBase64, payload.cvName, payload.cvMime);

  await sleep(1000);
  const submitted = await clickSubmit(['button[type="submit"]', 'input[type="submit"]']);
  if (!submitted) return { success: false, reason: 'Submit button not found' };

  await sleep(3000);
  return { success: !hasFatalError() };
}


// ── Ashby ─────────────────────────────────────────────────────────────────────

async function fillAshby(payload) {
  log('ATS: Ashby');

  await waitFor('form, .ashby-application-form', 15000);

  if (hasCaptcha()) {
    return { success: false, reason: 'CAPTCHA on Ashby form' };
  }

  await fillField(['input[name="name"]', 'input[placeholder*="name" i]'],  payload.name);
  await fillField(['input[name="email"]', 'input[type="email"]'],            payload.email);
  await fillField(['input[name="phone"]', 'input[type="tel"]'],              payload.phone);
  await fillField(['textarea'],                                               payload.coverLetter);

  await uploadFile(['input[type="file"]'], payload.cvBase64, payload.cvName, payload.cvMime);

  await sleep(1000);
  const submitted = await clickSubmit(['button[type="submit"]']);
  if (!submitted) return { success: false, reason: 'Submit button not found' };

  await sleep(3000);
  return { success: !hasFatalError() };
}


// ── Generic fallback ──────────────────────────────────────────────────────────

async function fillGeneric(payload) {
  log('ATS: Generic (unknown ATS)');

  await sleep(2000);

  if (hasCaptcha()) {
    return { success: false, reason: 'CAPTCHA detected' };
  }

  // Try common field patterns
  await fillField(['input[name="name"]', 'input[name="full_name"]', 'input[placeholder*="name" i]'], payload.name);
  await fillField(['input[name="first_name"]', 'input[placeholder*="first" i]'], payload.name.split(' ')[0]);
  await fillField(['input[name="last_name"]', 'input[placeholder*="last" i]'], payload.name.split(' ').slice(1).join(' '));
  await fillField(['input[type="email"]', 'input[name="email"]'], payload.email);
  await fillField(['input[type="tel"]', 'input[name="phone"]'], payload.phone);
  await fillField(['textarea'], payload.coverLetter);
  await uploadFile(['input[type="file"]'], payload.cvBase64, payload.cvName, payload.cvMime);

  await sleep(1000);
  const submitted = await clickSubmit(['button[type="submit"]', 'input[type="submit"]']);
  if (!submitted) return { success: false, reason: 'Could not find submit button (unknown ATS)' };

  await sleep(3000);
  return { success: !hasFatalError() };
}


// ── Field helpers ─────────────────────────────────────────────────────────────

/**
 * Try each selector, fill the first match found.
 * Uses React-compatible value setter for SPAs.
 */
async function fillField(selectors, value) {
  if (!value) return false;

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (!el || el.offsetParent === null) continue;  // skip hidden

    el.focus();
    await sleep(100);

    // React-compatible value setter
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
      'value'
    )?.set;

    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, value);
    } else {
      el.value = value;
    }

    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    await sleep(150);
    return true;
  }
  return false;
}

async function setTextarea(el, value) {
  if (!el || !value) return false;
  el.focus();
  await sleep(100);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(150);
  return true;
}

/**
 * Upload a file into a file input using DataTransfer.
 * Works in content scripts (user's own browser — no security restriction).
 * cvBase64 format: "data:application/pdf;base64,..."
 */
async function uploadFile(selectors, cvBase64, cvName, cvMime) {
  if (!cvBase64) return false;

  for (const sel of selectors) {
    const input = document.querySelector(sel);
    if (!input || input.type !== 'file') continue;

    try {
      // Convert base64 to Blob
      const byteString = atob(cvBase64.split(',')[1]);
      const ab = new ArrayBuffer(byteString.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
      }
      const blob = new Blob([ab], { type: cvMime || 'application/pdf' });
      const file = new File([blob], cvName || 'CV.pdf', { type: cvMime || 'application/pdf' });

      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;

      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('input',  { bubbles: true }));

      await sleep(500);
      log(`CV uploaded: ${cvName}`);
      return true;
    } catch (e) {
      log(`File upload error: ${e.message}`, 'error');
    }
  }
  return false;
}

async function selectOption(selectEl, preferredValues) {
  if (!selectEl) return false;
  const opts = Array.from(selectEl.options);
  for (const preferred of preferredValues) {
    const opt = opts.find(o =>
      o.text.toLowerCase().includes(preferred.toLowerCase()) ||
      o.value.toLowerCase().includes(preferred.toLowerCase())
    );
    if (opt) {
      selectEl.value = opt.value;
      selectEl.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(100);
      return true;
    }
  }
  return false;
}

async function clickSubmit(selectors) {
  for (const sel of selectors) {
    let el;
    // Support :contains() pseudo-selector via manual search
    if (sel.includes(':contains(')) {
      const text = sel.match(/:contains\("(.+?)"\)/)?.[1] || '';
      const tag  = sel.split(':')[0] || 'button';
      el = Array.from(document.querySelectorAll(tag))
        .find(b => b.textContent.trim().toLowerCase().includes(text.toLowerCase()));
    } else {
      el = document.querySelector(sel);
    }

    if (el && !el.disabled && el.offsetParent !== null) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(500);
      el.click();
      log(`Clicked submit: ${sel}`);
      return true;
    }
  }
  return false;
}

function waitFor(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(selector)) { resolve(document.querySelector(selector)); return; }
    const obs = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) { obs.disconnect(); resolve(el); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); resolve(null); }, timeout);
  });
}

async function waitForConfirmation(selectors, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      let el;
      if (sel.includes(':contains(')) {
        const text = sel.match(/:contains\("(.+?)"\)/)?.[1] || '';
        const tag  = sel.split(':')[0] || '*';
        el = Array.from(document.querySelectorAll(tag))
          .find(b => b.textContent.toLowerCase().includes(text.toLowerCase()));
      } else {
        el = document.querySelector(sel);
      }
      if (el) return true;
    }
    await sleep(500);
  }
  return false;
}

function hasCaptcha() {
  return !!(
    document.querySelector('iframe[src*="recaptcha"]') ||
    document.querySelector('iframe[src*="hcaptcha"]') ||
    document.querySelector('.g-recaptcha') ||
    document.querySelector('[data-sitekey]') ||
    document.querySelector('iframe[title*="captcha" i]')
  );
}

function hasFatalError() {
  const errs = document.querySelectorAll('.error, .field-error, [class*="error"], [role="alert"]');
  return Array.from(errs).some(e =>
    e.textContent.trim().length > 0 &&
    e.offsetParent !== null &&
    !e.classList.contains('success')
  );
}

function getFieldLabel(el) {
  // Try for-attribute label
  if (el.id) {
    const lbl = document.querySelector(`label[for="${el.id}"]`);
    if (lbl) return lbl.textContent.trim();
  }
  // Parent label
  const parent = el.closest('label');
  if (parent) return parent.textContent.trim();
  // Preceding label
  const prev = el.previousElementSibling;
  if (prev && prev.tagName === 'LABEL') return prev.textContent.trim();
  // Aria label
  if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
  // Placeholder
  if (el.placeholder) return el.placeholder;
  return '';
}

function matchesAny(str, keywords) {
  return keywords.some(kw => str.includes(kw));
}

function textToDataUrl(text, mime = 'text/plain') {
  const b64 = btoa(unescape(encodeURIComponent(text)));
  return `data:${mime};base64,${b64}`;
}

async function dismissCookieBanner() {
  // Common accept/agree button selectors for cookie banners
  const cookieSelectors = [
    // Text-based
    'button[id*="accept"]',
    'button[id*="cookie"]',
    'button[class*="accept"]',
    'button[class*="cookie"]',
    '[id*="accept-cookies"]',
    '[id*="cookie-accept"]',
    // Reed specific
    '#onetrust-accept-btn-handler',
    '.onetrust-accept-btn-handler',
    'button[aria-label*="Accept"]',
    // Generic
    'button[data-cookiebanner="accept"]',
    '.cc-accept',
    '#cookieAccept',
    '.cookie-accept',
  ];

  for (const sel of cookieSelectors) {
    const btn = document.querySelector(sel);
    if (btn && btn.offsetParent !== null) {
      btn.click();
      log('Dismissed cookie banner');
      await sleep(1000);
      return;
    }
  }

  // Text search fallback
  const allButtons = Array.from(document.querySelectorAll('button, a[role="button"]'));
  const acceptBtn = allButtons.find(b => {
    const t = b.textContent.trim().toLowerCase();
    return (t === 'accept all' || t === 'accept cookies' || t === 'i accept' ||
            t === 'agree' || t === 'ok' || t === 'got it' || t === 'allow all') &&
           b.offsetParent !== null;
  });
  if (acceptBtn) {
    acceptBtn.click();
    log('Dismissed cookie banner (text match)');
    await sleep(1000);
  }
}

async function reedLogin(email, password) {
  try {
    // Go to Reed login page
    window.location.href = 'https://www.reed.co.uk/login';
    await sleep(4000);

    // Fill email
    const emailFilled = await fillField([
      '#email', 'input[name="email"]', 'input[type="email"]',
      'input[name="UserName"]', '#UserName'
    ], email);

    // Fill password
    const passFilled = await fillField([
      '#password', 'input[name="password"]', 'input[type="password"]',
      'input[name="Password"]', '#Password'
    ], password);

    if (!emailFilled || !passFilled) {
      log('Reed login: could not find email/password fields');
      return false;
    }

    await sleep(500);

    // Click sign in button
    const signedIn = await clickSubmit([
      'button[type="submit"]',
      'input[type="submit"]',
      '#loginSubmit',
      'button:contains("Sign in")',
      'button:contains("Log in")',
    ]);

    if (!signedIn) {
      log('Reed login: submit button not found');
      return false;
    }

    // Wait for redirect after login
    await sleep(4000);

    // Check if login succeeded (no login form visible)
    const stillOnLogin = document.querySelector('input[type="password"]');
    if (stillOnLogin) {
      log('Reed login: failed — still on login page');
      return false;
    }

    log('Reed login: success');
    return true;
  } catch (e) {
    log(`Reed login error: ${e.message}`);
    return false;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function log(msg, level = 'info') {
  console.log(`[AutoApply content] ${msg}`);
}
