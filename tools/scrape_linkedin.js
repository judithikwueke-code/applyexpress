/**
 * scrape_linkedin.js — Scrape LinkedIn job listings via public guest API (no session required).
 *
 * Uses LinkedIn's unauthenticated jobs API which returns HTML fragments.
 *
 * Usage:
 *   node tools/scrape_linkedin.js --keywords "AML Compliance" --location "London" --count 20
 *
 * Outputs JSON array of jobs to stdout.
 * Exit 0 = success, Exit 1 = error.
 */

const _origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
  if (typeof chunk === 'string' && (chunk.startsWith('◇') || chunk.startsWith('⠋') || chunk.includes('injected env'))) return true;
  return _origWrite(chunk, ...args);
};
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
process.stdout.write = _origWrite;

const https = require('https');
const minimist = require('minimist');

const argv = minimist(process.argv.slice(2));
const KEYWORDS = argv['keywords'] || process.env.JOB_SEARCH_KEYWORDS || 'AML Compliance';
const LOCATION = argv['location'] || process.env.JOB_SEARCH_LOCATION || 'London';
const COUNT    = parseInt(argv['count'] || '20', 10);

function log(msg) {
  process.stderr.write(`[scrape_linkedin] ${msg}\n`);
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.5',
      },
    };
    const req = https.get(url, options, (res) => {
      // Follow redirect
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractAttr(html, attr) {
  const m = html.match(new RegExp(`${attr}="([^"]+)"`));
  return m ? m[1] : '';
}

function extractText(html, tag, cls) {
  const pattern = cls
    ? new RegExp(`<${tag}[^>]*class="[^"]*${cls}[^"]*"[^>]*>([\s\S]*?)<\/${tag}>`, 'i')
    : new RegExp(`<${tag}[^>]*>([\s\S]*?)<\/${tag}>`, 'i');
  const m = html.match(pattern);
  return m ? stripHtml(m[1]) : '';
}

async function fetchSearchPage(start) {
  // f_AL=true = LinkedIn Apply (Easy Apply) only — only jobs we can auto-apply to
  const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(KEYWORDS)}&location=${encodeURIComponent(LOCATION)}&sortBy=DD&f_TPR=r604800&f_AL=true&start=${start}&count=25`;
  log(`Fetching page start=${start}: ${url.slice(0, 90)}`);
  const { status, body } = await httpGet(url);
  if (status !== 200) {
    log(`  HTTP ${status} — skipping`);
    return [];
  }

  // Split into <li> blocks
  const liBlocks = body.split('<li>').slice(1);
  const cards = [];

  for (const block of liBlocks) {
    // Extract job ID from data-entity-urn
    const urnMatch = block.match(/data-entity-urn="urn:li:jobPosting:(\d+)"/);
    if (!urnMatch) continue;
    const jobId = urnMatch[1];

    // Extract URL from the full-link anchor
    const hrefMatch = block.match(/href="([^"]+\/jobs\/view\/[^"]+)"/);
    const url = hrefMatch ? hrefMatch[1].split('?')[0] : `https://uk.linkedin.com/jobs/view/${jobId}`;

    // Extract title from h3
    const titleMatch = block.match(/<h3[^>]*class="[^"]*base-search-card__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/i);
    const title = titleMatch ? stripHtml(titleMatch[1]) : '';

    // Extract company from h4/a
    const compMatch = block.match(/<h4[^>]*class="[^"]*base-search-card__subtitle[^"]*"[^>]*>([\s\S]*?)<\/h4>/i);
    const company = compMatch ? stripHtml(compMatch[1]) : '';

    // Extract location
    const locMatch = block.match(/<span[^>]*class="[^"]*job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const location = locMatch ? stripHtml(locMatch[1]) : '';

    // Extract date
    const dateMatch = block.match(/<time[^>]*datetime="([^"]+)"/);
    const datePosted = dateMatch ? dateMatch[1] : '';

    if (title && jobId) {
      cards.push({ jobId, title, company, location, url, date_posted: datePosted });
    }
  }

  log(`  Parsed ${cards.length} cards`);
  return cards;
}

async function fetchDescription(jobId) {
  const url = `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`;
  try {
    const { status, body } = await httpGet(url);
    if (status !== 200) return '';

    // Description is in .description__text or .show-more-less-html__markup
    const descMatch = body.match(/<div[^>]*class="[^"]*show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
      || body.match(/<section[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/section>/i);
    if (descMatch) return stripHtml(descMatch[1]);

    // Fallback: everything in main description section
    const fallback = body.match(/<div[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    return fallback ? stripHtml(fallback[1]).slice(0, 4000) : '';
  } catch (e) {
    return '';
  }
}

async function scrape() {
  const jobs = [];
  const seen = new Set();
  let start = 0;
  const kwLower = KEYWORDS.toLowerCase().split(/\s+/);

  while (jobs.length < COUNT) {
    const cards = await fetchSearchPage(start);
    if (cards.length === 0) break;

    // Filter by keyword relevance
    const relevant = cards.filter(c => {
      if (seen.has(c.jobId)) return false;
      seen.add(c.jobId);
      const text = `${c.title} ${c.company}`.toLowerCase();
      return kwLower.some(kw => text.includes(kw));
    });
    log(`  ${relevant.length} relevant after filter`);

    for (const card of relevant) {
      if (jobs.length >= COUNT) break;
      const description = await fetchDescription(card.jobId);
      jobs.push({
        id: `linkedin-${card.jobId}`,
        source: 'linkedin',
        title: card.title,
        company: card.company,
        location: card.location,
        url: card.url,
        description: description.slice(0, 4000),
        salary_min: null,
        salary_max: null,
        date_posted: card.date_posted,
        fetched_at: new Date().toISOString(),
        easy_apply: false,
      });
    }

    if (cards.length < 10) break; // LinkedIn returns fewer when no more results
    start += 25;
    // Small delay to be polite
    await new Promise(r => setTimeout(r, 1000));
  }

  log(`Scraped ${jobs.length} jobs from LinkedIn`);
  _origWrite(JSON.stringify(jobs));
  process.exit(0);
}

scrape().catch(err => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
