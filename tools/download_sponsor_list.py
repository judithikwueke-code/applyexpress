"""
download_sponsor_list.py — Download UK Register of Licensed Sponsors (Worker route).

Fetches the latest CSV from gov.uk via the Content API, extracts and normalises
company names, and saves them to data/sponsor_list.json as a sorted JSON array.

Usage:
    python3 tools/download_sponsor_list.py
    # or from project root:
    cd /opt/applyexpress && python3 tools/download_sponsor_list.py
"""

import csv
import json
import io
import sys
import logging
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger(__name__)

GOV_API_URL = (
    "https://www.gov.uk/api/content/government/publications/"
    "register-of-licensed-sponsors-workers"
)
OUTPUT_PATH = Path("data/sponsor_list.json")


def _find_csv_url(meta: dict) -> str:
    """Extract the Worker+Temporary Worker CSV download URL from the gov.uk API response."""
    attachments = meta.get("details", {}).get("attachments", [])
    for att in attachments:
        title = att.get("title", "")
        url   = att.get("url", "")
        if url.lower().endswith(".csv") and ("worker" in title.lower() or "Worker" in title):
            return url
    # Fallback: any CSV attachment
    for att in attachments:
        if att.get("url", "").lower().endswith(".csv"):
            return att["url"]
    raise RuntimeError(f"No CSV attachment found. Attachments: {[a.get('title') for a in attachments]}")


def download():
    try:
        import requests
    except ImportError:
        log.error("requests not installed — run: pip install requests")
        sys.exit(1)

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    log.info("Fetching gov.uk publication metadata…")
    r = requests.get(GOV_API_URL, timeout=30)
    r.raise_for_status()
    meta = r.json()

    csv_url = _find_csv_url(meta)
    log.info(f"Downloading sponsor CSV: {csv_url}")

    r2 = requests.get(csv_url, timeout=120, stream=True)
    r2.raise_for_status()

    raw = r2.content.decode("utf-8-sig", errors="replace")  # strip BOM if present
    reader = csv.DictReader(io.StringIO(raw))

    # Find the organisation name column (first column, typically "Organisation Name")
    fieldnames = reader.fieldnames or []
    name_col = None
    for candidate in ("Organisation Name", "Organisation name", "organisation_name",
                      "Name", "Company Name", "Sponsor Name"):
        if candidate in fieldnames:
            name_col = candidate
            break
    if not name_col and fieldnames:
        name_col = fieldnames[0]  # fallback to first column
    if not name_col:
        raise RuntimeError(f"Cannot identify company name column. Headers: {fieldnames}")

    log.info(f"Using column: '{name_col}' (all columns: {fieldnames})")

    companies: set[str] = set()
    for row in reader:
        name = (row.get(name_col) or "").strip().lower()
        if name:
            companies.add(name)

    result = sorted(companies)
    OUTPUT_PATH.write_text(json.dumps(result, indent=None))
    log.info(f"Saved {len(result):,} sponsors to {OUTPUT_PATH}")
    return len(result)


if __name__ == "__main__":
    count = download()
    print(f"Done — {count:,} licensed sponsors saved to {OUTPUT_PATH}")
