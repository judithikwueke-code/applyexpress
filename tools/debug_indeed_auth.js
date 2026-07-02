/**
 * debug_indeed_auth.js — Inspect Indeed auth page DOM interactively
 * Run with: xvfb-run --auto-servernum node tools/debug_indeed_auth.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
chromium.use(stealth());

const path = require('path');
const fs   = require('fs');

const EMAIL = process.env.INDEED_EMAIL || 'judith.ikwueke@gmail.com';
const SESSION_DIR = path.join(process.cwd(), '.tmp', 'indeed_session');
const TMP_DIR = path.join(process.cwd(), '.tmp');

function log(msg) { process.stderr.write(`[debug ${new Date().toISOString().slice(11,19)}] ${msg}\n`); }
async function ss(page, label) {
  const p = path.join(TMP_DIR, `idbg_${label}_${Date.now()}.png`);
  await page.screenshot({ path: p, fullPage: true }).catch(() => {});
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

  // Navigate
  log('Navigating...');
  await page.goto('https://secure.indeed.com/auth', { waitUntil: 'commit', timeout: 30000 });
  await page.waitForTimeout(4000);
  await ss(page, '01_landing');

  // Dump all iframes
  const frames = page.frames();
  log(`Frames (${frames.length}):`);
  for (const f of frames) {
    log(`  frame url: ${f.url().slice(0, 100)}`);
  }

  // Check current URL
  log(`URL: ${page.url()}`);

  // Dump all buttons
  const buttons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button, input[type="submit"], a[href*="google"]')).map(b => ({
      tag: b.tagName,
      text: (b.innerText || b.value || b.textContent || '').trim().slice(0, 60),
      type: b.getAttribute('type'),
      disabled: b.disabled,
      ariaDisabled: b.getAttribute('aria-disabled'),
      id: b.id,
      className: (b.className || '').slice(0, 80),
      href: b.href || '',
    }));
  });
  log('Buttons:');
  buttons.forEach(b => log(`  [${b.tag}] "${b.text}" type=${b.type} disabled=${b.disabled} id=${b.id}`));

  // Dump all inputs
  const inputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input')).map(i => ({
      name: i.name, type: i.type, id: i.id, value: i.value.slice(0, 30),
      placeholder: i.placeholder, autocomplete: i.autocomplete,
    }));
  });
  log('Inputs:');
  inputs.forEach(i => log(`  input name="${i.name}" type="${i.type}" id="${i.id}" val="${i.value}" placeholder="${i.placeholder}"`));

  // Fill email
  const emailInput = page.locator('input[type="email"], input[name="__email"], input[autocomplete="email"]').first();
  const emailVisible = await emailInput.isVisible().catch(() => false);
  log(`Email input visible: ${emailVisible}`);
  if (emailVisible) {
    log('Filling email...');
    await emailInput.fill(EMAIL);
    await page.waitForTimeout(1000);
    await ss(page, '02_email_filled');
  }

  // Check continue button
  const submitBtn = page.locator('button[type="submit"]').first();
  const submitVisible = await submitBtn.isVisible().catch(() => false);
  const submitDisabled = await submitBtn.evaluate(b => b.disabled).catch(() => null);
  log(`Submit button visible: ${submitVisible}, disabled: ${submitDisabled}`);

  // Scroll into view
  await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
  await ss(page, '03_before_click');

  // Click
  log('Clicking Continue via Enter key...');
  await emailInput.press('Enter');
  await page.waitForTimeout(2000);
  await ss(page, '04_after_enter');
  log(`URL after Enter: ${page.url()}`);

  // Wait longer for page to advance
  log('Waiting 30s for Turnstile to complete...');
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    const url = page.url();
    const body = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (!url.includes('/auth') || body.includes('Welcome back') || body.includes('Sign in with a code')) {
      log(`Page advanced after ${i+1}s: ${url}`);
      break;
    }
    if (i % 5 === 0) {
      log(`  ${i}s: still on ${url.slice(0, 60)}`);
      await ss(page, `wait_${i}s`);

      // Dump frames again
      const currentFrames = page.frames();
      for (const f of currentFrames) {
        if (f.url() && f.url() !== 'about:blank') {
          log(`  frame: ${f.url().slice(0, 100)}`);
        }
      }
    }
  }

  await ss(page, '05_final');
  log(`Final URL: ${page.url()}`);
  const finalBody = await page.evaluate(() => document.body.innerText).catch(() => '');
  log(`Final body (first 400 chars): ${finalBody.slice(0, 400).replace(/\s+/g, ' ')}`);

  await context.close();
}

main().catch(err => { log(`FATAL: ${err.message}`); process.exit(1); });
