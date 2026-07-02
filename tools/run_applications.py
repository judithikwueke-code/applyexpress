"""
run_applications.py — End-to-end job application orchestrator.

For each qualifying job:
  1. Generates a tailored CV .docx (unique per job, modified Professional Summary)
  2. Generates a matching .pdf version
  3. Applies via the correct tool (LinkedIn / Indeed / Reed / Greenhouse etc.)
  4. Records exactly which CV files were used and the outcome

Usage:
    python tools/run_applications.py \
        --keywords "MLRO compliance" \
        --location "London" \
        --max-apply 5 \
        --threshold 7

    python tools/run_applications.py --dry-run   # generate CVs and cover letters, skip apply

Output:
    .tmp/application_report_YYYYMMDD_HHMMSS.json   full machine-readable report
    Console: formatted human-readable table
"""

import os
import sys
import re
import json
import time
import logging
import argparse
import subprocess
from pathlib import Path
from datetime import datetime

from dotenv import load_dotenv

# Multi-user: load per-user .env early (before arg parsing) if USER_ENV_FILE is set.
# This is set by the --user flag handler below, or externally.
_early_user_env = os.getenv("USER_ENV_FILE")
if _early_user_env and Path(_early_user_env).exists():
    load_dotenv(_early_user_env, override=True)
else:
    load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s [run_app] %(message)s")
logger = logging.getLogger(__name__)

sys.path.insert(0, str(Path(__file__).parent.parent))

from tools.fetch_jobs        import fetch_all_jobs
from tools.score_job         import score_job
from tools.tailor_cv_docx    import tailor_cv_docx
from tools.generate_cv_pdf   import generate_cv_pdf
from tools.generate_cover_letter import generate_cover_letter

TMP_DIR = Path(os.getenv("TMP_DIR", ".tmp"))
TMP_DIR.mkdir(parents=True, exist_ok=True)


# ── Helpers ────────────────────────────────────────────────────────────────────

def slug(text: str, max_len: int = 22) -> str:
    """Make a filesystem-safe slug."""
    return re.sub(r"[^\w]", "_", text.lower())[:max_len].strip("_")


def detect_ats(url: str) -> str:
    """Return the ATS/platform name for a given job URL."""
    u = url.lower()
    if "linkedin.com" in u:
        return "linkedin"
    if "indeed.com" in u or "indeed.co.uk" in u:
        return "indeed"
    if "reed.co.uk" in u:
        return "reed"
    if "greenhouse.io" in u or "greenhouse.com" in u:
        return "greenhouse"
    if "lever.co" in u:
        return "lever"
    if "totaljobs.com" in u:
        return "totaljobs"
    return "unknown"


def apply_linkedin(url: str, cv_path: str, cover_letter: str) -> dict:
    cmd = [
        "node", "tools/apply_linkedin.js",
        "--url", url,
        "--cv-path", cv_path,
        "--cover-letter", cover_letter,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=240)
    output = result.stdout + result.stderr
    success  = result.returncode == 0 or "✓ submitted" in output.lower()
    external = result.returncode == 2 or "external" in output.lower() and "apply" in output.lower()
    return {"success": success, "external": external, "output": output[-1200:]}


def apply_indeed(url: str, cv_path: str, cover_letter: str) -> dict:
    cmd = [
        "node", "tools/apply_indeed.js",
        "--url", url,
        "--cv-path", cv_path,
        "--cover-letter", cover_letter,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=240)
    output = result.stdout + result.stderr
    success  = result.returncode == 0 or "✓ application submitted" in output.lower()
    external = "no easy apply button" in output.lower() or "redirect to external" in output.lower()
    return {"success": success, "external": external, "output": output[-1200:]}


