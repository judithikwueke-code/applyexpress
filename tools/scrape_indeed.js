/**
 * scrape_indeed.js — Scrape Indeed.co.uk job listings using saved session.
 *
 * Uses the persistent session saved by: node tools/apply_indeed.js --login
 *
 * Usage:
 *   node tools/scrape_indeed.js --keywords "AML Compliance" --location "London" --count 20
 *
 * Outputs JSON array of jobs to stdout.
 * Exit 0 = success, Exit 1 = error (no session or scrape failed).
 */

// Suppress dotenvx stdout injection messages — JSON goes to stdout, logs to stderr
const _origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  if (typeof chunk === 'string' && (chunk.startsWith('◇') || chunk.startsWith('⠋') || chunk.includes('injected env'))) return true;
  return _origWrite(chunk, ...args);
};
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.stdout.write = _origWrite; // restore after dotenv loads

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
chromium.use(stealth());
const path = require('path');
const fs = require('fs');
const minimist = require('minimist');

const argv = minimist(process.argv.slice(2), { string: ['keywords', 'location', 'cookies-path'] });
const KEYWORDS = argv['keywords'] || process.env.JOB_SEARCH_KEYWORDS || 'AML Compliance';
const LOCATION = argv['location'] || process.env.JOB_SEARCH_LOCATION || 'London';
const COUNT    = parseInt(argv['count'] || '20', 10);

const SESSION_DIR  = path.join(process.cwd(), '.tmp', 'indeed_session');
const TMP_DIR      = path.join(process.cwd(), '.tmp');
const cookiesFile  = argv['cookies-path'] || process.env.INDEED_COOKIES_PATH || '';
const hasCookiesFile = cookiesFile && fs.existsSync(cookiesFile);
const hasSession   = fs.existsSync(SESSION_DIR);

function log(msg) {
  process.stderr.write(`[scrape_indeed] ${msg}\n`);
}

async function scrape() {
  if (!hasSession && !hasCookiesFile) {
    log('No Indeed session found. Run: node tools/apply_indeed.js --login');
    process.exit(1);
  }

  const context = await chromium.launchPersistentContext(
    hasSession ? SESSION_DIR : path.join(TMP_DIR, `indeed_scrape_tmp_${Date.now()}`),
    {
      headless: !process.env.DISPLAY,  // headed when Xvfb is running (bypasses Cloudflare)
      slowMo: 50,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
      locale: 'en-GB',
    }
  );

  // Inject extension-synced cookies if available
  if (hasCookiesFile) {
    try {
      const cookies = JSON.parse(fs.readFileSync(cookiesFile, 'utf8'));
      if (Array.isArray(cookies) && cookies.length > 0) {
        await context.addCookies(cookies);
        log(`Loaded ${cookies.length} cookies from ${path.basename(cookiesFile)}`);
      }
    } catch (e) {
      log(`Warning: could not load cookies: ${e.message}`);
    }
  }

  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  try {
    // Navigate via search URL — use 'commit' (fires on first byte) then wait for cards
    // 'networkidle' hangs on Indeed; 'domcontentloaded' can fire before JS renders cards
    const searchUrl = `https://uk.indeed.com/jobs?q=${encodeURIComponent(KEYWORDS)}&l=${encodeURIComponent(LOCATION)}&sort=date&fromage=14`;
    log(`Searching: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'commit', timeout: 30000 });
    // Wait for job cards to render
    await page.waitForSelector('[data-jk], .job_seen_beacon, .tapItem', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // Accept cookies if prompted
    await page.locator('button[id*="accept"], button:has-text("Accept all"), button:has-text("Accept All")').first().click().catch(() => {});
    await page.waitForTimeout(500);

    log(`Search URL: ${page.url().slice(0, 80)}`);

    const jobs = [];
    let pageNum = 0;
    const maxPages = Math.ceil(COUNT / 15);

    while (jobs.length < COUNT && pageNum < maxPages) {
      pageNum++;
      log(`Scraping page ${pageNum}...`);

      // Extract job cards — data-jk is on the <a> title link (not on li/div)
      const cards = await page.evaluate(() => {
        const results = [];
        const titleLinks = document.querySelectorAll('a[data-jk]');
        titleLinks.forEach(link => {
          const jk = link.getAttribute('data-jk') || '';
          if (!jk) return;

          // Walk up to the job card container
          const card = link.closest('li') || link.closest('[class*="job_seen"]') || link.parentElement;

          const title = link.innerText?.trim() || '';
          const companyEl = card?.querySelector('[data-testid="company-name"], .companyName, [class*="companyName"]');
          const locationEl = card?.querySelector('[data-testid="text-location"], .companyLocation, [class*="companyLocation"]');
          const salaryEl = card?.querySelector('[data-testid="attribute_snippet_testid"], [class*="salary-snippet"], [class*="estimated-salary"]');

          const company = companyEl?.innerText?.trim() || '';
          const location = locationEl?.innerText?.trim() || '';
          const salary = salaryEl?.innerText?.trim() || '';
          const url = `https://uk.indeed.com/viewjob?jk=${jk}`;

          if (title && jk) {
            results.push({ title, company, location, salary, url, jk });
          }
        });
        return results;
      });

      log(`  Found ${cards.length} cards on page ${pageNum}`);

      // Filter cards by keyword relevance (Indeed returns broad results)
      const kwLower = KEYWORDS.toLowerCase().split(/\s+/);
      const relevantCards = cards.filter(c => {
        const text = `${c.title} ${c.company}`.toLowerCase();
        return kwLower.some(kw => text.includes(kw));
      });
      log(`  ${relevantCards.length} relevant after keyword filter`);

      // Fetch description for each card by clicking title link
      for (const card of relevantCards) {
        if (jobs.length >= COUNT) break;
        try {
          let description = '';
          if (card.jk) {
            // Fetch description from the job's own page (more reliable than the side panel)
            try {
              const jobPage = await context.newPage();
              jobPage.setDefaultTimeout(15000);
              await jobPage.goto(`https://uk.indeed.com/viewjob?jk=${card.jk}`, {
                waitUntil: 'commit', timeout: 15000,
              });
              await jobPage.waitForSelector('#jobDescriptionText', { timeout: 8000 }).catch(() => {});
              description = await jobPage.evaluate(() => {
                const el = document.querySelector('#jobDescriptionText, .jobsearch-jobDescriptionText');
                return el?.innerText?.trim() || '';
              }).catch(() => '');
              await jobPage.close();
            } catch (e) {
              // fallback: empty description
            }
          }

          jobs.push({
            id: `indeed-${card.jk}`,
            source: 'indeed',
            title: card.title,
            company: card.company,
            location: card.location,
            url: card.url,
            description: description.slice(0, 4000),
            salary_min: null,
            salary_max: null,
            date_posted: card.date,
            fetched_at: new Date().toISOString(),
          });
        } catch (e) {
          log(`  Card error: ${e.message.slice(0, 60)}`);
        }
      }

      // Next page
      if (jobs.length < COUNT) {
        const nextBtn = page.locator('[data-testid="pagination-page-next"], a[aria-label="Next Page"]').first();
        const hasNext = await nextBtn.isVisible().catch(() => false);
        if (!hasNext) break;
        await nextBtn.click().catch(() => {});
        await page.waitForTimeout(3000);
      }
    }

    log(`Scraped ${jobs.length} jobs from Indeed`);
    await context.close();
    process.stdout.write(JSON.stringify(jobs));
    process.exit(0);

  } catch (err) {
    log(`FATAL: ${err.message}`);
    await context.close().catch(() => {});
    process.exit(1);
  }
}

scrape();
