"""
run_pipeline.py — Main orchestrator for the AI job application pipeline.

Runs the full pipeline:
  1. Fetch jobs from free APIs
  2. Score all jobs (sequential, rate-limit safe)
  3. Filter by score threshold
  4. Generate AI content in parallel (CV, cover letter, answers, recruiter)
  5. Attempt auto-apply via Playwright (apply_job.js)
  6. Save all results to Google Sheets
  7. Send email digest

Usage:
    python tools/run_pipeline.py
    python tools/run_pipeline.py --dry-run      # fetch + score only, no apply/save
    python tools/run_pipeline.py --skip-apply   # generate content but don't apply
"""

import os
import sys
import json
import time
import logging
import argparse
import subprocess
from pathlib import Path
from datetime import date, datetime
from concurrent.futures import ThreadPoolExecutor, as_completed

from dotenv import load_dotenv

load_dotenv()

_TMP = Path(os.getenv("TMP_DIR", ".tmp"))
_TMP.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [pipeline] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(str(_TMP / "pipeline.log")),
    ],
)
logger = logging.getLogger(__name__)

# Ensure project root is on path
sys.path.insert(0, str(Path(__file__).parent.parent))

from tools.fetch_jobs import fetch_all_jobs
from tools.score_job import score_job
from tools.tailor_cv import tailor_cv
from tools.generate_cover_letter import generate_cover_letter
from tools.generate_application_answers import generate_application_answers
from tools.recruiter_finder import recruiter_finder
from tools.save_to_sheets import save_to_sheets
from tools.send_notification import send_notification

TMP_DIR = _TMP


# ---------------------------------------------------------------------------
# Config loader
# ---------------------------------------------------------------------------

def load_config() -> dict:
    profile_path = Path(os.getenv("CANDIDATE_PROFILE_PATH", "./candidate_profile.md"))
    if not profile_path.exists():
        raise FileNotFoundError(
            f"Candidate profile not found at {profile_path}. "
            "Fill in candidate_profile.md before running the pipeline."
        )

    profile_text = profile_path.read_text()

    # Check profile is actually filled in (not just the template)
    if "[Your Full Name]" in profile_text:
        logger.warning("candidate_profile.md appears to still have placeholder text. Fill it in for best results.")

    return {
        "profile_text": profile_text,
        "keywords": os.getenv("JOB_SEARCH_KEYWORDS", "engineer"),
        "location": os.getenv("JOB_SEARCH_LOCATION", "London"),
        "count": int(os.getenv("JOB_SEARCH_COUNT", "30")),
        "threshold": int(os.getenv("SCORE_THRESHOLD", "7")),
        "candidate_name": _extract_name(profile_text),
        "candidate_email": _extract_email(profile_text),
        "candidate_phone": _extract_phone(profile_text),
        "cv_path": os.getenv("CV_PATH", ""),
    }


def _extract_name(profile_text: str) -> str:
    for line in profile_text.splitlines():
        if line.strip().startswith("- Name:"):
            return line.split(":", 1)[1].strip().strip("[]")
    return ""


def _extract_email(profile_text: str) -> str:
    for line in profile_text.splitlines():
        if line.strip().startswith("- Email:"):
            return line.split(":", 1)[1].strip().strip("[]")
    return ""


def _extract_phone(profile_text: str) -> str:
    for line in profile_text.splitlines():
        if line.strip().startswith("- Phone:"):
            return line.split(":", 1)[1].strip().strip("[]")
    return ""


# ---------------------------------------------------------------------------
# Parallel AI generation for one job
# ---------------------------------------------------------------------------

def _generate_for_job(job: dict, profile_text: str) -> dict:
    """
    Run all 5 AI generation tasks for a single job.
    Returns the enriched job dict.
    """
    job_label = f"{job['title']} @ {job['company']}"
    logger.info(f"Generating AI content: {job_label}")

    results = {}
    errors = []

    tasks = {
        "cv_summary": lambda: tailor_cv(job, profile_text),
        "cover_letter": lambda: generate_cover_letter(job, profile_text),
        "app_answers": lambda: generate_application_answers(job, profile_text),
        "recruiter_strategy": lambda: recruiter_finder(job, profile_text),
    }

    # Run sequentially within this thread to avoid nested parallelism issues
    # (the outer ThreadPoolExecutor provides parallelism across jobs)
    for key, fn in tasks.items():
        try:
            results[key] = fn()
            time.sleep(0.3)  # small gap between calls within one job
        except Exception as e:
            logger.error(f"  {key} failed for {job_label}: {e}")
            errors.append(f"{key}: {e}")
            results[key] = None

    enriched = {**job, **results, "generation_errors": errors}
    logger.info(f"Generated content for: {job_label} ({'✓' if not errors else f'{len(errors)} errors'})")
    return enriched


