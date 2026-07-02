"""
generate_application_answers.py — Standard ATS application question answerer.

Generates concise, honest answers to the 7 most common screening questions.
Tailors each answer to the specific role where possible.

Usage (standalone):
    python tools/generate_application_answers.py --job-file .tmp/jobs_raw.json --job-index 0

Import:
    from tools.generate_application_answers import generate_application_answers
    answers = generate_application_answers(job_dict, profile_text)
    # returns: {"availability": "...", "strengths": "...", ...}
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
logging.basicConfig(level=logging.INFO, format="%(asctime)s [app_answers] %(message)s")
logger = logging.getLogger(__name__)

sys.path.insert(0, str(Path(__file__).parent.parent))
from tools.llm_client import call_llm


SYSTEM_PROMPT = """You are helping a job applicant complete an online application form.
You generate honest, specific, professionally-worded answers to standard screening questions.
You tailor each answer to the target role without inventing experience.
You respond ONLY with valid JSON. No other text before or after the JSON object."""

USER_PROMPT_TEMPLATE = """Generate answers to these standard application form questions for this candidate and job.

CANDIDATE PROFILE:
{profile_text}

TARGET JOB:
Title: {title}
Company: {company}
Description: {description}

Answer each question concisely and honestly, tailored to this specific role:

1. availability — When can you start? (1–2 sentences, use notice period from profile)
2. strengths — What are your top 2–3 strengths? (3–5 sentences, use specific examples from profile)
3. why_this_role — Why do you want this specific role? (3–4 sentences, be specific to this job/company)
4. salary_expectation — What are your salary expectations? (1–2 sentences, use range from profile)
5. right_to_work — Do you have right to work in the relevant country? (1 sentence, use profile info)
6. notice_period — What is your notice period? (1 sentence)
7. years_experience — How many years of relevant experience? (1 sentence)

Return ONLY valid JSON with exactly these keys:
{{
  "availability": "...",
  "strengths": "...",
  "why_this_role": "...",
  "salary_expectation": "...",
  "right_to_work": "...",
  "notice_period": "...",
  "years_experience": "..."
}}"""


def _extract_json(text: str) -> dict:
    match = re.search(r'\{.*\}', text, re.DOTALL)
    if not match:
        raise ValueError(f"No JSON found in response: {text[:200]}")
    return json.loads(match.group())


def generate_application_answers(job: dict, profile_text: str) -> dict:
    """
    Generate answers to standard application questions for a specific job.
    Returns dict with 7 standard answer fields.
    """
    user_prompt = USER_PROMPT_TEMPLATE.format(
        profile_text=profile_text,
        title=job.get("title", ""),
        company=job.get("company", ""),
        description=job.get("description", "")[:2500],
    )

    try:
        response_text = call_llm(SYSTEM_PROMPT, user_prompt, max_tokens=1000)
        return _extract_json(response_text)
    except Exception as e:
        logger.error(f"generate_application_answers failed for '{job.get('title')}': {e}")
        return {
            "availability": "[Generation failed — fill manually]",
            "strengths": "[Generation failed — fill manually]",
            "why_this_role": "[Generation failed — fill manually]",
            "salary_expectation": "[Generation failed — fill manually]",
            "right_to_work": "[Generation failed — fill manually]",
            "notice_period": "[Generation failed — fill manually]",
            "years_experience": "[Generation failed — fill manually]",
        }


def main():
    parser = argparse.ArgumentParser(description="Generate application answers for a specific job")
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

    print(f"\nGenerating answers for: {job['title']} @ {job['company']}")
    print("=" * 60)
    result = generate_application_answers(job, profile_text)
    print(json.dumps(result, indent=2))
    return result


if __name__ == "__main__":
    main()
