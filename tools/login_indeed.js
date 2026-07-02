/**
 * login_indeed.js — Automated Indeed login via Google OAuth popup.
 *
 * Strategy:
 *   1. Open headed browser (Xvfb) and navigate to Indeed auth
 *   2. Click "Continue with Google" — opens Google OAuth popup
 *   3. In popup: fill email → Next → fill password → handle 2FA if needed
 *   4. Popup closes → Indeed session established → cookies saved
 *
 * Usage:
 *   xvfb-run --auto-servernum node tools/login_indeed.js
 *
 * Exit 0 = session saved, Exit 1 = failed.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
chromium.use(stealth());

const path = require('path');
const fs   = require('fs');

const EMAIL       = process.env.INDEED_EMAIL    || 'judith.ikwueke@gmail.com';
const GOOGLE_PASS = process.env.INDEED_PASSWORD  || process.env.REED_PASSWORD   || '';
const GMAIL_PASS  = process.env.SMTP_PASSWORD   || '';

const SESSION_DIR = path.join(process.cwd(), '.tmp', 'indeed_session');
const TMP_DIR     = path.join(process.cwd(), '.tmp');
if (!fs.existsSync(TMP_DIR))     fs.mkdirSync(TMP_DIR, { recursive: true });
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

function log(msg) {
  process.stderr.write(`[login_indeed ${new Date().toISOString().slice(11,19)}] ${msg}\n`);
}

async function ss(page, label) {
  const p = path.join(TMP_DIR, `idl_${label}_${Date.now()}.png`);
  await page.screenshot({ path: p, fullPage: false }).catch(() => {});
  log(`Screenshot: ${p}`);
}

// ── Read OTP from Gmail IMAP ──────────────────────────────────────────────────
async function readOTP({ fromPattern = /indeed/i, notBefore = Date.now() - 120000, maxWaitMs = 120000 } = {}) {
  const { ImapFlow } = require('imapflow');
  log(`Reading Gmail IMAP for OTP (notBefore=${new Date(notBefore).toISOString()})...`);
  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user: EMAIL, pass: GMAIL_PASS }, logger: false,
  });
  await client.connect();
  await client.mailboxOpen('INBOX');

  const deadline = Date.now() + maxWaitMs;
  let code = null;

  while (Date.now() < deadline && !code) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    for await (const msg of client.fetch({ since }, { envelope: true, source: true })) {
      const from = (msg.envelope?.from || []).map(f => f.address || '').join(' ').toLowerCase();
      if (!fromPattern.test(from)) continue;

      const msgTime = msg.envelope?.date ? new Date(msg.envelope.date).getTime() : 0;
      if (msgTime < notBefore) {
        log(`  Skipping stale email from ${new Date(msgTime).toISOString()}`);
        continue;
      }

      const raw = msg.source?.toString('utf8') || '';
      const decoded = raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi,
        (_, h) => String.fromCharCode(parseInt(h, 16)));
      const text = decoded.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');

      const m = text.match(/\b(\d{6})\b/) ||
                text.match(/verification code[^0-9]*(\d{4,8})/i) ||
                text.match(/your code[^0-9]*(\d{4,8})/i) ||
                text.match(/code is[^0-9]*(\d{4,8})/i);
      if (m) { code = m[1]; log(`  ✓ OTP: ${code}`); break; }
    }
    if (!code) {
      log('  OTP not found yet — waiting 5s...');
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  await client.logout();
  return code;
}

// ── Handle Google OAuth popup ─────────────────────────────────────────────────
async function handleGooglePopup(popup) {
  log('Google popup opened — handling OAuth...');
  await popup.waitForTimeout(2000);
  await ss(popup, 'google_popup_01');

  // ── Step 1: Email ──
  const emailInput = popup.locator('#identifierId, input[type="email"]').first();
  if (await emailInput.isVisible({ timeout: 5000 }).catch(() => false)) {
    log(`Filling Google email: ${EMAIL}`);
    await emailInput.fill(EMAIL);
    await popup.waitForTimeout(500);
    await popup.locator('#identifierNext, button:has-text("Next")').first().click();
    await popup.waitForTimeout(3000);
    await ss(popup, 'google_popup_02_after_email');
  }

  // ── Step 2: Password ──
  const passInput = popup.locator('input[name="Passwd"], input[type="password"]').first();
  if (await passInput.isVisible({ timeout: 8000 }).catch(() => false)) {
    if (GOOGLE_PASS) {
      log(`Filling Google password (${GOOGLE_PASS.slice(0,2)}***)`);
      await passInput.fill(GOOGLE_PASS);
      await popup.waitForTimeout(500);
      await popup.locator('#passwordNext, button:has-text("Next")').first().click();
      await popup.waitForTimeout(4000);
      await ss(popup, 'google_popup_03_after_password');

      const bodyAfterPass = await popup.evaluate(() => document.body.innerText.slice(0, 400)).catch(() => '');
      if (/wrong password|incorrect password/i.test(bodyAfterPass)) {
        log('Password incorrect — trying "Try another way"...');
        // Clear the field so we don't re-try wrong password
        await passInput.fill('').catch(() => {});
      }
    }
  }

  // ── Step 3: "Try another way" — use email/phone code if password fails ──
  const body3 = await popup.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => '');
  log(`Current popup body: ${body3.slice(0, 200).replace(/\s+/g, ' ')}`);

  const tryAnotherWay = popup.locator('button:has-text("Try another way"), a:has-text("Try another way")').first();
  if (await tryAnotherWay.isVisible({ timeout: 3000 }).catch(() => false)) {
    log('Clicking "Try another way"...');
    await tryAnotherWay.click();
    await popup.waitForTimeout(3000);
    await ss(popup, 'google_popup_03b_try_another_way');

    const bodyAlt = await popup.evaluate(() => document.body.innerText.slice(0, 800)).catch(() => '');
    log(`Try-another-way options: ${bodyAlt.slice(0, 400).replace(/\s+/g, ' ')}`);

    // Look for email/phone code option
    const emailCodeOption = popup.locator([
      'li:has-text("email")',
      'div[role="radio"]:has-text("email")',
      'div[jsname]:has-text("email")',
      '[data-challengetype*="email"], [data-challengeid*="email"]',
      'li:has-text("@gmail")',
      'div:has-text("Send a code to")',
    ].join(', ')).first();

    if (await emailCodeOption.isVisible({ timeout: 5000 }).catch(() => false)) {
      const optionText = await emailCodeOption.innerText().catch(() => '');
      log(`Selecting: "${optionText.trim().slice(0, 80)}"`);
      const otpRequestTime = Date.now();
      await emailCodeOption.click();
      await popup.waitForTimeout(2000);

      // Click Next/Send to trigger code
      const sendBtn = popup.locator('button:has-text("Send"), button:has-text("Next"), button[jsname]').first();
      if (await sendBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await sendBtn.click();
        await popup.waitForTimeout(3000);
      }

      // Read OTP from Gmail
      log('Reading Google verification code from Gmail...');
      const otp = await readOTP({ fromPattern: /google/i, notBefore: otpRequestTime, maxWaitMs: 90000 });
      if (otp) {
        const otpInput = popup.locator('input[type="number"], input[name*="code"], input[autocomplete*="one-time"], input[inputmode="numeric"]').first();
        if (await otpInput.isVisible({ timeout: 10000 }).catch(() => false)) {
          await otpInput.fill(otp);
          await popup.waitForTimeout(500);
          await popup.locator('button:has-text("Next"), button:has-text("Verify")').first().click();
          await popup.waitForTimeout(4000);
          await ss(popup, 'google_popup_04_after_code');
        }
      }
    } else {
      // No email option — try clicking the nested "Try another way" for more options
      log('Email option not found — trying nested "Try another way"...');
      await ss(popup, 'google_popup_03c_options');

      const tryAnotherWay2 = popup.locator('li:has-text("Try another way"), div:has-text("Try another way")').last();
      if (await tryAnotherWay2.isVisible({ timeout: 3000 }).catch(() => false)) {
        await tryAnotherWay2.click();
        await popup.waitForTimeout(3000);
        await ss(popup, 'google_popup_03d_more_options');
        const bodyMore = await popup.evaluate(() => document.body.innerText.slice(0, 800)).catch(() => '');
        log(`More options: ${bodyMore.slice(0, 400).replace(/\s+/g, ' ')}`);

        // Look for phone number / SMS option
        const phoneOption = popup.locator([
          'li:has-text("phone"), li:has-text("text"), li:has-text("SMS")',
          'div[role="radio"]:has-text("phone"), div[role="radio"]:has-text("text")',
          '[data-challengetype*="phone"], [data-challengetype*="sms"]',
          'div:has-text("+44"), div:has-text("+1")',
        ].join(', ')).first();

        if (await phoneOption.isVisible({ timeout: 5000 }).catch(() => false)) {
          const optText = await phoneOption.innerText().catch(() => '');
          log(`Phone option: "${optText.trim().slice(0, 80)}"`);
          // Phone/SMS verification would need manual intervention
          // Just document what's available
        }
      }
    }
  }

  // ── Step 3b: 2FA if already offered ──
  const bodyOtp = await popup.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => '');
  if (/2-step|verify|check.*phone|sent.*code|enter.*code|enter the code|verification code/i.test(bodyOtp)) {
    log('OTP/2FA page detected — reading Gmail...');
    const otpRequestTime2 = Date.now() - 60000; // could have been triggered already
    const otp2 = await readOTP({ fromPattern: /google/i, notBefore: otpRequestTime2 });
    if (otp2) {
      const otpInput2 = popup.locator('input[type="number"], input[name*="code"], input[autocomplete*="one-time"], input[inputmode="numeric"]').first();
      if (await otpInput2.isVisible({ timeout: 5000 }).catch(() => false)) {
        await otpInput2.fill(otp2);
        await popup.locator('button:has-text("Next"), button:has-text("Verify")').first().click();
        await popup.waitForTimeout(3000);
        await ss(popup, 'google_popup_04b_after_2fa');
      }
    }
  }

  // ── Step 4: Grant / Allow / Continue ──
  const grantBtn = popup.locator('button:has-text("Allow"), button:has-text("Continue"), button:has-text("Grant"), [data-primary-action-label]').first();
  if (await grantBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    log('Clicking Grant/Allow...');
    await grantBtn.click();
    await popup.waitForTimeout(3000);
    await ss(popup, 'google_popup_05_after_grant');
  }

  const finalBody = await popup.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => '');
  const finalUrl  = popup.url();
  log(`Popup final URL: ${finalUrl.slice(0, 100)}`);
  log(`Popup final body: ${finalBody.slice(0, 200).replace(/\s+/g, ' ')}`);

  return !finalUrl.includes('accounts.google.com') || /indeed/.test(finalUrl);
}

// ── Manual login mode ─────────────────────────────────────────────────────────
async function manualLogin() {
  log('MANUAL LOGIN MODE');
  log(`Session dir: ${SESSION_DIR}`);
  log('Steps:');
  log('  1. A browser window will open at https://secure.indeed.com/auth');
  log('  2. Click "Continue with Google" and complete sign-in on your phone');
  log('  3. Once logged in, press Ctrl+C — session cookies save automatically');

  const context = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: false,
    args: ['--start-maximized'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: null,
    locale: 'en-GB',
  });
  const page = await context.newPage();
  await page.goto('https://secure.indeed.com/auth', { waitUntil: 'commit', timeout: 30000 });

  log('Browser open. Log in with Google, complete phone verification, then press Ctrl+C.');
  log('Session cookies are saved automatically when you close/kill this process.');

  // Wait until logged in to Indeed dashboard (not just any redirect)
  const check = setInterval(async () => {
    try {
      const url = page.url();
      // Only consider it done when we see the Indeed homepage/dashboard
      // Ignore transient Google OAuth redirects
      if (url && url.includes('indeed.') && !/auth|login|signin|accounts\.google|challenge|oauth/i.test(url)) {
        log(`✓ Detected Indeed dashboard: ${url.slice(0, 80)}`);
        log('Session saved — you can now run the pipeline.');
        clearInterval(check);
        await page.waitForTimeout(2000); // let cookies write
        await context.close();
        process.exit(0);
      }
    } catch (e) { /* page may be transitioning */ }
  }, 3000);

  // Keep process alive until user kills it or we detect login
  await new Promise(() => {});
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const argv = require('minimist')(process.argv.slice(2));
  if (argv['manual'] || argv['m']) {
    return manualLogin();
  }

  log(`Starting Indeed login for ${EMAIL}`);
  log(`Session dir: ${SESSION_DIR}`);

  const context = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: false,
    slowMo: 80,
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: null,
    locale: 'en-GB',
  });

  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  try {
    // ── Step 1: Navigate to auth ──
    log('Navigating to Indeed auth...');
    await page.goto('https://secure.indeed.com/auth', { waitUntil: 'commit', timeout: 30000 });
    await page.waitForTimeout(4000);
    await ss(page, '01_start');

    // Accept cookies
    await page.locator('button:has-text("Accept"), button:has-text("Accept All")').first().click().catch(() => {});
    await page.waitForTimeout(600);

    // ── Step 2: Check if already logged in ──
    if (!/auth|login|signin/i.test(page.url())) {
      log(`Already logged in: ${page.url()}`);
      await context.close();
      process.exit(0);
    }

    // ── Step 3: Click "Continue with Google" — no Turnstile on this path ──
    log('Clicking "Continue with Google"...');
    const googleBtn = page.locator('#login-google-button, button:has-text("Continue with Google")').first();
    if (!await googleBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      log('Google button not found — aborting');
      await ss(page, 'no_google_btn');
      await context.close();
      process.exit(1);
    }

    // Intercept popup
    let googlePopup = null;
    const popupPromise = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);
    await googleBtn.click();
    googlePopup = await popupPromise;

    if (!googlePopup) {
      // Maybe it redirected the main page
      await page.waitForTimeout(3000);
      if (page.url().includes('accounts.google.com')) {
        log('Redirected to Google OAuth in main tab');
        googlePopup = page; // treat main page as the "popup"
      }
    }

    if (!googlePopup) {
      log('No Google OAuth page detected — check screenshot');
      await ss(page, 'no_google_popup');
      await context.close();
      process.exit(1);
    }

    log(`Google OAuth page: ${googlePopup.url().slice(0, 80)}`);

    // ── Step 4: Complete Google OAuth ──
    const oauthSuccess = await handleGooglePopup(googlePopup);
    log(oauthSuccess ? 'Google OAuth completed' : 'Google OAuth may not have completed');

    // If popup, wait for it to close (means redirect back to Indeed)
    if (googlePopup !== page) {
      log('Waiting for popup to close and Indeed session to establish...');
      await googlePopup.waitForEvent('close', { timeout: 30000 }).catch(() => log('Popup did not close (may have redirected)'));
      await page.waitForTimeout(5000);
      await ss(page, '02_after_oauth');
    }

    // ── Step 5: Verify login ──
    const finalUrl = page.url();
    const finalBody = await page.innerText('body').catch(() => '');
    await ss(page, '03_final');

    const success = !/auth|login|signin|verify|challenge|accounts\.google/i.test(finalUrl) ||
                    /my jobs|profile|resume|dashboard|myj/i.test(finalUrl) ||
                    /welcome|signed in|account/i.test(finalBody);

    if (success) {
      log(`✓ Login successful — session saved to ${SESSION_DIR}`);
      log(`Final URL: ${finalUrl.slice(0, 80)}`);
    } else {
      log(`✗ Login may have failed`);
      log(`Final URL: ${finalUrl.slice(0, 80)}`);
      log(`Body: ${finalBody.slice(0, 200).replace(/\s+/g, ' ')}`);
    }

    await context.close();
    process.exit(success ? 0 : 1);

  } catch (err) {
    log(`FATAL: ${err.message}`);
    await ss(page, 'fatal').catch(() => {});
    await context.close();
    process.exit(1);
  }
}

main();
