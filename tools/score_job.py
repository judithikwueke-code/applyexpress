"""
score_job.py — AI-powered job scoring against candidate profile.

Scores a single job 1–10, explains the reasoning, and returns an apply decision.

Usage (standalone):
    python tools/score_job.py --job-file .tmp/jobs_raw.json --job-index 0
    python tools/score_job.py --job-file .tmp/jobs_raw.json --job-index 0 --profile candidate_profile.md

Import:
    from tools.score_job import score_job
    result = score_job(job_dict, profile_text)
    # returns: {"score": 8, "reason": "...", "apply_decision": "yes"}
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
logging.basicConfig(level=logging.INFO, format="%(asctime)s [score_job] %(message)s")
logger = logging.getLogger(__name__)

# Allow running as script from project root
sys.path.insert(0, str(Path(__file__).parent.parent))
from tools.llm_client import call_llm


SYSTEM_PROMPT = """You are an expert career advisor and recruiter with deep knowledge of the tech industry.
Your task is to evaluate how well a job opportunity matches a candidate's profile.
You are precise, honest, and do not inflate scores. A score of 9–10 is rare and reserved for exceptional matches.
You respond ONLY with valid JSON. No other text before or after the JSON."""

USER_PROMPT_TEMPLATE = """Evaluate this job against the candidate profile.

CANDIDATE PROFILE:
{profile_text}

JOB OPPORTUNITY:
Title: {title}
Company: {company}
Location: {location}
Description: {description}
Salary: {salary}

SCORING CRITERIA (weighted):
- Skills alignment (40%): How well do required skills match the candidate's skills?
- Role fit (25%): Does the seniority, title, and scope match the candidate's targets?
- Logistics (20%): Does location/remote arrangement, salary, and industry match preferences?
- Growth potential (15%): Does this role advance the candidate's stated career goals?

SCORE GUIDE:
9–10: Near-perfect match. Apply immediately.
7–8: Strong match with minor gaps. Worth applying.
5–6: Partial match. Apply only if pipeline is thin.
1–4: Poor fit. Skip.

APPLY DECISION RULES:
- score >= 8 → "yes"
- score 6–7 → "maybe"
- score <= 5 → "no"

Respond with ONLY this JSON (no other text):
{{
  "score": <integer 1-10>,
  "reason": "<2-3 sentences: specific matching elements and any notable gaps>",
  "apply_decision": "<yes|maybe|no>"
}}"""


def _extract_json(text: str) -> dict:
    """Extract JSON from LLM response, even if it has surrounding prose."""
    match = re.search(r'\{[^{}]*\}', text, re.DOTALL)
    if not match:
        raise ValueError(f"No JSON object found in response: {text[:200]}")
    return json.loads(match.group())


def score_job(job: dict, profile_text: str) -> dict:
    """
    Score a single job against the candidate profile.
    Returns: {"score": int, "reason": str, "apply_decision": str}
    """
    salary = "Not specified"
    if job.get("salary_min") and job.get("salary_max"):
        salary = f"{job['salary_min']}–{job['salary_max']}"
    elif job.get("salary_min"):
        salary = f"From {job['salary_min']}"

    user_prompt = USER_PROMPT_TEMPLATE.format(
        profile_text=profile_text,
        title=job.get("title", ""),
        company=job.get("company", ""),
        location=job.get("location", ""),
        description=job.get("description", "")[:800],
        salary=salary,
    )

    try:
        response_text = call_llm(SYSTEM_PROMPT, user_prompt, max_tokens=300)
        result = _extract_json(response_text)

        # Validate and coerce
        score = int(result.get("score", 0))
        score = max(1, min(10, score))
        apply_decision = result.get("apply_decision", "no").lower()
        if apply_decision not in ("yes", "maybe", "no"):
            apply_decision = "yes" if score >= 8 else "maybe" if score >= 6 else "no"

        return {
            "score": score,
            "reason": str(result.get("reason", "")),
            "apply_decision": apply_decision,
        }

    except Exception as e:
        logger.error(f"score_job failed for '{job.get('title')}' at '{job.get('company')}': {e}")
        return {"score": 0, "reason": f"Scoring failed: {e}", "apply_decision": "no"}


def main():
    parser = argparse.ArgumentParser(description="Score a job against the candidate profile")
    parser.add_argument("--job-file", default=".tmp/jobs_raw.json")
    parser.add_argument("--job-index", type=int, default=0)
    parser.add_argument("--profile", default=os.getenv("CANDIDATE_PROFILE_PATH", "./candidate_profile.md"))
    args = parser.parse_args()

    profile_path = Path(args.profile)
    if not profile_path.exists():
        print(f"ERROR: Profile not found at {profile_path}. Fill in candidate_profile.md first.")
        sys.exit(1)
    profile_text = profile_path.read_text()

    job_file = Path(args.job_file)
    if not job_file.exists():
        print(f"ERROR: Job file not found at {job_file}. Run fetch_jobs.py first.")
        sys.exit(1)

    with open(job_file) as f:
        jobs = json.load(f)

    if args.job_index >= len(jobs):
        print(f"ERROR: Job index {args.job_index} out of range (file has {len(jobs)} jobs)")
        sys.exit(1)

    job = jobs[args.job_index]
    print(f"\nScoring: {job['title']} @ {job['company']}")
    print("-" * 50)

    result = score_job(job, profile_text)
    print(json.dumps(result, indent=2))
    return result


if __name__ == "__main__":
    main()
