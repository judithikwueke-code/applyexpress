"""
setup_user.py — Onboard a new user into the multi-user job application system.

Creates:
  users/<username>/.env               — credentials and preferences
  users/<username>/candidate_profile.md — profile template (pre-filled)
  users.json                          — updated with new API key → username mapping

Usage:
    python tools/setup_user.py
    python tools/setup_user.py --non-interactive  # use defaults/env for testing
"""

import os
import sys
import json
import secrets
import argparse
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent


def _ask(prompt: str, default: str = "") -> str:
    """Prompt the user, showing default in brackets. Return stripped input or default."""
    if default:
        val = input(f"  {prompt} [{default}]: ").strip()
        return val if val else default
    else:
        return input(f"  {prompt}: ").strip()


PROFILE_TEMPLATE = """\
## Personal Info
- Name: {full_name}
- Email: {email}
- Phone: {phone}
- Location: {location}
- LinkedIn:
- GitHub / Portfolio:

## Target Roles
- Job titles:
- Industries: Financial Services, Fintech, Professional Services
- Work arrangement: Hybrid
- Seniority level:
- Salary expectations:
- Notice period: 1 month
- Open to relocation: No
- Right to work in UK: Yes

## CV Summary
(Write 2-3 sentences summarising your professional background and what you're looking for.)

## Work Experience

### <Job Title> — <Company> (<Start> – <End or Present>)
- Achievement 1
- Achievement 2
- Achievement 3

## Education

### <Degree> — <Institution> (<Year>)

## Skills
- Technical:
- Frameworks / Regulations:
- Tools:
- Soft skills:

## Achievements & Highlights
-

## Career Goals
(What are you looking for in your next role?)
"""


def create_user(
    username: str,
    first_name: str,
    last_name: str,
    email: str,
    phone: str,
    location: str,
    linkedin_email: str,
    linkedin_password: str,
    reed_email: str,
    reed_password: str,
    indeed_email: str,
    indeed_password: str,
    sheet_id: str,
    smtp_email: str,
    smtp_password: str,
    keywords: str,
    search_location: str,
    threshold: str,
    email_subject_prefix: str,
) -> str:
    """Create per-user directory and config files. Returns the generated API key."""

    user_dir = PROJECT_ROOT / "users" / username
    user_dir.mkdir(parents=True, exist_ok=True)
    (user_dir / ".tmp").mkdir(exist_ok=True)

    api_key = f"autoapply-{username}-{secrets.token_hex(4)}"

    # Write .env
    env_content = f"""\
# ── Identity ─────────────────────────────────────────────────────────────────
CANDIDATE_FIRST_NAME={first_name}
CANDIDATE_LAST_NAME={last_name}
CANDIDATE_EMAIL={email}
CANDIDATE_PHONE={phone}

# ── Paths (relative to project root) ─────────────────────────────────────────
CANDIDATE_PROFILE_PATH=./users/{username}/candidate_profile.md
CV_PATH=./users/{username}/cv.docx
TMP_DIR=./users/{username}/.tmp

# ── Job board credentials ─────────────────────────────────────────────────────
LINKEDIN_EMAIL={linkedin_email}
LINKEDIN_PASSWORD={linkedin_password}
REED_EMAIL={reed_email}
REED_PASSWORD={reed_password}
INDEED_EMAIL={indeed_email}
INDEED_PASSWORD={indeed_password}
TOTALJOBS_EMAIL={email}
TOTALJOBS_PASSWORD=

# ── Google Sheets ─────────────────────────────────────────────────────────────
GOOGLE_SHEET_ID={sheet_id}
GOOGLE_SERVICE_ACCOUNT_JSON=./users/{username}/service_account.json

# ── Email reports ─────────────────────────────────────────────────────────────
SMTP_EMAIL={smtp_email}
SMTP_PASSWORD={smtp_password}
SMTP_TO={smtp_email}

# ── Job search preferences ────────────────────────────────────────────────────
JOB_SEARCH_KEYWORDS={keywords}
JOB_SEARCH_LOCATION={search_location}
JOB_SEARCH_COUNT=30
SCORE_THRESHOLD={threshold}
EMAIL_SUBJECT_PREFIX={email_subject_prefix}

# ── API key for this user (also in users.json) ────────────────────────────────
API_KEY={api_key}
"""
    (user_dir / ".env").write_text(env_content)

    # Write candidate_profile.md template
    full_name = f"{first_name} {last_name}".strip()
    profile_content = PROFILE_TEMPLATE.format(
        full_name=full_name,
        email=email,
        phone=phone,
        location=location,
    )
    profile_path = user_dir / "candidate_profile.md"
    profile_path.write_text(profile_content)

    # Update users.json
    users_json_path = PROJECT_ROOT / "users.json"
    if users_json_path.exists():
        try:
            user_map = json.loads(users_json_path.read_text())
        except Exception:
            user_map = {}
    else:
        user_map = {}

    user_map[api_key] = username
    users_json_path.write_text(json.dumps(user_map, indent=2))

    return api_key


