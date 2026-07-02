"""
generate_cover_letter.py — AI-powered cover letter generator.

Generates a 3-paragraph, job-specific cover letter body (no salutation/sign-off).
Reads from candidate_profile.md. Returns plain text.

Usage (standalone):
    python tools/generate_cover_letter.py --job-file .tmp/jobs_raw.json --job-index 0

Import:
    from tools.generate_cover_letter import generate_cover_letter
    letter = generate_cover_letter(job_dict, profile_text)  # returns string
"""

import os
import sys
import json
import logging
import argparse
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s [cover_letter] %(message)s")
logger = logging.getLogger(__name__)

sys.path.insert(0, str(Path(__file__).parent.parent))
from tools.llm_client import call_llm


SYSTEM_PROMPT = """You are an expert cover letter writer who crafts specific, compelling, human-sounding letters.
You never use clichés, templates, or generic openers.
You read the job description carefully and connect it to the candidate's real experience.
You respond with ONLY the cover letter body paragraphs. No subject line, no salutation, no sign-off."""

USER_PROMPT_TEMPLATE = """Write a compelling, specific cover letter for this job application.

CANDIDATE PROFILE:
{profile_text}

TARGET JOB:
Title: {title}
Company: {company}
Location: {location}
Description: {description}

STRUCTURE — exactly 3 paragraphs:

Paragraph 1 (Opening — 3–4 sentences):
Why this specific role at this specific company. Reference something concrete from the description.
State the candidate's most relevant qualification immediately.
Do NOT start with "I am writing to apply for..." or "I am excited to..."

Paragraph 2 (Evidence — 4–5 sentences):
Connect the 2 most relevant experiences from the candidate profile to the job requirements.
Use specific, quantified examples where available in the profile.
Show understanding of what the role actually involves.

Paragraph 3 (Close — 2–3 sentences):
Reiterate fit, show genuine interest in this company's work (from what's in the description).
Invite next step. Professional but not stiff.

RULES:
- Under 350 words total
- No clichés: no "team player", "passionate about", "fast-paced environment", "self-starter"
- Match the company's apparent culture (read the description for tone clues)
- Return ONLY the 3 paragraphs. No subject line, no "Dear...", no sign-off."""


def generate_cover_letter(job: dict, profile_text: str) -> str:
    """
    Generate a tailored cover letter for a specific job.
    Returns the 3-paragraph body as plain text.
    """
    user_prompt = USER_PROMPT_TEMPLATE.format(
        profile_text=profile_text,
        title=job.get("title", ""),
        company=job.get("company", ""),
        location=job.get("location", ""),
        description=job.get("description", "")[:3000],
    )

    try:
        result = call_llm(SYSTEM_PROMPT, user_prompt, max_tokens=800)
        return result.strip()
    except Exception as e:
        logger.error(f"generate_cover_letter failed for '{job.get('title')}': {e}")
        return f"[Cover letter generation failed for {job.get('title')} at {job.get('company')}: {e}]"


def main():
    parser = argparse.ArgumentParser(description="Generate a cover letter for a specific job")
    parser.add_argument("--job-file", default=".tmp/jobs_raw.json")
    parser.add_argument("--job-index", type=int, default=0)
    parser.add_argument("--profile", default=os.getenv("CANDIDATE_PROFILE_PATH", "./candidate_profile.md"))
    args = parser.parse_args()

    profile_path = Path(args.profile)
    if not profile_path.exists():
        print(f"ERROR: Profile not found at {profile_path}")
        sys.exit(1)
    profile_text = profile_path.read_text()

    with open(args.job_file) as f:
        jobs = json.load(f)
    job = jobs[args.job_index]

    print(f"\nGenerating cover letter for: {job['title']} @ {job['company']}")
    print("=" * 60)
    result = generate_cover_letter(job, profile_text)
    print(result)
    return result


if __name__ == "__main__":
    main()
