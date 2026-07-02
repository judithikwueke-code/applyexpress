/**
 * apply_reed_playwright.js — Apply to a Reed.co.uk job listing.
 *
 * Strategy:
 *   - Uses persistent browser session (run --login once to authenticate).
 *   - Navigates to the Reed job page, clicks "Apply" / "Apply now".
 *   - Reed has two apply flows:
 *       1. Reed Quick Apply — pre-fills from profile, one-click apply.
 *       2. Employer redirect — job redirects to employer ATS (external).
 *   - For Quick Apply: fills CV/cover letter fields and submits.
 *   - For external ATS redirect: exits with code 2 so pipeline routes to
 *     the correct ATS-specific tool.
 *
 * Usage:
 *   node tools/apply_reed_playwright.js \
 *     --url "https://www.reed.co.uk/jobs/aml-analyst/56583306" \
 *     --cv-path "/path/to/cv.docx" \
 *     --cover-letter "Cover letter text"
 *
 * Exit codes: 0=applied, 1=error, 2=external ATS (pipeline should retry with right tool)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
chromium.use(stealth());
const path = require('path');
const fs   = require('fs');
const minimist = require('minimist');

const argv = minimist(process.argv.slice(2), { string: ['url', 'cv-path', 'cover-letter', 'cookies-path'] });

const CONFIG = {
  email:       argv['email']        || process.env.CANDIDATE_EMAIL || process.env.REED_EMAIL || '',
  password:    argv['password']     || process.env.REED_PASSWORD  || '',
  firstName:   argv['first-name']   || process.env.CANDIDATE_FIRST_NAME || '',
  lastName:    argv['last-name']    || process.env.CANDIDATE_LAST_NAME  || '',
  phone:       argv['phone']        || process.env.CANDIDATE_PHONE      || '',
  cvPath:      argv['cv-path']      ? path.resolve(argv['cv-path']) : null,
  coverLetter: argv['cover-letter'] || '',
  jobUrl:      argv['url']          || '',
  loginMode:   argv['login']        || false,
};

const TMP_DIR = process.env.TMP_DIR || path.join(process.cwd(), '.tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const SESSION_DIR = path.join(TMP_DIR, 'reed_session');

function log(msg) {
  console.log(`[reed ${new Date().toISOString().slice(11,19)}] ${msg}`);
}

async function screenshot(page, label) {
  const p = path.join(TMP_DIR, `reed_${label}_${Date.now()}.png`);
  await page.screenshot({ path: p, fullPage: false }).catch(() => {});
  log(`Screenshot: ${p}`);
}

// ── Login via email/password ──────────────────────────────────────────────────
// Reed's auth lives on secure.reed.co.uk (OAuth) — logged in = on www.reed.co.uk, not secure subdomain
function _isReedAuthUrl(url) {
  return url.includes('secure.reed.co.uk') || url.includes('account/signin') || url.includes('account/sign-in');
}

async function login(page) {
  log(`Logging in as ${CONFIG.email}...`);
  await page.goto('https://www.reed.co.uk/account/signin', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  // If the signin page redirected us to www.reed.co.uk (not secure subdomain), already logged in
  const postNavUrl = page.url();
  if (!_isReedAuthUrl(postNavUrl)) {
    log(`Already logged in (redirected to ${postNavUrl.slice(0, 60)})`);
    return true;
  }

  // Accept cookies
  await page.locator('#onetrust-accept-btn-handler, button:has-text("Accept All")').first().click().catch(() => {});
  await page.waitForTimeout(800);

  await page.locator('input[type="email"], input[name="email"], #email').first().fill(CONFIG.email);
  await page.waitForTimeout(300);
  await page.locator('input[type="password"], input[name="password"], #password').first().fill(CONFIG.password);
  await page.waitForTimeout(300);
  // Click the active submit button — Reed uses "Continue" text (not "Sign in")
  // Use :text-is() for exact text match to avoid matching "Continue with Apple/Google"
  await page.locator('button:text-is("Continue"), button:text-is("Sign in"), button:text-is("Log in")').first().click();

  // Wait for Reed's OAuth flow to redirect back to www.reed.co.uk (up to 15 seconds)
  // The flow: reed.co.uk/account/signin → secure.reed.co.uk/login → www.reed.co.uk
  try {
    await page.waitForURL(/^https:\/\/www\.reed\.co\.uk\//i, { timeout: 15000 });
  } catch (e) {
    // Timeout or still on OAuth — let URL check below handle it
  }
  await page.waitForTimeout(2000);

  await screenshot(page, 'after_login');
  const url = page.url();

  // Check for account lockout before anything else
  const pageText = await page.innerText('body').catch(() => '');
  if (pageText.includes('account has been locked') || pageText.includes('incorrect password') || pageText.includes('too many')) {
    log('ERROR: Reed account is LOCKED due to too many failed login attempts.');
    log('ACTION REQUIRED: Reset your Reed password at reed.co.uk/forgotten-password, then re-sync cookies via the extension.');
    return false;
  }

  // Logged in = on www.reed.co.uk, NOT on secure subdomain or any auth page
  const loggedIn = url.startsWith('https://www.reed.co.uk') && !_isReedAuthUrl(url);
  log(loggedIn ? `Login confirmed: ${url.slice(0, 60)}` : `WARNING: Still on login/auth: ${url.slice(0, 60)}`);
  return loggedIn;
}

// ── Check session ─────────────────────────────────────────────────────────────
async function isLoggedIn(page) {
  try {
    await page.goto('https://www.reed.co.uk/account', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);
    // Logged in = stayed on www.reed.co.uk/account (not redirected to secure.reed.co.uk or signin)
    const url = page.url();
    return url.startsWith('https://www.reed.co.uk') && !_isReedAuthUrl(url);
  } catch (e) { return false; }
}

// ── Apply to job ──────────────────────────────────────────────────────────────
async function applyToJob(page, jobUrl) {
  log(`Navigating to: ${jobUrl}`);
  await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  await screenshot(page, 'job_page');

  // Accept cookies overlay if present
  await page.locator('#onetrust-accept-btn-handler, button:has-text("Accept All")').first().click().catch(() => {});
  await page.waitForTimeout(500);

  const bodyText = await page.innerText('body').catch(() => '');

  // Already applied?
  if (/you.ve already applied|already applied|application submitted|you applied for this job/i.test(bodyText)) {
    log('Already applied — skipping');
    return 0;
  }

  // Find Apply button
  const applyBtn = page.locator([
    'button:has-text("Apply now")',
    'button:has-text("Apply")',
    'a:has-text("Apply now")',
    '[data-qa="apply-button"]',
    '#apply-button',
  ].join(', ')).first();

  if (!await applyBtn.isVisible().catch(() => false)) {
    log('No Apply button visible');
    await screenshot(page, 'no_apply_btn');
    return 1;
  }

  // Check if clicking will redirect to external ATS
  const applyHref = await applyBtn.getAttribute('href').catch(() => '');
  if (applyHref && !applyHref.includes('reed.co.uk') && applyHref.startsWith('http')) {
    log(`External apply URL detected: ${applyHref}`);
    // Route to appropriate tool based on URL
    process.exit(2); // tell pipeline: external ATS, re-route
  }

  // Track navigation to detect external redirect
  let externalRedirect = '';
  page.on('response', resp => {
    const u = resp.url();
    if (!u.includes('reed.co.uk') && !u.includes('google') && !u.includes('static') &&
        resp.status() >= 200 && resp.status() < 400) {
      if (u.includes('greenhouse.io') || u.includes('lever.co') || u.includes('linkedin') ||
          u.includes('workday') || u.includes('smartrecruiters') || u.includes('taleo')) {
        externalRedirect = u;
      }
    }
  });

  await applyBtn.click();
  await page.waitForTimeout(3000);

  // Check if we were redirected to external ATS
  const currentUrl = page.url();
  if (externalRedirect || !currentUrl.includes('reed.co.uk')) {
    const targetUrl = externalRedirect || currentUrl;
    log(`Redirected to external ATS: ${targetUrl}`);
    process.exit(2);
  }

  // Check if Apply redirected to login page — session expired mid-flow
  if (_isReedAuthUrl(currentUrl)) {
    log(`Session expired — Apply redirected to login. Re-authenticating...`);
    if (!CONFIG.password) {
      log('ERROR: No REED_PASSWORD set — cannot re-login');
      return 1;
    }
    const relogged = await login(page);
    if (!relogged) { log('Re-login failed'); return 1; }
    // Navigate back to job page and retry
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    const applyBtnRetry = page.locator([
      'button:has-text("Apply now")', 'button:has-text("Apply")',
      'a:has-text("Apply now")', '[data-qa="apply-button"]', '#apply-button',
    ].join(', ')).first();
    if (!await applyBtnRetry.isVisible().catch(() => false)) {
      log('No Apply button after re-login');
      return 1;
    }
    await applyBtnRetry.click();
    await page.waitForTimeout(3000);
    // If still on login, bail
    if (page.url().includes('account/signin')) { log('Still on login after retry'); return 1; }
  }

  await screenshot(page, 'after_apply_click');

  // ── Reed Quick Apply flow ─────────────────────────────────────────────────
  let step = 0;
  const maxSteps = 25;
  let cvUploaded = false;

  while (step < maxSteps) {
    step++;
    log(`Step ${step}...`);
    const text = await page.innerText('body').catch(() => '');

    // Check completion
    if (/application submitted|application sent|applied successfully|thank you for applying|we.ve received|processing application/i.test(text)) {
      log('✓ Application submitted!');
      await screenshot(page, 'submitted');
      return 0;
    }

    // Check for external ATS redirect step — Reed shows this before sending to employer site
    if (/take you to the employer.s website|apply on external site|complete this application.*employer/i.test(text)) {
      log('External employer site — exiting with code 2 for pipeline routing');
      process.exit(2);
    }

    // Answer Yes/No application questions — Reed uses value="true"/"false", not "Yes"/"No".
    // Smart strategy: answer "No" for employer-affiliation questions, "Yes" for all others.
    const allModalRadios = await page.locator('.modal.show input[type="radio"]').all().catch(() => []);
    if (allModalRadios.length > 0) {
      const seenNames = new Set();
      let answered = 0;
      for (const r of allModalRadios) {
        const name = await r.getAttribute('name').catch(() => null);
        if (!name || seenNames.has(name)) continue;
        seenNames.add(name);
        // Find the question label for this group to determine Yes/No intent
        const questionEl = page.locator(`.modal.show #question-wrapper-${name}, .modal.show [id*="${name}"]`).first();
        const questionText = (await questionEl.innerText().catch(() => '')).toLowerCase();
        // "Do you currently work for X?" / "have you ever worked for X?" → answer No
        const isAffiliationQ = /currently work|previously work|ever work|work for|employee of/i.test(questionText);
        // Find the radio to click: "false" (No) for affiliation, "true" (Yes) for rest
        const targetVal = isAffiliationQ ? 'false' : 'true';
        const targetRadio = page.locator(`.modal.show input[type="radio"][name="${name}"][value="${targetVal}"]`).first();
        const fallbackRadio = page.locator(`.modal.show input[type="radio"][name="${name}"]`).first();
        const radioToClick = (await targetRadio.isVisible().catch(() => false)) ? targetRadio : fallbackRadio;
        await radioToClick.check({ force: true }).catch(() => {});
        await page.waitForTimeout(200);
        answered++;
      }
      if (answered > 0) log(`  Answered ${answered} radio question(s)`);
    }

    // Handle Reed's custom dropdown questions (Bootstrap dropdown, not native <select>)
    const dropdownToggles = await page.locator('.modal.show [data-qa="dropdown-toggle"]').all().catch(() => []);
    for (const toggle of dropdownToggles) {
      // Open the dropdown
      await toggle.click().catch(() => {});
      await page.waitForTimeout(800);
      // Click the first meaningful option using Reed's data-qa="dropdown-item" selector
      const opts = await page.locator('[data-qa="dropdown-item"]').all().catch(() => []);
      for (const opt of opts) {
        const txt = (await opt.innerText().catch(() => '')).trim();
        if (txt && txt.length > 2) {
          await opt.click({ force: true }).catch(() => {});
          log(`  Dropdown: selected "${txt.slice(0, 60)}"`);
          await page.waitForTimeout(500);
          break;
        }
      }
    }

    // Handle required textarea fields in screening questions (e.g. "Personal summary")
    // Fill with cover letter text (already tailored) or a brief professional summary.
    const screeningTextareas = await page.locator('.modal.show textarea').all().catch(() => []);
    for (const ta of screeningTextareas) {
      const cur = (await ta.inputValue().catch(() => '')).trim();
      if (!cur) {
        const fillText = CONFIG.coverLetter
          ? CONFIG.coverLetter.slice(0, 1000)
          : `Experienced professional with a strong background relevant to this role. I am seeking a position where I can apply my skills and contribute to your organisation's objectives. I am available for an interview at your earliest convenience.`;
        await ta.fill(fillText).catch(() => {});
        log(`  Filled textarea (${fillText.length} chars)`);
      }
    }

    // Determine scope — Reed Quick Apply uses a modal overlay
    // Use data-modal attribute to scope interactions directly (more reliable than class chain)
    // Two [data-modal] elements exist — only the one with class "show" is active
    // Use a single selector (no comma) so descendant selectors work correctly
    const MODAL_SEL = '.modal.show';
    const isModal = await page.locator(MODAL_SEL).first().isVisible().catch(() => false);
    log(`  Modal visible: ${isModal}`);

    // CV upload — handles three Reed modal variants:
    // 1. "Upload your CV to continue" — new flow: "Choose your CV file" button reveals hidden input
    // 2. Logged-in review modal — "Update" button next to existing CV
    // 3. Direct visible file input (guest/non-logged-in flow)
    if (CONFIG.cvPath && fs.existsSync(CONFIG.cvPath) && !cvUploaded) {
      // Variant 1: new "Upload your CV to continue" modal with "Choose your CV file" button
      const chooseBtn = page.locator('button:has-text("Choose your CV file"), a:has-text("Choose your CV file")').first();
      if (await chooseBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        log('New Reed CV upload modal detected — clicking "Choose your CV file"');
        // The file input is hidden; set files directly without clicking (avoids OS dialog)
        const fileInput = page.locator('input[type="file"]').first();
        try {
          await fileInput.waitFor({ state: 'attached', timeout: 5000 });
          await fileInput.setInputFiles(CONFIG.cvPath);
          log(`CV uploaded (new modal): ${path.basename(CONFIG.cvPath)}`);
          cvUploaded = true;
          // Wait for "CV processing..." to clear before continuing
          await page.waitForFunction(
            () => !document.body.innerText.includes('CV processing'),
            { timeout: 15000 }
          ).catch(() => log('CV processing wait timed out — continuing anyway'));
        } catch (e) {
          log(`CV upload (new modal) failed: ${e.message}`);
        }
      } else {
        // Variant 2: logged-in review modal — "Update" button next to existing CV
        const updateBtn = page.locator(`${MODAL_SEL} button:has-text("Update"), ${MODAL_SEL} a:has-text("Update"), button:has-text("Update CV"), a:has-text("Update CV")`).first();
        if (await updateBtn.isVisible().catch(() => false)) {
          log('Clicking "Update" to replace profile CV with tailored CV…');
          await updateBtn.click();
          await page.waitForTimeout(1500);
          const fileInput = page.locator(`${MODAL_SEL} input[type="file"], input[type="file"]`).first();
          try {
            await fileInput.waitFor({ state: 'attached', timeout: 5000 });
            await fileInput.setInputFiles(CONFIG.cvPath);
            log(`CV updated: ${path.basename(CONFIG.cvPath)}`);
            cvUploaded = true;
            await page.waitForTimeout(2000);
          } catch (_) {
            log('Update clicked but no file input appeared — profile CV will be used');
          }
        } else {
          // Variant 3: direct visible file input (guest flow)
          const fileInputDirect = page.locator(`${MODAL_SEL} input[type="file"], input[type="file"]`).first();
          if (await fileInputDirect.isVisible().catch(() => false)) {
            await fileInputDirect.setInputFiles(CONFIG.cvPath);
            log(`CV uploaded (direct): ${path.basename(CONFIG.cvPath)}`);
            cvUploaded = true;
            await page.waitForTimeout(2000);
          }
        }
      }
    }

    // Cover letter — Reed review modal has an "Add" button to open the cover letter section.
    // Click Add to expose the textarea, then fill it.
    if (CONFIG.coverLetter) {
      // Try to find existing textarea first
      const clSel = isModal
        ? `${MODAL_SEL} textarea[name*="cover"], ${MODAL_SEL} textarea[id*="cover"], ${MODAL_SEL} textarea[placeholder*="cover" i], ${MODAL_SEL} textarea`
        : 'textarea[name*="cover"], textarea[id*="cover"], textarea[placeholder*="cover" i]';
      const clArea = page.locator(clSel).first();
      if (await clArea.isVisible().catch(() => false)) {
        const cur = await clArea.inputValue().catch(() => '');
        if (!cur) { await clArea.fill(CONFIG.coverLetter); log('Cover letter filled (direct textarea)'); }
      } else {
        // Logged-in review modal: click "Add" button next to "Cover letter"
        const addBtn = page.locator(`${MODAL_SEL} button:has-text("Add"), ${MODAL_SEL} a:has-text("Add")`).first();
        if (await addBtn.isVisible().catch(() => false)) {
          log('Clicking "Add" to open cover letter field…');
          await addBtn.click();
          await page.waitForTimeout(1500);
          const clAreaAfter = page.locator(`${MODAL_SEL} textarea`).first();
          if (await clAreaAfter.isVisible().catch(() => false)) {
            const cur = await clAreaAfter.inputValue().catch(() => '');
            if (!cur) { await clAreaAfter.fill(CONFIG.coverLetter); log('Cover letter filled (via Add button)'); }
          }
        }
      }
    }

    // Fill contact fields if empty
    for (const [fieldSel, val] of [
      ['input[name*="phone" i], input[type="tel"]', CONFIG.phone],
      ['input[name*="firstName" i], input[placeholder*="First" i]', CONFIG.firstName],
      ['input[name*="lastName" i], input[placeholder*="Last" i]', CONFIG.lastName],
    ]) {
      const elSel = isModal ? `${MODAL_SEL} ${fieldSel}` : fieldSel;
      const el = page.locator(elSel).first();
      if (await el.isVisible().catch(() => false)) {
        const cur = await el.inputValue().catch(() => '');
        if (!cur) await el.fill(val).catch(() => {});
      }
    }

    await screenshot(page, `step${step}`);

    // Wait for Reed's "CV processing..." loader to clear before looking for buttons
    await page.waitForFunction(
      () => !document.querySelector('.modal.show')?.innerText?.includes('CV processing'),
      { timeout: 12000 }
    ).catch(() => {}); // if no loader, continue immediately

    // Click Continue / Next / Submit — prefer modal-scoped buttons to avoid background buttons
    const btnSel = isModal
      ? `${MODAL_SEL} button:has-text("Submit application"), ${MODAL_SEL} button:has-text("Submit"), ${MODAL_SEL} button:has-text("Continue"), ${MODAL_SEL} button:has-text("Next"), ${MODAL_SEL} button[type="submit"]`
      : 'button:has-text("Submit application"), button:has-text("Submit"), button:has-text("Continue"), button:has-text("Next"), button[type="submit"]';
    const nextBtn = page.locator(btnSel).first();

    if (await nextBtn.isVisible().catch(() => false)) {
      const txt = await nextBtn.innerText().catch(() => '?');
      log(`Clicking: "${txt.trim()}"`);
      await nextBtn.click();
      await page.waitForTimeout(2500);
    } else {
      log('No navigation button — stopping');
      break;
    }
  }

  await page.waitForTimeout(3000);
  const finalText = await page.innerText('body').catch(() => '');
  const success = /application submitted|application sent|applied successfully|thank you for applying|we.ve received|processing application|your application has been|you.ve applied|application received|thanks for applying/i.test(finalText);
  log(success ? '\u2713 Submitted' : '? Unclear — check screenshots');
  return success ? 0 : 1;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log('Reed apply tool starting...');

  if (!CONFIG.jobUrl && !CONFIG.loginMode) {
    log('ERROR: --url is required');
    process.exit(1);
  }

  // Login mode: save session
  if (CONFIG.loginMode) {
    log('LOGIN MODE — opening headed browser.');
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
    const context = await chromium.launchPersistentContext(SESSION_DIR, {
      headless: false, slowMo: 50, args: ['--start-maximized'], viewport: null,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    await page.goto('https://www.reed.co.uk/account/signin');
    await page.locator('input[type="email"]').first().fill(CONFIG.email).catch(() => {});
    await page.locator('input[type="password"]').first().fill(CONFIG.password).catch(() => {});
    log('Credentials pre-filled. Complete login, then Ctrl+C.');
    await new Promise(() => {});
    return;
  }

  // Normal mode
  const cookiesFile = argv['cookies-path'] || '';
  const hasCookiesFile = cookiesFile && fs.existsSync(cookiesFile);
  const hasSession = fs.existsSync(SESSION_DIR);
  const context = await chromium.launchPersistentContext(hasSession ? SESSION_DIR : path.join(TMP_DIR, 'reed_session_new'), {
    headless: true, slowMo: 60,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-GB',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);

  // Inject uploaded session cookies if provided (takes priority over persistent context)
  if (hasCookiesFile) {
    try {
      const cookies = JSON.parse(fs.readFileSync(cookiesFile, 'utf8'));
      if (Array.isArray(cookies) && cookies.length > 0) {
        await context.addCookies(cookies);
        log(`Loaded ${cookies.length} session cookies from ${path.basename(cookiesFile)}`);
      }
    } catch (e) {
      log(`Warning: could not load cookies from ${cookiesFile}: ${e.message}`);
    }
  }

  try {
    // Try session first (from persistent context or injected cookies), fall back to credential login
    let loggedIn = (hasSession || hasCookiesFile) ? await isLoggedIn(page) : false;

    if (!loggedIn) {
      // Only attempt password login if we have NO session cookies at all.
      // If cookies were present but expired, exit cleanly — retrying with password
      // risks locking the account after repeated pipeline runs.
      if (hasCookiesFile) {
        log('Session cookies expired or rejected. Re-sync your Reed session via the browser extension.');
        await context.close(); process.exit(1);
      }
      if (!CONFIG.password) {
        log('ERROR: REED_PASSWORD not set in .env. Run --login first or set the password.');
        await context.close(); process.exit(1);
      }
      loggedIn = await login(page);
    }

    if (!loggedIn) {
      log('Login failed');
      await context.close(); process.exit(1);
    }

    const exitCode = await applyToJob(page, CONFIG.jobUrl);
    await context.close();
    process.exit(exitCode);

  } catch (err) {
    log(`FATAL: ${err.message}`);
    await screenshot(page, 'fatal').catch(() => {});
    await context.close();
    process.exit(1);
  }
}

main();
