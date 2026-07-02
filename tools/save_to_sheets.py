"""
save_to_sheets.py — Append a processed job to the Google Sheet.

Uses a service account for authentication (no browser OAuth flow — fully automated).
The service account JSON file must be shared as Editor on the target sheet.

Setup:
  1. Google Cloud Console → Create project → Enable Sheets API
  2. IAM → Create Service Account → Download JSON key as service_account.json
  3. Share your Google Sheet with the service account email (Editor access)
  4. Set GOOGLE_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON in .env

Import:
    from tools.save_to_sheets import save_to_sheets
    save_to_sheets(job_result_dict)

Standalone test:
    python tools/save_to_sheets.py --test
"""

import os
import sys
import json
import logging
from datetime import date
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s [save_to_sheets] %(message)s")
logger = logging.getLogger(__name__)

SHEET_HEADERS = [
    "Date", "Job Title", "Company", "Location", "URL",
    "Score", "Score Reason", "Apply Decision",
    "CV Summary", "Cover Letter", "App Answers",
    "LinkedIn Message", "Recruiter Strategy",
    "Status", "Notes",
]


def _get_worksheet():
    try:
        import gspread
    except ImportError:
        raise RuntimeError("gspread not installed. Run: pip install gspread google-auth")

    sheet_id = os.getenv("GOOGLE_SHEET_ID", "")
    sa_path = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON", "./service_account.json")

    if not sheet_id:
        raise ValueError("GOOGLE_SHEET_ID not set in .env")

    sa_file = Path(sa_path)
    if not sa_file.exists():
        raise FileNotFoundError(
            f"Service account JSON not found at {sa_path}. "
            "Download it from Google Cloud Console and save as service_account.json"
        )

    client = gspread.service_account(filename=str(sa_file))
    spreadsheet = client.open_by_key(sheet_id)
    return spreadsheet.sheet1


def save_to_sheets(job_result: dict) -> dict:
    """
    Append a fully processed job row to the Google Sheet.
    Returns {"success": True, "row": int} or {"success": False, "error": str}
    """
    try:
        worksheet = _get_worksheet()

        # Serialise dict fields to JSON strings for sheet cells
        app_answers = job_result.get("app_answers", {})
        recruiter_strategy = job_result.get("recruiter_strategy", {})

        row = [
            date.today().isoformat(),
            job_result.get("title", ""),
            job_result.get("company", ""),
            job_result.get("location", ""),
            job_result.get("url", ""),
            job_result.get("score", ""),
            job_result.get("score_reason", ""),
            job_result.get("apply_decision", ""),
            job_result.get("cv_summary", ""),
            job_result.get("cover_letter", ""),
            json.dumps(app_answers) if isinstance(app_answers, dict) else str(app_answers),
            job_result.get("linkedin_message", ""),
            json.dumps(recruiter_strategy) if isinstance(recruiter_strategy, dict) else str(recruiter_strategy),
            job_result.get("status", "Pending Review"),
            job_result.get("notes", ""),
        ]

        worksheet.append_row(row, value_input_option="USER_ENTERED")
        row_count = len(worksheet.get_all_values())
        logger.info(f"Saved: {job_result.get('title')} @ {job_result.get('company')} → row {row_count}")
        return {"success": True, "row": row_count}

    except Exception as e:
        logger.error(f"save_to_sheets failed for '{job_result.get('title')}': {e}")
        return {"success": False, "error": str(e)}


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Save job result to Google Sheets")
    parser.add_argument("--test", action="store_true", help="Save a test row to verify connection")
    args = parser.parse_args()

    if args.test:
        test_job = {
            "title": "TEST — Senior Python Engineer",
            "company": "Test Company Ltd",
            "location": "London, UK",
            "url": "https://example.com/jobs/test",
            "score": 9,
            "score_reason": "Perfect skill match. Strong alignment on remote work and salary.",
            "apply_decision": "yes",
            "cv_summary": "Experienced Python engineer with 5+ years building distributed systems...",
            "cover_letter": "Test cover letter paragraph 1.\n\nTest paragraph 2.\n\nTest paragraph 3.",
            "app_answers": {"availability": "2 weeks", "strengths": "Problem solving, systems design"},
            "linkedin_message": "Test LinkedIn message under 150 words.",
            "recruiter_strategy": {"target_titles": ["Engineering Manager"], "notes": "Test strategy"},
            "status": "Pending Review",
            "notes": "This is a test row — delete after verifying",
        }
        print("Saving test row to Google Sheets...")
        result = save_to_sheets(test_job)
        print(json.dumps(result, indent=2))
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
