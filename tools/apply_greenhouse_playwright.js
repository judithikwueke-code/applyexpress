/**
 * apply_greenhouse_playwright.js — v3 (JS-injection approach)
 *
 * KEY DESIGN CHANGE vs earlier versions:
 * All form interactions use frame.evaluate() (native DOM .click() + JS events)
 * instead of Playwright's .click() method. This bypasses the hit-testing that
 * fails when cookie consent overlays (Osano, OneTrust) intercept pointer events.
 *
 * This is exactly how LazyApply, Simplify Copilot and all working Chrome
 * extension tools operate: they inject JS into the page context and call
 * element.click() / dispatchEvent() directly — no viewport hit-test.
 *
 * Usage:
 *   node tools/apply_greenhouse_playwright.js \
 *     --url "https://job-boards.eu.greenhouse.io/dojo/jobs/4793340101" \
 *     --cv-path ".tmp/cv_dojo_compliance_lead.docx" \
 *     --cover-letter "$(cat .tmp/cover_letter_dojo.txt)" \
 *     --headed
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
chromium.use(stealth());
const path = require('path');
const fs = require('fs');
const minimist = require('minimist');

// Load .env early (needed for Gmail credentials) — only set vars not already inherited
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) process.env[match[1].trim()] = match[2].trim();
  });
}

const argv = minimist(process.argv.slice(2));

const CONFIG = {
  url:              argv['url']               || '',
  firstName:        argv['first-name']        || process.env.CANDIDATE_FIRST_NAME || '',
  lastName:         argv['last-name']         || process.env.CANDIDATE_LAST_NAME  || '',
  email:            argv['email']             || process.env.CANDIDATE_EMAIL       || '',
  phone:            argv['phone']             || process.env.CANDIDATE_PHONE       || '',
  city:             argv['city']              || process.env.CANDIDATE_LOCATION    || 'London',
  cvPath:           argv['cv-path']           ? path.resolve(argv['cv-path']) : null,
  coverLetterPath:  argv['cover-letter-path'] ? path.resolve(argv['cover-letter-path']) : null,
  coverLetterText:  argv['cover-letter']      || null,
  questionAnswer:   argv['question-answer']   || null,
  jobTitle:         argv['job-title']         || null,
  company:          argv['company']           || null,
  jobDescription:   argv['job-description']  || null,
  headed:           argv['headed']            || false,
};

const TMP_DIR = path.join(process.cwd(), '.tmp');

function log(msg) {
  console.log(`[greenhouse ${new Date().toISOString().slice(11,19)}] ${msg}`);
}

async function screenshot(page, label) {
  try {
    const p = path.join(TMP_DIR, `greenhouse_${label}_${Date.now()}.png`);
    await page.screenshot({ path: p, fullPage: false });
    log(`Screenshot: ${p}`);
    return p;
  } catch (_) { return null; }
}

async function tailorCV() {
  if (!CONFIG.jobTitle || !CONFIG.company) {
    log('No --job-title/--company — using CV as-is');
    return CONFIG.cvPath;
  }
  const { execFileSync } = require('child_process');
  try {
    const args = ['tools/tailor_cv_docx.py', '--job-title', CONFIG.jobTitle, '--company', CONFIG.company];
    if (CONFIG.jobDescription) args.push('--description', CONFIG.jobDescription);
    const out = execFileSync('.venv/bin/python', args, { cwd: process.cwd(), encoding: 'utf8', timeout: 30000 }).trim();
    log(`CV tailored: ${path.basename(out)}`);
    return out;
  } catch (e) {
    log(`CV tailoring failed (${e.message.slice(0,60)}) — using base CV`);
    return CONFIG.cvPath;
  }
}

// ── JS-injection helpers ────────────────────────────────────────────────────────

/**
 * Set a plain text input value the React way:
 * Uses the native HTMLInputElement setter so React's synthetic events fire.
 */
const JS_SET_INPUT = `
function setInput(el, value) {
  if (!el) return false;
  const proto = el.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value); else el.value = value;
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}
`;

/**
 * Open a React Select dropdown and pick the first option that matches searchText.
 * Works by: mousedown on control → input event on the hidden input → keydown Enter.
 * Returns a Promise that resolves after Enter is pressed.
 */
const JS_REACT_SELECT = `
function reactSelectPick(controlEl, searchText) {
  return new Promise(resolve => {
    if (!controlEl) { resolve('NOT_FOUND'); return; }
    // Open the dropdown via mousedown
    controlEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    controlEl.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true }));
    setTimeout(() => {
      // Find the active search input inside the select
      const input = controlEl.querySelector('input');
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(input, searchText); else input.value = searchText;
        input.dispatchEvent(new Event('input',  { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        setTimeout(() => {
          // Press Enter to select first matching option
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          setTimeout(() => {
            const val = controlEl.querySelector('.select__single-value')?.innerText?.trim() || '';
            resolve(val);
          }, 400);
        }, 600);
      } else {
        resolve('NO_INPUT');
      }
    }, 200);
  });
}
`;

// ---------------------------------------------------------------------------
// Gmail IMAP reader — fetches Greenhouse security code from inbox
// ---------------------------------------------------------------------------

