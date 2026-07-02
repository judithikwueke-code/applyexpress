"""
fetch_jobs.py — Fetch job listings from free APIs.

Sources:
  - Reed.co.uk (free, UK-focused — requires REED_API_KEY)
  - Adzuna (free tier — requires ADZUNA_APP_ID + ADZUNA_APP_KEY)
  - CV-Library (free, UK-focused — requires CVLIBRARY_API_KEY)
  - Indeed (via Indeed Publisher API — requires INDEED_PUBLISHER_ID)
  - Jobicy (free, no auth — remote roles)
  - RemoteOK (free, no auth)
  - Greenhouse job boards (free, no auth — direct company apply)
  - Lever job boards (free, no auth — direct company apply)

Output: .tmp/jobs_raw.json

Usage:
    python tools/fetch_jobs.py --keywords "AML Compliance" --location "London" --count 30
    python tools/fetch_jobs.py  # uses .env defaults
"""

import os
import sys
import json
import time
import logging
import argparse
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s [fetch_jobs] %(message)s")
logger = logging.getLogger(__name__)

TMP_DIR = Path(".tmp")
TMP_DIR.mkdir(exist_ok=True)

HEADERS = {"User-Agent": "JobApplicationBot/1.0 (automated job search tool)"}


# ---------------------------------------------------------------------------
# Normalise
# ---------------------------------------------------------------------------

def normalise_job(raw: dict, source: str) -> dict:
    return {
        "id": f"{source}-{raw.get('id', hash(str(raw)))}",
        "source": source,
        "title": raw.get("title", "").strip(),
        "company": raw.get("company", "").strip(),
        "location": raw.get("location", "").strip(),
        "url": raw.get("url", "").strip(),
        "description": (raw.get("description") or "")[:4000],  # cap to save tokens
        "salary_min": raw.get("salary_min"),
        "salary_max": raw.get("salary_max"),
        "date_posted": raw.get("date_posted", ""),
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }


def deduplicate(jobs: list) -> list:
    seen = set()
    unique = []
    for job in jobs:
        key = (job["title"].lower(), job["company"].lower())
        if key not in seen:
            seen.add(key)
            unique.append(job)
    return unique


# ---------------------------------------------------------------------------
# The Muse
# ---------------------------------------------------------------------------

MUSE_CATEGORY_MAP = {
    "python": "Engineering",
    "engineer": "Engineering",
    "developer": "Engineering",
    "data": "Data Science",
    "analyst": "Data Science",
    "product": "Product",
    "design": "Design",
    "marketing": "Marketing",
    "sales": "Sales",
    "finance": "Finance",
}


def _guess_muse_category(keywords: str) -> str:
    kw_lower = keywords.lower()
    for term, category in MUSE_CATEGORY_MAP.items():
        if term in kw_lower:
            return category
    return "Engineering"


def fetch_the_muse(keywords: str, count: int) -> list:
    category = _guess_muse_category(keywords)
    jobs = []
    page = 1
    while len(jobs) < count:
        try:
            resp = requests.get(
                "https://www.themuse.com/api/public/jobs",
                params={"category": category, "page": page, "descending": "true"},
                headers=HEADERS,
                timeout=15,
            )
            resp.raise_for_status()
            data = resp.json()
            results = data.get("results", [])
            if not results:
                break
            for r in results:
                locations = r.get("locations", [{}])
                loc = locations[0].get("name", "Remote") if locations else "Remote"
                jobs.append(normalise_job({
                    "id": str(r.get("id", "")),
                    "title": r.get("name", ""),
                    "company": r.get("company", {}).get("name", ""),
                    "location": loc,
                    "url": r.get("refs", {}).get("landing_page", ""),
                    "description": r.get("contents", ""),
                    "date_posted": r.get("publication_date", "")[:10] if r.get("publication_date") else "",
                }, "the_muse"))
            page += 1
            time.sleep(0.5)
        except Exception as e:
            logger.warning(f"The Muse fetch failed (page {page}): {e}")
            break
    logger.info(f"The Muse: fetched {len(jobs)} jobs")
    return jobs[:count]


# ---------------------------------------------------------------------------
# RemoteOK
# ---------------------------------------------------------------------------

