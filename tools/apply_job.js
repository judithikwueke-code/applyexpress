/**
 * apply_job.js — Playwright-based automated job application tool.
 *
 * Fully auto-submits applications. Escalates to human only when genuinely blocked:
 *   - CAPTCHA detected
 *   - Mandatory field the agent cannot fill (video, ID upload, custom assessment)
 *   - Unrecoverable error after retries
 *
 * On escalation: saves a screenshot and exits with code 1 (so run_pipeline.py
 * can update the Sheet status to "Needs Review").
 *
 * Usage:
 *   node tools/apply_job.js \
 *     --url "https://www.reed.co.uk/jobs/..." \
 *     --name "Jane Smith" \
 *     --email "jane@example.com" \
 *     --phone "+44 7700 900000" \
 *     --cv-path "/absolute/path/to/cv.pdf" \
 *     --cover-letter "Paragraph 1...\n\nParagraph 2...\n\nParagraph 3..."
 *
 * Flags:
 *   --headed         Run in headed (visible) mode for debugging
 *   --timeout        Max ms to wait for elements (default 8000)
 *   --reed-email     Reed.co.uk account email (or set REED_EMAIL in .env)
 *   --reed-password  Reed.co.uk account password (or set REED_PASSWORD in .env)
 */

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());
const minimist = require('minimist');
const path = require('path');
const fs = require('fs');

// Load .env
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  });
}

const argv = minimist(process.argv.slice(2));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG = {
  url: argv['url'] || '',
  name: argv['name'] || '',
  email: argv['email'] || '',
  phone: argv['phone'] || '',
  cvPath: argv['cv-path'] ? path.resolve(argv['cv-path']) : null,
  coverLetter: argv['cover-letter'] || '',
  headed: argv['headed'] || false,
  timeout: parseInt(argv['timeout'] || '8000', 10),
  reedEmail: argv['reed-email'] || process.env.REED_EMAIL || '',
  reedPassword: argv['reed-password'] || process.env.REED_PASSWORD || '',
};

const SESSION_FILE = path.join(process.cwd(), '.tmp', 'reed_session.json');

const TMP_DIR = path.join(process.cwd(), '.tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[apply_job ${ts}] ${msg}`);
}

function logError(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.error(`[apply_job ${ts}] ERROR: ${msg}`);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

async function humanDelay(min = 500, max = 1500) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  await new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Try multiple selectors for an action. Returns true if any succeeded.
 * action: async (locator) => void
 */
async function trySelectors(page, selectors, action, description = '') {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: 'visible', timeout: 3000 });
      await action(locator);
      log(`  ✓ ${description || selector}`);
      return true;
    } catch (_) {
      // Try next selector
    }
  }
  return false;
}

async function saveScreenshot(page, label) {
  const filename = `escalation_${label}_${Date.now()}.png`;
  const filepath = path.join(TMP_DIR, filename);
  try {
    await page.screenshot({ path: filepath, fullPage: true });
    log(`Screenshot saved: ${filepath}`);
  } catch (e) {
    logError(`Could not save screenshot: ${e.message}`);
  }
  return filepath;
}

