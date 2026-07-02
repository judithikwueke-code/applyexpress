/**
 * apply_totaljobs.js — Playwright-based Totaljobs Quick Apply automation.
 *
 * Handles:
 *   - Cookie consent (GDPRConsentManagerContainer) via JS click bypass
 *   - Totaljobs login via email/password
 *   - Quick Apply modal (single-page, CV upload + cover letter)
 *   - Multi-step apply forms
 *   - External ATS redirect detection (escalates to human)
 *
 * Usage:
 *   node tools/apply_totaljobs.js \
 *     --url "https://www.totaljobs.com/job/..." \
 *     --cv-path "/absolute/path/to/cv.docx" \
 *     --cover-letter "..." \
 *     [--headed] [--timeout 8000]
 */

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());
const minimist = require('minimist');
const path = require('path');
const fs = require('fs');

// Load .env — only set vars not already inherited from parent process
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) process.env[match[1].trim()] = match[2].trim();
  });
}

const argv = minimist(process.argv.slice(2));

const _candidateName = `${process.env.CANDIDATE_FIRST_NAME || ''} ${process.env.CANDIDATE_LAST_NAME || ''}`.trim();

const CONFIG = {
  url: argv['url'] || '',
  name: argv['name'] || _candidateName || '',
  email: argv['email'] || process.env.CANDIDATE_EMAIL || process.env.TOTALJOBS_EMAIL || '',
  phone: argv['phone'] || process.env.CANDIDATE_PHONE || '',
  cvPath: argv['cv-path'] ? path.resolve(argv['cv-path']) : null,
  coverLetter: argv['cover-letter'] || '',
  headed: argv['headed'] || false,
  timeout: parseInt(argv['timeout'] || '10000', 10),
  tjEmail: argv['tj-email'] || process.env.TOTALJOBS_EMAIL || '',
  tjPassword: argv['tj-password'] || process.env.TOTALJOBS_PASSWORD || '',
};