def fetch_remoteok(keywords: str, count: int) -> list:
    time.sleep(1)  # courtesy delay
    try:
        resp = requests.get(
            "https://remoteok.com/api",
            headers=HEADERS,
            timeout=20,
        )
        resp.raise_for_status()
        data = resp.json()
        raw_jobs = data[1:]  # index 0 is legal disclaimer

        kw_lower = keywords.lower().split()
        matched = []
        for r in raw_jobs:
            title = r.get("position", "").lower()
            tags = " ".join(r.get("tags", [])).lower()
            text = title + " " + tags
            if any(kw in text for kw in kw_lower):
                matched.append(normalise_job({
                    "id": str(r.get("id", "")),
                    "title": r.get("position", ""),
                    "company": r.get("company", ""),
                    "location": "Remote",
                    "url": r.get("url", ""),
                    "description": r.get("description", ""),
                    "date_posted": r.get("date", "")[:10] if r.get("date") else "",
                }, "remoteok"))

        logger.info(f"RemoteOK: fetched {len(matched)} matching jobs")
        return matched[:count]
    except Exception as e:
        logger.warning(f"RemoteOK fetch failed: {e}")
        return []


# ---------------------------------------------------------------------------
# Arbeitnow (free, no auth, EU + remote focused)
# ---------------------------------------------------------------------------

def fetch_arbeitnow(keywords: str, count: int) -> list:
    jobs = []
    page = 1
    kw_lower = keywords.lower().split()

    while len(jobs) < count:
        try:
            resp = requests.get(
                "https://www.arbeitnow.com/api/job-board-api",
                params={"page": page},
                headers=HEADERS,
                timeout=15,
            )
            resp.raise_for_status()
            data = resp.json()
            results = data.get("data", [])
            if not results:
                break

            for r in results:
                # Skip non-English job posts (Arbeitnow is EU-focused)
                if not r.get("english_only", False) and not r.get("remote", False):
                    lang_hints = ["(m/w/d)", "(w/m/d)", "gmbh", "ag ", " mbh"]
                    title_check = r.get("title", "").lower()
                    if any(h in title_check for h in lang_hints):
                        continue

                title = r.get("title", "").lower()
                tags = " ".join(r.get("tags", [])).lower()
                text = title + " " + tags
                if any(kw in text for kw in kw_lower):
                    jobs.append(normalise_job({
                        "id": str(r.get("slug", "")),
                        "title": r.get("title", ""),
                        "company": r.get("company_name", ""),
                        "location": r.get("location", "Remote"),
                        "url": r.get("url", ""),
                        "description": r.get("description", ""),
                        "date_posted": datetime.fromtimestamp(r["created_at"]).strftime("%Y-%m-%d")
                        if r.get("created_at") else "",
                    }, "arbeitnow"))

            page += 1
            time.sleep(0.3)
        except Exception as e:
            logger.warning(f"Arbeitnow fetch failed (page {page}): {e}")
            break

    logger.info(f"Arbeitnow: fetched {len(jobs)} matching jobs")
    return jobs[:count]


# ---------------------------------------------------------------------------
# Adzuna (optional, free tier)
# ---------------------------------------------------------------------------

