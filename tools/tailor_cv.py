"""
tailor_cv.py — ATS-optimised CV summary rewriter.

Rewrites ONLY the CV Summary section from the candidate profile to match a specific job.
Does not invent experience — mirrors language and keywords from the job description.

Usage (standalone):
    python tools/tailor_cv.py --job-file .tmp/jobs_raw.json --job-index 0

Import:
    from tools.tailor_cv import tailor_cv
    summary = tailor_cv(job_dict, profile_text)  # returns string
"""

import os
import sys
import re
import json
import logging
import argparse
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s [tailor_cv] %(message)s")
logger = logging.getLogger(__name__)

sys.path.insert(0, str(Path(__file__).parent.parent))
from tools.llm_client import call_llm


SYSTEM_PROMPT = """You are an expert CV writer and ATS optimisation specialist.
You rewrite CV summaries to maximise keyword match for specific job postings.
You never invent experience — you reframe what is already there using the language of the job description.
You respond with ONLY the rewritten summary text. No labels, no explanations, no markdown."""

USER_PROMPT_TEMPLATE = """Rewrite this candidate's CV Summary to maximise ATS match for the job below.

CANDIDATE PROFILE:
{profile_text}

TARGET JOB:
Title: {title}
Company: {company}
Description: {description}

RULES:
1. Keep the same person — do not invent skills or experience not in the profile
2. Mirror the exact language and keywords from the job description where genuinely applicable
3. Lead with the most relevant skills and experience for this specific role
4. 3–5 sentences, professional tone, no first person (start with "Experienced..." or role title)
5. Include 2–3 specific technical keywords from the job description
6. No buzzwords: no "passionate", "dynamic", "results-driven", "team player"

Return ONLY the rewritten summary paragraph. No labels, no headers, no explanations."""


def _extract_cv_summary(profile_text: str) -> str:
    """Extract the ## CV Summary section from the profile markdown."""
    match = re.search(r'## CV Summary\n(.*?)(?=\n## |\Z)', profile_text, re.DOTALL)
    if match:
        return match.group(1).strip()
    return profile_text  # fall back to full profile


def tailor_cv(job: dict, profile_text: str) -> str:
    """
    Rewrite the CV summary for a specific job.
    Returns the rewritten summary as a plain text string.
    """
    user_prompt = USER_PROMPT_TEMPLATE.format(
        profile_text=profile_text,
        title=job.get("title", ""),
        company=job.get("company", ""),
        description=job.get("description", "")[:3000],
    )

    try:
        result = call_llm(SYSTEM_PROMPT, user_prompt, max_tokens=500)
        return result.strip()
    except Exception as e:
        logger.error(f"tailor_cv failed for '{job.get('title')}': {e}")
        return _extract_cv_summary(profile_text)  # fall back to original summary


def main():
    parser = argparse.ArgumentParser(description="Tailor CV summary for a specific job")
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

    print(f"\nTailoring CV for: {job['title']} @ {job['company']}")
    print("-" * 50)
    result = tailor_cv(job, profile_text)
    print(result)
    return result


if __name__ == "__main__":
    main()