def apply_greenhouse(url: str, cv_path: str, cover_letter: str) -> dict:
    cmd = [
        "node", "tools/apply_greenhouse_playwright.js",
        "--url", url,
        "--cv-path", cv_path,
        "--cover-letter", cover_letter,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=240)
    output = result.stdout + result.stderr
    success = result.returncode == 0 or "submitted" in output.lower()
    return {"success": success, "output": output[-1200:]}


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--user",       default=None, help="Load from users/<username>/.env (multi-user mode)")
    parser.add_argument("--keywords",   default=None)
    parser.add_argument("--location",   default=None)
    parser.add_argument("--count",      type=int, default=None, help="Max jobs to fetch")
    parser.add_argument("--threshold",  type=int, default=None, help="Min score to apply (1-10)")
    parser.add_argument("--max-apply",  type=int, default=10,   help="Max applications to submit")
    parser.add_argument("--dry-run",    action="store_true",    help="Generate CVs but skip apply")
    parser.add_argument("--jobs-file",  default=None, help="Skip fetch — use existing jobs JSON")
    args = parser.parse_args()

    # Load per-user .env if --user supplied (overrides root .env values)
    if args.user:
        user_env_path = Path(__file__).parent.parent / "users" / args.user / ".env"
        if user_env_path.exists():
            load_dotenv(user_env_path, override=True)
            logger.info(f"Loaded user env: {user_env_path}")
            # Refresh TMP_DIR after reloading env
            global TMP_DIR
            TMP_DIR = Path(os.getenv("TMP_DIR", f"users/{args.user}/.tmp"))
            TMP_DIR.mkdir(parents=True, exist_ok=True)
        else:
            logger.warning(f"User env not found: {user_env_path}")

    # Resolve defaults from env (which may now be user-specific)
    keywords  = args.keywords  or os.getenv("JOB_SEARCH_KEYWORDS", "AML compliance")
    location  = args.location  or os.getenv("JOB_SEARCH_LOCATION", "London")
    count     = args.count     or int(os.getenv("JOB_SEARCH_COUNT", "30"))
    threshold = args.threshold or int(os.getenv("SCORE_THRESHOLD", "7"))

    run_id = datetime.now().strftime("%Y%m%d_%H%M%S")
    report = {
        "run_id":    run_id,
        "keywords":  keywords,
        "location":  location,
        "threshold": threshold,
        "dry_run":   args.dry_run,
        "jobs":      [],
    }

    profile_path = Path(os.getenv("CANDIDATE_PROFILE_PATH", "candidate_profile.md"))
    profile_text = profile_path.read_text()

    # ── 1. Fetch ──────────────────────────────────────────────────────────────
    if args.jobs_file:
        logger.info(f"Loading jobs from {args.jobs_file}")
        jobs_raw = json.loads(Path(args.jobs_file).read_text())
    else:
        logger.info(f"Fetching jobs: {keywords!r} in {location!r}")
        jobs_raw = fetch_all_jobs(keywords, location, count)
        raw_path = TMP_DIR / "jobs_raw.json"
        raw_path.write_text(json.dumps(jobs_raw, indent=2))
        logger.info(f"Fetched {len(jobs_raw)} jobs")

    # ── 2. Score ──────────────────────────────────────────────────────────────
    logger.info("Scoring jobs...")
    scored = []
    for job in jobs_raw:
        try:
            result = score_job(job, profile_text)
            job["score"] = result.get("score", 0)
            job["score_reason"] = result.get("reason", "")
        except Exception as e:
            logger.warning(f"Score failed for '{job.get('title')}': {e}")
            job["score"] = 0
            job["score_reason"] = ""
        scored.append(job)
        time.sleep(0.3)

    scored_path = TMP_DIR / "jobs_scored.json"
    scored_path.write_text(json.dumps(scored, indent=2))

    qualifying = [j for j in scored if j["score"] >= threshold]
    logger.info(f"{len(qualifying)} qualifying jobs (score >= {threshold}) out of {len(scored)}")

    if not qualifying:
        logger.info("No qualifying jobs — done.")
        print("\nNo jobs met the score threshold. Exiting.")
        return

    # ── 3. Per-job: tailor CV → generate PDF → cover letter → apply ──────────
    applied_count = 0

    for job in qualifying:
        if applied_count >= args.max_apply:
            logger.info(f"Reached max-apply limit ({args.max_apply})")
            break

        title   = job.get("title", "Unknown")
        company = job.get("company", "Unknown")
        url     = job.get("url", "")
        source  = job.get("source", "unknown")
        score   = job.get("score", 0)
        desc    = job.get("description", "")

        logger.info(f"\n{'='*60}")
        logger.info(f"Processing: {title} @ {company}  [score={score}]")

        record = {
            "title":    title,
            "company":  company,
            "url":      url,
            "source":   source,
            "score":    score,
            "cv_docx":  None,
            "cv_pdf":   None,
            "cover_letter_path": None,
            "status":   "pending",
            "ats":      detect_ats(url),
            "notes":    "",
        }

        # ── 3a. Tailor CV → .docx ──────────────────────────────────────────
        cv_filename = f"cv_{slug(company)}_{slug(title)}.docx"
        cv_docx_path = str(TMP_DIR / cv_filename)
        try:
            tailor_cv_docx(title, company, desc, cv_docx_path)
            record["cv_docx"] = cv_docx_path
            logger.info(f"  DOCX: {cv_docx_path}")
        except Exception as e:
            logger.error(f"  DOCX tailor failed: {e} — using base CV")
            cv_docx_path = os.getenv("CV_PATH", "")
            record["cv_docx"] = cv_docx_path
            record["notes"] += f"CV tailor error: {e}. "

        # ── 3b. Convert to .pdf ────────────────────────────────────────────
        cv_pdf_path = cv_docx_path.replace(".docx", ".pdf")
        try:
            generate_cv_pdf(cv_docx_path, cv_pdf_path)
            record["cv_pdf"] = cv_pdf_path
            logger.info(f"  PDF:  {cv_pdf_path}")
        except Exception as e:
            logger.error(f"  PDF generation failed: {e}")
            record["notes"] += f"PDF error: {e}. "

        # ── 3c. Generate cover letter ──────────────────────────────────────
        cl_path = str(TMP_DIR / f"cl_{slug(company)}_{slug(title)}.txt")
        try:
            cover_letter = generate_cover_letter(job, profile_text)
            Path(cl_path).write_text(cover_letter)
            record["cover_letter_path"] = cl_path
            logger.info(f"  Cover letter: {cl_path}")
        except Exception as e:
            logger.error(f"  Cover letter failed: {e}")
            cover_letter = ""
            record["notes"] += f"Cover letter error: {e}. "

        # ── 3d. Apply ──────────────────────────────────────────────────────
        if args.dry_run:
            record["status"] = "dry_run"
            record["notes"] += "Dry run — apply skipped."
            logger.info("  [DRY RUN] Skipping apply")
            report["jobs"].append(record)
            continue

        ats = record["ats"]
        apply_result = None

        try:
            if ats == "linkedin":
                apply_result = apply_linkedin(url, cv_docx_path, cover_letter)
            elif ats == "indeed":
                apply_result = apply_indeed(url, cv_docx_path, cover_letter)
            elif ats == "greenhouse":
                apply_result = apply_greenhouse(url, cv_docx_path, cover_letter)
            else:
                record["status"] = "needs_review"
                record["notes"] += f"ATS '{ats}' not supported for auto-apply. Apply manually at: {url}"
                logger.info(f"  ATS '{ats}' — flagged for manual review")
                report["jobs"].append(record)
                continue

            if apply_result["success"]:
                record["status"] = "submitted"
                applied_count += 1
                logger.info(f"  ✓ SUBMITTED")
            elif apply_result.get("external"):
                record["status"] = "needs_review"
                record["notes"] += "External ATS (not Easy Apply) — apply manually at URL above."
                logger.info(f"  ⚠ EXTERNAL APPLY — needs manual review")
            else:
                record["status"] = "failed"
                record["notes"] += "Apply returned failure. Check screenshots."
                logger.info(f"  ✗ FAILED")

            record["apply_log"] = apply_result.get("output", "")[-600:]

        except subprocess.TimeoutExpired:
            record["status"] = "timeout"
            record["notes"] += "Apply timed out after 240s."
            logger.warning(f"  Timeout during apply")
        except Exception as e:
            record["status"] = "error"
            record["notes"] += str(e)
            logger.error(f"  Apply error: {e}")

        report["jobs"].append(record)
        time.sleep(3)  # brief pause between applications

    # ── 4. Save report ────────────────────────────────────────────────────────
    report_path = TMP_DIR / f"application_report_{run_id}.json"
    report_path.write_text(json.dumps(report, indent=2))
    logger.info(f"\nReport saved: {report_path}")

    # ── 4b. Auto-email the report if SMTP credentials are set ─────────────────
    smtp_email = os.getenv("SMTP_EMAIL", "")
    smtp_pass  = os.getenv("SMTP_PASSWORD", "")
    if smtp_email and smtp_pass:
        try:
            from tools.send_application_report import send_report
            logger.info("Sending email report…")
            result = send_report(report)
            if result.get("success"):
                logger.info(f"✓ Report emailed to {result['to']} ({result['attachments']} attachments)")
            else:
                logger.warning(f"Email failed: {result.get('error')}")
        except Exception as e:
            logger.warning(f"Could not send email report: {e}")
    else:
        logger.info("SMTP not configured — skipping email. Set SMTP_EMAIL and SMTP_PASSWORD to enable.")

    # ── 5. Print human-readable summary ───────────────────────────────────────
    submitted  = [j for j in report["jobs"] if j["status"] == "submitted"]
    failed     = [j for j in report["jobs"] if j["status"] in ("failed", "error", "timeout")]
    review     = [j for j in report["jobs"] if j["status"] == "needs_review"]
    dry        = [j for j in report["jobs"] if j["status"] == "dry_run"]

    print("\n" + "=" * 70)
    print(f"  APPLICATION RUN REPORT  —  {run_id}")
    print(f"  Keywords: {keywords}  |  Location: {location}")
    print("=" * 70)
    print(f"  Jobs fetched:     {len(jobs_raw)}")
    print(f"  Jobs qualifying:  {len(qualifying)}")
    print(f"  Applications:     {len(submitted)} submitted  |  {len(failed)} failed  |  {len(review)} needs review")
    if dry:
        print(f"  Dry run:          {len(dry)} (CVs generated, apply skipped)")
    print()

    STATUS_ICON = {
        "submitted":   "✓",
        "failed":      "✗",
        "error":       "✗",
        "timeout":     "⏱",
        "needs_review":"⚠",
        "dry_run":     "◌",
        "pending":     "?",
    }

    for j in report["jobs"]:
        icon = STATUS_ICON.get(j["status"], "?")
        print(f"  {icon} [{j['score']}/10] {j['title'][:45]:<45} | {j['company'][:25]:<25}")
        print(f"       ATS: {j['ats']:<12}  Status: {j['status']}")
        print(f"       DOCX: {Path(j['cv_docx']).name if j['cv_docx'] else 'N/A'}")
        print(f"       PDF:  {Path(j['cv_pdf']).name  if j['cv_pdf']  else 'N/A'}")
        if j.get("cover_letter_path"):
            print(f"       CL:   {Path(j['cover_letter_path']).name}")
        if j["notes"]:
            print(f"       Note: {j['notes'][:90]}")
        print()

    if review:
        print("─" * 70)
        print("  MANUAL REVIEW REQUIRED:")
        for j in review:
            print(f"    • {j['title']} @ {j['company']}")
            print(f"      {j['url']}")
        print()

    print(f"  Full report: {report_path}")
    print("=" * 70)


if __name__ == "__main__":
    main()