def fetch_adzuna(keywords: str, location: str, count: int) -> list:
    app_id = os.getenv("ADZUNA_APP_ID", "")
    app_key = os.getenv("ADZUNA_APP_KEY", "")
    country = os.getenv("ADZUNA_COUNTRY", "gb")

    if not app_id or not app_key:
        logger.info("Adzuna: skipped (ADZUNA_APP_ID/ADZUNA_APP_KEY not set)")
        return []

    try:
        resp = requests.get(
            f"https://api.adzuna.com/v1/api/jobs/{country}/search/1",
            params={
                "app_id": app_id,
                "app_key": app_key,
                "results_per_page": min(count, 50),
                "what": keywords,
                "where": location,
                "content-type": "application/json",
                "sort_by": "date",
            },
            headers=HEADERS,
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        results = data.get("results", [])

        jobs = []
        for r in results:
            jobs.append(normalise_job({
                "id": str(r.get("id", "")),
                "title": r.get("title", ""),
                "company": r.get("company", {}).get("display_name", ""),
                "location": r.get("location", {}).get("display_name", ""),
                "url": r.get("redirect_url", ""),
                "description": r.get("description", ""),
                "salary_min": r.get("salary_min"),
                "salary_max": r.get("salary_max"),
                "date_posted": r.get("created")[:10] if r.get("created") else "",
            }, "adzuna"))

        logger.info(f"Adzuna: fetched {len(jobs)} jobs")
        return jobs
    except Exception as e:
        logger.warning(f"Adzuna fetch failed: {e}")
        return []


# ---------------------------------------------------------------------------
# Main fetcher
# ---------------------------------------------------------------------------

def fetch_reed(keywords: str, location: str, count: int) -> list:
    api_key = os.getenv("REED_API_KEY", "")
    if not api_key:
        logger.info("Reed: skipped (REED_API_KEY not set — register free at reed.co.uk/api)")
        return []

    try:
        resp = requests.get(
            "https://www.reed.co.uk/api/1.0/search",
            params={
                "keywords": keywords,
                "locationName": location,
                "resultsToTake": min(count, 100),
                "fullTime": True,
                "dateFrom": (datetime.now(timezone.utc) - __import__('datetime').timedelta(days=14)).strftime("%d/%m/%Y"),
            },
            auth=(api_key, ""),
            headers=HEADERS,
            timeout=15,
        )
        resp.raise_for_status()
        results = resp.json().get("results", [])

        jobs = []
        for r in results:
            jobs.append(normalise_job({
                "id": str(r.get("jobId", "")),
                "title": r.get("jobTitle", ""),
                "company": r.get("employerName", ""),
                "location": r.get("locationName", ""),
                "url": r.get("jobUrl", ""),
                "description": r.get("jobDescription", ""),
                "salary_min": r.get("minimumSalary"),
                "salary_max": r.get("maximumSalary"),
                "date_posted": r.get("date", "")[:10] if r.get("date") else "",
            }, "reed"))

        logger.info(f"Reed: fetched {len(jobs)} jobs")
        return jobs
    except Exception as e:
        logger.warning(f"Reed fetch failed: {e}")
        return []


# ---------------------------------------------------------------------------
# CV-Library (free UK job board API)
# ---------------------------------------------------------------------------

def fetch_cvlibrary(keywords: str, location: str, count: int) -> list:
    api_key = os.getenv("CVLIBRARY_API_KEY", "")
    if not api_key:
        logger.info("CV-Library: skipped (CVLIBRARY_API_KEY not set — free at cv-library.co.uk/api)")
        return []

    try:
        resp = requests.get(
            "https://www.cv-library.co.uk/api/jobs",
            params={
                "key": api_key,
                "q": keywords,
                "loc": location,
                "distance": 20,
                "rows": min(count, 100),
                "sort": "date",
                "format": "json",
            },
            headers=HEADERS,
            timeout=15,
        )
        resp.raise_for_status()
        results = resp.json().get("jobs", [])
        jobs = []
        for r in results:
            jobs.append(normalise_job({
                "id": str(r.get("id", "")),
                "title": r.get("title", ""),
                "company": r.get("company", ""),
                "location": r.get("location", ""),
                "url": r.get("url", ""),
                "description": r.get("description", ""),
                "salary_min": r.get("salary_min"),
                "salary_max": r.get("salary_max"),
                "date_posted": r.get("date", "")[:10] if r.get("date") else "",
            }, "cvlibrary"))
        logger.info(f"CV-Library: fetched {len(jobs)} jobs")
        return jobs
    except Exception as e:
        logger.warning(f"CV-Library fetch failed: {e}")
        return []


# ---------------------------------------------------------------------------
# Jobicy (free, no auth, remote-friendly)
# ---------------------------------------------------------------------------

def fetch_jobicy(keywords: str, count: int) -> list:
    try:
        resp = requests.get(
            "https://jobicy.com/api/v2/remote-jobs",
            params={"count": min(count, 50), "tag": keywords.split()[0]},
            headers=HEADERS,
            timeout=15,
        )
        resp.raise_for_status()
        results = resp.json().get("jobs", [])
        kw_lower = keywords.lower().split()
        jobs = []
        for r in results:
            text = (r.get("jobTitle", "") + " " + r.get("jobExcerpt", "")).lower()
            if any(kw in text for kw in kw_lower):
                jobs.append(normalise_job({
                    "id": str(r.get("id", "")),
                    "title": r.get("jobTitle", ""),
                    "company": r.get("companyName", ""),
                    "location": r.get("jobGeo", "Remote"),
                    "url": r.get("url", ""),
                    "description": r.get("jobExcerpt", ""),
                    "date_posted": r.get("pubDate", "")[:10] if r.get("pubDate") else "",
                }, "jobicy"))
        logger.info(f"Jobicy: fetched {len(jobs)} matching jobs")
        return jobs[:count]
    except Exception as e:
        logger.warning(f"Jobicy fetch failed: {e}")
        return []


# ---------------------------------------------------------------------------
# Greenhouse (direct company career pages — no login, auto-apply works)
# ---------------------------------------------------------------------------

# AML/Compliance-relevant companies known to use Greenhouse
GREENHOUSE_COMPANIES = [
    # UK fintech / neobanks (confirmed Greenhouse users)
    "monzo", "revolut", "wise", "starling", "oaknorth",
    "checkout", "form3", "currencycloud", "railsr", "modulr",
    "paynetics", "payoneer", "airwallex", "rapyd", "nium",
    "chainalysis", "elliptic",
    # UK high street / challenger banks
    "metro-bank", "atom-bank", "tandem-bank", "aldermore",
    # Professional services (compliance-heavy teams)
    "deloitte", "kpmg-uk", "ey", "accenture", "pwc",
    "kroll", "control-risks", "fti-consulting",
    # RegTech / FinCrime platforms
    "sumsub", "acuris-risk-intelligence", "featurespace",
    "quantexa", "napier-ai", "encompass-corporation",
    "seon", "unit21", "sardine", "hawk-ai",
    # Capital markets / data
    "lseg", "icis", "dun-bradstreet",
    # Insurance / finserv
    "aviva", "direct-line-group", "admiral-group",
    # Additional UK payments & open banking
    "gocardless", "funding-circle", "paysafe", "ebury",
    "truelayer", "yapily", "pensionbee", "zopa",
    # Crypto / digital assets compliance
    "coinbase", "kraken", "gemini", "blockchain-com",
]

def fetch_greenhouse(keywords: str, count: int) -> list:
    kw_lower = [k.strip().lower() for k in keywords.split(',') if k.strip()]
    jobs = []

    for company in GREENHOUSE_COMPANIES:
        if len(jobs) >= count:
            break
        try:
            resp = requests.get(
                f"https://boards-api.greenhouse.io/v1/boards/{company}/jobs",
                params={"content": "true"},
                headers=HEADERS,
                timeout=10,
            )
            if resp.status_code != 200:
                continue
            results = resp.json().get("jobs", [])
            # Tech/engineering titles to reject even if content mentions compliance
            _excl = ("engineer", "developer", "designer", "devops", "infrastructure",
                     "android", "ios", "frontend", "backend", "full stack",
                     "data scientist", "machine learning", "product manager",
                     "marketing", "sales", "recruiter", "talent")
            for r in results:
                title = r.get("title", "").lower()
                content = r.get("content", "").lower()
                loc = r.get("location", {}).get("name", "")
                loc_lower = loc.lower()
                # Only include UK-based roles
                uk_terms = ("uk", "united kingdom", "england", "london", "manchester",
                            "birmingham", "edinburgh", "leeds", "bristol", "remote")
                if loc and not any(t in loc_lower for t in uk_terms):
                    continue
                # Skip clearly irrelevant job titles
                if any(ex in title for ex in _excl):
                    continue
                if any(kw in title or kw in content for kw in kw_lower):
                    job_id = str(r.get("id", ""))
                    # Use direct Greenhouse board URL so _route_apply() can detect it
                    gh_url = f"https://boards.greenhouse.io/{company}/jobs/{job_id}"
                    jobs.append(normalise_job({
                        "id": job_id,
                        "title": r.get("title", ""),
                        "company": company.title(),
                        "location": loc,
                        "url": gh_url,
                        "description": r.get("content", "")[:4000],
                        "date_posted": r.get("updated_at", "")[:10] if r.get("updated_at") else "",
                    }, "greenhouse"))
            time.sleep(0.3)
        except Exception:
            continue

    logger.info(f"Greenhouse: fetched {len(jobs)} matching jobs")
    return jobs[:count]


# ---------------------------------------------------------------------------
# Ashby (modern ATS — direct apply, no login needed)
# Lever v0 public API was deprecated; replaced with Ashby which is widely
# adopted by UK fintechs and RegTech firms.
# ---------------------------------------------------------------------------

ASHBY_COMPANIES = [
    # Crypto / blockchain compliance (confirmed Ashby users)
    "elliptic", "kraken",
    # RegTech / FinCrime analytics
    "quantexa", "seon", "sardine", "hawk",
    # UK challenger banks
    "griffin", "clearbank", "oaknorth",
    # UK / global payments
    "airwallex", "capchase",
]

def fetch_ashby(keywords: str, count: int) -> list:
    kw_lower = [k.strip().lower() for k in keywords.split(',') if k.strip()]
    jobs = []

    _excl = ("engineer", "developer", "designer", "devops", "android",
             "ios", "frontend", "backend", "data scientist", "machine learning",
             "marketing", "sales", "recruiter")

    for company in ASHBY_COMPANIES:
        if len(jobs) >= count:
            break
        try:
            resp = requests.get(
                f"https://api.ashbyhq.com/posting-api/job-board/{company}",
                headers=HEADERS,
                timeout=10,
            )
            if resp.status_code != 200:
                continue
            results = resp.json().get("jobs", [])
            for r in results:
                title = r.get("title", "").lower()
                desc = r.get("descriptionHtml", "").lower()
                loc = r.get("location", "") or r.get("locationName", "")
                loc_lower = loc.lower()
                uk_terms = ("uk", "united kingdom", "england", "london", "manchester",
                            "birmingham", "edinburgh", "leeds", "bristol", "remote")
                if loc and not any(t in loc_lower for t in uk_terms):
                    continue
                if any(ex in title for ex in _excl):
                    continue
                if any(kw in title or kw in desc for kw in kw_lower):
                    apply_url = r.get("applyUrl") or r.get("jobUrl", "")
                    jobs.append(normalise_job({
                        "id": str(r.get("id", "")),
                        "title": r.get("title", ""),
                        "company": company.title(),
                        "location": loc,
                        "url": apply_url,
                        "description": r.get("descriptionHtml", "")[:4000],
                        "date_posted": r.get("publishedAt", "")[:10] if r.get("publishedAt") else "",
                    }, "ashby"))
            time.sleep(0.3)
        except Exception:
            continue

    logger.info(f"Ashby: fetched {len(jobs)} matching jobs")
    return jobs[:count]


# ---------------------------------------------------------------------------
# Indeed (Playwright scraper — requires saved session)
# ---------------------------------------------------------------------------

def _primary_keyword(keywords: str) -> str:
    """Extract the first clean keyword from a comma-separated list.
    'AML, Compliance, MLRO, Data Protection Officer' → 'AML Compliance'
    'site engineer' → 'site engineer'
    Returns a 2-word max search term that works well with LinkedIn/Indeed APIs.
    """
    parts = [p.strip() for p in keywords.split(",") if p.strip()]
    if not parts:
        return keywords
    # Use first two parts joined (e.g. "AML" + "Compliance" → "AML Compliance")
    return " ".join(parts[:2])


def fetch_indeed(keywords: str, location: str, count: int, cookies_path: str = "") -> list:
    script = Path("tools/scrape_indeed.js")
    has_cookies = bool(cookies_path and Path(cookies_path).exists())

    # Only use the persistent session dir as a fallback when a user cookies file exists —
    # the global .tmp/indeed_session session expires and returns 0 jobs silently.
    # Prefer the extension-synced user-specific cookies file.
    session_dir = Path(".tmp/indeed_session")
    has_session = session_dir.exists() and has_cookies  # only trust session dir if we also have fresh cookies

    if not has_cookies and not session_dir.exists():
        logger.info("Indeed: skipped — log in to Indeed.co.uk in Chrome with the ApplyExpress extension to enable this source")
        return []
    if not has_cookies and not has_session:
        logger.info("Indeed: skipped — no valid session (log in to Indeed in Chrome to sync cookies)")
        return []
    if not script.exists():
        logger.info("Indeed: skipped (scrape_indeed.js not found)")
        return []

    # Indeed/LinkedIn APIs work best with 1-2 clean keywords, not a full comma-separated list
    search_kw = _primary_keyword(keywords)
    cmd = ["node", str(script),
           "--keywords", search_kw,
           "--location", location,
           "--count", str(count)]
    if has_cookies:
        cmd += ["--cookies-path", cookies_path]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True, text=True, timeout=180,
        )
        if result.returncode != 0:
            logger.warning(f"Indeed scraper failed: {result.stderr.strip()[-200:]}")
            return []
        jobs = json.loads(result.stdout)
        logger.info(f"Indeed: fetched {len(jobs)} jobs")
        return jobs
    except subprocess.TimeoutExpired:
        logger.warning("Indeed: scraper timed out (180s)")
        return []
    except Exception as e:
        logger.warning(f"Indeed fetch failed: {e}")
        return []


