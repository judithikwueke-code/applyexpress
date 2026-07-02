"""
apply_lever_api.py — Submit a Lever job application via the public Lever API.

No browser, no CAPTCHA. Lever's Job Postings API is fully public.

Usage:
    python tools/apply_lever_api.py \
        --url "https://jobs.lever.co/revolut/abc123" \
        --name "Ngozika Judith Okenwa" \
        --email "judith.ikwueke@gmail.com" \
        --phone "+447487863927" \
        --cv-path "/root/Agentic Workflow Done/Judith_Okenwa_AMLAs_CV.docx" \
        --cover-letter "Your cover letter text here"

Exit codes:
    0 = Applied successfully
    1 = Failed
"""

import sys
import re
import json
import argparse
import requests
from pathlib import Path


def extract_company_and_job(url: str):
    """Extract company slug and job ID from a Lever URL.

    Supports:
      https://jobs.lever.co/revolut/abc-123
      https://jobs.lever.co/revolut/abc-123/apply
    """
    match = re.search(r'jobs\.lever\.co/([^/]+)/([^/?#]+)', url)
    if not match:
        return None, None
    return match.group(1), match.group(2)


def get_job_details(company: str, job_id: str):
    """Fetch job posting details from Lever API."""
    url = f"https://api.lever.co/v0/postings/{company}/{job_id}"
    try:
        resp = requests.get(url, timeout=15)
        if resp.status_code == 200:
            return resp.json()
    except Exception as e:
        print(f"[lever_api] Warning: Could not fetch job details: {e}", file=sys.stderr)
    return {}


def submit_application(company: str, job_id: str, name: str, email: str,
                       phone: str, cv_path: str, cover_letter: str):
    """POST application to Lever API."""
    url = f"https://api.lever.co/v0/postings/{company}/{job_id}/apply"

    # Build multipart form data
    data = {
        "name": name,
        "email": email,
        "phone": phone,
        "org": "",          # Current company (optional)
        "urls[LinkedIn]": "",
        "comments": cover_letter,
    }

    files = {}

    if cv_path and Path(cv_path).exists():
        cv_file = Path(cv_path)
        if cv_file.suffix.lower() == ".docx":
            mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        elif cv_file.suffix.lower() == ".pdf":
            mime = "application/pdf"
        else:
            mime = "application/octet-stream"
        files["resume"] = (cv_file.name, open(cv_path, "rb"), mime)
        print(f"[lever_api] Attaching CV: {cv_file.name}")
    else:
        print("[lever_api] Warning: No CV file attached", file=sys.stderr)

    print(f"[lever_api] Submitting to: {url}")
    print(f"[lever_api] Candidate: {name} <{email}>")

    resp = requests.post(url, data=data, files=files if files else None, timeout=30)

    # Close file handles
    for f in files.values():
        try:
            f[1].close()
        except Exception:
            pass

    return resp


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--email", required=True)
    parser.add_argument("--phone", default="")
    parser.add_argument("--cv-path", default="")
    parser.add_argument("--cover-letter", default="")
    args = parser.parse_args()

    company, job_id = extract_company_and_job(args.url)
    if not company or not job_id:
        print(f"[lever_api] ERROR: Could not parse Lever URL: {args.url}", file=sys.stderr)
        sys.exit(1)

    print(f"[lever_api] Company: {company} | Job: {job_id}")

    # Fetch job details for logging
    job = get_job_details(company, job_id)
    if job:
        print(f"[lever_api] Job: {job.get('text', 'Unknown')} @ {company}")

    # Submit
    resp = submit_application(company, job_id, args.name, args.email,
                              args.phone, args.cv_path, args.cover_letter)

    print(f"[lever_api] Response: {resp.status_code}")

    if resp.status_code in (200, 201):
        print("[lever_api] Application submitted successfully!")
        try:
            body = resp.json()
            print(json.dumps(body, indent=2))
        except Exception:
            print(resp.text[:500])
        sys.exit(0)
    else:
        print(f"[lever_api] ERROR: Submission failed", file=sys.stderr)
        print(f"[lever_api] Response: {resp.text[:1000]}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
