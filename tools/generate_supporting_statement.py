"""
generate_supporting_statement.py — NHS/Trac supporting statement generator.

NHS shortlisting is anonymised and scored against the job's Person Specification:
a panel ticks off each Essential/Desirable criterion your statement evidences.
So the statement must (a) contain NO personal identifying details — Trac's rule —
and (b) read as genuinely human-written, not an AI template that mirrors the spec.

Import:
    from tools.generate_supporting_statement import generate_supporting_statement
    text = generate_supporting_statement(job_dict, profile_text, cv_text)
"""

import os
import re
import sys
import json
import logging
import argparse
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s [supporting_stmt] %(message)s")
logger = logging.getLogger(__name__)

sys.path.insert(0, str(Path(__file__).parent.parent))
from tools.llm_client import call_llm

# Phrases that betray AI-written / templated prose. Used to score a draft and,
# if it leaks too many, trigger one rewrite pass.
_AI_TELLS = [
    "i am writing to apply", "i am excited", "i am thrilled", "i am delighted",
    "ideal candidate", "perfect candidate", "in today's", "throughout my career",
    "i am confident that", "i am confident in", "proven track record", "passionate",
    "results-driven", "results driven", "wealth of experience", "hit the ground running",
    "align with", "aligns with", "leverage", "eager to bring", "particularly drawn to",
    "i am well-positioned", "i am well positioned", "make a valuable contribution",
    "i believe i", "dynamic", "seamlessly", "furthermore,", "moreover,",
    "strong candidate", "unique understanding", "unique perspective", "firsthand",
    "important work", "make me well-suited", "make me a strong", "draws me to",
]


def _quality_call(system: str, user: str, max_tokens: int) -> str:
    """Prefer Anthropic for these (best human voice + honours negative constraints);
    fall back to the shared chain if the key is unset."""
    if os.getenv("ANTHROPIC_API_KEY"):
        try:
            from tools.llm_client import _call_anthropic
            return _call_anthropic(system, user, max_tokens)
        except Exception as e:
            logger.warning(f"Anthropic path failed ({e}); using shared LLM chain")
    return call_llm(system, user, max_tokens)


def _count_tells(text: str) -> list:
    # Normalise contractions so "I'm confident" matches the "i am confident" tell
    low = text.lower()
    low = low.replace("i'm", "i am").replace("i've", "i have").replace("i'd", "i would")
    return [t for t in _AI_TELLS if t in low]


