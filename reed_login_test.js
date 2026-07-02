// Test Reed credential login and verify session works for apply
require('dotenv').config({ path: './.env' });
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
chromium.use(stealth());
const path = require('path');
const fs = require('fs');

const SESSION_DIR = path.join(process.cwd(), '.tmp', 'reed_session');
const email = process.env.REED_EMAIL || '';
const password = process.env.REED_PASSWORD || '';

async function main() {
  console.log(`Testing Reed login for ${email}...`);

  const context = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: true, slowMo: 50,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 }, locale: 'en-GB',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  // Step 1: Try login
  console.log('Step 1: Logging in...');
  await page.goto('https://www.reed.co.uk/account/signin', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(2000);
  const currentUrl = page.url();
  console.log(`  After goto: ${currentUrl.slice(0,80)}`);

  if (!currentUrl.includes('account/signin') && !currentUrl.includes('authorize')) {
    console.log('  Already logged in!');
  } else {
    await page.locator('#onetrust-accept-btn-handler, button:has-text("Accept All")').first().click().catch(() => {});
    await page.waitForTimeout(500);
    await page.locator('input[type="email"], #email').first().fill(email);
    await page.waitForTimeout(300);
    await page.locator('input[type="password"], #password').first().fill(password);
    await page.waitForTimeout(300);
    await page.locator('button:text-is("Continue"), button:text-is("Sign in")').first().click();
    try { await page.waitForURL(/reed\.co\.uk\/(?!account\/signin)/i, { timeout: 12000 }); } catch(e) {}
    await page.waitForTimeout(3000);
    const afterLogin = page.url();
    console.log(`  After login: ${afterLogin.slice(0,80)}`);
    await page.screenshot({ path: '/tmp/reed_after_login.png' });
  }

  // Step 2: Check if profile page accessible (requires login)
  console.log('Step 2: Checking profile page...');
  await page.goto('https://www.reed.co.uk/account', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);
  const profileUrl = page.url();
  const profileTitle = await page.title();
  console.log(`  Profile URL: ${profileUrl.slice(0,80)}`);
  console.log(`  Profile title: ${profileTitle}`);
  await page.screenshot({ path: '/tmp/reed_profile.png' });

  const loggedIn = !profileUrl.includes('account/signin') && !profileUrl.includes('authorize');
  console.log(loggedIn ? '✓ Session valid for profile' : '✗ Not logged in');

  await context.close();
  process.exit(loggedIn ? 0 : 1);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
