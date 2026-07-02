"""
recruiter_finder.py — Recruiter and hiring manager targeting strategy generator.

Uses AI to identify who to contact at a company, their likely titles,
how to find them on LinkedIn, and an outreach sequence.

Usage (standalone):
    python tools/recruiter_finder.py --job-file .tmp/jobs_raw.json --job-index 0

Import:
    from tools.recruiter_finder import recruiter_finder
    strategy = recruiter_finder(job_dict, profile_text)
    # returns: {target_titles, linkedin_search_url, outreach_sequence, notes, search_terms}
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
logging.basicConfig(level=logging.INFO, format="%(asctime)s [recruiter_finder] %(message)s")
logger = logging.getLogger(__name__)

sys.path.insert(0, str(Path(__file__).parent.parent))
from tools.llm_client import call_llm


SYSTEM_PROMPT = """You are a job search strategist specialising in direct outreach and recruiter targeting.
You know how to identify the right people to contact for any role and how to approach them effectively.
You respond ONLY with valid JSON. No other text before or after the JSON object."""

USER_PROMPT_TEMPLATE = """Generate a recruiter/hiring manager targeting strategy for this job application.

CANDIDATE PROFILE:
{profile_text}

TARGET JOB:
Title: {title}
Company: {company}
Description: {description}

Provide a targeting strategy with:

1. target_titles — List of 2–4 job titles to search for at this company on LinkedIn
   (the people most likely to influence hiring for this role)

2. linkedin_search_url — Pre-built LinkedIn people search URL for the most likely title.
   Format: https://www.linkedin.com/search/results/people/?keywords=TITLE+COMPANY&origin=GLOBAL_SEARCH_HEADER

3. outreach_sequence — A 2–3 step outreach plan with specific timing.
   Keep it lean and non-spammy. Example: ["Day 1: Connect request with personalised note", "Day 7: Follow-up if no response"]

4. notes — 1–2 sentences of strategic advice based on signals in the job description
   (team size signals, direct hire vs recruiter, seniority of the role, company stage)

5. search_terms — 3 Google search strings to find people at this company
   (use LinkedIn Google dork format: site:linkedin.com/in "{company}" "{title}")

Return ONLY valid JSON with exactly these keys:
{{
  "target_titles": ["...", "..."],
  "linkedin_search_url": "https://...",
  "outreach_sequence": ["Day 1: ...", "Day 7: ..."],
  "notes": "...",
  "search_terms": ["site:linkedin.com/in ...", "..."]
}}"""


def _extract_json(text: str) -> dict:
    match = re.search(r'\{.*\}', text, re.DOTALL)
    if not match:
        raise ValueError(f"No JSON found in response: {text[:200]}")
    return json.loads(match.group())


def recruiter_finder(job: dict, profile_text: str) -> dict:
    """
    Generate a recruiter targeting strategy for a specific job.
    Returns a dict with targeting information.
    """
    user_prompt = USER_PROMPT_TEMPLATE.format(
        profile_text=profile_text,
        title=job.get("title", ""),
        company=job.get("company", ""),
        description=job.get("description", "")[:2500],
    )

    try:
        response_text = call_llm(SYSTEM_PROMPT, user_prompt, max_tokens=600)
        result = _extract_json(response_text)

        # Ensure all expected keys exist
        return {
            "target_titles": result.get("target_titles", []),
            "linkedin_search_url": result.get("linkedin_search_url", ""),
            "outreach_sequence": result.get("outreach_sequence", []),
            "notes": result.get("notes", ""),
            "search_terms": result.get("search_terms", []),
        }

    except Exception as e:
        logger.error(f"recruiter_finder failed for '{job.get('company')}': {e}")
        company = job.get("company", "")
        title = job.get("title", "")
        return {
            "target_titles": ["Recruiter", "Engineering Manager", "Head of Engineering"],
            "linkedin_search_url": f"https://www.linkedin.com/search/results/people/?keywords={title.replace(' ', '+')}+{company.replace(' ', '+')}",
            "outreach_sequence": ["Day 1: Send connection request", "Day 7: Follow up if no response"],
            "notes": f"Strategy generation failed: {e}",
            "search_terms": [f'site:linkedin.com/in "{company}" recruiter'],
        }


def main():
    parser = argparse.ArgumentParser(description="Generate recruiter targeting strategy")
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

    print(f"\nFinding recruiters for: {job['title']} @ {job['company']}")
    print("=" * 60)
    result = recruiter_finder(job, profile_text)
    print(json.dumps(result, indent=2))
    return result


if __name__ == "__main__":
    main()