const TMP_DIR = path.join(process.cwd(), '.tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const SESSION_FILE = path.join(TMP_DIR, 'totaljobs_session.json');

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[apply_totaljobs ${ts}] ${msg}`);
}

function logError(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.error(`[apply_totaljobs ${ts}] ERROR: ${msg}`);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

async function humanDelay(min = 500, max = 1500) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function saveScreenshot(page, label) {
  const filename = `totaljobs_${label}_${Date.now()}.png`;
  const filepath = path.join(TMP_DIR, filename);
  try {
    await page.screenshot({ path: filepath, fullPage: true });
    log(`Screenshot saved: ${filepath}`);
  } catch (e) {
    logError(`Could not save screenshot: ${e.message}`);
  }
  return filepath;
}

// Neutralise Totaljobs cookie consent overlay.
// GDPRConsentManagerContainer is a fixed/absolute overlay that intercepts all pointer events.
// Setting display:none via JS doesn't reliably stop interception — CSS injection with !important does.
async function dismissCookieBanner(page) {
  await page.addStyleTag({
    content: '#GDPRConsentManagerContainer { pointer-events: none !important; display: none !important; }'
  }).catch(() => {});
  log('Cookie consent: overlay disabled via CSS injection');
  await humanDelay(400, 600);
}

// ---------------------------------------------------------------------------
// Session management
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

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

async function loginToTotaljobs(page, context) {
  if (!CONFIG.tjEmail || !CONFIG.tjPassword) {
    log('No Totaljobs credentials — skipping login (set TOTALJOBS_EMAIL + TOTALJOBS_PASSWORD in .env)');
    return false;
  }

  log(`Logging in to Totaljobs as ${CONFIG.tjEmail}...`);

  try {
    // Totaljobs login: /account/signin redirects to /en-GB/candidate/login
    await page.goto('https://www.totaljobs.com/account/signin?ReturnUrl=/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await humanDelay(2000, 3000);
    await dismissCookieBanner(page);
    await humanDelay(1000, 1500);

    // Disable GDPR overlay so Playwright clicks work normally
    await dismissCookieBanner(page);

    // Fill email — input[type="email"] is reliable (only one on the login page)
    const emailInput = page.locator('input[type="email"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 10000 });
    await emailInput.fill(CONFIG.tjEmail);
    await humanDelay(300, 500);

    // Fill password
    const passInput = page.locator('input[type="password"]').first();
    await passInput.fill(CONFIG.tjPassword);
    await humanDelay(300, 500);

    // Click "Log in" — must filter to avoid the "Search" submit button on the same page
    await page.locator('button[type="submit"]').filter({ hasText: 'Log in' }).first().click();
    await page.waitForNavigation({ timeout: 15000 }).catch(() => {});
    await humanDelay(2000, 3000);

    const url = page.url();
    log(`Post-login URL: ${url.slice(0, 80)}`);

    if (!url.includes('/login') && !url.includes('/signin')) {
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
    await saveScreenshot(page, 'login_error');
    return false;
  }
}

async function ensureLoggedIn(page, context) {
  // Always try to login fresh — faster and more reliable than session cache checks
  // (Totaljobs session cookies expire quickly, making cache validation wasteful)
  const loaded = await loadSession(context);
  if (loaded) {
    log('Session cookies loaded — will verify after first navigation');
  }
  // Defer actual login check to post-navigation (see loginIfNeeded)
  return true;
}

// Check if the current page requires login and do so if needed
async function loginIfNeeded(page, context) {
  const content = await page.content();
  const url = page.url();
  const needsLogin = content.includes('Sign in') && (url.includes('/login') || url.includes('/signin') || content.includes('Jobseeker login'));
  if (needsLogin) {
    log('Login required — authenticating...');
    return await loginToTotaljobs(page, context);
  }
  // Check if we can see logged-in indicators
  const loggedIn = content.includes('My career') && (content.includes('Ngozika') || content.includes('Sign out') || content.includes('My jobs'));
  log(loggedIn ? 'Already logged in (session valid)' : 'Session state unknown — proceeding');
  return true;
}

// ---------------------------------------------------------------------------
// CV upload
// ---------------------------------------------------------------------------

async function uploadCV(page, cvPath) {
  if (!cvPath || !fs.existsSync(cvPath)) {
    log('  No CV to upload or file not found');
    return false;
  }

  const uploadSelectors = [
    'input[type="file"][accept*=".doc"]',
    'input[type="file"][accept*="pdf"]',
    'input[type="file"][name*="cv" i]',
    'input[type="file"][name*="resume" i]',
    'input[type="file"]',
  ];

  for (const selector of uploadSelectors) {
    try {
      const el = page.locator(selector).first();
      await el.waitFor({ state: 'attached', timeout: 3000 });
      await el.setInputFiles(cvPath);
      await humanDelay(1500, 2500);
      log(`  ✓ CV uploaded: ${path.basename(cvPath)}`);
      return true;
    } catch (_) {}
  }

  log('  CV upload field not found');
  return false;
}

// ---------------------------------------------------------------------------
// Fill cover letter
// ---------------------------------------------------------------------------

async function fillCoverLetter(page, coverLetter) {
  if (!coverLetter) return false;

  const selectors = [
    'textarea[name*="cover" i]',
    'textarea[id*="cover" i]',
    'textarea[placeholder*="cover" i]',
    'textarea[aria-label*="cover" i]',
    'textarea',
  ];

  for (const selector of selectors) {
    try {
      const el = page.locator(selector).first();
      await el.waitFor({ state: 'visible', timeout: 3000 });
      await el.click();
      await humanDelay(200, 400);
      await el.fill(coverLetter);
      log('  ✓ Cover letter filled');
      return true;
    } catch (_) {}
  }

  log('  Cover letter field not found');
  return false;
}

// ---------------------------------------------------------------------------
// Handle Quick Apply form / multi-step modal
// ---------------------------------------------------------------------------

async function handleQuickApplyForm(page) {
  log('Handling Quick Apply form...');
  await humanDelay(2000, 3000);

  // Re-apply GDPR suppression — new page navigation resets injected styles
  await dismissCookieBanner(page);
  await humanDelay(500, 800);

  // Upload CV
  await uploadCV(page, CONFIG.cvPath);

  // Fill cover letter if present
  await fillCoverLetter(page, CONFIG.coverLetter);

  // Multi-step: click through Continue/Next buttons, answer required questions
  for (let step = 0; step < 10; step++) {
    const state = await page.evaluate(() => {
      const visibleBtns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null).map(b => b.textContent?.trim()).filter(Boolean);
      const radios = Array.from(document.querySelectorAll('input[type="radio"]')).filter(r => r.offsetParent !== null).map(r => ({
        id: r.id, name: r.name, checked: r.checked, value: r.value,
        label: r.parentElement?.textContent?.trim() || r.id,
      }));
      const hasError = document.body.innerText.includes('Please answer') || document.body.innerText.includes('required');
      return { buttons: visibleBtns, radios, hasError };
    });

    log(`  Step ${step + 1} — buttons: [${state.buttons.slice(0, 5).join(', ')}]`);

    // Check for success/confirmation
    const successText = await page.evaluate(() => {
      const t = document.body.innerText;
      return /application sent|application submitted|thank you|we have received/i.test(t);
    });
    if (successText) {
      log('  ✓ Application confirmation detected');
      return true;
    }

    // Answer unanswered radio groups (pick Yes or first option)
    if (state.radios.length > 0) {
      const groups = {};
      state.radios.forEach(r => {
        if (!groups[r.name]) groups[r.name] = [];
        groups[r.name].push(r);
      });
      for (const [name, options] of Object.entries(groups)) {
        const answered = options.some(o => o.checked);
        if (!answered) {
          const yesOpt = options.find(o => /yes/i.test(o.label) || /yes/i.test(o.value)) || options[0];
          await page.evaluate(id => { const el = document.getElementById(id); if (el) el.click(); }, yesOpt.id);
          log(`  Answered radio "${name}": "${yesOpt.label}"`);
          await humanDelay(300, 500);
        }
      }
    }

    // Look for Submit/Send button
    const submitBtn = state.buttons.find(b => /send application|submit application|^submit$/i.test(b));
    if (submitBtn) {
      log(`  Clicking "${submitBtn}"...`);
      const beforeUrl = page.url();
      await page.evaluate(text => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.offsetParent !== null && b.textContent?.trim() === text);
        if (btn) btn.click();
      }, submitBtn);
      await humanDelay(4000, 6000);

      // Check URL changed or confirmation shown
      const afterUrl = page.url();
      const confirmed = await page.evaluate(() => /application sent|application submitted|thank you|we have received/i.test(document.body.innerText));
      if (confirmed || afterUrl !== beforeUrl) {
        log('  ✓ Application submitted successfully');
        return true;
      }
      continue;
    }

    // Look for Continue/Next button
    const continueBtn = state.buttons.find(b => /^continue$|^next$|^next step$/i.test(b));
    if (continueBtn) {
      log(`  Clicking "${continueBtn}"...`);
      await page.evaluate(text => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.offsetParent !== null && b.textContent?.trim() === text);
        if (btn) btn.click();
      }, continueBtn);
      await humanDelay(2000, 3000);
      continue;
    }

    // No recognised button — wait and recheck
    log('  No recognised button found — waiting...');
    await humanDelay(2000, 3000);
  }

  log('  Quick Apply loop exhausted without confirmation');
  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!CONFIG.url) {
    logError('--url is required');
    process.exit(1);
  }

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
      '--no-zygote',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();
  page.setDefaultTimeout(CONFIG.timeout);

  // Load cached session if available (avoids separate login navigation when still valid)
  await ensureLoggedIn(page, context);

  // Navigate to the job posting
  log(`Navigating to job: ${CONFIG.url}`);
  await page.goto(CONFIG.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await humanDelay(2000, 3000);

  // Disable cookie consent overlay
  await dismissCookieBanner(page);

  // Login if the page redirected us to a login wall
  const loginOk = await loginIfNeeded(page, context);
  if (!loginOk) {
    logError('Could not authenticate with Totaljobs');
    await browser.close();
    process.exit(1);
  }

  // If we just logged in, navigate back to the job URL
  if (!page.url().includes(new URL(CONFIG.url).pathname.split('/')[2])) {
    log('Re-navigating to job after login...');
    await page.goto(CONFIG.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await humanDelay(2000, 3000);
    await dismissCookieBanner(page);
  }

  // Screenshot before clicking Apply
  await saveScreenshot(page, 'before_apply');

  // Check current URL — if redirected away from Totaljobs, escalate
  const currentUrl = page.url();
  if (!currentUrl.includes('totaljobs.com')) {
    log(`Redirected to external ATS: ${currentUrl}`);
    log('External ATS detected — this job must be handled by a separate tool');
    await saveScreenshot(page, 'external_ats');
    await browser.close();
    process.exit(2); // Exit code 2 = external ATS redirect
  }

  // Check if already applied to this job
  const alreadyApplied = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.some(b => /already applied/i.test(b.textContent));
  });
  if (alreadyApplied) {
    log('Already applied to this job — skipping');
    await browser.close();
    process.exit(0); // Success — application already on record
  }

  // Click Apply button via JS to bypass any remaining overlay
  const applyResult = await page.evaluate(() => {
    // Try Quick Apply / Apply button selectors
    const selectors = [
      '[data-testid="harmonised-apply-button"]',
      '[data-testid="apply-button"]',
      'a[data-automation="btn-apply"]',
      'button[data-automation="btn-apply"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        el.click();
        return `clicked: ${sel}`;
      }
    }
    // Fallback: find any visible Apply button by text
    const allBtns = Array.from(document.querySelectorAll('a, button'));
    const applyBtn = allBtns.find(b => /^apply now$|^quick apply$|^apply$/i.test(b.textContent?.trim()));
    if (applyBtn) {
      applyBtn.click();
      return `clicked-by-text: ${applyBtn.tagName} "${applyBtn.textContent?.trim()}"`;
    }
    return 'not-found';
  });

  log(`Apply button: ${applyResult}`);

  // Wait for navigation to the apply form (may take a few seconds)
  await page.waitForNavigation({ timeout: 15000 }).catch(() => {});
  await humanDelay(2000, 3000);

  // Check if we've been redirected to an external employer ATS
  const afterApplyUrl = page.url();
  log(`After apply URL: ${afterApplyUrl.slice(0, 120)}`);

  if (!afterApplyUrl.includes('totaljobs.com')) {
    log(`Redirected to external ATS: ${afterApplyUrl}`);
    log('This job links to an external ATS — cannot auto-apply here');
    await saveScreenshot(page, 'external_ats_redirect');
    await browser.close();
    process.exit(2);
  }

  // Re-inject CSS on the apply form page (new navigation resets styles)
  await dismissCookieBanner(page);
  await humanDelay(500, 800);

  // We're still on Totaljobs — Quick Apply modal or form should be open
  await saveScreenshot(page, 'apply_form_opened');

  // Check if we need to log in (form might show login prompt)
  const loginPrompt = await page.evaluate(() => {
    const t = document.body.innerText.toLowerCase();
    return t.includes('sign in to apply') || t.includes('log in to apply') || t.includes('create an account');
  });

  if (loginPrompt) {
    log('Login prompt detected after clicking Apply — re-logging in...');
    await context.clearCookies();
    const loggedIn = await loginToTotaljobs(page, context);
    if (!loggedIn) {
      logError('Could not log in — saving screenshot and exiting');
      await saveScreenshot(page, 'login_required');
      await browser.close();
      process.exit(1);
    }
    // Go back to job and click Apply again
    await page.goto(CONFIG.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await humanDelay(2000, 3000);
    await dismissCookieBanner(page);
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="harmonised-apply-button"], [data-testid="apply-button"], a[data-automation="btn-apply"]');
      if (el) el.click();
    });
    await humanDelay(3000, 5000);
  }

  // Handle the Quick Apply form
  const submitted = await handleQuickApplyForm(page);

  await saveScreenshot(page, submitted ? 'success' : 'failed');

  if (!submitted) {
    logError('Application form did not confirm submission');
    await browser.close();
    process.exit(1);
  }

  log('Application complete.');
  await browser.close();
  process.exit(0);
}

main().catch(async (err) => {
  logError(`Fatal: ${err.message}`);
  process.exit(1);
});
