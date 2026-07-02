"""
generate_linkedin_message.py — LinkedIn outreach message generator.

Generates a short (≤150 words), confident, human-tone connection request message
for a recruiter or hiring manager at the target company.

Usage (standalone):
    python tools/generate_linkedin_message.py --job-file .tmp/jobs_raw.json --job-index 0
    python tools/generate_linkedin_message.py --job-file .tmp/jobs_raw.json --job-index 0 --recipient-title "Engineering Manager"

Import:
    from tools.generate_linkedin_message import generate_linkedin_message
    msg = generate_linkedin_message(job_dict, profile_text, recipient_title="Recruiter")
"""

import os
import sys
import json
import logging
import argparse
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s [linkedin_msg] %(message)s")
logger = logging.getLogger(__name__)

sys.path.insert(0, str(Path(__file__).parent.parent))
from tools.llm_client import call_llm

WORD_LIMIT = 150

SYSTEM_PROMPT = """You are writing a LinkedIn connection request message on behalf of a job applicant.
The message must be under 150 words (LinkedIn's hard limit).
It must feel like a real person wrote it — not a template.
You respond with ONLY the message text. No labels, no subject line, no explanation."""

USER_PROMPT_TEMPLATE = """Write a LinkedIn connection request message to a {recipient_title} at {company}.

CANDIDATE PROFILE:
{profile_text}

TARGET JOB:
Title: {title}
Company: {company}
Description: {description}

RULES:
1. Under 150 words (hard limit — count carefully)
2. Open with a personalised hook — reference something specific about the company or role
3. State the sender's most relevant credential in one sentence
4. Make a clear, low-pressure ask (connect to learn more / discuss the opportunity)
5. Do NOT start with "Hi, my name is..." or "I hope this message finds you well"
6. Do NOT say "I came across your profile" or any variant
7. Tone: confident, direct, warm — not salesy, not desperate

Return ONLY the message text."""

TRIM_SYSTEM_PROMPT = """You are editing a LinkedIn message to be under 150 words.
Preserve all key points. Keep the same tone and structure.
Return ONLY the trimmed message. No labels or explanation."""


def _word_count(text: str) -> int:
    return len(text.split())


def generate_linkedin_message(job: dict, profile_text: str, recipient_title: str = "Recruiter") -> str:
    """
    Generate a LinkedIn connection request message (≤150 words).
    Returns the message as a plain text string.
    """
    user_prompt = USER_PROMPT_TEMPLATE.format(
        recipient_title=recipient_title,
        company=job.get("company", ""),
        profile_text=profile_text,
        title=job.get("title", ""),
        description=job.get("description", "")[:2000],
    )

    try:
        result = call_llm(SYSTEM_PROMPT, user_prompt, max_tokens=300)
        result = result.strip()

        # Enforce word limit — trim if over
        if _word_count(result) > WORD_LIMIT:
            logger.info(f"Message over {WORD_LIMIT} words ({_word_count(result)}). Trimming...")
            trim_prompt = f"Trim this LinkedIn message to under {WORD_LIMIT} words while keeping all key points:\n\n{result}"
            result = call_llm(TRIM_SYSTEM_PROMPT, trim_prompt, max_tokens=250)
            result = result.strip()

        logger.info(f"LinkedIn message: {_word_count(result)} words")
        return result

    except Exception as e:
        logger.error(f"generate_linkedin_message failed for '{job.get('company')}': {e}")
        return f"[LinkedIn message generation failed for {job.get('company')}: {e}]"


def main():
    parser = argparse.ArgumentParser(description="Generate LinkedIn outreach message")
    parser.add_argument("--job-file", default=".tmp/jobs_raw.json")
    parser.add_argument("--job-index", type=int, default=0)
    parser.add_argument("--profile", default=os.getenv("CANDIDATE_PROFILE_PATH", "./candidate_profile.md"))
    parser.add_argument("--recipient-title", default="Recruiter")
    args = parser.parse_args()

    profile_path = Path(args.profile)
    if not profile_path.exists():
        print(f"ERROR: Profile not found at {profile_path}")
        sys.exit(1)
    profile_text = profile_path.read_text()

    with open(args.job_file) as f:
        jobs = json.load(f)
    job = jobs[args.job_index]

    print(f"\nGenerating LinkedIn message for: {job['title']} @ {job['company']}")
    print(f"Recipient: {args.recipient_title}")
    print("=" * 60)
    result = generate_linkedin_message(job, profile_text, args.recipient_title)
    print(result)
    print(f"\n[Word count: {_word_count(result)}/{WORD_LIMIT}]")
    return result


if __name__ == "__main__":
    main()
