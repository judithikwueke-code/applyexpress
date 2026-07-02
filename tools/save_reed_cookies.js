require('dotenv').config({ path: '/opt/applyexpress/.env' });
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
chromium.use(stealth());
const fs = require('fs');
const path = require('path');

const SESSION_DIR = '/opt/applyexpress/data/users/1/.tmp/reed_session';
const SAVE_TO = '/opt/applyexpress/data/users/1/sessions/reed.json';

(async () => {
  const ctx = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: !process.env.DISPLAY,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();
  await page.goto('https://www.reed.co.uk/account', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);
  const url = page.url();
  const body = await page.innerText('body').catch(() => '');
  const loggedIn = url.startsWith('https://www.reed.co.uk') && !url.includes('signin') && !url.includes('secure.reed.co.uk');
  console.log('URL:', url);
  console.log('Logged in:', loggedIn);
  if (loggedIn) {
    const cookies = await ctx.cookies();
    fs.mkdirSync(path.dirname(SAVE_TO), { recursive: true });
    fs.writeFileSync(SAVE_TO, JSON.stringify(cookies, null, 2));
    console.log(`Saved ${cookies.length} cookies to ${SAVE_TO}`);
  } else {
    console.log('Not logged in — cannot save cookies');
    console.log('Page snippet:', body.slice(0, 200));
  }
  await ctx.close();
})().catch(e => console.error('ERR:', e.message));
