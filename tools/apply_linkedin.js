/**
 * apply_linkedin.js — Submit a LinkedIn Easy Apply application.
 *
 * Strategy:
 *   - Email/password login. If LinkedIn requires a PIN/OTP, reads it from Gmail via IMAP.
 *   - Navigates to the job URL, clicks "Easy Apply", fills each modal step automatically.
 *   - Uploads CV, fills contact fields, answers screening questions, submits.
 *
 * Usage (single job):
 *   node tools/apply_linkedin.js \
 *     --url "https://www.linkedin.com/jobs/view/1234567890" \
 *     --cv-path "/path/to/cv.docx" \
 *     --cover-letter "Cover letter text"
 *
 * Usage (search mode):
 *   node tools/apply_linkedin.js \
 *     --keywords "AML compliance" --location "London" \
 *     --cv-path "/path/to/cv.docx" --max-jobs 5
 *
 * Exit codes: 0=success, 1=error
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
chromium.use(stealth());
const path = require('path');
const fs   = require('fs');
const minimist = require('minimist');

const argv = minimist(process.argv.slice(2), { string: ['url', 'cv-path', 'cover-letter', 'keywords', 'location', 'cookies-path'] });

const CONFIG = {
  email:       argv['email']        || process.env.LINKEDIN_EMAIL         || '',
  password:    argv['password']     || process.env.LINKEDIN_PASSWORD      || '',
  firstName:   argv['first-name']   || process.env.CANDIDATE_FIRST_NAME   || '',
  lastName:    argv['last-name']    || process.env.CANDIDATE_LAST_NAME    || '',
  phone:       argv['phone']        || process.env.CANDIDATE_PHONE        || '',
  cvPath:      argv['cv-path']      ? path.resolve(argv['cv-path']) : null,
  coverLetter: argv['cover-letter'] || '',
  jobUrl:      argv['url']          || '',
  keywords:    argv['keywords']     || process.env.JOB_SEARCH_KEYWORDS || 'AML compliance',
  location:    argv['location']     || process.env.JOB_SEARCH_LOCATION || 'London',
  maxJobs:     parseInt(argv['max-jobs'] || '5', 10),
  gmailPass:   process.env.SMTP_PASSWORD || '',
  loginMode:   argv['login'] || false,
};

const TMP_DIR = process.env.TMP_DIR || path.join(process.cwd(), '.tmp');
const SESSION_DIR = path.join(TMP_DIR, 'linkedin_session');

// Auto-detect session cookies: explicit arg > sessions/linkedin.json beside TMP_DIR
const _sessionsDir = path.join(path.dirname(TMP_DIR), 'sessions');
const _autoSessionFile = path.join(_sessionsDir, 'linkedin.json');
const cookiesFile = argv['cookies-path'] || (fs.existsSync(_autoSessionFile) ? _autoSessionFile : '');
const hasCookiesFile = cookiesFile && fs.existsSync(cookiesFile);
const hasSession = fs.existsSync(SESSION_DIR);
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

function log(msg) {
  console.log(`[linkedin ${new Date().toISOString().slice(11,19)}] ${msg}`);
}

async function screenshot(page, label) {
  const p = path.join(TMP_DIR, `linkedin_${label}_${Date.now()}.png`);
  await page.screenshot({ path: p, fullPage: false }).catch(() => {});
  log(`Screenshot: ${p}`);
}

// ── Gmail IMAP OTP reader ─────────────────────────────────────────────────────
async function readGmailOTP({ email, password, maxWaitSeconds = 90, fromPattern = /linkedin/i }) {
  const { ImapFlow } = require('imapflow');
  log(`Reading Gmail IMAP for OTP (from: linkedin)...`);
  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user: email, pass: password }, logger: false,
  });
  await client.connect();
  await client.mailboxOpen('INBOX');

  const deadline = Date.now() + maxWaitSeconds * 1000;
  let code = null;

  while (Date.now() < deadline && !code) {
    const since = new Date(Date.now() - 5 * 60 * 1000);
    for await (const msg of client.fetch({ since }, { envelope: true, source: true })) {
      const from = (msg.envelope?.from || []).map(f => f.address || '').join(' ');
      if (!fromPattern.test(from)) continue;

      const raw = msg.source?.toString('utf8') || '';
      const decoded = raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi,
        (_, h) => String.fromCharCode(parseInt(h, 16)));
      const text = decoded.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');

      const m = text.match(/\b(\d{6})\b/) ||
                text.match(/pin[^0-9]*(\d{4,8})/i) ||
                text.match(/verification code[^0-9]*(\d{4,8})/i) ||
                text.match(/your code[^0-9]*(\d{4,8})/i);
      if (m) { code = m[1]; break; }
    }
    if (!code) await new Promise(r => setTimeout(r, 5000));
  }

  await client.logout();
  if (code) log(`✓ OTP: ${code}`);
  else log('✗ OTP not found within timeout');
  return code;
}

// ── Login ─────────────────────────────────────────────────────────────────────
async function login(page) {
  log(`Logging in as ${CONFIG.email}...`);
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'commit', timeout: 30000 });
  await page.waitForTimeout(2000);

  const _unEl = page.locator('#username');
  if (!await _unEl.isVisible({ timeout: 8000 }).catch(() => false)) {
    log('WARNING: #username not visible - checkpoint page detected');
    await screenshot(page, 'login_blocked');
    return false;
  }
  await _unEl.fill(CONFIG.email);
  await page.waitForTimeout(300);
  await page.locator('#password').fill(CONFIG.password);
  await page.waitForTimeout(300);
  await page.locator('button[type="submit"]').click();
  await page.waitForTimeout(4000);

  await screenshot(page, 'after_login');

  // Handle PIN/OTP verification page
  for (let attempt = 0; attempt < 3; attempt++) {
    const url = page.url();
    const body = await page.innerText('body').catch(() => '');

    if (/checkpoint|verify|pin|verification|security/i.test(url) ||
        /enter the pin|verification code|sent.*code|check your email/i.test(body)) {
      log('Verification page — reading OTP from Gmail...');
      const otp = await readGmailOTP({
        email: CONFIG.email,
        password: CONFIG.gmailPass,
        maxWaitSeconds: 90,
        fromPattern: /linkedin/i,
      });
      if (otp) {
        // LinkedIn PIN input: single box or split inputs
        const pinInput = page.locator('input[name="pin"], input[id*="pin"], input[autocomplete*="one-time"], input[type="number"], input[inputmode="numeric"]').first();
        if (await pinInput.isVisible().catch(() => false)) {
          await pinInput.fill(otp);
          await page.waitForTimeout(500);
          await page.locator('button[type="submit"], button:has-text("Verify"), button:has-text("Submit")').first().click();
          await page.waitForTimeout(3000);
        }
      }
    }

    if (!/login|checkpoint|verify|challenge/i.test(page.url()) || page.url().includes('feed')) {
      log(`Login confirmed: ${page.url().slice(0, 60)}`);
      return true;
    }
  }

  const loggedIn = !/login|checkpoint|verify/i.test(page.url()) || page.url().includes('feed');
  log(loggedIn ? 'Login confirmed' : `WARNING: Still on auth page: ${page.url().slice(0, 80)}`);
  return loggedIn;
}

// ── Fill one step of the Easy Apply modal ────────────────────────────────────
async function fillModalStep(page, stepNum) {
  const modal = page.locator('.jobs-easy-apply-modal, [role="dialog"]').first();
  let cvUploaded = false;

  // ── Contact info fields ──
  for (const [sel, val] of [
    ['input[id*="firstName" i], input[placeholder*="First name" i]', CONFIG.firstName],
    ['input[id*="lastName" i], input[placeholder*="Last name" i]', CONFIG.lastName],
    ['input[id*="phone" i], input[type="tel"]', CONFIG.phone],
    ['input[id*="city" i], input[placeholder*="City" i]', 'London'],
  ]) {
    const el = modal.locator(sel).first();
    if (await el.isVisible().catch(() => false)) {
      const cur = await el.inputValue().catch(() => '');
      if (!cur || cur.trim() === '') {
        await el.fill(val).catch(() => {});
      }
    }
  }

  // ── CV upload ──
  if (CONFIG.cvPath && fs.existsSync(CONFIG.cvPath)) {
    const uploadBtn = modal.locator('button:has-text("Upload resume"), label:has-text("Upload"), button:has-text("Change resume")').first();
    const fileInput = modal.locator('input[type="file"]').first();

    if (await uploadBtn.isVisible().catch(() => false) || await fileInput.isVisible().catch(() => false)) {
      try {
        const [chooser] = await Promise.all([
          page.waitForFileChooser({ timeout: 3000 }).catch(() => null),
          (await uploadBtn.isVisible().catch(() => false)) ? uploadBtn.click() : Promise.resolve(),
        ]);
        if (chooser) {
          await chooser.setFiles(CONFIG.cvPath);
          cvUploaded = true;
        } else if (await fileInput.isVisible().catch(() => false)) {
          await fileInput.setInputFiles(CONFIG.cvPath);
          cvUploaded = true;
        }
        if (cvUploaded) {
          log(`CV uploaded: ${path.basename(CONFIG.cvPath)}`);
          await page.waitForTimeout(2000);
        }
      } catch (e) {
        log(`CV upload: ${e.message.slice(0, 60)}`);
      }
    }
  }

  // ── Text inputs / textareas (screening questions) ──
  const textInputs = modal.locator('input[type="text"]:not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled])');
  const textCount = await textInputs.count().catch(() => 0);
  for (let i = 0; i < textCount; i++) {
    const el = textInputs.nth(i);
    const cur = await el.inputValue().catch(() => '');
    if (cur.trim()) continue;
    const label = await el.evaluate(el => {
      const id = el.id;
      const lbl = id ? document.querySelector(`label[for="${id}"]`)?.innerText : '';
      return lbl || el.placeholder || el.name || '';
    }).catch(() => '');

    // Heuristic answers
    let answer = '5'; // default for number-ish questions
    if (/cover letter|why|motivation|tell us/i.test(label) && CONFIG.coverLetter) answer = CONFIG.coverLetter;
    else if (/salary|compensation/i.test(label)) answer = '50000';
    else if (/notice|available/i.test(label)) answer = '1 month';
    else if (/years|experience/i.test(label)) answer = '5';

    await el.fill(answer).catch(() => {});
  }

  // ── Number inputs ──
  const numInputs = modal.locator('input[type="number"]');
  const numCount = await numInputs.count().catch(() => 0);
  for (let i = 0; i < numCount; i++) {
    const v = await numInputs.nth(i).inputValue().catch(() => '');
    if (!v) await numInputs.nth(i).fill('5').catch(() => {});
  }

  // ── Radio buttons (Yes/No) ──
  const fieldsets = modal.locator('fieldset');
  const fsCount = await fieldsets.count().catch(() => 0);
  for (let i = 0; i < fsCount; i++) {
    const fs = fieldsets.nth(i);
    const legend = await fs.locator('legend, span[class*="label"]').first().innerText().catch(() => '');
    const answerNo = /sponsor|visa|right to work.*no/i.test(legend);
    const target = answerNo ? /^no$/i : /^yes$/i;
    const radio = fs.locator(`label:has-text("Yes"), label:has-text("No")`).filter({ hasText: target }).first();
    if (await radio.isVisible().catch(() => false)) {
      await radio.click().catch(() => {});
    }
  }

  // ── Dropdowns (select elements) ──
  const selects = modal.locator('select');
  const selCount = await selects.count().catch(() => 0);
  for (let i = 0; i < selCount; i++) {
    const sel = selects.nth(i);
    const cur = await sel.inputValue().catch(() => '');
    if (!cur || cur === 'Select an option' || cur === '') {
      const options = await sel.locator('option').all();
      for (const opt of options) {
        const v = await opt.getAttribute('value').catch(() => '');
        const t = await opt.innerText().catch(() => '');
        if (v && v !== '' && !/select|choose|please/i.test(t)) {
          await sel.selectOption(v).catch(() => {});
          break;
        }
      }
    }
  }

  // ── Cover letter textarea ──
  if (CONFIG.coverLetter) {
    const clArea = modal.locator('textarea[id*="cover" i], textarea[placeholder*="cover" i]').first();
    if (await clArea.isVisible().catch(() => false)) {
      const cur = await clArea.inputValue().catch(() => '');
      if (!cur) { await clArea.fill(CONFIG.coverLetter); log('Cover letter filled'); }
    }
  }

  return cvUploaded;
}

// ── Apply to a single job URL ─────────────────────────────────────────────────
async function applyToJob(page, jobUrl) {
  // Normalize to www.linkedin.com (session cookies are for www, not uk subdomain)
  const normalizedUrl = jobUrl.replace(/^https?:\/\/[a-z]{2}\.linkedin\.com/, 'https://www.linkedin.com');
  log(`\nNavigating to job: ${normalizedUrl}`);
  await page.goto(normalizedUrl, { waitUntil: 'commit', timeout: 90000 });
  await page.waitForTimeout(3000);
  await dismissCookies(page);

  // Wait for job content to fully render — wait for Apply button or job title
  await page.waitForFunction(
    () => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.some(b => /^(easy apply|apply)$/i.test(b.innerText?.trim())) ||
             document.querySelector('h1') !== null;
    },
    { timeout: 20000 }
  ).catch(() => {});
  await page.waitForTimeout(2000);
  await screenshot(page, 'job_page');

  // Check login redirect
  if (/login|authwall/i.test(page.url())) {
    log('Redirected to login — re-authenticating...');
    await login(page);
    await page.goto(normalizedUrl, { waitUntil: 'commit', timeout: 30000 });
    await page.waitForTimeout(4000);
  }

  // Already applied?
  const jobBody = await page.innerText('body').catch(() => '');
  if (/applied \d+ (day|hour|week)|you applied|application submitted/i.test(jobBody)) {
    log('Already applied — skipping');
    return true;
  }

  // Try evaluate-based click — ONLY click "Easy Apply", never plain "Apply" (external ATS)
  let applyClicked = await page.evaluate(() => {
    for (const sel of ['button', '[role="button"]', '.artdeco-button']) {
      for (const el of document.querySelectorAll(sel)) {
        const t = (el.innerText || '').trim().toLowerCase();
        if (t === 'easy apply') { el.click(); return 'easy apply'; }
      }
    }
    return null;
  }).catch(() => null);

  if (!applyClicked) {
    // Fallback: navigate via search panel with currentJobId (headless anti-bot bypass)
    const jobIdMatch = normalizedUrl.match(/\/(\d{10,})/);
    if (jobIdMatch) {
      const jk = jobIdMatch[1];
      log(`Direct URL failed — retrying via search panel (currentJobId=${jk})`);
      const searchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(CONFIG.keywords)}&location=${encodeURIComponent(CONFIG.location)}&f_AL=true&currentJobId=${jk}`;
      await page.goto(searchUrl, { waitUntil: 'commit', timeout: 30000 });
      await page.waitForTimeout(4000);
      await dismissCookies(page);
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll('button, [role="button"]')).some(b => /easy apply|apply/i.test(b.innerText?.trim())),
        { timeout: 15000 }
      ).catch(() => {});
      await page.waitForTimeout(1000);
      await screenshot(page, 'job_via_search');

      applyClicked = await page.evaluate(() => {
        // Prefer "Easy Apply" — never click plain "Apply" which opens external ATS
        for (const sel of ['button', '[role="button"]', '.artdeco-button']) {
          for (const el of document.querySelectorAll(sel)) {
            const t = (el.innerText || '').trim().toLowerCase();
            if (t === 'easy apply') { el.click(); return 'easy apply'; }
          }
        }
        return null;
      }).catch(() => null);
    }
  }

  if (!applyClicked) {
    // Check if there is only a plain "Apply" (external ATS) — mark as needs_review
    const hasExternalApply = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"], .artdeco-button'));
      return btns.some(b => /^apply$/i.test((b.innerText || '').trim()));
    }).catch(() => false);

    if (hasExternalApply) {
      log('External "Apply" button found (not Easy Apply) — marking for manual review');
      await screenshot(page, 'external_apply');
      process.exitCode = 2;  // signal: external apply, not a failure
      return 'external';
    }

    const allBtns = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button, [role="button"]')).map(b => (b.innerText || '').trim().slice(0, 40)).filter(Boolean)
    ).catch(() => []);
    log(`No Apply button found. Visible elements: ${JSON.stringify(allBtns.slice(0, 10))}`);
    await screenshot(page, 'no_apply_btn');
    return false;
  }

  log(`Easy Apply clicked`);
  await page.waitForTimeout(2500);
  await screenshot(page, 'modal_opened');

  // Multi-step modal
  let step = 0;
  const maxSteps = 10;

  while (step < maxSteps) {
    step++;
    log(`Modal step ${step}...`);

    // Check for completion
    const modalText = await page.locator('.jobs-easy-apply-modal, [role="dialog"]').first().innerText().catch(() => '');
    const pageText = await page.innerText('body').catch(() => '');
    if (/application submitted|your application was sent|done|success/i.test(modalText) ||
        /application submitted|your application was sent/i.test(pageText)) {
      log('✓ Application submitted!');
      await screenshot(page, 'submitted');
      return true;
    }

    await fillModalStep(page, step);
    await screenshot(page, `step${step}`);

    // Navigate modal using evaluate-based approach (handles artdeco-button and varying text)
    const navResult = await page.evaluate(() => {
      const containers = [document.querySelector('.jobs-easy-apply-modal, [role="dialog"]'), document.body].filter(Boolean);
      for (const container of containers) {
        const visible = Array.from(container.querySelectorAll('button')).filter(b => {
          const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0;
        });
        for (const b of visible) {
          const t = (b.innerText || b.getAttribute('aria-label') || '').trim();
          if (/submit/i.test(t)) return { action: 'submit', text: t };
        }
        for (const b of visible) {
          const t = (b.innerText || b.getAttribute('aria-label') || '').trim();
          if (/review/i.test(t)) return { action: 'review', text: t };
        }
        for (const b of visible) {
          const t = (b.innerText || b.getAttribute('aria-label') || '').trim();
          if (/next|continue/i.test(t)) return { action: 'next', text: t };
        }
        for (const b of visible) {
          const t = (b.innerText || b.getAttribute('aria-label') || '').trim();
          if (/^done$/i.test(t)) return { action: 'done', text: t };
        }
      }
      const allV = Array.from(document.querySelectorAll('button')).filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).map(b => (b.innerText || b.getAttribute('aria-label') || '').trim().slice(0, 40)).filter(Boolean);
      return { action: 'none', btns: allV };
    }).catch(() => null);

    if (!navResult || navResult.action === 'none') {
      log(`No modal nav button — buttons: ${JSON.stringify(navResult?.btns || [])}`);
      break;
    }
    if (navResult.action === 'submit') {
      log(`Clicking "${navResult.text}"`);
      await page.evaluate(() => {
        const containers = [document.querySelector('.jobs-easy-apply-modal, [role="dialog"]'), document.body].filter(Boolean);
        for (const c of containers) {
          const b = Array.from(c.querySelectorAll('button')).filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).find(b => /submit/i.test((b.innerText || b.getAttribute('aria-label') || '')));
          if (b) { b.click(); return; }
        }
      });
      await page.waitForTimeout(3000);
      const postText = await page.locator('.jobs-easy-apply-modal, [role="dialog"]').first().innerText().catch(() => '');
      if (/submitted|sent|done/i.test(postText)) {
        await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find(b => /^done$/i.test((b.innerText||'').trim())); if(b) b.click(); }).catch(()=>{});
        log('✓ Application submitted!');
        await screenshot(page, 'submitted');
        return true;
      }
    } else if (navResult.action === 'review') {
      log('Clicking "Review"');
      await page.evaluate(() => {
        const containers = [document.querySelector('.jobs-easy-apply-modal, [role="dialog"]'), document.body].filter(Boolean);
        for (const c of containers) {
          const b = Array.from(c.querySelectorAll('button')).filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).find(b => /review/i.test((b.innerText || b.getAttribute('aria-label') || '')));
          if (b) { b.click(); return; }
        }
      });
      await page.waitForTimeout(2000);
    } else if (navResult.action === 'next') {
      log(`Clicking "${navResult.text}" (step ${step})`);
      await page.evaluate(() => {
        const containers = [document.querySelector('.jobs-easy-apply-modal, [role="dialog"]'), document.body].filter(Boolean);
        for (const c of containers) {
          const b = Array.from(c.querySelectorAll('button')).filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).find(b => /next|continue/i.test((b.innerText || b.getAttribute('aria-label') || '')));
          if (b) { b.click(); return; }
        }
      });
      await page.waitForTimeout(2000);
    } else if (navResult.action === 'done') {
      log('Done — application complete');
      await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find(b => /^done$/i.test((b.innerText||'').trim())); if(b) b.click(); }).catch(()=>{});
      await screenshot(page, 'done');
      return true;
    }
  }

  const finalText = await page.innerText('body').catch(() => '');
  const success = /application submitted|your application was sent/i.test(finalText);
  log(success ? '✓ Submitted' : '? Unclear — check screenshots');
  return success;
}

// ── Search mode ───────────────────────────────────────────────────────────────
async function dismissCookies(page) {
  // Set LinkedIn's cookie consent via cookie so banner never reappears
  await page.context().addCookies([
    { name: 'li_gc', value: 'MTsxOzE3MDA0NTEyMDA7MjsyMTM7', domain: '.linkedin.com', path: '/' },
    { name: 'bcookie', value: '"v=2&' + Math.random().toString(36).slice(2) + '"', domain: '.linkedin.com', path: '/' },
  ]).catch(() => {});

  // Also click the button if visible
  const acceptBtn = page.locator('button:has-text("Accept"), button:has-text("Accept all")').first();
  if (await acceptBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await acceptBtn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1000);
    log('Cookie banner dismissed');
  }
}

async function searchJobs(page) {
  const url = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(CONFIG.keywords)}&location=${encodeURIComponent(CONFIG.location)}&f_AL=true&sortBy=DD`;
  log(`Searching Easy Apply jobs: ${url}`);
  await page.goto(url, { waitUntil: 'commit', timeout: 30000 });
  await page.waitForTimeout(4000);

  // Dismiss cookie banner if present
  await dismissCookies(page);
  await page.waitForTimeout(2000);
  await screenshot(page, 'search');

  const jobs = await page.evaluate(() => {
    // Grab all job links — works regardless of wrapper class changes
    const links = Array.from(document.querySelectorAll('a[href*="/jobs/view/"]'));
    const seen = new Set();
    return links.map(link => {
      const href = link.href.split('?')[0];
      const jk = href.match(/\/jobs\/view\/(\d+)/)?.[1];
      if (!jk || seen.has(jk)) return null;
      seen.add(jk);
      // Walk up to find card container for title/company
      let el = link;
      for (let i = 0; i < 6; i++) {
        el = el.parentElement;
        if (!el) break;
      }
      const title = el?.querySelector('strong, h3, [class*="title"]')?.innerText?.trim()
                 || link.innerText?.trim()
                 || '';
      const company = el?.querySelector('[class*="company"], [class*="subtitle"], h4')?.innerText?.trim() || '';
      return { jk, title, company, url: href };
    }).filter(Boolean);
  });

  log(`Jobs found: ${jobs.length}`);
  jobs.slice(0, 8).forEach((j, i) => log(`  [${i}] ${(j.company || '?').slice(0, 25).padEnd(25)} | ${j.title}`));
  return jobs;
}

// ── Check session validity ────────────────────────────────────────────────────
async function isLoggedIn(page) {
  try {
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'commit', timeout: 20000 });
    await page.waitForTimeout(2500);
    const url = page.url();
    if (url.includes('/feed')) return true;

    // "We're signing you in" — LinkedIn auto-completing login from cookies, just wait
    const bodyText = await page.innerText('body').catch(() => '');
    if (bodyText.includes("signing you in") || bodyText.includes("We're signing you in")) {
      log('LinkedIn auto-signing in — waiting...');
      await page.waitForURL('**/feed/**', { timeout: 15000 }).catch(() => {});
      if (page.url().includes('/feed')) return true;
    }

    // "Welcome Back" checkpoint — click account card to complete auth
    if (/login|authwall|checkpoint/i.test(page.url())) {
      // Try any account card visible on the page
      const accts = page.locator('[data-test-id="sign-in-form__sign-in-cta"], .profile-card button, li.member-tile button, div[class*="account-picker"] li').first();
      const visible = await accts.isVisible({ timeout: 3000 }).catch(() => false);
      if (visible) {
        log('Checkpoint: clicking account to authenticate');
        await accts.click();
        await page.waitForTimeout(4000);
        return page.url().includes('/feed');
      }
    }
    return false;
  } catch (e) {
    if (e.message && e.message.includes('ERR_TOO_MANY_REDIRECTS')) {
      log('Redirect loop — clearing context cookies');
      await page.context().clearCookies().catch(() => {});
    }
    return false;
  }
}

// ── Apply from search panel (click card → right panel → Apply) ───────────────
async function applyFromSearchPanel(page, maxJobs) {
  const url = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(CONFIG.keywords)}&location=${encodeURIComponent(CONFIG.location)}&f_AL=true&sortBy=DD`;
  log(`Opening search: ${url}`);
  await page.goto(url, { waitUntil: 'commit', timeout: 30000 });
  await page.waitForTimeout(4000);
  await dismissCookies(page);
  await page.waitForTimeout(2000);
  await screenshot(page, 'search');

  // Wait for job cards to load before collecting IDs
  log('Waiting for job cards to load...');
  await page.waitForSelector('a[href*="/jobs/view/"]', { timeout: 30000 }).catch(() => {
    log('Timeout waiting for job cards — trying anyway');
  });
  await page.waitForTimeout(1500);

  // Collect all job view links on the search page
  const jobLinks = await page.evaluate(() => {
    const seen = new Set();
    return Array.from(document.querySelectorAll('a[href*="/jobs/view/"]'))
      .map(a => { const m = a.href.match(/\/jobs\/view\/(\d+)/); return m ? m[1] : null; })
      .filter(jk => { if (!jk || seen.has(jk)) return false; seen.add(jk); return true; });
  }).catch(() => []);

  if (jobLinks.length === 0) {
    log('No jobs found — check screenshot for page state');
    await screenshot(page, 'no_jobs');
    return 0;
  }
  log(`Job IDs found: ${jobLinks.length} — ${jobLinks.join(', ')}`);

  let successCount = 0;
  let tried = 0;

  for (let i = 0; i < jobLinks.length && tried < maxJobs; i++) {
    const jk = jobLinks[i];
    // Navigate to search page with this job selected via currentJobId param
    // This forces LinkedIn to render the full right panel including the Apply button
    const jobSearchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(CONFIG.keywords)}&location=${encodeURIComponent(CONFIG.location)}&f_AL=true&currentJobId=${jk}`;
    await page.goto(jobSearchUrl, { waitUntil: 'commit', timeout: 30000 });
    await page.waitForTimeout(4000);
    await dismissCookies(page);
    // Wait specifically for the Apply button to render
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('button')).some(b => /easy apply|apply/i.test(b.innerText?.trim())),
      { timeout: 15000 }
    ).catch(() => {});
    await page.waitForTimeout(1000);

    // Get title from right panel
    const title = await page.locator('h1').first().innerText().catch(() => `Job ${jk}`);
    log(`Job ${jk}: ${title.trim().slice(0, 50)}`);
    await screenshot(page, `job_panel_${jk}`);

    // Apply button — LinkedIn uses button OR div/a with role="button" (artdeco-button)
    // Find and click any element with "Apply" or "Easy Apply" text
    // Only click "Easy Apply" — plain "Apply" opens external ATS in new tab (not automatable)
    const applyFound = await page.evaluate(() => {
      for (const sel of ['button', '[role="button"]', '.artdeco-button']) {
        for (const el of document.querySelectorAll(sel)) {
          const t = (el.innerText || '').trim().toLowerCase();
          if (t === 'easy apply') { el.click(); return 'easy apply'; }
        }
      }
      // Check if there's only a plain Apply (external) so we can log it
      for (const sel of ['button', '[role="button"]', '.artdeco-button']) {
        for (const el of document.querySelectorAll(sel)) {
          const t = (el.innerText || '').trim().toLowerCase();
          if (t === 'apply') return 'external';
        }
      }
      return null;
    }).catch(() => null);

    if (!applyFound || applyFound === 'external') {
      if (applyFound === 'external') {
        log(`  Job ${jk}: External apply (not Easy Apply) — skipping`);
      } else {
        const allClickable = await page.evaluate(() =>
          Array.from(document.querySelectorAll('button, [role="button"], .artdeco-button'))
            .map(b => (b.innerText || '').trim().slice(0, 40)).filter(Boolean)
        ).catch(() => []);
        log(`  No Easy Apply button. Clickables: ${JSON.stringify(allClickable.slice(0, 10))}`);
      }
      continue;
    }

    tried++;
    log(`  Clicked "${applyFound}"...`);
    // Get a locator reference for subsequent modal interactions (same button, already clicked)
    const applyBtn = page.locator('button, [role="button"]').filter({ hasText: /^(easy apply|apply)$/i }).first();
    await page.waitForTimeout(2500);
    await screenshot(page, `modal_opened_${i}`);

    // Fill modal steps
    let step = 0;
    const maxSteps = 25;
    let submitted = false;
    let consecutiveNext = 0;

    while (step < maxSteps) {
      step++;
      const modal = page.locator('.jobs-easy-apply-modal, [role="dialog"]').first();
      const modalText = await modal.innerText().catch(() => '');

      if (/application submitted|your application was sent|done/i.test(modalText)) {
        log(`  ✓ Submitted!`);
        submitted = true;
        await page.locator('button:has-text("Done"), button[aria-label*="Done"]').first().click().catch(() => {});
        break;
      }

      await fillModalStep(page, step);
      await screenshot(page, `step${i}_${step}`);

      // Find the right action button via evaluate — search dialog first, then whole page
      const navResult = await page.evaluate(() => {
        // Try dialog first, then fall back to full page
        const containers = [
          document.querySelector('.jobs-easy-apply-modal, [role="dialog"]'),
          document.body,
        ].filter(Boolean);

        for (const container of containers) {
          const btns = Array.from(container.querySelectorAll('button'));
          const visible = btns.filter(b => {
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });

          for (const b of visible) {
            const t = (b.innerText || b.getAttribute('aria-label') || '').trim();
            if (/submit/i.test(t)) return { action: 'submit', text: t };
          }
          for (const b of visible) {
            const t = (b.innerText || b.getAttribute('aria-label') || '').trim();
            if (/review/i.test(t)) return { action: 'review', text: t };
          }
          for (const b of visible) {
            const t = (b.innerText || b.getAttribute('aria-label') || '').trim();
            if (/next|continue/i.test(t)) return { action: 'next', text: t };
          }
          for (const b of visible) {
            const t = (b.innerText || b.getAttribute('aria-label') || '').trim();
            if (/^done$/i.test(t)) return { action: 'done', text: t };
          }
        }

        // Diagnosis: log all visible buttons on page
        const allVisible = Array.from(document.querySelectorAll('button'))
          .filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
          .map(b => (b.innerText || b.getAttribute('aria-label') || '').trim().slice(0, 40))
          .filter(Boolean);
        return { action: 'none', btns: allVisible };
      }).catch(() => null);

      if (!navResult || navResult.action === 'none') {
        log(`  No modal nav button — dialog buttons: ${JSON.stringify(navResult?.btns || [])}`);
        break;
      }

      if (navResult.action === 'submit') {
        consecutiveNext = 0;
        log(`  Clicking "${navResult.text}"`);
        await page.evaluate(() => {
          const dialog = document.querySelector('.jobs-easy-apply-modal, [role="dialog"]');
          const btns = Array.from(dialog?.querySelectorAll('button') || []);
          const btn = btns.find(b => /submit/i.test((b.innerText || b.getAttribute('aria-label') || '')));
          if (btn) btn.click();
        });
        await page.waitForTimeout(3000);
        const postText = await modal.innerText().catch(() => '');
        if (/submitted|sent|done/i.test(postText)) {
          submitted = true;
          await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const done = btns.find(b => /^done$/i.test((b.innerText || '').trim()));
            if (done) done.click();
          }).catch(() => {});
          log('  ✓ Submitted!');
          await screenshot(page, `submitted_${i}`);
          break;
        }
      } else if (navResult.action === 'review') {
        consecutiveNext = 0;
        log(`  Clicking "Review"`);
        await page.evaluate(() => {
          const dialog = document.querySelector('.jobs-easy-apply-modal, [role="dialog"]');
          const btns = Array.from(dialog?.querySelectorAll('button') || []);
          const btn = btns.find(b => /review/i.test((b.innerText || b.getAttribute('aria-label') || '')));
          if (btn) btn.click();
        });
        await page.waitForTimeout(2000);
      } else if (navResult.action === 'next') {
        consecutiveNext++;
        if (consecutiveNext >= 10) {
          log(`  Stuck: 10 consecutive Next clicks — required field not filling. Giving up on this job.`);
          await screenshot(page, `stuck_${i}`);
          break;
        }
        log(`  Clicking "${navResult.text}" (step ${step})`);
        await page.evaluate(() => {
          const containers = [
            document.querySelector('.jobs-easy-apply-modal, [role="dialog"]'),
            document.body,
          ].filter(Boolean);
          for (const c of containers) {
            const btns = Array.from(c.querySelectorAll('button'));
            const btn = btns.filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
              .find(b => /next|continue/i.test((b.innerText || b.getAttribute('aria-label') || '')));
            if (btn) { btn.click(); return; }
          }
        });
        await page.waitForTimeout(2000);
      } else if (navResult.action === 'done') {
        log(`  Done button — application complete`);
        submitted = true;
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const done = btns.find(b => /^done$/i.test((b.innerText || '').trim()));
          if (done) done.click();
        }).catch(() => {});
        break;
      }
    }

    if (submitted) successCount++;
    await page.waitForTimeout(2000);
  }

  return successCount;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log('LinkedIn Easy Apply tool starting...');

  // ── Login mode: headed browser for user to authenticate ──
  if (CONFIG.loginMode) {
    log('LOGIN MODE — opening headed browser. Log in, then close this terminal.');
    log(`Session will be saved to: ${SESSION_DIR}`);
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

    const context = await chromium.launchPersistentContext(SESSION_DIR, {
      headless: false,
      slowMo: 50,
      args: ['--start-maximized'],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: null,
    });
    const page = await context.newPage();

    // Pre-fill email and password so user only needs to handle 2FA/OTP if prompted
    try {
      await page.goto('https://www.linkedin.com/login', { waitUntil: 'commit' });
      await page.locator('#username').fill(CONFIG.email).catch(() => {});
      await page.locator('#password').fill(CONFIG.password).catch(() => {});
      await page.locator('button[type="submit"]').click().catch(() => {});
      log('Credentials submitted. Complete any 2FA if prompted, then close the terminal.');
    } catch (e) {
      log(`Pre-fill note: ${e.message}`);
    }
    await new Promise(() => {});
    return;
  }

  // ── Normal mode: use persistent session or injected cookies ──
  if (!hasSession && !hasCookiesFile) {
    log('No saved session and no cookies file. Run with --login first:');
    log('  node tools/apply_linkedin.js --login');
    process.exit(1);
  }

  const context = await chromium.launchPersistentContext(
    SESSION_DIR,  // always persist session; Playwright creates the dir if missing
    {
      headless: !process.env.DISPLAY,
      slowMo: 60,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
      locale: 'en-GB',
    }
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15000);

  // Inject session cookies from extension-synced file (takes priority over persistent context)
  if (hasCookiesFile) {
    try {
      const cookies = JSON.parse(fs.readFileSync(cookiesFile, 'utf8'));
      if (Array.isArray(cookies) && cookies.length > 0) {
        await context.addCookies(cookies);
        log(`Loaded ${cookies.length} session cookies from ${path.basename(cookiesFile)}`);
      }
    } catch (e) {
      log(`Warning: could not load cookies: ${e.message}`);
    }
  }

  try {
    let loggedIn = (hasSession || hasCookiesFile) ? await isLoggedIn(page) : false;
    if (!loggedIn) {
      log('Session expired — attempting headless auto-login...');
      loggedIn = await login(page);
      if (!loggedIn) {
        log('Auto-login failed — run with --login to re-authenticate manually:');
        log('  node tools/apply_linkedin.js --login');
        await context.close();
        process.exit(1);
      }
    }
    log('Session valid — proceeding');

    if (CONFIG.jobUrl) {
      const success = await applyToJob(page, CONFIG.jobUrl);
      await context.close();
      process.exit(success ? 0 : 1);
    } else {
      // Use search-panel approach (click cards in results, apply from right panel)
      const successCount = await applyFromSearchPanel(page, CONFIG.maxJobs);
      log(`Done: ${successCount}/${CONFIG.maxJobs} submitted`);
      await context.close();
      process.exit(successCount > 0 ? 0 : 1);
    }

  } catch (err) {
    log(`FATAL: ${err.message}`);
    await screenshot(page, 'fatal').catch(() => {});
    await context.close();
    process.exit(1);
  }
}

main();
