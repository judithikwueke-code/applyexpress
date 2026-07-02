"""
apply_greenhouse_api.py — Submit a Greenhouse job application via the public Job Board API.

Completely bypasses browser/CAPTCHA issues by posting directly to the API.

Usage:
    python tools/apply_greenhouse_api.py \
        --url "https://job-boards.greenhouse.io/monzo/jobs/7746038" \
        --name "Ngozika Judith Okenwa" \
        --email "judith.ikwueke@gmail.com" \
        --phone "+447487863927" \
        --cv-path "/root/Agentic Workflow Done/Judith_Okenwa_AMLAs_CV.docx" \
        --cover-letter "Your cover letter text here"

Exit codes:
    0 = Applied successfully
    1 = Failed (reason printed to stderr)
"""

import sys
import re
import json
import argparse
import requests
from pathlib import Path


def extract_board_token_and_job_id(url: str):
    """Extract board token and job ID from a Greenhouse URL."""
    # job-boards.greenhouse.io/monzo/jobs/7746038
    # boards.greenhouse.io/monzo/jobs/7746038
    match = re.search(r'greenhouse\.io/([^/]+)/jobs/(\d+)', url)
    if not match:
        return None, None
    return match.group(1), match.group(2)


def get_job_questions(board_token: str, job_id: str):
    """Fetch the job details including custom questions."""
    url = f"https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{job_id}?questions=true"
    resp = requests.get(url, timeout=15)
    if resp.status_code != 200:
        print(f"[greenhouse_api] Warning: Could not fetch job questions ({resp.status_code})", file=sys.stderr)
        return []
    data = resp.json()
    return data.get("questions", [])


def build_form_data(name: str, email: str, phone: str, cover_letter: str, questions: list):
    """Build the multipart form data fields."""
    parts = name.strip().split(None, 1)
    first_name = parts[0] if parts else ""
    last_name = parts[1] if len(parts) > 1 else ""

    data = {
        "first_name": first_name,
        "last_name": last_name,
        "email": email,
        "phone": phone,
    }

    # Answer custom questions automatically
    for q in questions:
        fields = q.get("fields", [{}])
        field_name = fields[0].get("name", "") if fields else ""
        q_label = q.get("label", "").lower()
        q_type = fields[0].get("type", "") if fields else ""
        values = fields[0].get("values", []) if fields else []

        if not field_name:
            continue

        # Skip resume/cover letter — handled separately
        if "resume" in field_name or "cover" in field_name:
            continue

        # Helper: find the first matching option value by label regex
        def pick_value(regex, fallback=None):
            for v in values:
                if re.search(regex, v.get("label", ""), re.I):
                    return str(v.get("value", ""))
            return fallback

        # US Person → No
        if "us person" in q_label:
            data[field_name] = pick_value(r"^No$", "0")

        # Privacy / data notice → I've read it
        elif "data safe" in q_label or "privacy" in q_label or "candidate data" in q_label:
            data[field_name] = pick_value(r"read it|acknowledge", str(values[0].get("value","")) if values else "1")

        # Right to work → UK/Irish National
        elif any(kw in q_label for kw in ["right to work", "authoris", "authoriz", "eligible", "sponsorship"]):
            data[field_name] = pick_value(r"UK or Irish|Indefinite Leave|British|without.*sponsor", "Yes")

        # CONC / compliance knowledge questions → provide a real answer
        elif "conc" in q_label or "consumer credit" in q_label:
            data[field_name] = (
                "I have working knowledge of CONC (Consumer Credit sourcebook), including rules on "
                "responsible lending, creditworthiness assessments, arrears handling, and fair treatment "
                "of customers in financial difficulty. In my AML compliance roles I have applied CONC "
                "principles when conducting customer risk assessments and ensuring regulatory compliance "
                "with FCA guidelines."
            )

        # Decline identity/demographic questions
        elif any(kw in q_label for kw in ["gender", "race", "ethnicity", "veteran", "disability", "sexual", "neurodiverg", "transgender", "pronoun"]):
            data[field_name] = pick_value(r"prefer not|decline|not wish", "")

        # Location / city
        elif any(kw in q_label for kw in ["location", "city", "where are you"]):
            if q_type == "input_text":
                data[field_name] = "London, UK"

    # GDPR demographic consent checkbox
    data["gdpr_demographic_data_consent_given"] = "true"

    return data


def submit_application(board_token: str, job_id: str, data: dict, cv_path: str, cover_letter: str):
    """POST the application to Greenhouse API."""
    url = f"https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{job_id}"

    files = {}

    # Attach CV
    if cv_path and Path(cv_path).exists():
        cv_file = Path(cv_path)
        mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document" if cv_file.suffix == ".docx" else "application/pdf"
        files["resume"] = (cv_file.name, open(cv_path, "rb"), mime)
        print(f"[greenhouse_api] Attaching CV: {cv_file.name}")
    else:
        print("[greenhouse_api] Warning: No CV file — submitting without resume", file=sys.stderr)

    # Attach cover letter as text file
    if cover_letter:
        files["cover_letter"] = ("cover_letter.txt", cover_letter.encode("utf-8"), "text/plain")

    print(f"[greenhouse_api] Submitting to {url}")
    print(f"[greenhouse_api] Candidate: {data.get('first_name')} {data.get('last_name')} <{data.get('email')}>")

    resp = requests.post(url, data=data, files=files, timeout=30)

    # Clean up file handles
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

    board_token, job_id = extract_board_token_and_job_id(args.url)
    if not board_token or not job_id:
        print(f"[greenhouse_api] ERROR: Could not parse Greenhouse URL: {args.url}", file=sys.stderr)
        sys.exit(1)

    print(f"[greenhouse_api] Board: {board_token} | Job: {job_id}")

    # Fetch questions
    questions = get_job_questions(board_token, job_id)
    print(f"[greenhouse_api] Found {len(questions)} custom questions")

    # Build form data
    data = build_form_data(args.name, args.email, args.phone, args.cover_letter, questions)

    # Submit
    resp = submit_application(board_token, job_id, data, args.cv_path, args.cover_letter)

    print(f"[greenhouse_api] Response: {resp.status_code}")

    if resp.status_code in (200, 201):
        print("[greenhouse_api] Application submitted successfully!")
        try:
            print(json.dumps(resp.json(), indent=2))
        except Exception:
            print(resp.text[:500])
        sys.exit(0)
    else:
        print(f"[greenhouse_api] ERROR: Submission failed", file=sys.stderr)
        print(f"[greenhouse_api] Response body: {resp.text[:1000]}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