# ---------------------------------------------------------------------------
# Apply via Playwright
# ---------------------------------------------------------------------------

def _route_apply_script(url: str) -> tuple[str, int]:
    """
    Return (script_path, timeout_seconds) for the right apply tool given a job URL.
    Routing mirrors the Chrome extension's processNextJob() logic.
    """
    u = url.lower()
    if "greenhouse.io" in u or "boards.eu.greenhouse.io" in u:
        return "tools/apply_greenhouse_playwright.js", 240
    if "jobs.lever.co" in u:
        return "tools/apply_lever_playwright.js", 180
    if "reed.co.uk" in u:
        return "tools/apply_reed_playwright.js", 180
    if "totaljobs.com" in u:
        return "tools/apply_totaljobs.js", 180
    if "indeed.co.uk" in u or "uk.indeed.com" in u or "indeed.com" in u:
        return "tools/apply_indeed.js", 180
    if "linkedin.com/jobs" in u:
        return "tools/apply_linkedin.js", 300
    # Fallback: generic script
    return "tools/apply_job.js", 180


def _apply_to_job(job: dict, cv_path: str = None) -> dict:
    """
    Attempt to apply to a job using the correct Playwright script for the ATS.
    Routes by URL: Greenhouse → Lever → Reed → Totaljobs → Indeed → LinkedIn → generic.
    Returns {"status": "Applied"|"Needs Review", "reason": str}
    """
    url = job.get("url", "")
    if not url:
        return {"status": "Needs Review", "reason": "No application URL"}

    script_path, timeout = _route_apply_script(url)
    if not Path(script_path).exists():
        return {"status": "Needs Review", "reason": f"{script_path} not found"}

    cover_letter = job.get("cover_letter", "")
    name = job.get("_candidate_name", "")
    email = job.get("_candidate_email", "")
    phone = job.get("_candidate_phone", "")
    job_title = job.get("title", "")
    company = job.get("company", "")

    u = url.lower()

    # Build command — each script has slightly different flags
    if "apply_greenhouse_playwright.js" in script_path:
        cmd = [
            "node", script_path,
            "--url", url,
            "--cover-letter", cover_letter[:3000],
            "--job-title", job_title,
            "--company", company,
        ]
        if cv_path and Path(cv_path).exists():
            cmd += ["--cv-path", cv_path]

    elif "apply_lever_playwright.js" in script_path:
        cmd = [
            "node", script_path,
            "--url", url,
            "--name", name,
            "--email", email,
            "--phone", phone,
            "--cover-letter", cover_letter[:3000],
        ]
        if cv_path and Path(cv_path).exists():
            cmd += ["--cv-path", cv_path]

    elif "apply_totaljobs.js" in script_path:
        cmd = [
            "node", script_path,
            "--url", url,
            "--cover-letter", cover_letter[:3000],
        ]
        if cv_path and Path(cv_path).exists():
            cmd += ["--cv-path", cv_path]

    elif "apply_indeed.js" in script_path or "apply_linkedin.js" in script_path:
        cmd = [
            "node", script_path,
            "--url", url,
            "--cover-letter", cover_letter[:3000],
        ]
        if cv_path and Path(cv_path).exists():
            cmd += ["--cv-path", cv_path]

    else:
        # Generic fallback
        cmd = [
            "node", script_path,
            "--url", url,
            "--name", name,
            "--email", email,
            "--phone", phone,
            "--cover-letter", cover_letter[:2000],
        ]
        if cv_path and Path(cv_path).exists():
            cmd += ["--cv-path", cv_path]

    try:
        logger.info(f"Applying [{Path(script_path).stem}]: {job_title} @ {company} ({url[:60]})")
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )

        output = (result.stdout + result.stderr).strip()
        last_line = output.splitlines()[-1] if output else ""

        if result.returncode == 0:
            logger.info(f"  ✓ Applied: {job_title} @ {company}")
            return {"status": "Applied", "reason": "Auto-applied successfully"}
        elif result.returncode == 2:
            # Lever exit code 2 = external ATS, not a failure
            logger.info(f"  → External ATS: {job_title} @ {company}")
            return {"status": "Needs Review", "reason": "External ATS — apply manually"}
        elif result.returncode == 3:
            # Lever exit code 3 = CAPTCHA blocked
            logger.warning(f"  ⚠ CAPTCHA blocked: {job_title} @ {company}")
            return {"status": "Needs Review", "reason": "CAPTCHA — needs TWOCAPTCHA_API_KEY"}
        else:
            logger.warning(f"  ✗ Failed: {job_title} @ {company} — {last_line}")
            return {"status": "Needs Review", "reason": last_line or "Apply script returned non-zero"}

    except subprocess.TimeoutExpired:
        return {"status": "Needs Review", "reason": f"Apply script timed out ({timeout}s)"}
    except FileNotFoundError:
        return {"status": "Needs Review", "reason": "Node.js not found. Install Node.js."}
    except Exception as e:
        return {"status": "Needs Review", "reason": str(e)}


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def run_pipeline(dry_run: bool = False, skip_apply: bool = False) -> dict:
    start_time = time.time()
    run_date = date.today().isoformat()
    logger.info(f"=== Pipeline starting: {run_date} ===")

    errors = []
    stats = {
        "date": run_date,
        "total_fetched": 0,
        "total_scored": 0,
        "qualifying_jobs": 0,
        "processed_jobs": 0,
        "applied": 0,
        "escalated": 0,
        "saved_to_sheets": 0,
        "errors": [],
        "jobs": [],
        "threshold": 0,
    }

    # ── Step 1: Load config ───────────────────────────────────────────────
    try:
        config = load_config()
    except Exception as e:
        logger.error(f"Config load failed: {e}")
        return {"success": False, "error": str(e)}

    stats["threshold"] = config["threshold"]
    logger.info(f"Profile loaded | Keywords: '{config['keywords']}' | Location: '{config['location']}' | Threshold: {config['threshold']}")

    # ── Step 2: Fetch jobs ────────────────────────────────────────────────
    logger.info("Fetching jobs...")
    try:
        jobs = fetch_all_jobs(config["keywords"], config["location"], config["count"])
        stats["total_fetched"] = len(jobs)
        with open(TMP_DIR / "jobs_raw.json", "w") as f:
            json.dump(jobs, f, indent=2)
        logger.info(f"Fetched {len(jobs)} jobs")
    except Exception as e:
        logger.error(f"Job fetch failed: {e}")
        errors.append(f"fetch_jobs: {e}")
        jobs = []

    if not jobs:
        logger.warning("No jobs fetched. Sending notification and exiting.")
        stats["errors"] = errors
        send_notification(stats)
        return stats

    # ── Step 3: Score all jobs (sequential) ───────────────────────────────
    logger.info(f"Scoring {len(jobs)} jobs...")
    scored_jobs = []
    for i, job in enumerate(jobs):
        try:
            score_result = score_job(job, config["profile_text"])
            job.update(score_result)
            scored_jobs.append(job)
            logger.info(f"  [{i+1}/{len(jobs)}] {job['title']} @ {job['company']} → {score_result['score']}/10 ({score_result['apply_decision']})")
        except Exception as e:
            logger.error(f"  Score failed for {job.get('title')}: {e}")
            errors.append(f"score_job({job.get('title')}): {e}")
        time.sleep(2)  # Groq free tier: ~30 req/min, 2s gap keeps us safe

    stats["total_scored"] = len(scored_jobs)
    with open(TMP_DIR / "jobs_scored.json", "w") as f:
        json.dump(scored_jobs, f, indent=2)

    # ── Step 4: Filter ────────────────────────────────────────────────────
    qualifying = [
        j for j in scored_jobs
        if j.get("score", 0) >= config["threshold"]
        and j.get("apply_decision") in ("yes", "maybe")
    ]
    stats["qualifying_jobs"] = len(qualifying)
    logger.info(f"{len(qualifying)} qualifying jobs (score >= {config['threshold']})")

    if dry_run:
        logger.info("Dry run: stopping after scoring. No applications or saves.")
        stats["runtime_seconds"] = int(time.time() - start_time)
        return stats

    if not qualifying:
        logger.info("No qualifying jobs. Sending notification.")
        stats["errors"] = errors
        send_notification(stats)
        return stats

    # ── Step 5: Parallel AI generation ───────────────────────────────────
    logger.info(f"Generating AI content for {len(qualifying)} jobs (parallel, max 3 workers)...")
    enriched_jobs = []

    with ThreadPoolExecutor(max_workers=1) as executor:
        future_to_job = {
            executor.submit(_generate_for_job, job, config["profile_text"]): job
            for job in qualifying
        }
        for future in as_completed(future_to_job):
            try:
                enriched = future.result()
                # Attach candidate details for the apply script
                enriched["_candidate_name"] = config["candidate_name"]
                enriched["_candidate_email"] = config["candidate_email"]
                enriched["_candidate_phone"] = config["candidate_phone"]
                enriched_jobs.append(enriched)
            except Exception as e:
                orig_job = future_to_job[future]
                logger.error(f"Generation failed for {orig_job.get('title')}: {e}")
                errors.append(f"generate({orig_job.get('title')}): {e}")

    stats["processed_jobs"] = len(enriched_jobs)
    with open(TMP_DIR / "jobs_enriched.json", "w") as f:
        json.dump(enriched_jobs, f, indent=2)

    # ── Step 6: Apply + Save ──────────────────────────────────────────────
    for enriched in enriched_jobs:
        job_label = f"{enriched['title']} @ {enriched['company']}"

        # Auto-apply
        if not skip_apply:
            apply_result = _apply_to_job(enriched, cv_path=config.get("cv_path"))
            enriched["status"] = apply_result["status"]
            enriched["notes"] = apply_result.get("reason", "")
        else:
            enriched["status"] = "Pending Review"

        if enriched.get("status") == "Applied":
            stats["applied"] += 1
        else:
            stats["escalated"] += 1

        # Save to Sheets
        try:
            save_result = save_to_sheets({
                "title": enriched.get("title", ""),
                "company": enriched.get("company", ""),
                "location": enriched.get("location", ""),
                "url": enriched.get("url", ""),
                "score": enriched.get("score", ""),
                "score_reason": enriched.get("reason", ""),
                "apply_decision": enriched.get("apply_decision", ""),
                "cv_summary": enriched.get("cv_summary", ""),
                "cover_letter": enriched.get("cover_letter", ""),
                "app_answers": enriched.get("app_answers", {}),
                "linkedin_message": "",
                "recruiter_strategy": enriched.get("recruiter_strategy", {}),
                "status": enriched.get("status", "Pending Review"),
                "notes": enriched.get("notes", ""),
            })
            if save_result.get("success"):
                stats["saved_to_sheets"] += 1
            else:
                errors.append(f"save_sheets({job_label}): {save_result.get('error')}")
        except Exception as e:
            errors.append(f"save_sheets({job_label}): {e}")

        # Track for email
        stats["jobs"].append({
            "title": enriched.get("title", ""),
            "company": enriched.get("company", ""),
            "score": enriched.get("score", 0),
            "apply_decision": enriched.get("apply_decision", ""),
            "status": enriched.get("status", ""),
        })

    # ── Step 7: Notify ────────────────────────────────────────────────────
    stats["errors"] = errors
    stats["runtime_seconds"] = int(time.time() - start_time)

    logger.info(f"Sending notification: {stats['applied']} applied, {stats['escalated']} need review")
    send_notification(stats)

    logger.info(
        f"=== Pipeline complete in {stats['runtime_seconds']}s | "
        f"Fetched: {stats['total_fetched']} | "
        f"Qualifying: {stats['qualifying_jobs']} | "
        f"Applied: {stats['applied']} | "
        f"Saved: {stats['saved_to_sheets']} ==="
    )

    return stats


