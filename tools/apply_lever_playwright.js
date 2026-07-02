/**
 * apply_lever_playwright.js — Playwright-based Lever job application tool.
 *
 * Handles:
 *   - Direct apply URLs (jobs.lever.co/{company}/{id}/apply)
 *   - Job listing URLs (jobs.lever.co/{company}/{id}) — clicks "Apply now" first
 *   - hCaptcha checkbox: attempts to click via iframe locator (stealth mode)
 *   - Custom card questions (radio/checkbox/textarea per company)
 *   - EEO selects → "Prefer not to say" / "Decline to identify"
 *   - Diversity surveys → "Prefer not to say"
 *
 * hCaptcha strategy:
 *   1. Click the hCaptcha iframe checkbox (works for low-risk headless sessions with stealth)
 *   2. Wait up to 8 seconds for the token to populate the hidden field
 *   3. If token still empty → save screenshot + exit code 3 (CAPTCHA blocker)
 *      Run pipeline can then mark the job as "Needs Review (captcha)"
 *
 * Usage:
 *   node tools/apply_lever_playwright.js \
 *     --url "https://jobs.lever.co/company/abc123" \
 *     --cv-path "/absolute/path/cv.docx" \
 *     --cover-letter "..." \
 *     [--headed] [--timeout 10000]
 *
 * Exit codes:
 *   0 = Applied successfully
 *   1 = Fatal error
 *   2 = Redirected to external ATS (not a Lever form)
 *   3 = hCaptcha not solved (needs human review)
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
  email: argv['email'] || process.env.CANDIDATE_EMAIL || process.env.REED_EMAIL || '',
  phone: argv['phone'] || process.env.CANDIDATE_PHONE || '',
  location: argv['location'] || process.env.CANDIDATE_LOCATION || 'London, UK',
  cvPath: argv['cv-path'] ? path.resolve(argv['cv-path']) : null,
  coverLetter: argv['cover-letter'] || '',
  headed: argv['headed'] || false,
  timeout: parseInt(argv['timeout'] || '10000', 10),
};

const TMP_DIR = path.join(process.cwd(), '.tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[apply_lever ${ts}] ${msg}`);
}

function logError(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.error(`[apply_lever ${ts}] ERROR: ${msg}`);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

async function humanDelay(min = 400, max = 1200) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function saveScreenshot(page, label) {
  const filename = `lever_${label}_${Date.now()}.png`;
  const filepath = path.join(TMP_DIR, filename);
  try {
    await page.screenshot({ path: filepath, fullPage: true });
    log(`Screenshot: ${filepath}`);
  } catch (_) {}
  return filepath;
}

// ---------------------------------------------------------------------------
// Ensure we're on the apply form (not the job listing page)
// ---------------------------------------------------------------------------

async function navigateToApplyForm(page) {
  const url = page.url();

  // If URL doesn't end in /apply, we're on the job listing — find and click Apply
  if (!url.endsWith('/apply') && !url.includes('/apply?')) {
    log('On job listing page — finding Apply button...');

    // Lever job listing page has an "Apply now" button
    const applyBtn = page.locator('a[href$="/apply"], a:has-text("Apply now"), a:has-text("Apply for this job")').first();
    try {
      await applyBtn.waitFor({ state: 'visible', timeout: 8000 });
      const applyHref = await applyBtn.getAttribute('href');
      log(`Apply href: ${applyHref}`);
      await applyBtn.click();
      await page.waitForNavigation({ timeout: 15000 }).catch(() => {});
      await humanDelay(1500, 2500);
    } catch (err) {
      logError(`Could not find Apply button: ${err.message}`);
      return false;
    }
  }

  // Verify we landed on a Lever apply form
  const currentUrl = page.url();
  if (!currentUrl.includes('jobs.lever.co')) {
    log(`Redirected to external site: ${currentUrl}`);
    return false;
  }

  log(`Apply form URL: ${currentUrl.slice(0, 90)}`);
  return true;
}

// ---------------------------------------------------------------------------
// Fill standard fields
// ---------------------------------------------------------------------------

async function fillField(page, selector, value, label) {
  if (!value) return;
  try {
    const el = page.locator(selector).first();
    await el.waitFor({ state: 'visible', timeout: 3000 });
    await el.fill(value);
    log(`  ✓ ${label}`);
    await humanDelay(200, 400);
  } catch (_) {
    log(`  - ${label} field not found`);
  }
}

async function fillStandardFields(page) {
  log('Filling standard fields...');

  await fillField(page, 'input[name="name"]', CONFIG.name, 'Name');
  await fillField(page, 'input[name="email"]', CONFIG.email, 'Email');
  await fillField(page, 'input[name="phone"]', CONFIG.phone, 'Phone');
  await fillField(page, 'input[name="location"], input[id="location-input"]', CONFIG.location, 'Location');
  await fillField(page, 'input[name="org"]', '', 'Current org (skipped)');

  // Cover letter in comments textarea
  if (CONFIG.coverLetter) {
    await fillField(page, 'textarea[name="comments"], textarea[id="additional-information"]', CONFIG.coverLetter, 'Cover letter');
  }
}

// ---------------------------------------------------------------------------
// Upload CV
// ---------------------------------------------------------------------------

async function uploadCV(page) {
  if (!CONFIG.cvPath) { log('  No CV path — skipping upload'); return; }
  if (!fs.existsSync(CONFIG.cvPath)) { logError(`CV not found: ${CONFIG.cvPath}`); return; }

  try {
    const fileInput = page.locator('input[type="file"][name="resume"], input[id="resume-upload-input"]').first();
    await fileInput.waitFor({ state: 'attached', timeout: 5000 });
    await fileInput.setInputFiles(CONFIG.cvPath);
    log(`  ✓ CV uploaded: ${path.basename(CONFIG.cvPath)}`);
    await humanDelay(1500, 2500);
  } catch (err) {
    log(`  CV upload failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Answer custom card questions (per-company radio/checkbox/textarea questions)
// ---------------------------------------------------------------------------

async function answerCustomCards(page) {
  // Get all card radio groups — pick "Yes" or first option
  const radioGroups = await page.evaluate(() => {
    const cards = {};
    Array.from(document.querySelectorAll('input[type="radio"][name^="cards["]')).forEach(r => {
      if (!cards[r.name]) cards[r.name] = [];
      cards[r.name].push({
        value: r.value,
        checked: r.checked,
        label: r.parentElement?.textContent?.trim() || r.value,
      });
    });
    return cards;
  });

  for (const [name, options] of Object.entries(radioGroups)) {
    const answered = options.some(o => o.checked);
    if (!answered && options.length > 0) {
      // Try "Yes" first, otherwise pick first option
      const target = options.find(o => /^yes$/i.test(o.label) || /^yes$/i.test(o.value)) || options[0];
      await page.evaluate(({ fieldName, value }) => {
        const el = document.querySelector(`input[type="radio"][name="${fieldName}"][value="${value}"]`);
        if (el) el.click();
      }, { fieldName: name, value: target.value });
      log(`  ✓ Card radio "${name.slice(0, 40)}": "${target.label}"`);
      await humanDelay(200, 400);
    }
  }

  // Card textareas — fill with cover letter if present, else skip
  const cardTextareas = await page.evaluate(() =>
    Array.from(document.querySelectorAll('textarea[name^="cards["]')).map(t => ({
      name: t.name,
      value: t.value,
    }))
  );
  for (const ta of cardTextareas) {
    if (!ta.value && CONFIG.coverLetter) {
      await fillField(page, `textarea[name="${ta.name}"]`, CONFIG.coverLetter.slice(0, 500), `Card textarea ${ta.name.slice(0, 30)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// EEO / diversity selects → "Prefer not to say" / "Decline to identify"
// ---------------------------------------------------------------------------

async function fillEEO(page) {
  // Use page.evaluate to avoid Playwright's selectOption() timeout issue
  // (selectOption waits defaultTimeout for the label to appear if not found)
  const filled = await page.evaluate(() => {
    const declinePatterns = /prefer not|decline|do not wish|choose not|i don.t wish/i;
    const results = [];

    // EEO selects — pick the decline option or last option
    Array.from(document.querySelectorAll('select[name^="eeo["]')).forEach(sel => {
      const opts = Array.from(sel.options);
      const declineOpt = opts.find(o => declinePatterns.test(o.text)) || opts[opts.length - 1];
      if (declineOpt && sel.value !== declineOpt.value) {
        sel.value = declineOpt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        results.push(`EEO ${sel.name}: "${declineOpt.text}"`);
      }
    });

    // Diversity survey radios — pick decline option or last per group
    const groups = {};
    Array.from(document.querySelectorAll('input[type="radio"][name^="surveysResponses["]')).forEach(r => {
      if (!groups[r.name]) groups[r.name] = [];
      groups[r.name].push(r);
    });
    Object.entries(groups).forEach(([name, radios]) => {
      const declineRadio = radios.find(r => declinePatterns.test(r.parentElement?.textContent || '')) || radios[radios.length - 1];
      if (declineRadio && !declineRadio.checked) {
        declineRadio.click();
        results.push(`Survey ${name.slice(0, 40)}: decline`);
      }
    });

    return results;
  });

  filled.forEach(r => log(`  ✓ ${r}`));
  log(`  EEO/diversity: ${filled.length} fields set`);
}

// ---------------------------------------------------------------------------
// hCaptcha: click the checkbox in the iframe
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 2captcha solver for hCaptcha (used when TWOCAPTCHA_API_KEY is set)
// ---------------------------------------------------------------------------

async function solveHCaptchaWith2captcha(sitekey, pageUrl) {
  const apiKey = process.env.TWOCAPTCHA_API_KEY;
  if (!apiKey) return null;

  log(`  Submitting to 2captcha (sitekey: ${sitekey.slice(0, 8)}...)`);

  const http = require('https');

  const post = (url, data) => new Promise((resolve, reject) => {
    const body = new URLSearchParams(data).toString();
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  const get = (url) => new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });

  // Submit task
  const submitResp = await post('https://2captcha.com/in.php', {
    key: apiKey, method: 'hcaptcha', sitekey, pageurl: pageUrl, json: '1',
  });

  let submitData;
  try { submitData = JSON.parse(submitResp); } catch (_) { log(`  2captcha submit error: ${submitResp}`); return null; }
  if (submitData.status !== 1) { log(`  2captcha error: ${submitData.request}`); return null; }

  const taskId = submitData.request;
  log(`  Task submitted: ${taskId} — polling...`);

  // Poll for result (up to 120 seconds)
  for (let i = 0; i < 24; i++) {
    await humanDelay(5000, 5000);
    const result = await get(`https://2captcha.com/res.php?key=${apiKey}&action=get&id=${taskId}&json=1`);
    let data;
    try { data = JSON.parse(result); } catch (_) { continue; }
    if (data.status === 1) {
      log(`  ✓ 2captcha solved — token length: ${data.request.length}`);
      return data.request;
    }
    if (data.request !== 'CAPCHA_NOT_READY') {
      log(`  2captcha failed: ${data.request}`);
      return null;
    }
    log(`  Waiting for 2captcha... (${(i + 1) * 5}s)`);
  }

  log('  2captcha timeout');
  return null;
}

// ---------------------------------------------------------------------------
// hCaptcha solving — try checkbox first, then 2captcha
// ---------------------------------------------------------------------------

async function solveHCaptcha(page) {
  log('Attempting hCaptcha checkbox click...');

  // Find the hCaptcha checkbox frame via page.frames() — faster and more reliable
  // than frameLocator which depends on DOM iframe attributes being stable.
  // The checkbox frame contains div[role="button"]; challenge frames are initially empty.
  let checkboxFrame = null;
  const frames = page.frames();
  for (const frame of frames) {
    if (!frame.url().includes('hcaptcha.com')) continue;
    try {
      await frame.locator('[role="button"]').first().waitFor({ state: 'visible', timeout: 1500 });
      checkboxFrame = frame;
      log(`  Found hCaptcha checkbox frame: ${frame.url().slice(0, 60)}`);
      break;
    } catch (_) {}
  }

  if (!checkboxFrame) {
    log('  hCaptcha checkbox frame not found');
    return false;
  }

  try {
    await checkboxFrame.locator('[role="button"]').first().click();
    log('  hCaptcha checkbox clicked');
    await humanDelay(4000, 6000); // Wait for verification to complete

    // Check if the token was populated
    const token = await page.evaluate(() => {
      const el = document.getElementById('hcaptchaResponseInput') ||
        document.querySelector('input[name="h-captcha-response"]');
      return el?.value || '';
    });

    if (token && token.length > 10) {
      log(`  ✓ hCaptcha token received (${token.length} chars)`);
      return true;
    }

    log('  hCaptcha token still empty — challenge appeared, trying 2captcha...');
  } catch (err) {
    log(`  hCaptcha click failed: ${err.message} — trying 2captcha...`);
  }

  // Fallback: 2captcha service
  if (!process.env.TWOCAPTCHA_API_KEY) {
    log('  No TWOCAPTCHA_API_KEY set — cannot solve automatically');
    log('  Add TWOCAPTCHA_API_KEY to .env (sign up at https://2captcha.com, ~$0.002/solve)');
    return false;
  }

  // Extract sitekey from iframe URL
  const sitekey = await page.evaluate(() => {
    const iframe = document.querySelector('iframe[src*="hcaptcha.com"]');
    if (!iframe) return null;
    const match = iframe.src.match(/sitekey=([^&]+)/);
    return match ? match[1] : null;
  });

  if (!sitekey) {
    log('  Could not extract hCaptcha sitekey');
    return false;
  }

  const token = await solveHCaptchaWith2captcha(sitekey, page.url());
  if (!token) return false;

  // Inject the token
  await page.evaluate(t => {
    const el = document.getElementById('hcaptchaResponseInput') ||
      document.querySelector('input[name="h-captcha-response"]');
    if (el) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, t);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, token);

  log('  ✓ hCaptcha token injected via 2captcha');
  return true;
}

// ---------------------------------------------------------------------------
// Submit the form
// ---------------------------------------------------------------------------

async function submitForm(page) {
  log('Submitting application...');

  const beforeUrl = page.url();

  // Lever uses a "Submit application" button of type="button" (not submit)
  // There's also a hidden type="submit" — try the visible button first
  const submitBtn = page.locator('button:has-text("Submit application"), button[type="button"]:has-text("Submit"), button[type="submit"]').first();
  try {
    await submitBtn.waitFor({ state: 'visible', timeout: 5000 });
    await submitBtn.click();
  } catch (_) {
    // Fallback: JS click
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b =>
        /submit application/i.test(b.textContent) || b.type === 'submit'
      );
      if (btn) btn.click();
    });
  }

  await humanDelay(3000, 5000);

  const afterUrl = page.url();
  const bodyText = await page.evaluate(() => document.body.innerText);

  // Check for success signals
  const successPatterns = [
    /application submitted/i,
    /application received/i,
    /thank you for applying/i,
    /we.{0,10}received your application/i,
    /your application has been/i,
    /successfully submitted/i,
  ];

  if (successPatterns.some(p => p.test(bodyText))) {
    log('✓ Application confirmed submitted');
    return true;
  }

  if (afterUrl !== beforeUrl) {
    log(`URL changed after submit → assuming success: ${afterUrl.slice(0, 80)}`);
    return true;
  }

  // Check for errors on the page
  const errorText = bodyText.match(/(captcha|error|failed|required|please fill)/i);
  if (errorText) {
    logError(`Submission error detected: "${errorText[0]}"`);
    return false;
  }

  log('Submit result ambiguous — taking screenshot');
  return null; // Ambiguous — caller decides
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!CONFIG.url) {
    logError('--url is required');
    process.exit(1);
  }

  if (!CONFIG.url.includes('lever.co')) {
    logError(`Not a Lever URL: ${CONFIG.url}`);
    process.exit(1);
  }

  log(`Starting: ${CONFIG.url}`);
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
    locale: 'en-GB',
  });

  const page = await context.newPage();
  page.setDefaultTimeout(CONFIG.timeout);

  // Navigate to the job URL
  await page.goto(CONFIG.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await humanDelay(2000, 3000);

  // If on job listing, click Apply to get to the form
  const onForm = await navigateToApplyForm(page);
  if (!onForm) {
    log('Could not reach Lever apply form — external ATS redirect');
    await saveScreenshot(page, 'external_redirect');
    await browser.close();
    process.exit(2);
  }

  await humanDelay(1500, 2500);
  await saveScreenshot(page, 'form_loaded');

  // Upload CV
  await uploadCV(page);

  // Fill standard fields
  await fillStandardFields(page);

  // Answer custom card questions
  await answerCustomCards(page);

  // Fill EEO / diversity questions
  await fillEEO(page);

  await humanDelay(1000, 1500);
  await saveScreenshot(page, 'before_captcha');

  // Solve hCaptcha
  const captchaSolved = await solveHCaptcha(page);
  if (!captchaSolved) {
    logError('hCaptcha could not be solved automatically');
    await saveScreenshot(page, 'captcha_failed');
    await browser.close();
    process.exit(3); // CAPTCHA blocker — needs human review
  }

  await saveScreenshot(page, 'before_submit');

  // Submit
  const result = await submitForm(page);
  await saveScreenshot(page, result ? 'success' : 'submit_check');

  if (result === false) {
    logError('Form submission failed');
    await browser.close();
    process.exit(1);
  }

  log('Application complete.');
  await browser.close();
  process.exit(0);
}

main().catch(async err => {
  logError(`Fatal: ${err.message}`);
  process.exit(1);
});
