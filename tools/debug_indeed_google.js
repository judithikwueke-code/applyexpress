/**
 * debug_indeed_google.js — Try Google OAuth path for Indeed login
 * Run with: xvfb-run --auto-servernum node tools/debug_indeed_google.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
chromium.use(stealth());

const path = require('path');
const fs   = require('fs');

const SESSION_DIR = path.join(process.cwd(), '.tmp', 'indeed_session');
const TMP_DIR = path.join(process.cwd(), '.tmp');

function log(msg) { process.stderr.write(`[gauth ${new Date().toISOString().slice(11,19)}] ${msg}\n`); }
async function ss(page, label) {
  const p = path.join(TMP_DIR, `igauth_${label}_${Date.now()}.png`);
  await page.screenshot({ path: p, fullPage: false }).catch(() => {});
  log(`Screenshot: ${p}`);
}

async function main() {
  const context = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: false,
    slowMo: 100,
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: null,
    locale: 'en-GB',
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  // Check Google auth status first
  log('Checking Google session...');
  await page.goto('https://accounts.google.com/signin/v2/identifier', { waitUntil: 'commit', timeout: 30000 });
  await page.waitForTimeout(3000);
  await ss(page, '00_google_check');
  const googleUrl = page.url();
  log(`Google URL: ${googleUrl.slice(0, 100)}`);
  const googleBody = await page.evaluate(() => document.body.innerText.slice(0, 200)).catch(() => '');
  log(`Google body: ${googleBody.replace(/\s+/g, ' ')}`);

  // Navigate to Indeed auth
  log('Navigating to Indeed auth...');
  await page.goto('https://secure.indeed.com/auth', { waitUntil: 'commit', timeout: 30000 });
  await page.waitForTimeout(4000);
  await ss(page, '01_landing');

  // Listen for popups
  let googlePopup = null;
  context.on('page', p => {
    log(`NEW PAGE (context event): ${p.url()}`);
    googlePopup = p;
  });
  page.on('popup', p => {
    log(`POPUP (page event): ${p.url()}`);
    googlePopup = p;
  });

  // Click Continue with Google
  log('Clicking "Continue with Google"...');
  const googleBtn = page.locator('#login-google-button, button:has-text("Continue with Google")').first();
  const visible = await googleBtn.isVisible().catch(() => false);
  log(`Google button visible: ${visible}`);

  // Capture any navigation events
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) {
      log(`Main frame navigated to: ${frame.url().slice(0, 100)}`);
    }
  });

  await googleBtn.click();
  log('Clicked — waiting 5s for response...');
  await page.waitForTimeout(5000);
  await ss(page, '02_after_google_click');
  log(`Main page URL: ${page.url().slice(0, 100)}`);

  if (googlePopup) {
    log(`Popup detected: ${googlePopup.url().slice(0, 100)}`);
    await ss(googlePopup, '02_popup');
    // Wait for popup to load
    await googlePopup.waitForTimeout(3000);
    await ss(googlePopup, '03_popup_loaded');
    const popupUrl = googlePopup.url();
    const popupBody = await googlePopup.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => '');
    log(`Popup URL: ${popupUrl.slice(0, 100)}`);
    log(`Popup body: ${popupBody.replace(/\s+/g, ' ')}`);

    // If Google OAuth shown in popup, try to continue
    if (popupUrl.includes('accounts.google.com')) {
      log('Google OAuth in popup — looking for account chooser...');
      // Select account if multiple
      const accountBtn = googlePopup.locator('[data-email], [data-identifier*="gmail"]').first();
      if (await accountBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await accountBtn.click();
        log('Selected account');
        await googlePopup.waitForTimeout(3000);
      }
      // Click "Continue" or "Allow"
      const continueBtn = googlePopup.locator('button:has-text("Continue"), button:has-text("Allow"), [data-primary-action-label]').first();
      if (await continueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await continueBtn.click();
        log('Clicked Continue in OAuth popup');
        await googlePopup.waitForTimeout(3000);
      }
      await ss(googlePopup, '04_popup_after_continue');
      log(`Popup URL after: ${googlePopup.url().slice(0, 100)}`);
    }

    // Wait for popup to close
    await googlePopup.waitForEvent('close', { timeout: 30000 }).catch(() => log('Popup did not close within 30s'));
    log('Popup closed — checking main page...');
  } else {
    // No popup — maybe it redirected the main page
    log('No popup detected — checking main page URL...');
    await page.waitForTimeout(5000);
    const url = page.url();
    log(`Main page URL: ${url.slice(0, 100)}`);
    if (url.includes('accounts.google.com')) {
      log('Redirected to Google OAuth in main tab!');
      await ss(page, '03_google_oauth_main');
      // Handle Google in main tab
      const body = await page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => '');
      log(`Google body: ${body.replace(/\s+/g, ' ')}`);
    }
  }

  await page.waitForTimeout(3000);
  await ss(page, '05_final');
  log(`Final main page URL: ${page.url().slice(0, 100)}`);
  const finalBody = await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => '');
  log(`Final body: ${finalBody.replace(/\s+/g, ' ')}`);

  await context.close();
}

main().catch(err => { log(`FATAL: ${err.message}`); process.exit(1); });