# Personal details that must never appear (anonymised shortlisting).
_PII_PATTERNS = [
    (re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b"), ""),              # emails
    (re.compile(r"\+?\d[\d\s()./-]{8,}\d"), ""),                    # phone numbers
    (re.compile(r"\b\d{1,2}\s+years?\s+old\b", re.I), ""),          # age
]


def _extract_person_spec(description: str) -> str:
    """Pull the Person Specification section out of the advert text, if present."""
    d = description or ""
    m = re.search(r"person specification", d, re.I)
    if m:
        spec = d[m.start():]
        # Trim trailing NHS boilerplate that sometimes follows the spec
        for marker in ("Employer certification", "Documents to download",
                       "Apply for this job", "Further details"):
            i = spec.find(marker)
            if i != -1:
                spec = spec[:i]
        return spec.strip()[:3500]
    return d[:3500]


def _strip_pii(text: str, first_name: str = "", last_name: str = "") -> str:
    """Remove anything that could identify the candidate (Trac requirement)."""
    for pat, repl in _PII_PATTERNS:
        text = pat.sub(repl, text)
    for name in filter(None, [first_name, last_name]):
        text = re.sub(rf"\b{re.escape(name)}\b", "", text, flags=re.I)
    # Collapse artefacts left by removals
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


SYSTEM_PROMPT = (
    "You are a UK healthcare professional writing your own supporting statement for an "
    "NHS job application through Trac. You are not a copywriter and not an AI — you write "
    "plainly and specifically, the way an experienced applicant actually does. "
    "NHS shortlisting is anonymised and scored against the Person Specification, so you "
    "methodically evidence each essential criterion with real examples from your own career, "
    "but you never sound like you are ticking boxes. Return ONLY the statement text."
)

USER_PROMPT_TEMPLATE = """Write my supporting statement for this NHS role.

MY BACKGROUND (draw only from this — never invent):
{profile_text}

MY CV:
{cv_text}

THE ROLE:
Title: {title}
Employer: {company}

PERSON SPECIFICATION (the panel scores my statement against these criteria):
{person_spec}

HOW TO WRITE IT — read carefully:

Evidence, in order: Work through the Essential criteria in the order the Person
Specification lists them, then the strongest Desirable ones. For each, give a concrete
example from my real experience that shows I meet it — what I did, in what setting, and
what came of it. Where a criterion asks for something I am still building (e.g. a
qualification in progress, or NHS-specific exposure I have transferable equivalents for),
say so honestly and show the nearest real evidence — never claim it outright.

Sound like a person, not a template:
- Do NOT restate or paraphrase the criteria back as headings or a checklist. Weave the
  evidence into flowing paragraphs a human would write.
- Vary sentence length. Some short. Some longer and more detailed. Real writing is uneven.
- British spelling throughout (organise, programme, specialised, behaviour).
- BANNED openings and phrases: "I am writing to apply", "I am excited/thrilled/delighted",
  "I believe I am the ideal/perfect candidate", "In today's ...", "throughout my career I
  have", "I am confident that", "proven track record", "passionate", "dynamic",
  "results-driven", "wealth of experience", "hit the ground running", "align with", "leverage".
- No grand mission-statement opener and no summarising conclusion that repeats everything.
  Open by going straight into the most relevant experience. Close with one plain, genuine
  sentence about why this particular role.
- Specifics over adjectives: name the actual regulations, systems, and situations I worked
  with (from my CV) rather than describing myself with praise words.

CRITICAL — anonymised shortlisting:
- Do NOT include my name anywhere.
- Do NOT include age, date of birth, gender, nationality, address, phone, or email.
- Referring to my employers and roles is fine; identifying ME personally is not.

Length: 500–750 words. Plain paragraphs, no headings, no bullet points, no sign-off.

Return ONLY the statement."""


def generate_supporting_statement(job: dict, profile_text: str, cv_text: str = "",
                                  first_name: str = "", last_name: str = "") -> str:
    person_spec = _extract_person_spec(job.get("description", ""))
    prompt = USER_PROMPT_TEMPLATE.format(
        profile_text=(profile_text or "")[:2000],
        cv_text=(cv_text or "")[:2500],
        title=job.get("title", ""),
        company=job.get("company", ""),
        person_spec=person_spec,
    )
    try:
        text = _quality_call(SYSTEM_PROMPT, prompt, max_tokens=1400).strip()
    except Exception as e:
        logger.error(f"Supporting statement generation failed for '{job.get('title')}': {e}")
        raise

    # One rewrite pass if the draft reads templated or fell short on length
    tells = _count_tells(text)
    if len(tells) >= 3 or len(text.split()) < 450:
        logger.info(f"Rewriting statement (tells={tells}, words={len(text.split())})")
        rewrite = (
            "Rewrite the supporting statement below so it reads as genuinely human-written "
            "and is 550–700 words. Keep every real example and fact, but:\n"
            f"- Remove these clichéd/AI phrases entirely and rephrase plainly: {', '.join(tells) or 'none'}.\n"
            "- Do not repeat the same idea (e.g. 'the importance of data protection and "
            "information governance') more than once — each paragraph must add something new.\n"
            "- Vary sentence length; British spelling; no headings or bullets; no name or "
            "personal details.\n"
            "- End on ONE plain, specific sentence about this role — not a summary of everything above.\n\n"
            "DRAFT:\n" + text
        )
        try:
            text = _quality_call(SYSTEM_PROMPT, rewrite, max_tokens=1400).strip()
        except Exception as e:
            logger.warning(f"Rewrite pass failed, keeping first draft: {e}")

    # Belt-and-braces: strip any personal details the model let slip
    text = _strip_pii(text, first_name, last_name)
    remaining = _count_tells(text)
    logger.info(f"Supporting statement: {len(text.split())} words for '{job.get('title','')}'"
                f" (residual tells: {remaining or 'none'})")
    return text


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-file", default=".tmp/jobs_raw.json")
    parser.add_argument("--job-index", type=int, default=0)
    parser.add_argument("--profile", default=os.getenv("CANDIDATE_PROFILE_PATH", "./candidate_profile.md"))
    args = parser.parse_args()

    with open(args.job_file) as f:
        job = json.load(f)[args.job_index]
    profile_text = Path(args.profile).read_text() if Path(args.profile).exists() else ""
    print(generate_supporting_statement(job, profile_text, profile_text))


if __name__ == "__main__":
    main()
