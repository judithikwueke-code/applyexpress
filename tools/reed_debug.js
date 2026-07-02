require('dotenv').config({ path: '/opt/applyexpress/.env' });
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
chromium.use(stealth());
const fs = require('fs');

(async () => {
  const ctx = await chromium.launchPersistentContext('/opt/applyexpress/data/users/1/.tmp/reed_session', {
    headless: !process.env.DISPLAY,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();
  await page.goto('https://www.reed.co.uk/account/signin', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.locator('#onetrust-accept-btn-handler').click().catch(() => {});
  await page.waitForTimeout(1000);
  console.log('URL:', page.url());
  const body = await page.innerText('body').catch(() => '');
  console.log('Page text:', body.slice(0, 400));
  await page.screenshot({ path: '/opt/applyexpress/data/users/1/.tmp/reed_login_debug.png' });
  await ctx.close();
})().catch(e => console.error('ERR:', e.message));