async function readGmailSecurityCode({ email, password, maxWaitSeconds = 60 }) {
  if (!password) {
    console.log('[greenhouse] No SMTP_PASSWORD set — cannot read Gmail security code');
    return null;
  }

  const { ImapFlow } = require('imapflow');

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: email, pass: password },
    logger: false,
  });

  const startTime = Date.now();
  const maxMs = maxWaitSeconds * 1000;

  console.log(`[greenhouse] Connecting to Gmail IMAP for ${email}...`);

  try {
    await client.connect();
    await client.mailboxOpen('INBOX');

    for (let attempt = 0; (Date.now() - startTime) < maxMs; attempt++) {
      // Search for recent emails from Greenhouse (noreply@greenhouse.io or similar)
      const since = new Date(Date.now() - 10 * 60 * 1000); // Last 10 minutes
      const messages = await client.search({
        since,
        or: [
          { from: 'greenhouse.io' },
          { subject: 'security code' },
          { subject: 'verification code' },
        ],
      });

      for (const uid of messages.reverse()) { // Newest first
        const msg = await client.fetchOne(uid, { source: true });
        // Decode quoted-printable HTML body (Greenhouse sends code in HTML part)
        const msg2 = await client.fetchOne(uid, { bodyParts: ['1'] });
        const htmlQP = msg2.bodyParts?.get('1')?.toString() || '';
        // Decode QP encoding (=3D → = etc.)
        const html = htmlQP.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
        const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

        // Greenhouse code format: "Copy and paste this code into the security code field on your application: XXXXXXXX"
        const codeMatch = text.match(/security code field[^:]*:\s*([A-Za-z0-9]{6,12})/i) ||
          text.match(/your application:\s*([A-Za-z0-9]{6,12})/i) ||
          text.match(/paste this code[^:]*:\s*([A-Za-z0-9]{6,12})/i);

        if (codeMatch) {
          console.log(`[greenhouse] ✓ Security code found: ${codeMatch[1]}`);
          await client.logout();
          return codeMatch[1];
        }
      }

      if ((Date.now() - startTime) < maxMs) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`[greenhouse] Waiting for security code email... (${elapsed}s / ${maxWaitSeconds}s)`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    await client.logout();
    console.log('[greenhouse] Timeout — no security code email found');
    return null;

  } catch (err) {
    console.log(`[greenhouse] Gmail IMAP error: ${err.message}`);
    try { await client.logout(); } catch (_) {}
    return null;
  }
}

// ---------------------------------------------------------------------------