# ---------------------------------------------------------------------------
# LinkedIn (Playwright scraper — requires saved session)
# ---------------------------------------------------------------------------

def fetch_linkedin(keywords: str, location: str, count: int) -> list:
    script = Path("tools/scrape_linkedin.js")
    if not script.exists():
        logger.info("LinkedIn: skipped (scrape_linkedin.js not found)")
        return []
    # LinkedIn's guest API returns 0 results for long comma-separated keyword strings
    search_kw = _primary_keyword(keywords)
    try:
        result = subprocess.run(
            ["node", str(script),
             "--keywords", search_kw,
             "--location", location,
             "--count", str(count)],
            capture_output=True, text=True, timeout=240,
        )
        if result.returncode != 0:
            logger.warning(f"LinkedIn scraper failed: {result.stderr.strip()[-200:]}")
            return []
        jobs = json.loads(result.stdout)
        logger.info(f"LinkedIn: fetched {len(jobs)} jobs")
        return jobs
    except subprocess.TimeoutExpired:
        logger.warning("LinkedIn: scraper timed out (240s)")
        return []
    except Exception as e:
        logger.warning(f"LinkedIn fetch failed: {e}")
        return []


# ---------------------------------------------------------------------------
# Main fetcher
# ---------------------------------------------------------------------------

