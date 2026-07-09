// One-time Reed login script — logs in with credentials, saves cookies to sessions/reed.json
require('dotenv').config({ path: '/opt/applyexpress/.env' });
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
chromium.use(stealth());
const path = require('path');
const fs = require('fs');

const TMP_DIR = process.env.TMP_DIR;
if (!TMP_DIR) { console.error('TMP_DIR env var is required'); process.exit(1); }
const SESSION_DIR = path.join(TMP_DIR, 'reed_session');
const SESSIONS_FILE = path.join(path.dirname(TMP_DIR), 'sessions', 'reed.json');
const EMAIL = process.env.REED_EMAIL || '';
const PASSWORD = process.env.REED_PASSWORD || '';
if (!EMAIL || !PASSWORD) { console.error('REED_EMAIL and REED_PASSWORD env vars are required'); process.exit(1); }

function log(msg) { console.log(`[reed-login ${new Date().toISOString().slice(11,19)}] ${msg}`); }

(async () => {
  const ctx = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: !process.env.DISPLAY,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();

  log(`Navigating to Reed sign-in...`);
  await page.goto('https://secure.reed.co.uk/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);

  // Accept cookies banner if present
  await page.locator('#onetrust-accept-btn-handler, button:has-text("Accept All")').first().click().catch(() => {});
  await page.waitForTimeout(800);

  // Check if already logged in
  const urlNow = page.url();
  if (urlNow.startsWith('https://www.reed.co.uk') && !urlNow.includes('signin') && !urlNow.includes('secure.reed.co.uk')) {
    log('Already logged in!');
  } else {
    log(`Filling credentials for ${EMAIL}...`);
    await page.locator('#signin_email, input[type="email"]').first().fill(EMAIL);
    await page.waitForTimeout(300);
    await page.locator('#signin_password, input[type="password"]').first().fill(PASSWORD);
    await page.waitForTimeout(300);
    await page.locator('button:text-is("Continue"), button:text-is("Sign in"), button:text-is("Log in")').first().click();

    try {
      await page.waitForURL(/^https:\/\/www\.reed\.co\.uk\//i, { timeout: 15000 });
    } catch (_) {}
    await page.waitForTimeout(3000);

    const finalUrl = page.url();
    const body = await page.innerText('body').catch(() => '');

    if (body.includes('account has been locked') || body.includes('incorrect password')) {
      log('ERROR: Account still locked or wrong password. Check credentials.');
      await ctx.close(); process.exit(1);
    }

    // CAPTCHA → exit 3 so the caller can tell the user to retry later / use extension
    const captcha = await page.locator('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [class*="captcha"]').first().isVisible().catch(() => false);
    if (captcha) {
      log('CAPTCHA challenge shown — cannot complete server-side login right now.');
      await page.screenshot({ path: path.join(TMP_DIR, `reed_refresh_captcha_${Date.now()}.png`) }).catch(() => {});
      await ctx.close(); process.exit(3);
    }

    const loggedIn = finalUrl.startsWith('https://www.reed.co.uk') &&
                     !finalUrl.includes('secure.reed.co.uk') && !finalUrl.includes('signin');
    if (!loggedIn) {
      log(`Login failed — still on: ${finalUrl}`);
      await page.screenshot({ path: path.join(TMP_DIR, `reed_refresh_failed_${Date.now()}.png`) }).catch(() => {});
      await ctx.close(); process.exit(1);
    }
    log(`Logged in! URL: ${finalUrl}`);
  }

  // Save cookies to sessions/reed.json
  const cookies = await ctx.cookies();
  fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(cookies, null, 2));
  log(`Saved ${cookies.length} cookies to ${SESSIONS_FILE}`);

  await ctx.close();
  log('Done — Reed session ready.');
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