def main():
    parser = argparse.ArgumentParser(description="Onboard a new user")
    parser.add_argument("--non-interactive", action="store_true",
                        help="Use defaults for all prompts (for testing)")
    args = parser.parse_args()

    print("\n" + "=" * 60)
    print("  AutoApply — New User Setup")
    print("=" * 60)

    if args.non_interactive:
        username     = "testuser"
        first_name   = "Test"
        last_name    = "User"
        email        = "testuser@example.com"
        phone        = "+440000000000"
        location     = "London"
        li_email     = ""
        li_pass      = ""
        reed_email   = ""
        reed_pass    = ""
        indeed_email = ""
        indeed_pass  = ""
        sheet_id     = ""
        smtp_email   = ""
        smtp_pass    = ""
        keywords     = "software engineer"
        search_loc   = "London"
        threshold    = "7"
        subject      = "Software Engineer"
    else:
        print("\n── Basic Details ──────────────────────────────────────────")
        username   = _ask("Username (lowercase, no spaces, e.g. alice)")
        while not username or " " in username:
            print("  Username must be lowercase with no spaces.")
            username = _ask("Username")
        first_name = _ask("First name")
        last_name  = _ask("Last name")
        email      = _ask("Email address")
        phone      = _ask("Phone (with country code, e.g. +447700900000)")
        location   = _ask("Location (city/country)", "United Kingdom")

        print("\n── Job Board Credentials (press Enter to skip) ────────────")
        li_email     = _ask("LinkedIn email",  email)
        li_pass      = _ask("LinkedIn password")
        reed_email   = _ask("Reed.co.uk email",  email)
        reed_pass    = _ask("Reed.co.uk password")
        indeed_email = _ask("Indeed email",  email)
        indeed_pass  = _ask("Indeed password")

        print("\n── Google Sheets ──────────────────────────────────────────")
        sheet_id = _ask("Google Sheet ID (leave blank to set later)")

        print("\n── Email Reports ──────────────────────────────────────────")
        smtp_email = _ask("Gmail address for reports", email)
        smtp_pass  = _ask("Gmail app password (not account password)")

        print("\n── Job Search Preferences ─────────────────────────────────")
        keywords    = _ask("Job search keywords", "compliance AML")
        search_loc  = _ask("Search location", location)
        threshold   = _ask("Minimum score to apply (1-10)", "7")
        subject     = _ask("Email subject prefix", f"{keywords.title()}")

    # Check if username already exists
    user_dir = Path(PROJECT_ROOT / "users" / username)
    if user_dir.exists():
        print(f"\n  WARNING: users/{username}/ already exists — files will be overwritten.")
        if not args.non_interactive:
            confirm = input("  Continue? [y/N]: ").strip().lower()
            if confirm != "y":
                print("  Aborted.")
                sys.exit(0)

    api_key = create_user(
        username=username,
        first_name=first_name,
        last_name=last_name,
        email=email,
        phone=phone,
        location=location,
        linkedin_email=li_email,
        linkedin_password=li_pass,
        reed_email=reed_email,
        reed_password=reed_pass,
        indeed_email=indeed_email,
        indeed_password=indeed_pass,
        sheet_id=sheet_id,
        smtp_email=smtp_email,
        smtp_password=smtp_pass,
        keywords=keywords,
        search_location=search_loc,
        threshold=threshold,
        email_subject_prefix=subject,
    )

    print(f"\n{'=' * 60}")
    print(f"  ✓ User '{username}' created successfully!")
    print(f"{'=' * 60}")
    print(f"\n  API Key:   {api_key}")
    print(f"  User dir:  users/{username}/")
    print(f"\n  Next steps:")
    print(f"  1. Copy your master CV:  cp /path/to/YourCV.docx users/{username}/cv.docx")
    print(f"  2. Edit your profile:    nano users/{username}/candidate_profile.md")
    print(f"  3. (Optional) Add your Google service account: users/{username}/service_account.json")
    print(f"  4. Run the pipeline:     python tools/run_applications.py --user {username}")
    print(f"  5. Chrome extension:     Enter server URL + API key above in the extension popup")
    print()


if __name__ == "__main__":
    main()