def main():
    parser = argparse.ArgumentParser(description="Run the AI job application pipeline")
    parser.add_argument("--user",        default=None, help="Load from users/<username>/.env (multi-user mode)")
    parser.add_argument("--dry-run",     action="store_true", help="Fetch and score only — no apply or save")
    parser.add_argument("--skip-apply",  action="store_true", help="Generate content but don't attempt applications")
    args = parser.parse_args()

    # Load per-user .env if --user supplied (overrides root .env values)
    if args.user:
        user_env_path = Path(__file__).parent.parent / "users" / args.user / ".env"
        if user_env_path.exists():
            load_dotenv(user_env_path, override=True)
            logger.info(f"Loaded user env: {user_env_path}")
        else:
            logger.warning(f"User env not found: {user_env_path}")

    stats = run_pipeline(dry_run=args.dry_run, skip_apply=args.skip_apply)

    print("\n" + "=" * 60)
    print(f"Pipeline complete — {stats.get('date', '')}")
    print(f"  Fetched:    {stats.get('total_fetched', 0)} jobs")
    print(f"  Qualifying: {stats.get('qualifying_jobs', 0)} (score >= {stats.get('threshold', 7)})")
    print(f"  Applied:    {stats.get('applied', 0)}")
    print(f"  Review:     {stats.get('escalated', 0)}")
    print(f"  Saved:      {stats.get('saved_to_sheets', 0)}")
    print(f"  Runtime:    {stats.get('runtime_seconds', 0)}s")
    if stats.get("errors"):
        print(f"  Errors:     {len(stats['errors'])}")
    print("=" * 60)


if __name__ == "__main__":
    main()
