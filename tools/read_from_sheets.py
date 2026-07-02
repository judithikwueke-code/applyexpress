"""
read_from_sheets.py — Read jobs from the Google Sheet.

Usage:
    python tools/read_from_sheets.py                  # Print all jobs
    python tools/read_from_sheets.py --greenhouse     # Print only live Greenhouse URLs
    python tools/read_from_sheets.py --needs-review   # Print jobs needing review
"""

import os
import sys
import json
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()


def _get_worksheet(sheet_id: str = None, sa_path: str = None):
    import gspread
    from google.oauth2.service_account import Credentials

    sheet_id = sheet_id or os.getenv("GOOGLE_SHEET_ID", "")
    sa_path  = sa_path  or os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON", "./service_account.json")

    scopes = [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive",
    ]

    if Path(sa_path).exists():
        creds = Credentials.from_service_account_file(sa_path, scopes=scopes)
    else:
        raise RuntimeError(f"Service account JSON not found: {sa_path}")

    gc = gspread.authorize(creds)
    sh = gc.open_by_key(sheet_id)
    return sh.sheet1


def read_jobs(status_filter=None, source_filter=None, sheet_id: str = None, sa_path: str = None):
    ws = _get_worksheet(sheet_id=sheet_id, sa_path=sa_path)

    # Get raw values to handle duplicate headers gracefully
    all_values = ws.get_all_values()
    if not all_values:
        return []

    # Deduplicate headers by appending _2, _3 etc
    raw_headers = all_values[0]
    headers = []
    seen = {}
    for h in raw_headers:
        if h in seen:
            seen[h] += 1
            headers.append(f"{h}_{seen[h]}")
        else:
            seen[h] = 1
            headers.append(h)

    rows = []
    for i, values in enumerate(all_values[1:], start=2):
        # Pad values to match header length
        padded = values + [''] * (len(headers) - len(values))
        row = dict(zip(headers, padded))
        row['_sheet_row'] = i
        rows.append(row)

    results = []
    for row in rows:
        if status_filter and row.get("Status", "").strip() != status_filter:
            continue
        if source_filter and source_filter.lower() not in row.get("URL", "").lower():
            continue
        results.append(row)

    return results


def update_job_status(row_number, status, notes="", sheet_id: str = None, sa_path: str = None):
    ws = _get_worksheet(sheet_id=sheet_id, sa_path=sa_path)
    # Find Status and Notes columns
    headers = ws.row_values(1)
    status_col = headers.index("Status") + 1 if "Status" in headers else None
    notes_col = headers.index("Notes") + 1 if "Notes" in headers else None

    if status_col:
        ws.update_cell(row_number, status_col, status)
    if notes_col and notes:
        ws.update_cell(row_number, notes_col, notes)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--greenhouse", action="store_true", help="Only show Greenhouse jobs")
    parser.add_argument("--needs-review", action="store_true", help="Only show Needs Review jobs")
    parser.add_argument("--status", help="Filter by status")
    parser.add_argument("--summary", action="store_true", help="Show URL type breakdown")
    args = parser.parse_args()

    source = "greenhouse" if args.greenhouse else None
    status = "Needs Review" if args.needs_review else args.status

    jobs = read_jobs(status_filter=status, source_filter=source)

    if args.summary:
        from urllib.parse import urlparse
        from collections import Counter
        hosts = Counter()
        for job in read_jobs():
            url = job.get("URL", "")
            try:
                host = urlparse(url).hostname or "unknown"
            except Exception:
                host = "unknown"
            hosts[host] += 1
        print("\nURL breakdown across all jobs:\n")
        for host, count in hosts.most_common():
            print(f"  {count:3d}  {host}")
        print()
    else:
        print(f"\nFound {len(jobs)} jobs:\n")
        for job in jobs:
            print(f"  Row {job['_sheet_row']}: {job.get('Job Title')} @ {job.get('Company')}")
            print(f"    Status: {job.get('Status')}")
            print(f"    URL: {job.get('URL')}")
            print()
