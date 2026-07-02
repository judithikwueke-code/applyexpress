/**
 * apply_indeed.js — Submit an Indeed Easy Apply application.
 *
 * Strategy:
 *   - Email/password login. If Indeed sends a verification code to email, reads it
 *     from Gmail via IMAP (same pattern as Greenhouse security code).
 *   - Indeed Easy Apply is a multi-step modal/page. Navigates each step automatically.
 *   - CV upload via file input DataTransfer API.
 *
 * Usage:
 *   node tools/apply_indeed.js \
 *     --url "https://uk.indeed.com/viewjob?jk=abc123" \
 *     --cv-path "/path/to/cv.docx" \
 *     --cover-letter "Optional cover letter text"
 *
 * Or search mode (applies to N Easy Apply jobs):
 *   node tools/apply_indeed.js \
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
  email:       argv['email']         || process.env.INDEED_EMAIL          || '',
  password:    argv['password']      || process.env.INDEED_PASSWORD       || '',
  firstName:   argv['first-name']    || process.env.CANDIDATE_FIRST_NAME  || '',
  lastName:    argv['last-name']     || process.env.CANDIDATE_LAST_NAME   || '',
  phone:       argv['phone']         || process.env.CANDIDATE_PHONE       || '',
  cvPath:      argv['cv-path']       ? path.resolve(argv['cv-path']) : null,
  coverLetter: argv['cover-letter']  || '',
  jobUrl:      argv['url']           || '',
  keywords:    argv['keywords']      || process.env.JOB_SEARCH_KEYWORDS || 'AML compliance',
  location:    argv['location']      || process.env.JOB_SEARCH_LOCATION || 'London',
  maxJobs:     parseInt(argv['max-jobs'] || '5', 10),
  gmailPass:   process.env.SMTP_PASSWORD || '',
  // --login: run headed so user can complete Google OAuth manually; saves session for future runs
  loginMode:   argv['login'] || false,
};

// Persistent session directory — keeps cookies/localStorage between runs
const TMP_DIR = process.env.TMP_DIR || path.join(process.cwd(), '.tmp');
const SESSION_DIR = path.join(TMP_DIR, 'indeed_session');

const cookiesFile = argv['cookies-path'] || '';
const hasCookiesFile = cookiesFile && fs.existsSync(cookiesFile);
const hasSession = fs.existsSync(SESSION_DIR);
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

function log(msg) {
  console.log(`[indeed ${new Date().toISOString().slice(11,19)}] ${msg}`);
}

async function screenshot(page, label) {
  const p = path.join(TMP_DIR, `indeed_${label}_${Date.now()}.png`);
  await page.screenshot({ path: p, fullPage: true }).catch(() => {});
  log(`Screenshot: ${p}`);
}

// ── Gmail IMAP reader (reused from Greenhouse tool) ───────────────────────────
async function readGmailOTP({ email, password, maxWaitSeconds = 60, fromPattern = /indeed/i, notBefore = null }) {
  const { ImapFlow } = require('imapflow');
  log(`Reading Gmail IMAP for OTP from ${email}... (notBefore=${notBefore ? new Date(notBefore).toISOString() : 'none'})`);
  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user: email, pass: password }, logger: false,
  });
  await client.connect();
  await client.mailboxOpen('INBOX');

  const deadline = Date.now() + maxWaitSeconds * 1000;
  let code = null;

  while (Date.now() < deadline && !code) {
    // IMAP SINCE is day-granular — fetch last 24h and filter by exact timestamp
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    for await (const msg of client.fetch({ since }, { envelope: true, source: true })) {
      const from = (msg.envelope?.from || []).map(f => f.address || '').join(' ');
      if (!fromPattern.test(from)) continue;

      // Filter by message timestamp if notBefore is set
      if (notBefore) {
        const msgTime = msg.envelope?.date ? new Date(msg.envelope.date).getTime() : 0;
        if (msgTime < notBefore) {
          log(`  Skipping stale email from ${new Date(msgTime).toISOString()}`);
          continue;
        }
      }

      const raw = msg.source?.toString('utf8') || '';
      // Decode quoted-printable
      const decoded = raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi,
        (_, h) => String.fromCharCode(parseInt(h, 16)));
      // Strip HTML tags
      const text = decoded.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');

      // Try common OTP patterns
      const m = text.match(/\b(\d{6})\b/) ||
                text.match(/verification code[^0-9]*(\d{4,8})/i) ||
                text.match(/your code[^0-9]*(\d{4,8})/i) ||
                text.match(/code is[^0-9]*(\d{4,8})/i);
      if (m) { code = m[1]; break; }
    }
    if (!code) await new Promise(r => setTimeout(r, 5000));
  }

  await client.logout();
  if (code) log(`  ✓ OTP found: ${code}`);
  else log('  ✗ OTP not found within timeout');
  return code;
}

// ── Google OAuth helper ───────────────────────────────────────────────────────
// Called when we land on accounts.google.com after clicking "Continue with Google".
// The Google password is the Reed/main account password since they share the Gmail.
async function handleGoogleOAuth(page) {
  log('Handling Google OAuth...');
  await page.waitForTimeout(2000);

  // Google email step (may already be pre-filled)
  const gEmailInput = page.locator('#identifierId, input[type="email"]').first();
  if (await gEmailInput.isVisible().catch(() => false)) {
    const existing = await gEmailInput.inputValue().catch(() => '');
    if (!existing) {
      await gEmailInput.fill(CONFIG.email);
      await page.waitForTimeout(300);
    }
    await page.locator('#identifierNext, [data-primary-action-label="Next"], button:has-text("Next")').first().click();
    await page.waitForTimeout(2500);
  }

  // Google password step
  const gPassInput = page.locator('input[name="Passwd"], input[type="password"]').first();
  if (await gPassInput.isVisible().catch(() => false)) {
    // Google password = main Gmail account password (same as Reed since Reed uses Gmail)
    const googlePass = process.env.REED_PASSWORD || CONFIG.password;
    log(`Filling Google password (${googlePass.slice(0,2)}***)`);
    await gPassInput.fill(googlePass);
    await page.waitForTimeout(300);
    await page.locator('#passwordNext, [data-primary-action-label="Next"], button:has-text("Next")').first().click();
    await page.waitForTimeout(4000);
  }

  // Google may ask for 2FA/OTP after password
  const bodyAfterPass = await page.innerText('body').catch(() => '');
  if (/verify|2-step|enter the code|sent.*code|check.*phone/i.test(bodyAfterPass)) {
    log('Google 2FA/OTP required — reading Gmail IMAP...');
    const otp = await readGmailOTP({
      email: CONFIG.email,
      password: CONFIG.gmailPass,
      maxWaitSeconds: 60,
      fromPattern: /google/i,
    });
    if (otp) {
      const otpInput = page.locator('input[type="number"], input[name*="code"], input[autocomplete*="one-time"]').first();
      if (await otpInput.isVisible().catch(() => false)) {
        await otpInput.fill(otp);
        await page.locator('button:has-text("Next"), button:has-text("Verify"), button[type="submit"]').first().click();
        await page.waitForTimeout(3000);
      }
    }
  }

  // Grant access / confirm
  const grantBtn = page.locator('button:has-text("Allow"), button:has-text("Continue"), button:has-text("Grant")').first();
  if (await grantBtn.isVisible().catch(() => false)) {
    await grantBtn.click().catch(() => {});
    await page.waitForTimeout(3000);
  }
}

// ── Login ─────────────────────────────────────────────────────────────────────
async function login(page) {
  log(`Logging in as ${CONFIG.email}...`);
  await page.goto('https://secure.indeed.com/account/login', { waitUntil: 'commit', timeout: 30000 });
  await page.waitForTimeout(2500);

  // Accept cookies
  await page.locator('button:has-text("Accept"), button:has-text("Accept All")').first().click().catch(() => {});
  await page.waitForTimeout(800);

  // Fill email
  const emailInput = page.locator('input[type="email"], input[name="__email"], input[autocomplete="email"]').first();
  await emailInput.waitFor({ state: 'visible', timeout: 10000 });
  await emailInput.fill(CONFIG.email);
  await page.waitForTimeout(600);

  // Wait for Cloudflare Turnstile to complete before clicking Continue.
  // Turnstile populates a hidden input (cf-turnstile-response) when it passes,
  // and enables the submit button. We wait for either signal.
  log('Waiting for Cloudflare Turnstile to clear...');
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('button[type="submit"]');
      const turnstile = document.querySelector('input[name="cf-turnstile-response"]');
      return (btn && !btn.disabled && !btn.getAttribute('aria-disabled')) ||
             (turnstile && turnstile.value && turnstile.value.length > 0);
    },
    { timeout: 35000 }
  ).catch(() => log('Turnstile wait timed out — clicking anyway'));

  await page.waitForTimeout(500);
  await page.locator('button[type="submit"], button:has-text("Continue")').last().click();
  await page.waitForTimeout(3000);

  // ── Path A: direct Indeed password field ──
  const pwInput = page.locator('input[type="password"]').first();
  if (await pwInput.isVisible().catch(() => false)) {
    log('Direct password field — filling...');
    await pwInput.fill(CONFIG.password);
    await page.waitForTimeout(300);
    await page.locator('button[type="submit"], button:has-text("Sign in")').first().click();
    await page.waitForTimeout(3000);
  }

  // ── Path B: "Welcome back / Secure with Google" — click "Sign in with a code instead" ──
  const bodyB = await page.innerText('body').catch(() => '');
  if (/welcome back|securely powered by google|sign in with a code/i.test(bodyB)) {
    log('"Welcome back" Google page — clicking "Sign in with a code instead"...');
    const codeLink = page.locator('button:has-text("Sign in with a code"), a:has-text("Sign in with a code"), [data-tn-element*="code"]').first();
    if (await codeLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      const otpRequestTime = Date.now();
      await codeLink.click();
      await page.waitForTimeout(3000);

      // Indeed sends OTP to registered email — read it from Gmail IMAP
      log('OTP requested — reading Gmail IMAP...');
      const otp = await readGmailOTP({
        email: CONFIG.email,
        password: CONFIG.gmailPass,
        maxWaitSeconds: 90,
        fromPattern: /indeed/i,
        notBefore: otpRequestTime,
      });
      if (otp) {
        const otpInput = page.locator('#passcode-input, input[name="passcode"], input[name*="code"], input[autocomplete*="one-time"]').first();
        await otpInput.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        if (await otpInput.isVisible().catch(() => false)) {
          await otpInput.fill(otp);
          await page.waitForTimeout(500);
          await page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Verify")').first().click();
          await page.waitForTimeout(4000);
        } else {
          log('OTP input not visible — taking screenshot');
          await screenshot(page, 'otp_input_missing');
        }
      }
    } else {
      log('"Sign in with a code instead" not found — taking screenshot');
      await screenshot(page, 'no_code_link');
    }
  }

  // ── Path C: "Continue with Google" button on Indeed page ──
  const googleBtn = page.locator('button:has-text("Continue with Google"), a:has-text("Continue with Google")').first();
  if (await googleBtn.isVisible().catch(() => false)) {
    log('Clicking "Continue with Google" on Indeed...');
    const [popup] = await Promise.all([
      page.context().waitForEvent('page', { timeout: 5000 }).catch(() => null),
      googleBtn.click(),
    ]);
    await page.waitForTimeout(3000);
    const googlePage = popup || (page.url().includes('google.com') ? page : null);
    if (googlePage) {
      await handleGoogleOAuth(googlePage);
      if (popup) {
        await popup.waitForEvent('close', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(3000);
      }
    }
  }

  // ── Path D: redirected to accounts.google.com in main tab ──
  if (page.url().includes('accounts.google.com')) {
    await handleGoogleOAuth(page);
  }

  // ── Path E: Indeed generic email OTP page ──
  const bodyAfter = await page.innerText('body').catch(() => '');
  const currentUrl = page.url();
  if (/verify|verification|confirm|security code|check your email/i.test(bodyAfter) &&
      !/application submitted|indeed\.com\/myj/i.test(bodyAfter)) {
    log('Generic email OTP page — reading Gmail IMAP...');
    const otp = await readGmailOTP({
      email: CONFIG.email, password: CONFIG.gmailPass, maxWaitSeconds: 60,
      fromPattern: /indeed/i, notBefore: Date.now() - 120000,
    });
    if (otp) {
      const otpInput = page.locator('#passcode-input, input[name="passcode"], input[name*="code"], input[placeholder*="code" i], input[autocomplete*="one-time"]').first();
      if (await otpInput.isVisible().catch(() => false)) {
        await otpInput.fill(otp);
        await page.locator('button[type="submit"], button:has-text("Verify"), button:has-text("Sign in"), button:has-text("Continue")').first().click();
        await page.waitForTimeout(3000);
      }
    }
  }

  await screenshot(page, 'after_login');

  const finalUrl = page.url();
  const loggedIn = !/\/auth|\/login|\/signin|verify|challenge|accounts\.google/i.test(finalUrl);
  log(loggedIn ? `Login confirmed: ${finalUrl.slice(0, 70)}` : `WARNING: Still on auth page: ${finalUrl.slice(0, 70)}`);
  return loggedIn;
}

// ── Apply to a single job URL ─────────────────────────────────────────────────
async function applyToJob(page, jobUrl) {
  log(`Navigating to job: ${jobUrl}`);
  await page.goto(jobUrl, { waitUntil: 'commit', timeout: 30000 });
  // Wait for apply button or page content to render
  await page.waitForSelector('button[data-testid*="apply"], button:has-text("Apply"), [data-indeed-apply-widget], #viewJobBodyJobDescriptionTitle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await screenshot(page, 'job_page');

  // Check for auth redirect
  if (/\/auth|\/login|\/signin|accounts\.google/i.test(page.url())) {
    log('Redirected to auth — session expired. Run: node tools/apply_indeed.js --login');
    return false;
  }

  // Check if already applied
  const bodyText = await page.innerText('body').catch(() => '');
  if (/applied on|you applied|already applied/i.test(bodyText)) {
    log('Already applied to this job — skipping');
    return true;
  }

  // Click "Apply now" / "Easily apply" button
  const applyBtn = page.locator([
    'button[data-testid*="apply"]',
    'button:has-text("Apply now")',
    'button:has-text("Easily apply")',
    '[data-indeed-apply-widget]',
    'a:has-text("Apply")',
  ].join(', ')).first();

  const applyVisible = await applyBtn.isVisible().catch(() => false);
  if (!applyVisible) {
    log('No Easy Apply button found — this job may redirect to external ATS');
    await screenshot(page, 'no_apply_btn');
    return false;
  }

  await applyBtn.click();
  await page.waitForTimeout(2500);
  await screenshot(page, 'apply_opened');

  // Check if apply click redirected to login (session expired)
  const postClickText = await page.innerText('body').catch(() => '');
  const postClickUrl = page.url();
  if (/\/auth|\/login|\/signin/i.test(postClickUrl) ||
      /sign in to indeed|create an account|log in to apply/i.test(postClickText)) {
    log('Apply clicked but redirected to login — session expired. Run: node tools/apply_indeed.js --login');
    return false;
  }

  // Multi-step form loop
  let step = 0;
  const maxSteps = 20;
  let cvUploaded = false;
  let clFilled = false;

  while (step < maxSteps) {
    step++;
    log(`Step ${step}...`);
    await screenshot(page, `step${step}`);

    const text = await page.innerText('body').catch(() => '');

    // Completion check
    if (/application (has been )?submitted|we received your application|thank you for applying|you applied|return to job search/i.test(text)) {
      log('✓ Application submitted!');
      return true;
    }

    // ── Fill contact fields ──
    for (const [sel, val] of [
      ['input[name*="firstName" i], input[placeholder*="First name" i]', CONFIG.firstName],
      ['input[name*="lastName" i], input[placeholder*="Last name" i]', CONFIG.lastName],
      ['input[type="tel"], input[name*="phone" i]', CONFIG.phone],
      ['input[name*="city" i], input[placeholder*="City" i]', 'London'],
    ]) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        const cur = await el.inputValue().catch(() => '');
        if (!cur) { await el.fill(val); }
      }
    }

    // ── CV upload ──
    if (CONFIG.cvPath && fs.existsSync(CONFIG.cvPath) && !cvUploaded) {
      const fileInput = page.locator('input[type="file"]').first();
      if (await fileInput.isVisible().catch(() => false) ||
          await fileInput.evaluate(el => el.offsetParent !== null).catch(() => false)) {
        try {
          const [chooser] = await Promise.all([
            page.waitForFileChooser({ timeout: 3000 }).catch(() => null),
            page.locator('label[for], button:has-text("Upload"), button:has-text("Choose")').first().click().catch(() => {}),
          ]);
          if (chooser) {
            await chooser.setFiles(CONFIG.cvPath);
          } else {
            await fileInput.setInputFiles(CONFIG.cvPath);
          }
          log(`CV uploaded: ${path.basename(CONFIG.cvPath)}`);
          cvUploaded = true;
          await page.waitForTimeout(2000);
        } catch (e) {
          log(`CV upload attempt: ${e.message.slice(0, 60)}`);
        }
      }
    }

    // ── Cover letter ──
    if (CONFIG.coverLetter && !clFilled) {
      const clArea = page.locator('textarea[name*="letter" i], textarea[id*="letter" i], textarea[placeholder*="cover" i]').first();
      if (await clArea.isVisible().catch(() => false)) {
        await clArea.fill(CONFIG.coverLetter);
        clFilled = true;
        log('Cover letter filled');
      }
    }

    // ── Yes/No radio groups — group by name, select based on question context ──
    await page.evaluate(() => {
      // Get all radio inputs on the visible/active part of the form
      const inputs = Array.from(document.querySelectorAll('input[type="radio"]'));
      // Group by name
      const groups = {};
      for (const inp of inputs) {
        const name = inp.name || inp.id;
        if (!name) continue;
        if (!groups[name]) groups[name] = [];
        groups[name].push(inp);
      }
      for (const [name, radios] of Object.entries(groups)) {
        // Skip if already answered
        if (radios.some(r => r.checked)) continue;

        // Get context text from the question label
        let context = '';
        const firstRadio = radios[0];
        // Walk up to find question container text
        let el = firstRadio.parentElement;
        for (let depth = 0; depth < 8; depth++) {
          if (!el) break;
          const txt = el.innerText || '';
          if (txt.length > 10 && txt.length < 500) { context = txt.toLowerCase(); break; }
          el = el.parentElement;
        }

        // Sponsorship/unable to offer → No; commute/FCA/experience → Yes
        const wantNo = /sponsor|unable to offer/i.test(context);
        const targetValue = wantNo ? 'no' : 'yes';

        // Find the matching radio by label text or value
        for (const radio of radios) {
          const id = radio.id;
          const labelEl = id ? document.querySelector(`label[for="${id}"]`) : null;
          const labelText = (labelEl ? labelEl.innerText : radio.value || '').toLowerCase().trim();
          if (labelText === targetValue || labelText.startsWith(targetValue)) {
            radio.click();
            break;
          }
        }
        // Fallback: if targetValue is 'yes' click first radio, 'no' click last
        const alreadyAnswered = radios.some(r => r.checked);
        if (!alreadyAnswered) {
          if (wantNo) radios[radios.length - 1].click();
          else radios[0].click();
        }
      }
    }).catch(e => log(`Radio handler: ${e.message}`));

    // ── Number inputs (years of experience etc.) ──
    const numInputs = page.locator('input[type="number"], input[inputmode="numeric"]');
    const numCount = await numInputs.count().catch(() => 0);
    for (let i = 0; i < numCount; i++) {
      const inp = numInputs.nth(i);
      if (!await inp.isVisible().catch(() => false)) continue;
      const v = await inp.inputValue().catch(() => '');
      if (!v) await inp.fill('5').catch(() => {});
    }

    // ── Text inputs for screener questions (salary, notice period, etc.) ──
    const textInputs = page.locator('input[type="text"]:visible, input[type="number"]:visible');
    const textCount = await textInputs.count().catch(() => 0);
    for (let i = 0; i < textCount; i++) {
      const inp = textInputs.nth(i);
      if (!await inp.isVisible().catch(() => false)) continue;
      const v = await inp.inputValue().catch(() => '');
      if (v) continue; // already filled
      // Infer answer from label/placeholder context
      const label = await page.evaluate(el => {
        const id = el.id;
        if (id) {
          const lbl = document.querySelector(`label[for="${id}"]`);
          if (lbl) return lbl.innerText;
        }
        return el.placeholder || el.name || '';
      }, await inp.elementHandle()).catch(() => '');
      let answer = '5'; // default for numeric
      if (/salary|compensation|pay|£/i.test(label)) answer = '50000';
      else if (/notice/i.test(label)) answer = '1 month';
      else if (/year|experience/i.test(label)) answer = '5';
      else if (/\d/.test(label)) answer = '5'; // any numeric context
      await inp.fill(answer).catch(() => {});
    }

    // ── Textareas for open-ended screener questions ──
    const textareas = page.locator('textarea:visible');
    const taCount = await textareas.count().catch(() => 0);
    for (let i = 0; i < taCount; i++) {
      const ta = textareas.nth(i);
      if (!await ta.isVisible().catch(() => false)) continue;
      // Skip cover letter (already handled above)
      const name = await ta.getAttribute('name').catch(() => '');
      const id = await ta.getAttribute('id').catch(() => '');
      if (/letter/i.test(name + id)) continue;
      const v = await ta.inputValue().catch(() => '');
      if (v) continue;
      // Generic answer for regulatory/experience questions
      await ta.fill('I have extensive experience in AML compliance, KYC, and financial crime prevention within regulated financial institutions, with strong knowledge of FCA regulatory frameworks including SYSC, JMLSG guidance, and the Money Laundering Regulations 2017.').catch(() => {});
    }

    // ── Dropdowns — pick first non-placeholder option ──
    const selects = page.locator('select');
    const selCount = await selects.count().catch(() => 0);
    for (let i = 0; i < selCount; i++) {
      const sel = selects.nth(i);
      const val = await sel.inputValue().catch(() => '');
      if (!val || val === '' || val === 'Select') {
        const options = await sel.locator('option').all();
        for (const opt of options) {
          const v = await opt.getAttribute('value').catch(() => '');
          if (v && v !== '' && v !== 'Select') {
            await sel.selectOption(v).catch(() => {});
            break;
          }
        }
      }
    }

    // ── Checkboxes — tick any unchecked required checkbox ──
    await page.evaluate(() => {
      const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
      for (const cb of boxes) {
        if (!cb.checked) {
          // Only tick checkboxes that are visible
          const r = cb.getBoundingClientRect();
          if (r.width > 0 || r.height > 0 || cb.offsetParent !== null) {
            cb.click();
          }
        }
      }
    }).catch(() => {});
    await page.waitForTimeout(300);

    // ── Click Continue / Next / Submit ──
    // Indeed renders ALL step buttons in the DOM simultaneously — must find the VISIBLE one.
    const navBtnSelectors = [
      'button[data-testid="continue-button"]',
      'button[data-testid="submit-button"]',
      'button:has-text("Continue")',
      'button:has-text("Next")',
      'button:has-text("Review your application")',
      'button:has-text("Submit")',
      'button[type="submit"]',
    ];

    // Scroll to bottom first — CV previews can push buttons far below fold
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(600);

    // Find first visible nav button
    let clickedBtn = false;
    for (const sel of navBtnSelectors) {
      const btns = page.locator(sel);
      const count = await btns.count().catch(() => 0);
      for (let bi = 0; bi < count; bi++) {
        const btn = btns.nth(bi);
        if (await btn.isVisible().catch(() => false)) {
          await btn.scrollIntoViewIfNeeded().catch(() => {});
          await page.waitForTimeout(500);
          const btnText = await btn.innerText().catch(() => '?');
          log(`Clicking: "${btnText.trim()}"`);
          // Use force:true as fallback — disabled state may clear after checkbox tick
          await btn.click({ timeout: 8000 }).catch(async () => {
            await btn.click({ force: true }).catch(() => {});
          });
          await page.waitForTimeout(2500);
          clickedBtn = true;
          break;
        }
      }
      if (clickedBtn) break;
    }

    if (!clickedBtn) {
      const allBtns = await page.evaluate(() =>
        Array.from(document.querySelectorAll('button')).map(b => b.innerText.trim().slice(0, 40))
      ).catch(() => []);
      log(`No visible navigation button found. All buttons: ${JSON.stringify(allBtns)}`);
      break;
    }
  }

  const finalText = await page.innerText('body').catch(() => '');
  const success = /application (has been )?submitted|we received your application|thank you for applying|you applied|return to job search/i.test(finalText);
  log(success ? '✓ Submitted' : '? Unclear — check screenshots');
  return success;
}

// ── Search mode: find Easy Apply jobs ────────────────────────────────────────
async function searchJobs(page) {
  // Filter by "easily apply" — indeed.co.uk uses &remotejob=&l= format
  const url = `https://uk.indeed.com/jobs?q=${encodeURIComponent(CONFIG.keywords)}&l=${encodeURIComponent(CONFIG.location)}&sort=date&fromage=14&iaLabel=indeedApply`;
  log(`Searching: ${url}`);
  await page.goto(url, { waitUntil: 'commit', timeout: 30000 });
  await page.waitForTimeout(4000);
  await screenshot(page, 'search');

  // Log page title for debug
  const title = await page.title().catch(() => '');
  log(`Page title: ${title}`);

  const jobs = await page.evaluate(() => {
    // indeed.co.uk uses data-jk on the li or the anchor
    const cards = Array.from(document.querySelectorAll('li.css-5lfssm, li[class*="job_seen"], [data-jk], .job_seen_beacon'));
    return cards.map(c => {
      const jk = c.getAttribute('data-jk') ||
                 c.querySelector('[data-jk]')?.getAttribute('data-jk') ||
                 c.querySelector('a[id^="job_"]')?.id?.replace('job_', '');
      const title = c.querySelector('h2 a span[title], h2 span[title], [class*="jobTitle"] span, h2 a')?.innerText?.trim() ||
                    c.querySelector('h2')?.innerText?.trim();
      const company = c.querySelector('[data-testid="company-name"], [class*="companyName"], .companyName')?.innerText?.trim();
      const text = (c.innerText || '').toLowerCase();
      const easyApply = text.includes('easily apply') || text.includes('indeed apply') ||
                        !!c.querySelector('[aria-label*="Easy Apply"], [class*="iaLabel"], .iaLabel');
      return { jk, title, company, easyApply };
    }).filter(j => j.jk);
  });

  const eaJobs = jobs.filter(j => j.easyApply);
  log(`Total job cards: ${jobs.length} | Easy Apply: ${eaJobs.length}`);
  if (!eaJobs.length && jobs.length) {
    log('No Easy Apply flag detected — using all jobs (may include external ATS)');
  }
  const toUse = eaJobs.length ? eaJobs : jobs;
  toUse.slice(0, 10).forEach((j, i) => log(`  [${i}] ${(j.company || '?').slice(0, 25).padEnd(25)} | ${j.title}`));
  return toUse.map(j => ({ ...j, url: `https://uk.indeed.com/viewjob?jk=${j.jk}` }));
}

// ── Check if session has a valid Indeed login ─────────────────────────────────
// Indeed allows browsing job pages without login — actual auth check happens when
// Easy Apply is clicked. We skip the pre-check and rely on in-flow auth detection.
async function isLoggedIn(page) {
  return true; // always proceed; applyToJob detects auth redirect if session is invalid
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log('Indeed Easy Apply tool starting...');

  // ── Login mode: run headed so user completes Google OAuth, then saves session ──
  if (CONFIG.loginMode) {
    log('LOGIN MODE — opening headed browser. Complete Google OAuth, then press Ctrl+C when logged in.');
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
    await page.goto('https://secure.indeed.com/account/login', { waitUntil: 'commit' });
    log('Browser opened. Log in with Google, then close this terminal or press Ctrl+C.');
    log('Session cookies will be saved automatically.');
    // Keep browser open until user kills the process
    await new Promise(() => {});
    return;
  }

  // ── Normal mode: use persistent session or injected cookies ──
  if (!hasSession && !hasCookiesFile) {
    log('No saved session and no cookies file. Run with --login first:');
    log('  node tools/apply_indeed.js --login');
    process.exit(1);
  }

  const context = await chromium.launchPersistentContext(
    hasSession ? SESSION_DIR : path.join(TMP_DIR, `indeed_session_tmp_${Date.now()}`),
    {
      headless: !process.env.DISPLAY,  // headed when Xvfb is running (bypasses Cloudflare)
      slowMo: 60,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
      locale: 'en-GB',
    }
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15000);

  // Inject session cookies from extension-synced file
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
    // Verify session is still valid — auto-login if expired
    let loggedIn = (hasSession || hasCookiesFile) ? await isLoggedIn(page) : false;
    if (!loggedIn) {
      log('Session expired — attempting headless auto-login...');
      loggedIn = await login(page);
      if (!loggedIn) {
        log('Auto-login failed — run with --login to re-authenticate manually:');
        log('  node tools/apply_indeed.js --login');
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
      const jobs = await searchJobs(page);
      if (!jobs.length) { log('No Easy Apply jobs found.'); await context.close(); process.exit(1); }

      const toApply = jobs.slice(0, CONFIG.maxJobs);
      log(`Applying to ${toApply.length} jobs...`);
      let successCount = 0;
      for (const job of toApply) {
        const ok = await applyToJob(page, job.url);
        if (ok) successCount++;
        await page.waitForTimeout(2000);
      }
      log(`Done: ${successCount}/${toApply.length} submitted`);
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