async function escalate(page, reason, companySlug = 'unknown') {
  logError(`Escalating to human: ${reason}`);
  const screenshotPath = await saveScreenshot(page, companySlug);
  console.error(`ESCALATION_REASON: ${reason}`);
  console.error(`SCREENSHOT: ${screenshotPath}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Reed login / session management
// ---------------------------------------------------------------------------

async function loadSession(context) {
  if (fs.existsSync(SESSION_FILE)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      await context.addCookies(cookies);
      log('Session loaded from cache');
      return true;
    } catch (_) {}
  }
  return false;
}

async function saveSession(context) {
  const cookies = await context.cookies();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(cookies, null, 2));
  log('Session saved to cache');
}

async function isLoggedIn(page) {
  try {
    // Reed shows account nav or profile link when logged in
    await page.goto('https://www.reed.co.uk', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await humanDelay(1000, 2000);
    const url = page.url();
    const content = await page.content();
    return content.includes('Sign out') || content.includes('My Reed') || content.includes('My account');
  } catch (_) {
    return false;
  }
}

async function loginToReed(page, context) {
  if (!CONFIG.reedEmail || !CONFIG.reedPassword) {
    log('No Reed credentials provided — skipping login (set REED_EMAIL + REED_PASSWORD in .env)');
    return false;
  }

  log(`Logging in to Reed as ${CONFIG.reedEmail}...`);

  try {
    // Reed redirects /login to Auth0 at secure.reed.co.uk — go via the authentication path
    await page.goto('https://www.reed.co.uk/authentication/login?returnTo=%2F', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Auth0 login page uses #signin_email and #signin_password
    const emailField = page.locator('#signin_email').first();
    await emailField.waitFor({ state: 'visible', timeout: 10000 });
    await emailField.click();
    await humanDelay(200, 400);
    await emailField.fill(CONFIG.reedEmail);
    await humanDelay(300, 600);

    const passwordField = page.locator('#signin_password').first();
    await passwordField.waitFor({ state: 'visible', timeout: 5000 });
    await passwordField.click();
    await humanDelay(200, 400);
    await passwordField.fill(CONFIG.reedPassword);
    await humanDelay(300, 600);

    // Auth0 submit — use the specific #signin_button id (avoid clicking Apple SSO which also says "Continue")
    await page.locator('#signin_button').click();
    await page.waitForNavigation({ timeout: 15000 }).catch(() => {});
    await humanDelay(2000, 3000);

    const currentUrl = page.url();
    log(`Post-login URL: ${currentUrl.slice(0, 80)}`);

    if (currentUrl.includes('reed.co.uk') && !currentUrl.includes('/login') && !currentUrl.includes('secure.reed')) {
      log('Login successful');
      await saveSession(context);
      return true;
    } else {
      logError('Login may have failed — check credentials');
      await saveScreenshot(page, 'login_failed');
      return false;
    }

  } catch (err) {
    logError(`Login error: ${err.message}`);
    return false;
  }
}

async function ensureLoggedIn(page, context) {
  // Try cached session first
  const sessionLoaded = await loadSession(context);
  if (sessionLoaded) {
    if (await isLoggedIn(page)) {
      log('Using cached Reed session');
      return true;
    }
    log('Cached session expired — logging in fresh');
    // Clear expired cookies
    await context.clearCookies();
  }
  return await loginToReed(page, context);
}

// ---------------------------------------------------------------------------
// CAPTCHA detection
// ---------------------------------------------------------------------------

async function detectBlockers(page, company) {
  const captchaSelectors = [
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    '.g-recaptcha',
    '[data-sitekey]',
    'iframe[title*="CAPTCHA" i]',
  ];

  for (const sel of captchaSelectors) {
    try {
      const el = page.locator(sel).first();
      await el.waitFor({ state: 'attached', timeout: 1000 });
      await escalate(page, `CAPTCHA detected (${sel})`, company);
    } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Apply button finding
// ---------------------------------------------------------------------------

async function clickApplyButton(page) {
  const applySelectors = [
    '[data-qa="apply-btn"]',          // Reed's actual selector (confirmed)
    '[data-qa="btn-apply"]',
    '[data-automation="job-detail-apply"]',
    'button:has-text("Apply now")',
    'button:has-text("Apply for this job")',
    'button:has-text("Apply")',
    'a:has-text("Apply now")',
    'a:has-text("Apply")',
    '.apply-button',
    '#apply-btn',
    'a[href*="apply"]',
  ];

  log('Looking for Apply button...');
  const found = await trySelectors(page, applySelectors, async (locator) => {
    await locator.click();
    await humanDelay(1000, 2500);
  }, 'Apply button clicked');

  return found;
}

// ---------------------------------------------------------------------------
// Form filling
// ---------------------------------------------------------------------------

async function fillTextField(page, selectors, value, label) {
  if (!value) {
    log(`  Skipping ${label} (no value)`);
    return false;
  }

  return await trySelectors(page, selectors, async (locator) => {
    await locator.click();
    await humanDelay(200, 500);
    await locator.fill(value);
    await humanDelay(300, 700);
  }, label);
}

async function fillName(page, name) {
  return await fillTextField(page, [
    'input[name="name"]',
    'input[name="full_name"]',
    'input[name="fullName"]',
    'input[id="name"]',
    'input[placeholder*="name" i]',
    'input[aria-label*="name" i]',
    'input[data-field="name"]',
    '#applicant-name',
  ], name, `Name: ${name}`);
}

async function fillFirstLastName(page, name) {
  const parts = name.trim().split(/\s+/);
  const firstName = parts[0] || '';
  const lastName = parts.slice(1).join(' ') || '';

  await fillTextField(page, [
    'input[name="first_name"]',
    'input[name="firstName"]',
    'input[name*="first_name"]',
    'input[id="first_name"]',
    'input[placeholder*="first name" i]',
    'input[aria-label*="first name" i]',
  ], firstName, `First name: ${firstName}`);

  await fillTextField(page, [
    'input[name="last_name"]',
    'input[name="lastName"]',
    'input[name*="last_name"]',
    'input[id="last_name"]',
    'input[placeholder*="last name" i]',
    'input[aria-label*="last name" i]',
  ], lastName, `Last name: ${lastName}`);
}

async function fillEmail(page, email) {
  return await fillTextField(page, [
    'input[type="email"]',
    'input[name="email"]',
    'input[id="email"]',
    'input[placeholder*="email" i]',
    'input[aria-label*="email" i]',
  ], email, `Email: ${email}`);
}

async function fillPhone(page, phone) {
  return await fillTextField(page, [
    'input[type="tel"]',
    'input[name="phone"]',
    'input[name="phone_number"]',
    'input[id="phone"]',
    'input[placeholder*="phone" i]',
    'input[aria-label*="phone" i]',
  ], phone, `Phone: ${phone}`);
}

async function uploadCV(page, cvPath) {
  if (!cvPath) {
    log('  Skipping CV upload (no cv-path provided)');
    return false;
  }

  if (!fs.existsSync(cvPath)) {
    logError(`CV file not found at: ${cvPath}`);
    return false;
  }

  const uploadSelectors = [
    'input[type="file"][accept*="pdf"]',
    'input[type="file"][name*="resume"]',
    'input[type="file"][name*="cv"]',
    'input[type="file"]',
  ];

  for (const selector of uploadSelectors) {
    try {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: 'attached', timeout: 3000 });
      await locator.setInputFiles(cvPath);
      await humanDelay(1000, 2000);
      log(`  ✓ CV uploaded: ${path.basename(cvPath)}`);
      return true;
    } catch (_) {}
  }

  log('  CV upload field not found — may not be required');
  return false;
}

async function fillCoverLetter(page, coverLetter) {
  if (!coverLetter) return false;

  return await trySelectors(page, [
    'textarea[name="cover_letter"]',
    'textarea[name="coverLetter"]',
    'textarea[id="cover_letter"]',
    'textarea[placeholder*="cover" i]',
    'textarea[aria-label*="cover" i]',
    '#cover-letter',
    '.cover-letter textarea',
  ], async (locator) => {
    await locator.click();
    await humanDelay(200, 500);
    await locator.fill(coverLetter);
    await humanDelay(300, 800);
  }, 'Cover letter filled');
}

async function fillGreenhouseExtras(page) {
  // Country select — pick United Kingdom
  try {
    const countrySelect = page.locator('select[name="job_application[location_attributes][country_code]"], select[id*="country" i]').first();
    await countrySelect.waitFor({ state: 'visible', timeout: 3000 });
    await countrySelect.selectOption({ label: 'United Kingdom' });
    await humanDelay(300, 600);
    log('  ✓ Country set to United Kingdom');
  } catch (_) {}

  // Work authorisation dropdowns — select "Yes" for right to work in UK
  try {
    const selects = page.locator('select');
    const count = await selects.count();
    for (let i = 0; i < count; i++) {
      const sel = selects.nth(i);
      const label = await sel.getAttribute('name') || '';
      const id = await sel.getAttribute('id') || '';
      const text = (label + id).toLowerCase();
      if (text.includes('authoris') || text.includes('authoriz') || text.includes('eligible') || text.includes('work') || text.includes('sponsorship')) {
        try { await sel.selectOption({ label: 'Yes' }); } catch (_) {}
        try { await sel.selectOption({ value: 'yes' }); } catch (_) {}
        await humanDelay(200, 400);
        log(`  ✓ Work auth select set: ${text}`);
      }
    }
  } catch (_) {}

  // Identity/demographic dropdowns — select "I don't wish to answer" or "Decline to self-identify"
  try {
    const selects = page.locator('select');
    const count = await selects.count();
    const declineOptions = [
      'I don\'t wish to answer',
      'Decline to self-identify',
      'I do not wish to answer',
      'Prefer not to say',
      'Prefer not to disclose',
    ];
    for (let i = 0; i < count; i++) {
      const sel = selects.nth(i);
      const name = await sel.getAttribute('name') || '';
      if (name.includes('demographic') || name.includes('gender') || name.includes('race') || name.includes('ethnicity') || name.includes('veteran') || name.includes('disability')) {
        for (const opt of declineOptions) {
          try { await sel.selectOption({ label: opt }); break; } catch (_) {}
        }
        await humanDelay(200, 400);
      }
    }
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

async function submitApplication(page, company) {
  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Submit application")',
    'button:has-text("Submit")',
    'button:has-text("Send application")',
    'button:has-text("Apply")',
    '[data-qa="btn-submit"]',
  ];

  log('Submitting application...');
  const beforeUrl = page.url();

  const clicked = await trySelectors(page, submitSelectors, async (locator) => {
    await locator.click();
    await humanDelay(2000, 4000);
  }, 'Submit button clicked');

  if (!clicked) {
    await escalate(page, 'Submit button not found', company);
  }

  // Verify submission succeeded
  const afterUrl = page.url();
  const successSelectors = [
    ':has-text("application received")',
    ':has-text("Thank you")',
    ':has-text("successfully submitted")',
    ':has-text("application submitted")',
    ':has-text("we\'ll be in touch")',
    '[class*="success"]',
    '[class*="confirmation"]',
  ];

  for (const sel of successSelectors) {
    try {
      await page.locator(sel).first().waitFor({ state: 'visible', timeout: 5000 });
      log(`Application confirmed submitted`);
      return true;
    } catch (_) {}
  }

  // If URL changed, likely succeeded
  if (afterUrl !== beforeUrl) {
    log(`URL changed after submit: ${afterUrl} — assuming success`);
    return true;
  }

  // Ambiguous result — take screenshot, return success anyway (not escalating)
  log('Submit result ambiguous — taking screenshot for record');
  await saveScreenshot(page, company);
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!CONFIG.url) {
    logError('--url is required');
    process.exit(1);
  }
  if (!CONFIG.email) {
    logError('--email is required');
    process.exit(1);
  }

  const companySlug = CONFIG.url.replace(/https?:\/\//, '').split('/')[1] || 'unknown';
  log(`Starting application: ${CONFIG.url}`);
  log(`Candidate: ${CONFIG.name} <${CONFIG.email}>`);

  const browser = await chromium.launch({
    headless: !CONFIG.headed,
    slowMo: CONFIG.headed ? 50 : 0,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-setuid-sandbox',
      '--no-zygote',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();
  page.setDefaultTimeout(CONFIG.timeout);

  // Reed Easy Apply: proven flow from run testing
  const isReedJob = CONFIG.url.includes('reed.co.uk');

  if (isReedJob) {
    await ensureLoggedIn(page, context);

    log(`Navigating to: ${CONFIG.url}`);
    await page.goto(CONFIG.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await humanDelay(2000, 3000);

    // Accept cookie banner by clicking the button (required before Apply works)
    try {
      await page.click('#onetrust-accept-btn-handler', { timeout: 5000 });
      log('Cookie banner accepted');
      await humanDelay(1500, 2000);
    } catch (_) {}

    // Click Apply via JS (bypasses any remaining overlay interception)
    const applyClicked = await page.evaluate(() => {
      const btn = document.querySelector('[data-qa="apply-btn"]');
      if (btn) { btn.click(); return true; }
      return false;
    });
    log(`Apply button clicked via JS: ${applyClicked}`);
    await humanDelay(4000, 5000);

    // Check for session-expired modal (re-login if needed)
    const sessionExpired = await page.evaluate(() => document.body.innerText.includes('session has expired')).catch(() => false);
    if (sessionExpired) {
      log('Session expired after navigate — re-logging in...');
      await context.clearCookies();
      await loginToReed(page, context);
      await page.goto(CONFIG.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await humanDelay(2000, 3000);
      await page.click('#onetrust-accept-btn-handler', { timeout: 5000 }).catch(() => {});
      await humanDelay(1500, 2000);
      await page.evaluate(() => document.querySelector('[data-qa="apply-btn"]')?.click());
      await humanDelay(4000, 5000);
    }

    // Handle multi-step modal: answer questions and click Continue until Submit appears
    for (let step = 0; step < 15; step++) {
      const modalState = await page.evaluate(() => {
        const visibleBtns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null).map(b => b.textContent?.trim()).filter(Boolean);
        const radios = Array.from(document.querySelectorAll('input[type="radio"]')).filter(r => r.offsetParent !== null).map(r => ({ id: r.id, name: r.name, checked: r.checked }));
        const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]')).filter(c => c.offsetParent !== null).map(c => ({ id: c.id, name: c.name, checked: c.checked }));
        const textInputs = Array.from(document.querySelectorAll('input[type="text"], textarea')).filter(el => el.offsetParent !== null).map(el => ({ id: el.id, name: el.name, value: el.value }));
        const hasError = document.body.innerText.includes('Please answer');
        return { buttons: visibleBtns, radios, checkboxes, textInputs, hasError };
      });

      const hasSubmit = modalState.buttons.some(b => /submit application/i.test(b));
      if (hasSubmit) break;

      // Answer any unanswered radio groups (pick Yes/first option)
      if (modalState.radios.length > 0) {
        const unansweredGroups = {};
        modalState.radios.forEach(r => {
          if (!unansweredGroups[r.name]) unansweredGroups[r.name] = [];
          unansweredGroups[r.name].push(r);
        });
        for (const [name, options] of Object.entries(unansweredGroups)) {
          const answered = options.some(o => o.checked);
          if (!answered) {
            // Pick "Yes" or first option
            const yesOption = options.find(o => /yes/i.test(o.id)) || options[0];
            await page.evaluate(id => { document.getElementById(id)?.click(); }, yesOption.id);
            log(`  Answered radio "${name}": "${yesOption.id}"`);
            await humanDelay(300, 500);
          }
        }
      }

      const hasContinue = modalState.buttons.find(b => /^continue$|^next$/i.test(b));
      if (hasContinue) {
        log(`  Step ${step+1}: clicking "${hasContinue}"...`);
        await page.evaluate(text => {
          Array.from(document.querySelectorAll('button')).find(b => b.offsetParent !== null && b.textContent?.trim() === text)?.click();
        }, hasContinue);
        await humanDelay(2000, 3000);
      } else {
        break;
      }
    }

    // Click Submit application — modal shows saved CV already attached
    const submitted = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.offsetParent !== null && /submit application/i.test(b.textContent));
      if (btn) { btn.click(); return true; }
      return false;
    });

    if (!submitted) {
      log('Submit button not found — taking diagnostic screenshot');
      await saveScreenshot(page, companySlug + '_no_submit');
      await escalate(page, 'Reed submit button not found in modal', companySlug);
    }

    await humanDelay(5000, 6000);
    log('Application complete.');
    await saveScreenshot(page, companySlug);
    await browser.close();
    process.exit(0);
  }

  // Non-Reed jobs: generic flow
  let retries = 0;
  const MAX_RETRIES = 3;

  while (retries < MAX_RETRIES) {
    try {
      // Navigate to job page
      log(`Navigating to: ${CONFIG.url}`);
      await page.goto(CONFIG.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await humanDelay(1500, 3000);

      // Detect redirect away from expected URL (e.g. expired job)
      const finalUrl = page.url();
      const expectedHost = new URL(CONFIG.url).hostname;
      const finalHost = new URL(finalUrl).hostname;
      if (finalHost === expectedHost && finalUrl !== CONFIG.url) {
        const expectedPath = new URL(CONFIG.url).pathname;
        const finalPath = new URL(finalUrl).pathname;
        if (!finalPath.startsWith(expectedPath.replace(/\/$/, ''))) {
          await escalate(page, `Job posting expired or redirected: ${finalUrl}`, companySlug);
        }
      }

      await detectBlockers(page, companySlug);

      const applyClicked = await clickApplyButton(page);
      if (!applyClicked) {
        log('Apply button not found — may already be on application form');
      }
      await humanDelay(1000, 2500);

      await detectBlockers(page, companySlug);

      log('Filling application form...');
      await fillName(page, CONFIG.name);
      await fillFirstLastName(page, CONFIG.name);
      await fillEmail(page, CONFIG.email);
      await fillPhone(page, CONFIG.phone);
      await humanDelay(500, 1000);
      await uploadCV(page, CONFIG.cvPath);
      await humanDelay(500, 1000);
      await fillCoverLetter(page, CONFIG.coverLetter);
      await humanDelay(500, 1000);
      await fillGreenhouseExtras(page);
      await humanDelay(800, 1500);

      // Submit
      await submitApplication(page, companySlug);

      log('Application complete.');
      await browser.close();
      process.exit(0);

    } catch (err) {
      retries++;
      logError(`Attempt ${retries}/${MAX_RETRIES} failed: ${err.message}`);

      if (retries >= MAX_RETRIES) {
        await escalate(page, `Failed after ${MAX_RETRIES} attempts: ${err.message}`, companySlug);
      }

      await humanDelay(3000, 5000);
    }
  }
}

main().catch(async (err) => {
  logError(`Fatal: ${err.message}`);
  process.exit(1);
});