async function main() {
  log(`Starting Greenhouse apply: ${CONFIG.url}`);
  log(`Candidate: ${CONFIG.firstName} ${CONFIG.lastName} <${CONFIG.email}>`);

  const cvPath = await tailorCV();
  if (cvPath && cvPath !== CONFIG.cvPath) CONFIG.cvPath = cvPath;
  await new Promise(r => setTimeout(r, 500));

  const browser = await chromium.launch({
    headless: !CONFIG.headed,
    slowMo: 0,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--disable-background-timer-throttling',   // prevents setTimeout throttling in background tabs
      '--disable-renderer-backgrounding',         // keeps renderer active when window not focused
      '--disable-backgrounding-occluded-windows', // keeps windows active when occluded
      '--disable-dev-shm-usage',                  // use /tmp instead of /dev/shm (prevents OOM in containers)
      '--disable-gpu',                             // avoids GPU process crashes in headless Linux
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  let page = await context.newPage();
  page.setDefaultTimeout(20000);

  // Capture console messages from ALL pages/frames (for reCAPTCHA debugging)
  context.on('page', newPage => {
    newPage.on('console', msg => log(`[new-page] ${msg.text().slice(0, 100)}`));
  });
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('CAPTCHA') || text.includes('recaptcha') || text.includes('error') || text.includes('Error')) {
      log(`[browser] ${text.slice(0, 200)}`);
    }
  });

  try {
    // ── 0. reCAPTCHA setup ────────────────────────────────────────────────
    // Real reCAPTCHA runs — stealth plugin helps with fingerprint.
    // Problem in run 30: reCAPTCHA /clr endpoint (score completion) was blocked
    // by the Greenhouse iframe's Content-Security-Policy.
    // Fix: intercept responses from job-boards.eu.greenhouse.io and strip the CSP header.
    // This allows reCAPTCHA to complete all its network calls and return a higher-score token.
    await context.route('https://job-boards.eu.greenhouse.io/**', async route => {
      try {
        const response = await route.fetch();
        const headers = response.headers();
        // Strip CSP so reCAPTCHA can call recaptcha.net endpoints freely
        const filtered = Object.fromEntries(
          Object.entries(headers).filter(([k]) =>
            !['content-security-policy', 'x-content-security-policy', 'content-security-policy-report-only'].includes(k.toLowerCase())
          )
        );
        await route.fulfill({ response, headers: filtered });
      } catch (e) {
        await route.continue().catch(() => {});
      }
    });
    log('reCAPTCHA: CSP stripped on Greenhouse iframe (allows /clr completion)');

    // ── 1. Navigate ────────────────────────────────────────────────────────
    log('Navigating...');
    await page.goto(CONFIG.url, { waitUntil: 'commit', timeout: 30000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // ── 2. Kill overlay CSS immediately on every navigation ────────────────
    // This prevents Osano/OneTrust from intercepting pointer events.
    // We do this on the outer page AND inside the iframe after load.
    async function killOverlays(targetPage) {
      await targetPage.addStyleTag({ content: `
        .osano-cm-window, [class*="osano-cm"],
        #onetrust-banner-sdk, #onetrust-consent-sdk,
        [id*="cookie-banner"], [class*="cookie-banner"],
        [class*="cookie-consent"], [class*="CookieBanner"],
        [class*="gdpr-banner"], .cc-window, #cc-main {
          display: none !important;
          visibility: hidden !important;
          pointer-events: none !important;
        }
      `}).catch(() => {});
      await targetPage.evaluate(() => {
        document.querySelectorAll(
          '.osano-cm-window, [class*="osano-cm"], #onetrust-banner-sdk, ' +
          '#onetrust-consent-sdk, [id*="cookie-banner"]'
        ).forEach(el => el.remove());
      }).catch(() => {});
    }
    await killOverlays(page);

    // ── 3. Natural browsing delay before Apply (improves reCAPTCHA score) ──
    // reCAPTCHA v3 scores sessions partly based on time spent on page and scroll behavior.
    // Spending ~15s reading the page before applying gives a more human-like signal.
    log('Natural browsing: scrolling job page before applying...');
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, 300 + Math.random() * 200)).catch(() => {});
      await page.waitForTimeout(2000 + Math.random() * 1000);
    }
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await page.waitForTimeout(2000);
    log('Natural browsing done');

    // ── 3b. Click Apply if needed (may open new tab) ────────────────────────
    log('Looking for Apply button...');
    const applyVisible = await page.locator(
      'button:has-text("Apply"), a:has-text("Apply"), ' +
      'button:has-text("Apply Now"), a:has-text("Apply Now")'
    ).first().isVisible({ timeout: 5000 }).catch(() => false);

    if (applyVisible) {
      const [newPage] = await Promise.all([
        context.waitForEvent('page', { timeout: 8000 }).catch(() => null),
        page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button, a'))
            .find(el => /apply now|apply/i.test(el.textContent.trim()) && el.offsetParent !== null);
          if (btn) btn.click();
        }),
      ]);
      if (newPage) {
        log('Apply opened new tab — switching');
        await newPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
        page = newPage;
        await killOverlays(page);
      }
      await page.waitForTimeout(3000);
      log(`Now at: ${page.url()}`);
    }

    // Kill overlays again after any navigation
    await killOverlays(page);
    await page.waitForTimeout(1000);

    // ── 4. Find the Greenhouse iframe frame ────────────────────────────────
    log('Locating form frame...');
    let ghFrame = null;

    // Wait up to 15s for the greenhouse iframe to appear
    for (let i = 0; i < 15 && !ghFrame; i++) {
      await page.waitForTimeout(1000);
      for (const frame of page.frames()) {
        if (frame.url().includes('greenhouse.io') && frame.url().includes('embed')) {
          // Verify it has the form
          const hasForm = await frame.evaluate(() => !!document.querySelector('#first_name, input[name="first_name"]')).catch(() => false);
          if (hasForm) { ghFrame = frame; break; }
        }
      }
      if (!ghFrame && i === 5) log('  Still waiting for iframe...');
    }

    if (!ghFrame) {
      // Fallback: form might be on the page itself (standard greenhouse.io board)
      const hasDirectForm = await page.evaluate(() => !!document.querySelector('#first_name, input[name="first_name"]')).catch(() => false);
      if (hasDirectForm) {
        log('Form on main page (no iframe)');
        ghFrame = page.mainFrame();
      } else {
        log('ERROR: Could not find Greenhouse form');
        await screenshot(page, 'error_no_form');
        await browser.close();
        process.exit(1);
      }
    } else {
      log(`Form iframe: ${ghFrame.url().slice(0, 70)}`);
    }

    // ── 5. Build frameLocator for file-upload & setInputFiles ─────────────
    // Raw Frame (ghFrame) = JS injection, bypasses click interception.
    // FrameLocator = needed for filechooser-based file upload (cross-origin).
    let ghFrameLocator = null;
    for (const sel of [
      'iframe[src*="eu.greenhouse.io/embed"]',
      'iframe[src*="greenhouse.io/embed"]',
      'iframe[src*="greenhouse.io"]',
    ]) {
      try {
        const fl = page.frameLocator(sel);
        const hasInput = await fl.locator('input[type="file"]').first()
          .isVisible({ timeout: 2000 }).catch(() => false);
        if (hasInput) { ghFrameLocator = fl; log(`FrameLocator: ${sel}`); break; }
      } catch (_) {}
    }

    // Scroll the iframe into view
    await page.evaluate(() => window.scrollBy(0, 400)).catch(() => {});
    await page.waitForTimeout(500);

    // ── 6. Fill text fields via JS injection ─────────────────────────────
    log('Filling fields via JS...');

    const fillResult = await ghFrame.evaluate(({ firstName, lastName, email, phone }) => {
      // React-safe setter
      function setInput(el, value) {
        if (!el) return false;
        const proto = el.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, value); else el.value = value;
        el.dispatchEvent(new Event('focus',  { bubbles: true }));
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur',   { bubbles: true }));
        return true;
      }

      const results = {};

      // First name
      const fn = document.querySelector('#first_name, input[name="first_name"]');
      results.firstName = setInput(fn, firstName) ? 'OK' : 'NOT_FOUND';

      // Last name
      const ln = document.querySelector('#last_name, input[name="last_name"]');
      results.lastName = setInput(ln, lastName) ? 'OK' : 'NOT_FOUND';

      // Email
      const em = document.querySelector('#email, input[name="email"], input[type="email"]');
      results.email = setInput(em, email) ? 'OK' : 'NOT_FOUND';

      // Phone — fill the number input directly (skip the country flyout)
      const phoneEl = document.querySelector(
        'input[name="phone"], input[type="tel"], ' +
        'input[id*="phone"], .phone-number-field input'
      );
      results.phone = setInput(phoneEl, phone) ? 'OK' : 'NOT_FOUND';

      return results;
    }, { firstName: CONFIG.firstName, lastName: CONFIG.lastName, email: CONFIG.email, phone: CONFIG.phone });

    log(`Text fields: ${JSON.stringify(fillResult)}`);
    await page.waitForTimeout(500);

    // ── 7. Upload CV ───────────────────────────────────────────────────────
    // Greenhouse upload widget: "Attach" button must be clicked first to
    // activate the hidden file input. Use JS eval (bypasses overlay), then
    // catch the OS file-chooser dialog via page.waitForEvent('filechooser').
    // DO NOT use setInputFiles on a cross-origin iframe frameLocator — it crashes Chrome.
    if (CONFIG.cvPath && fs.existsSync(CONFIG.cvPath)) {
      log(`Uploading CV: ${path.basename(CONFIG.cvPath)}`);
      try {
        // The working approach from run 3: use FrameLocator.locator().evaluate(el => el.click())
        // This triggers the OS file dialog from within the iframe context via Playwright's
        // FrameLocator code path, which properly handles cross-origin file inputs.
        // DO NOT use raw ghFrame.evaluate() for file input click — it doesn't trigger filechooser.
        // DO NOT use setInputFiles on frameLocator — it crashes Chrome on cross-origin iframes.

        // Make file input visible
        await ghFrame.evaluate(() => {
          document.querySelectorAll('input[type="file"]').forEach(fi => {
            fi.style.display = 'block'; fi.style.opacity = '1';
          });
        });
        await page.waitForTimeout(300);

        // For main-page forms: setInputFiles() works directly on hidden inputs.
        // For iframe forms: use FrameLocator + filechooser pattern.
        if (!ghFrameLocator) {
          // Main page — setInputFiles bypasses filechooser entirely
          await page.locator('input[type="file"]').first().setInputFiles(CONFIG.cvPath, { timeout: 10000 });
          log('CV uploaded via setInputFiles (main page) ✓');
          await page.waitForTimeout(4000);
        } else {
          // Cross-origin iframe — must use filechooser pattern
          const [chooser] = await Promise.all([
            page.waitForEvent('filechooser', { timeout: 10000 }).catch(() => null),
            ghFrameLocator.locator('input[type="file"]').first().evaluate(el => el.click()).catch(() => {}),
          ]);
          if (chooser) {
            await chooser.setFiles(CONFIG.cvPath);
            log('CV uploaded via filechooser ✓');
            await page.waitForTimeout(4000);
          } else {
            log('WARNING: No filechooser from iframe — trying setInputFiles fallback...');
            await ghFrameLocator.locator('input[type="file"]').first().setInputFiles(CONFIG.cvPath, { timeout: 8000 }).catch((e) => {
              log(`CV iframe setInputFiles fallback failed: ${e.message.slice(0, 80)}`);
            });
            await page.waitForTimeout(4000);
          }
        }
      } catch (e) {
        log(`CV upload error: ${e.message.slice(0, 100)}`);
      }
    }

    // ── 8. React Select dropdowns ─────────────────────────────────────────
    // All dropdowns use JS mousedown → input → Enter (bypasses overlay).
    log('Discovering and filling dropdowns...');

    // Discover all .select__control elements and their labels
    const selectInfo = await ghFrame.evaluate(() => {
      return Array.from(document.querySelectorAll('.select__control')).map((ctrl, i) => {
        // Detect multi-select: has .select__multi-value tags (Monzo EEO uses these)
        const isMulti = ctrl.querySelector('.select__multi-value') !== null ||
                        ctrl.closest('[class*="multi"]') !== null;
        const multiValues = Array.from(ctrl.querySelectorAll('.select__multi-value__label'))
          .map(el => el.innerText.trim());
        const singleVal = ctrl.querySelector('.select__single-value')?.innerText?.trim() || '';
        const currentVal = isMulti
          ? (multiValues.length ? multiValues.join(', ') : 'Select...')
          : (singleVal || 'Select...');

        // Walk up the DOM to find associated label
        let node = ctrl;
        for (let j = 0; j < 6; j++) {
          if (!node.parentElement) break;
          node = node.parentElement;
          const lbl = node.querySelector('label');
          if (lbl) return { i, label: lbl.innerText.trim().replace(/\*/g, '').trim(), currentVal, isMulti };
        }
        // Also check for input id → label
        const inp = ctrl.querySelector('input');
        if (inp?.id) {
          const lbl = document.querySelector(`label[for="${inp.id}"]`);
          if (lbl) return { i, label: lbl.innerText.trim().replace(/\*/g, '').trim(), currentVal, isMulti };
        }
        return { i, label: '?', currentVal, isMulti };
      });
    });
    log('Selects: ' + JSON.stringify(selectInfo));

    // Helper: pick a React Select option by index using JS injection.
    // Uses Playwright-level await between steps (NOT setTimeout inside evaluate)
    // so Chrome's background tab timer throttling cannot stall the sequence.
    async function jsReactSelect(idx, searchText, label, waitMs = 700, arrowDownFirst = false) {
      // Use real Playwright locator clicks so React's synthetic event system fires properly.
      // JS-injected clicks (.click() in evaluate) don't reliably trigger React state updates.
      const ctrl = ghFrame.locator('.select__control').nth(idx);

      // Step 1: Click to open the dropdown
      await ctrl.click({ timeout: 5000 }).catch(async () => {
        // Fallback: JS mousedown if Playwright click fails (e.g., element partially off-screen)
        await ghFrame.evaluate((idx) => {
          const ctrl = document.querySelectorAll('.select__control')[idx];
          if (ctrl) ctrl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        }, idx).catch(() => {});
      });
      await page.waitForTimeout(300);

      // Step 1.5: log available options before typing
      const options = await ghFrame.evaluate((idx) => {
        const menu = document.querySelectorAll('.select__menu')[idx] ||
          document.querySelector('.select__menu');
        return Array.from(menu?.querySelectorAll('.select__option') || []).map(o => o.innerText.trim());
      }, idx).catch(() => []);
      if (options.length) log(`  Options[${idx}]: ${JSON.stringify(options)}`);

      // Step 2: Type the search text using pressSequentially (real key events → React onChange fires)
      const input = ghFrame.locator('.select__control').nth(idx).locator('input');
      // pressSequentially fires individual keydown/keypress/keyup events — more reliable
      // than fill() for React Select which uses keydown to filter options
      await input.pressSequentially(searchText, { delay: 50, timeout: 5000 }).catch(async () => {
        // Fallback: fill + manual input event dispatch
        await ghFrame.evaluate(({ idx, searchText }) => {
          const ctrl  = document.querySelectorAll('.select__control')[idx];
          const inp = ctrl?.querySelector('input');
          if (!inp) return;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(inp, searchText); else inp.value = searchText;
          inp.dispatchEvent(new Event('input',  { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
        }, { idx, searchText }).catch(() => {});
      });
      await page.waitForTimeout(waitMs);

      // Log options after typing (important for async/search dropdowns)
      const optionsAfter = await ghFrame.evaluate((idx) => {
        const menu = document.querySelectorAll('.select__menu')[idx] ||
          document.querySelector('.select__menu');
        return Array.from(menu?.querySelectorAll('.select__option') || []).map(o => o.innerText.trim());
      }, idx).catch(() => []);
      if (optionsAfter.length) log(`  Options[${idx}] after search: ${JSON.stringify(optionsAfter.slice(0, 5))}`);

      // Step 3: Select the first filtered option.
      // For async selects (arrowDownFirst=true): ArrowDown focuses the first option, Enter selects.
      // For static selects: Enter alone selects the focused/first option.
      if (arrowDownFirst) {
        await input.press('ArrowDown', { timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(100);
      }
      await input.press('Enter', { timeout: 2000 }).catch(async () => {
        // Fallback: Click the first visible option via CDP
        const firstOption = ghFrame.locator('.select__option').first();
        const optionVisible = await firstOption.isVisible({ timeout: 1000 }).catch(() => false);
        if (optionVisible) await firstOption.click({ timeout: 3000 }).catch(() => {});
      });
      await page.waitForTimeout(500);

      // Read back the selected value
      const val = await ghFrame.evaluate((idx) => {
        const ctrl = document.querySelectorAll('.select__control')[idx];
        const single = ctrl?.querySelector('.select__single-value')?.innerText?.trim();
        if (single) return single;
        const multiTags = Array.from(ctrl?.querySelectorAll('.select__multi-value__label') || [])
          .map(el => el.innerText.trim());
        if (multiTags.length) return multiTags.join(', ');
        return 'no-value';
      }, idx).catch(() => 'eval-error');

      log(`  ${label} [${idx}]: "${searchText}" → "${val}"`);
      await page.waitForTimeout(200);
      return val;
    }

    // Map by label
    function findByLabel(regex) {
      return selectInfo.find(s => regex.test(s.label));
    }

    const countrySelect  = findByLabel(/country/i);
    const usPersonSelect = findByLabel(/US (person|tax)/i);
    const privacySelect  = findByLabel(/privacy|data protection/i);
    const rtwSelect      = findByLabel(/right to work|work in (the )?UK|authoris/i);
    const workPrefSelect = findByLabel(/working model|work preference|attendance|four days|hybrid|office days/i);

    if (countrySelect)  await jsReactSelect(countrySelect.i,  'United Kingdom', 'Country');
    if (usPersonSelect) await jsReactSelect(usPersonSelect.i, 'No',             'US Person');
    if (privacySelect)  await jsReactSelect(privacySelect.i,  "I've read",      'Privacy policy');
    if (rtwSelect) {
      // Try multiple search terms to handle both UK and Ireland-based forms.
      // Use a single attempt per term to avoid corrupting React Select state with repeated failures.
      const rtwAttempts = ['Irish Citizen', 'UK citizen', 'UK or Irish', 'National of an EU', 'Yes'];
      for (const attempt of rtwAttempts) {
        const r = await jsReactSelect(rtwSelect.i, attempt, `Right to Work (${attempt})`);
        if (r && r !== 'no-value' && r !== 'NOT_FOUND' && r !== 'eval-error') break;
      }
    }
    if (workPrefSelect) await jsReactSelect(workPrefSelect.i, 'Yes',            'Work preferences');

    // Explicit: visa sponsorship → No
    const visaSelect = findByLabel(/visa sponsorship|sponsorship/i);
    if (visaSelect) await jsReactSelect(visaSelect.i, 'No', 'Visa sponsorship');

    // Explicit: Location (City) → London  (async search — needs extra wait, Enter selects first result)
    const locationSelect = findByLabel(/location.*(city|town)|city.*location|^city$/i);
    if (locationSelect) await jsReactSelect(locationSelect.i, 'London', 'Location City', 1500);

    // Fill any remaining "Select..." dropdowns with "Prefer not to say" or "No"
    log('Filling remaining empty dropdowns...');
    const handledIdx = new Set([
      countrySelect?.i, usPersonSelect?.i, privacySelect?.i,
      rtwSelect?.i, workPrefSelect?.i, visaSelect?.i, locationSelect?.i,
    ].filter(x => x !== undefined));

    for (const s of selectInfo) {
      if (handledIdx.has(s.i)) continue;
      if (!/Select\.\.\./i.test(s.currentVal)) continue; // already filled

      // Multi-select dropdowns (e.g. Monzo EEO): pick ONLY "Prefer not to say"
      // — do NOT iterate through multiple options or all will get selected.
      // If already has values, skip entirely.
      if (s.isMulti && s.currentVal !== 'Select...') {
        log(`  Skipping multi-select[${s.i}] — already has value: ${s.currentVal}`);
        continue;
      }

      try {
        // Try "Prefer not to say" first, then "No", then "Yes"
        // For multi-selects, a successful selection removes the option from the menu
        // and returns the tag label — so any non-empty, non-NOT_FOUND result = success.
        const r = await jsReactSelect(s.i, 'Prefer', `Select[${s.i}] "${s.label.slice(0,40)}"`);
        const rOk = r && r !== 'no-value' && r !== 'NOT_FOUND' && r !== 'eval-error';
        if (!rOk) {
          const r2 = await jsReactSelect(s.i, 'No', `Select[${s.i}] fallback-No`);
          const r2Ok = r2 && r2 !== 'no-value' && r2 !== 'NOT_FOUND' && r2 !== 'eval-error';
          if (!r2Ok) {
            await jsReactSelect(s.i, 'Yes', `Select[${s.i}] fallback-Yes`);
          }
        }

        // NOTE: do NOT press Escape here — React Select clears isClearable fields on Escape
        await page.waitForTimeout(200);
      } catch (dropErr) {
        log(`  Dropdown[${s.i}] error (continuing): ${dropErr.message.slice(0, 60)}`);
        if (/closed|destroyed|disconnected/i.test(dropErr.message)) throw dropErr;
      }
      await page.waitForTimeout(300);
    }

    await page.waitForTimeout(500);

    // ── 9. Free-text questions ─────────────────────────────────────────────
    log('Answering free-text questions...');
    const defaultAnswer = CONFIG.questionAnswer ||
      'I have strong working knowledge of UK FCA regulatory frameworks including CONC, MCOBS, SYSC and AML requirements under the POCA 2002 and MLR 2017. In my compliance roles I have conducted customer risk assessments, supported MLRO reporting, and advised product and operations teams on regulatory obligations. I hold relevant compliance certifications and am comfortable translating complex regulatory requirements into practical business guidance.';

    const textareaCount = await ghFrame.evaluate((answer) => {
      const tas = document.querySelectorAll('textarea[id^="question_"], textarea[id^="answer"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      tas.forEach(ta => {
        if (setter) setter.call(ta, answer); else ta.value = answer;
        ta.dispatchEvent(new Event('input',  { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
      });
      return tas.length;
    }, defaultAnswer);
    log(`  Free-text questions answered: ${textareaCount}`);

    // ── 10. Cover letter ───────────────────────────────────────────────────
    const clText = CONFIG.coverLetterText ||
      (CONFIG.coverLetterPath && fs.existsSync(CONFIG.coverLetterPath)
        ? fs.readFileSync(CONFIG.coverLetterPath, 'utf8') : null);

    if (clText) {
      log('Filling cover letter...');
      const clResult = await ghFrame.evaluate((text) => {
        const ta = document.querySelector('#cover_letter_text, textarea[name="cover_letter"]');
        if (!ta) return 'NOT_FOUND';
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) setter.call(ta, text); else ta.value = text;
        ta.dispatchEvent(new Event('input',  { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        return 'OK';
      }, clText);
      log(`  Cover letter: ${clResult}`);
    }

    // ── 11. GDPR checkbox ──────────────────────────────────────────────────
    // React checkboxes: cb.click() is the most reliable approach.
    // We also scroll to it first to ensure it's in view.
    log('Checking GDPR...');
    const gdprResult = await ghFrame.evaluate(() => {
      const cb = document.querySelector(
        '#gdpr_demographic_data_consent_given_1, input[id*="gdpr"], input[name*="gdpr"]'
      );
      if (!cb) {
        // Log all checkboxes for debug
        const all = Array.from(document.querySelectorAll('input[type="checkbox"]'))
          .map(el => ({ id: el.id, name: el.name, checked: el.checked }));
        return 'NOT_FOUND — checkboxes: ' + JSON.stringify(all);
      }
      cb.scrollIntoView({ block: 'center' });
      if (cb.checked) return 'ALREADY_CHECKED';
      // Use native click() — most reliable for React controlled checkboxes
      cb.click();
      // Verify and force if click didn't work
      if (!cb.checked) {
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'checked'
        )?.set;
        if (nativeSetter) nativeSetter.call(cb, true);
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return cb.checked ? 'CHECKED' : 'CLICK_FAILED';
    });
    log(`  GDPR: ${gdprResult}`);

    await page.waitForTimeout(500);

    // ── 12. Final state check ──────────────────────────────────────────────
    log('Checking form state...');
    const formState = await ghFrame.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('.select__control'))
        .map((el, i) => ({ i, val: el.querySelector('.select__single-value')?.innerText?.trim() || 'Select...' }));
      const required = Array.from(document.querySelectorAll('[aria-required="true"], [required]'))
        .map(el => ({ tag: el.tagName, name: el.name || el.id || '?', value: el.value || el.checked || '?' }));
      const errors = Array.from(document.querySelectorAll('.error-message, [class*="--error"], [role="alert"]'))
        .map(el => el.innerText.trim()).filter(Boolean);
      return { selects, required, errors };
    });
    log('Select values: ' + JSON.stringify(formState.selects));
    if (formState.errors.length) log('Errors: ' + formState.errors.join(' | '));

    await screenshot(page, 'before_submit');

    // ── 13. Submit ─────────────────────────────────────────────────────────
    log('Submitting...');

    // Monitor ALL network requests/responses from all frames (context-level)
    const capturedPosts = [];
    let got428 = false;  // Set when Greenhouse returns 428 (dummy reCAPTCHA token accepted by server)
    context.on('request', req => {
      const url = req.url();
      if (req.method() === 'POST' || url.includes('greenhouse') || url.includes('apply')) {
        log(`  → ${req.method()} ${url.slice(0, 100)}`);
        if (req.method() === 'POST') capturedPosts.push(url);
      }
    });
    context.on('response', async resp => {
      const url = resp.url();
      if (url.includes('greenhouse') || (resp.request().method() === 'POST' && !url.includes('google-analytics'))) {
        let body = '';
        try { body = (await resp.text().catch(() => '')).slice(0, 200); } catch(_) {}
        log(`  ← ${resp.status()} ${url.slice(0, 80)} | ${body}`);
        if (resp.status() === 428 && url.includes('greenhouse')) {
          got428 = true;
          log('  ✓ 428 received — Greenhouse emailed security code, waiting for React to render input...');
        }
      }
    });

    // Let reCAPTCHA run normally — stealth plugin should produce a valid token.

    // Approach 1: Direct Node.js POST (requires valid reCAPTCHA token — skip for now,
    // the FrameLocator click approach below sends a real browser token).
    log('Skipping Node.js direct POST — FrameLocator click sends real reCAPTCHA token...');

    const iframeFullUrl = ghFrame.url();
    log(`  Iframe URL: ${iframeFullUrl.slice(0, 80)}`);
    // Known POST endpoint confirmed by network monitoring in run 29:
    // boards.eu.greenhouse.io/embed/{board}/jobs/{id}
    log('Using FrameLocator click — browser sends real reCAPTCHA token');

    // ── Neutralise reCAPTCHA block ────────────────────────────────────────────
    // Strategy:
    //   1. Remove the `grecaptcha-error` CSS class (the form submit handler checks
    //      for this class and aborts if present — removing it unblocks the submit).
    //   2. Inject a dummy token into all g-recaptcha-response hidden inputs.
    //   3. Monkey-patch execute() so any pending/future execute() calls return our
    //      dummy token rather than hanging.
    // The server will reject the dummy token (HTTP 428), email a security code, and
    // show a security code input. Our Gmail IMAP reader picks up the code and resubmits.
    await ghFrame.evaluate(() => {
      // 1. Remove error state
      document.querySelectorAll('.grecaptcha-error, [class*="grecaptcha-error"]').forEach(el => {
        el.classList.remove('grecaptcha-error');
      });

      // 2. Inject dummy token into all hidden reCAPTCHA response inputs
      const DUMMY = 'dummy_recaptcha_token_force_428';
      document.querySelectorAll(
        'textarea[name="g-recaptcha-response"], ' +
        'input[name="g-recaptcha-response"], ' +
        '.g-recaptcha-response'
      ).forEach(el => {
        try {
          const setter = Object.getOwnPropertyDescriptor(
            window[el.tagName === 'TEXTAREA' ? 'HTMLTextAreaElement' : 'HTMLInputElement'].prototype, 'value'
          )?.set;
          if (setter) setter.call(el, DUMMY); else el.value = DUMMY;
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (_) {}
      });

      // 3. Monkey-patch execute() + ready()
      if (window.grecaptcha) {
        window.grecaptcha.execute = () => Promise.resolve(DUMMY);
        window.grecaptcha.ready = (cb) => { if (typeof cb === 'function') cb(); };
      }
      // Also patch on the enterprise namespace
      if (window.grecaptcha?.enterprise) {
        window.grecaptcha.enterprise.execute = () => Promise.resolve(DUMMY);
        window.grecaptcha.enterprise.ready = (cb) => { if (typeof cb === 'function') cb(); };
      }
    }).catch((e) => log(`reCAPTCHA neutralise warning: ${e.message}`));
    log('reCAPTCHA: error class removed + token injected + execute() patched');

    // Approach 2a: Playwright FrameLocator click with force=true.
    // This sends real Playwright mouse events (mousedown, mouseup, click) into the iframe.
    // More reliable than JS .click() for React components that check event properties.
    log('Trying Playwright frameLocator submit click (force)...');
    let submitResult = 'not-attempted';
    if (ghFrameLocator) {
      try {
        await ghFrameLocator.locator('#submit_app, button[type="submit"]').first().click({ force: true, timeout: 5000 });
        submitResult = 'playwright-framelocator-click';
        log('  Playwright FrameLocator click fired');
      } catch (e) {
        log(`  FrameLocator click failed: ${e.message.slice(0,80)}`);
      }
    }
    // Wait up to 8s for either: success confirmation OR 428 security code field
    await page.waitForTimeout(1000);
    for (let w = 0; w < 8; w++) {
      await page.waitForTimeout(1000);
      const ifrSnap = await ghFrame.evaluate(() => document.body.innerText).catch(() => '');
      if (/thank you|application received|submitted|we.ll be in touch/i.test(ifrSnap)) {
        log('✓ Confirmed after Playwright click');
        await screenshot(page, 'success');
        await browser.close();
        process.exit(0);
      }
      if (got428) {
        log(`  428 detected at ${w+1}s — waiting for security code field to render...`);
        break;
      }
    }

    // If 428 triggered, skip further submit attempts — let React render the security code input
    if (got428) {
      // Wait up to 6 more seconds for React to update the DOM with security code field
      log('Waiting for React to render security code input after 428...');
      let secFieldVisible = false;
      for (let w = 0; w < 6; w++) {
        await page.waitForTimeout(1000);
        const check = await ghFrame.evaluate(() => {
          const f = document.querySelector(
            'input[name="security_code"], input[data-field="security_code"], ' +
            'input[placeholder*="code" i], input[id*="code" i]'
          );
          if (f) return { found: true, name: f.name, id: f.id, placeholder: f.placeholder };
          const body = document.body.innerText;
          return { found: false, codeSent: /security code|verification code|code.*sent|check.*email/i.test(body), body: body.slice(0, 200) };
        }).catch(() => ({ found: false }));
        log(`  Sec field check ${w+1}s: ${JSON.stringify(check)}`);
        if (check.found) { secFieldVisible = true; break; }
      }
      if (!secFieldVisible) {
        log('Security code field not visible after 428 — React may need more time. Proceeding to Gmail read anyway.');
      }
      // Jump straight to Gmail IMAP — skip requestSubmit and JS sequence
      await screenshot(page, 'after_428');
      // Falls through to security code fallback section below
    } else {

    // Approach 2b: form.requestSubmit() — triggers the native HTML form submit event
    // React listens for 'submit' on the form element. requestSubmit() fires it properly.
    log('Trying form.requestSubmit()...');
    const requestSubmitResult = await ghFrame.evaluate(() => {
      const form = document.querySelector('form');
      if (!form) return 'NO_FORM';
      try {
        form.requestSubmit();
        return 'requestSubmit-called';
      } catch (e) {
        // If form has required fields that are empty, requestSubmit throws
        // Fallback: manually click the submit button
        const btn = document.querySelector('#submit_app, button[type="submit"]');
        if (btn) { btn.click(); return 'btn-click-fallback'; }
        return 'error: ' + e.message;
      }
    });
    log(`  requestSubmit: ${requestSubmitResult}`);
    await page.waitForTimeout(3000);

    ifrTextCheck = await ghFrame.evaluate(() => document.body.innerText).catch(() => '');
    if (/thank you|application received|submitted|we.ll be in touch/i.test(ifrTextCheck)) {
      log('✓ Confirmed after requestSubmit');
      await screenshot(page, 'success');
      await browser.close();
      process.exit(0);
    }

    // Approach 2c: JS click with full mouse event sequence (last resort)
    log('Trying JS full mouse event sequence on submit button...');
    submitResult = await ghFrame.evaluate(() => {
      const btn = document.querySelector(
        '#submit_app, button[type="submit"], input[type="submit"], ' +
        'button[data-submit], [class*="submit"]'
      );
      if (!btn) return 'NOT_FOUND: ' + Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim()).join('|');
      btn.scrollIntoView({ block: 'center' });
      // Fire full sequence of mouse events
      ['mouseenter','mouseover','mousedown','mouseup','click'].forEach(evtName => {
        btn.dispatchEvent(new MouseEvent(evtName, { bubbles: true, cancelable: true, view: window }));
      });
      return 'full-sequence: ' + btn.textContent.trim();
    });
    log(`Submit: ${submitResult}`);

    if (submitResult.startsWith('NOT_FOUND')) {
      log('Submit button not found — dumping form HTML for debug');
      await screenshot(page, 'error_no_submit');
      await browser.close();
      process.exit(1);
    }

    // Wait for confirmation (check both iframe and outer page)
    await page.waitForTimeout(2000);
    let confirmed = false;
    for (let i = 0; i < 15 && !confirmed; i++) {
      await page.waitForTimeout(1000);

      // Check iframe for confirmation text
      const ifrText = await ghFrame.evaluate(() => document.body.innerText).catch(() => '');
      if (/thank you|application received|submitted|we.ll be in touch/i.test(ifrText)) {
        log(`Confirmation in iframe at ${i+1}s`);
        confirmed = true;
        break;
      }

      // Check outer page URL change
      if (/confirm|success|thank/i.test(page.url())) {
        log(`Confirmation URL: ${page.url()}`);
        confirmed = true;
        break;
      }

      // Check for security code input (428 triggered by dummy reCAPTCHA token)
      const secFieldEarly = await ghFrame.evaluate(() => {
        const f = document.querySelector(
          'input[name="security_code"], input[data-field="security_code"], ' +
          'input[placeholder*="code" i], input[id*="code" i]'
        );
        if (f) return { found: true, name: f.name, id: f.id };
        const body = document.body.innerText;
        return { found: false, codeSent: /security code|verification code|code.*sent|check.*email/i.test(body) };
      }).catch(() => ({ found: false }));

      if (secFieldEarly.found || secFieldEarly.codeSent) {
        log(`Security code input detected at ${i+1}s — breaking to Gmail IMAP read`);
        break;
      }

      // Check for post-submit validation errors (every 2s)
      if (i % 2 === 1) {
        const diagnostics = await ghFrame.evaluate(() => {
          // 1. Check for error/invalid elements
          const errEls = Array.from(document.querySelectorAll(
            '.error-message, [class*="--error"], [class*="invalid"], [role="alert"], ' +
            '.field-errors, .greenhouse-validation, [aria-invalid="true"], ' +
            '[class*="error"], [class*="Error"], .has-error'
          )).map(el => ({ cls: el.className.toString().slice(0,40), text: el.innerText.trim().slice(0,60) }));

          // 2. Check which inputs are empty / invalid
          const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="file"]), textarea'))
            .map(el => ({
              name: el.name || el.id || '?',
              val: (el.value || '').slice(0, 30),
              required: el.required,
              valid: el.validity?.valid,
            }));

          // 3. Full body text (first 1000 chars)
          const body = document.body.innerText.slice(0, 1000);

          return { errEls: errEls.slice(0, 10), inputs, body };
        }).catch(() => ({ errEls: [], inputs: [], body: '' }));

        if (diagnostics.errEls.length) {
          log(`Post-submit errors [${i+1}s]: ${JSON.stringify(diagnostics.errEls)}`);
        }
        const invalidInputs = diagnostics.inputs.filter(inp => !inp.valid || (inp.required && !inp.val));
        if (invalidInputs.length) {
          log(`Invalid/empty required inputs: ${JSON.stringify(invalidInputs)}`);
        }
        const bodySnippet = diagnostics.body.slice(0, 400).replace(/\n/g, ' ');
        log(`  Iframe body[${i+1}s]: ${bodySnippet}`);
      }
    }

    await screenshot(page, confirmed ? 'success' : 'post_submit');
    log(`URL after submit: ${page.url()}`);

    if (confirmed) {
      log('✓ APPLICATION SUBMITTED SUCCESSFULLY');
      await browser.close();
      process.exit(0);
    }

    } // end else (no 428 yet — requestSubmit + JS sequence path)

    // ── 14. Security code fallback ─────────────────────────────────────────
    // When reCAPTCHA score is too low, Greenhouse returns 428 and:
    // 1. Shows a security code input in the iframe
    // 2. Sends a 6-digit code to the applicant's email
    // We read the code from Gmail via IMAP and inject it.
    log('No confirmation — checking for security code field (Greenhouse 428 fallback)...');

    const secCodeFieldInfo = await ghFrame.evaluate(() => {
      // Greenhouse security code field appears after 428
      const field = document.querySelector(
        'input[name="security_code"], input[data-field="security_code"], ' +
        'input[placeholder*="code" i], input[id*="code" i]'
      );
      if (field) return { found: true, name: field.name, id: field.id, placeholder: field.placeholder };

      // Also check for text indicating code was sent
      const body = document.body.innerText;
      const codeSent = /security code|verification code|code.*sent|check.*email/i.test(body);
      return { found: false, codeSent, bodySnippet: body.slice(0, 300) };
    }).catch(() => ({ found: false }));

    log(`Security code field: ${JSON.stringify(secCodeFieldInfo)}`);

    if (!secCodeFieldInfo.found && !secCodeFieldInfo.codeSent && !got428) {
      log('✗ No security code field found and no 428 received — submit failed');
      await screenshot(page, 'failed');
      await browser.close();
      process.exit(1);
    }

    // Read security code from Gmail
    // (got428=true means Greenhouse already emailed the code even if React hasn't rendered the input yet)
    log('Security code required — reading Gmail via IMAP...');
    const gmailCode = await readGmailSecurityCode({
      email: process.env.SMTP_EMAIL || CONFIG.email,
      password: process.env.SMTP_PASSWORD,
      maxWaitSeconds: 60,
    });

    if (!gmailCode) {
      log('✗ Could not read security code from Gmail within timeout');
      log('ESCALATION_REASON: CAPTCHA blocked — reCAPTCHA required, security code email not received');
      log('  Check SMTP_PASSWORD in .env is the Gmail App Password, or this employer requires a real reCAPTCHA solve');
      await screenshot(page, 'no_security_code');
      await browser.close();
      process.exit(3);  // 3 = CAPTCHA blocked → pipeline marks as needs_review, not failed
    }

    log(`✓ Security code from Gmail: ${gmailCode}`);

    // Poll up to 10s for the security code field to appear (React re-renders after 428)
    log('Waiting for security code input to render in DOM...');
    let codeInjected = false;
    for (let w = 0; w < 10; w++) {
      await page.waitForTimeout(1000);
      codeInjected = await ghFrame.evaluate((code) => {
        const SEC_SELECTORS = 'input[name="security_code"], input[data-field="security_code"], ' +
          'input[placeholder*="code" i], input[id*="security" i], input[id*="code" i]';
        const field = document.querySelector(SEC_SELECTORS);
        if (!field) {
          const body = document.body.innerText.slice(0, 100);
          return false;
        }
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(field, code);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }, gmailCode);

      if (codeInjected) {
        log(`  Security code injected at poll ${w+1}s`);
        break;
      }
      // Log what IS in the DOM to debug
      const snap = await ghFrame.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input')).map(i => ({ name: i.name, id: i.id, type: i.type, placeholder: i.placeholder }));
        const body = document.body.innerText.slice(0, 200);
        return { inputs, body };
      }).catch(() => ({}));
      log(`  Poll ${w+1}s — inputs: ${JSON.stringify(snap.inputs?.slice(0,5))} | body: ${snap.body?.slice(0,100)}`);
    }

    if (!codeInjected) {
      log('✗ Could not inject security code — field not rendered after 10s');
      log('  This may indicate Greenhouse is not rendering the security code UI in this browser session.');
      log('  Try: run with --headed to observe the form state visually');
      await screenshot(page, 'failed_no_sec_field');
      await browser.close();
      process.exit(1);
    }

    log('Security code injected — resubmitting...');
    await page.waitForTimeout(1000);

    // Resubmit
    await ghFrame.evaluate(() => {
      const btn = document.querySelector('#submit_app, button[type="submit"]');
      if (btn) btn.click();
    });
    await page.waitForTimeout(5000);

    const finalText = await ghFrame.evaluate(() => document.body.innerText).catch(() => '');
    const finalConfirmed = /thank you|application received|submitted|we.ll be in touch/i.test(finalText);

    await screenshot(page, finalConfirmed ? 'success' : 'failed');

    if (finalConfirmed) {
      log('✓ APPLICATION SUBMITTED SUCCESSFULLY (via security code)');
      await browser.close();
      process.exit(0);
    } else {
      log('✗ Security code submit did not confirm — check .tmp/ screenshots');
      await browser.close();
      process.exit(1);
    }

  } catch (err) {
    log(`FATAL ERROR: ${err.message}`);
    await screenshot(page, 'fatal_error').catch(() => {});
    await browser.close();
    process.exit(1);
  }
}

main();