def fetch_all_jobs(keywords: str, location: str, count: int, indeed_cookies: str = "") -> list:
    per_source = max(count // 4, 10)

    all_jobs = []
    all_jobs += fetch_reed(keywords, location, count)
    # Also search major regional UK cities to surface non-London roles
    if location.lower() in ("united kingdom", "uk", "england", "britain"):
        for city in ("Manchester", "Birmingham", "Edinburgh", "Leeds", "Bristol"):
            city_jobs = fetch_reed(keywords, city, per_source)
            all_jobs += city_jobs
        logger.info("Reed: added regional UK city searches (Manchester/Birmingham/Edinburgh/Leeds/Bristol)")
    all_jobs += fetch_adzuna(keywords, location, per_source)
    all_jobs += fetch_cvlibrary(keywords, location, per_source)
    all_jobs += fetch_greenhouse(keywords, per_source)
    all_jobs += fetch_ashby(keywords, per_source)
    all_jobs += fetch_jobicy(keywords, per_source)
    # all_jobs += fetch_remoteok(keywords, per_source)  # disabled: returns US-only jobs
    all_jobs += fetch_indeed(keywords, location, per_source, cookies_path=indeed_cookies)
    all_jobs += fetch_linkedin(keywords, location, per_source)

    unique_jobs = deduplicate(all_jobs)
    logger.info(f"Total after deduplication: {len(unique_jobs)} jobs (from {len(all_jobs)} raw)")
    return unique_jobs


def main():
    parser = argparse.ArgumentParser(description="Fetch job listings from free APIs")
    parser.add_argument("--keywords", default=os.getenv("JOB_SEARCH_KEYWORDS", "engineer"))
    parser.add_argument("--location", default=os.getenv("JOB_SEARCH_LOCATION", "London"))
    parser.add_argument("--count", type=int, default=int(os.getenv("JOB_SEARCH_COUNT", "30")))
    parser.add_argument("--output", default=".tmp/jobs_raw.json")
    args = parser.parse_args()

    logger.info(f"Fetching jobs: keywords='{args.keywords}', location='{args.location}', count={args.count}")
    jobs = fetch_all_jobs(args.keywords, args.location, args.count)

    output_path = Path(args.output)
    output_path.parent.mkdir(exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(jobs, f, indent=2)

    logger.info(f"Saved {len(jobs)} jobs to {output_path}")
    print(f"\nFetched {len(jobs)} jobs. Saved to {output_path}")
    return jobs


if __name__ == "__main__":
    main()
