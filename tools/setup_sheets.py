"""
setup_sheets.py — One-time Google Sheets setup script.

Run this once before first use. Creates the header row with correct columns.
After running, copy the Sheet ID into GOOGLE_SHEET_ID in your .env file.

Usage:
    python tools/setup_sheets.py
    python tools/setup_sheets.py --sheet-name "Job Applications 2026"
"""

import os
import sys
import json
import logging
import argparse
from pathlib import Path
from datetime import date

from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s [setup_sheets] %(message)s")
logger = logging.getLogger(__name__)

SHEET_HEADERS = [
    "Date", "Job Title", "Company", "Location", "URL",
    "Score", "Score Reason", "Apply Decision",
    "CV Summary", "Cover Letter", "App Answers",
    "LinkedIn Message", "Recruiter Strategy",
    "Status", "Notes",
]


def setup_sheet(sheet_name: str = None) -> dict:
    """
    Create or verify the Google Sheet with correct headers.
    Returns {"sheet_id": str, "sheet_url": str}
    """
    try:
        import gspread
    except ImportError:
        raise RuntimeError("gspread not installed. Run: pip install gspread google-auth")

    sa_path = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON", "./service_account.json")
    sa_file = Path(sa_path)
    if not sa_file.exists():
        raise FileNotFoundError(
            f"Service account JSON not found at {sa_path}.\n"
            "Steps:\n"
            "  1. Go to Google Cloud Console → APIs & Services → Credentials\n"
            "  2. Create a Service Account\n"
            "  3. Download the JSON key → save as service_account.json in the project root\n"
            "  4. Enable the Google Sheets API in your project"
        )

    client = gspread.service_account(filename=str(sa_file))

    existing_sheet_id = os.getenv("GOOGLE_SHEET_ID", "")

    if existing_sheet_id:
        try:
            spreadsheet = client.open_by_key(existing_sheet_id)
            logger.info(f"Opened existing sheet: {spreadsheet.title}")
        except Exception:
            logger.info("GOOGLE_SHEET_ID set but sheet not accessible. Creating new sheet...")
            existing_sheet_id = ""

    if not existing_sheet_id:
        if not sheet_name:
            sheet_name = f"Job Applications {date.today().year}"
        spreadsheet = client.create(sheet_name)

        # Share with the user's Google account if possible
        # (The sheet is owned by the service account — make it accessible)
        spreadsheet.share("", perm_type="anyone", role="reader")
        logger.info(f"Created sheet: {spreadsheet.title} (ID: {spreadsheet.id})")

    worksheet = spreadsheet.sheet1

    # Check if headers already exist
    existing_values = worksheet.row_values(1)
    if existing_values == SHEET_HEADERS:
        logger.info("Headers already correct. No changes made.")
    else:
        # Write headers
        worksheet.clear()
        worksheet.append_row(SHEET_HEADERS, value_input_option="USER_ENTERED")

        # Bold and freeze the header row
        try:
            spreadsheet.batch_update({
                "requests": [
                    {
                        "repeatCell": {
                            "range": {
                                "sheetId": worksheet.id,
                                "startRowIndex": 0,
                                "endRowIndex": 1,
                            },
                            "cell": {
                                "userEnteredFormat": {
                                    "textFormat": {"bold": True},
                                    "backgroundColor": {"red": 0.24, "green": 0.47, "blue": 0.85},
                                    "textFormat": {"bold": True, "foregroundColor": {"red": 1, "green": 1, "blue": 1}},
                                }
                            },
                            "fields": "userEnteredFormat(textFormat,backgroundColor)",
                        }
                    },
                    {
                        "updateSheetProperties": {
                            "properties": {
                                "sheetId": worksheet.id,
                                "gridProperties": {"frozenRowCount": 1},
                            },
                            "fields": "gridProperties.frozenRowCount",
                        }
                    },
                ]
            })
        except Exception as e:
            logger.warning(f"Could not apply formatting (non-critical): {e}")

        logger.info(f"Headers written: {len(SHEET_HEADERS)} columns")

    sheet_url = f"https://docs.google.com/spreadsheets/d/{spreadsheet.id}/edit"
    return {"sheet_id": spreadsheet.id, "sheet_url": sheet_url}


def main():
    parser = argparse.ArgumentParser(description="Set up the Google Sheet for the job pipeline")
    parser.add_argument("--sheet-name", default=None, help="Name for the new sheet (default: 'Job Applications {year}')")
    args = parser.parse_args()

    print("\n=== Google Sheets Setup ===\n")

    try:
        result = setup_sheet(args.sheet_name)

        print(f"Sheet ID:  {result['sheet_id']}")
        print(f"Sheet URL: {result['sheet_url']}")
        print()

        existing_id = os.getenv("GOOGLE_SHEET_ID", "")
        if not existing_id or existing_id != result["sheet_id"]:
            print("ACTION REQUIRED: Add this to your .env file:")
            print(f"  GOOGLE_SHEET_ID={result['sheet_id']}")
        else:
            print("GOOGLE_SHEET_ID is already set correctly in .env")

        print("\nDone! Your sheet is ready.")

    except FileNotFoundError as e:
        print(f"\nERROR: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\nERROR: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
