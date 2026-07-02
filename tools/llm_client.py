"""
llm_client.py — Shared LLM wrapper for the job application pipeline.

Primary: Groq (free, 500k tokens/day).
Fallback: Google Gemini (free, 1M tokens/day) — kicks in automatically when
          Groq hits its daily token limit (TPD error).

Usage:
    from tools.llm_client import call_llm
    response = call_llm(system_prompt, user_prompt, max_tokens=500)
"""

import os
import re
import time
import logging
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

LLM_PROVIDER    = os.getenv("LLM_PROVIDER", "groq").lower()
GROQ_API_KEY    = os.getenv("GROQ_API_KEY", "")
GROQ_API_KEY_2  = os.getenv("GROQ_API_KEY_2", "")
GROQ_API_KEY_3  = os.getenv("GROQ_API_KEY_3", "")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
GEMINI_API_KEY  = os.getenv("GEMINI_API_KEY", "")

GROQ_MODEL      = "meta-llama/llama-4-scout-17b-16e-instruct"
ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"
GEMINI_MODEL    = "gemini-2.0-flash"

MAX_RETRIES  = 5
RETRY_WAIT   = 15

# Track whether each Groq account's daily token limit has been hit this process lifetime.
_groq_tpd_exhausted   = False
_groq_tpd_exhausted_2 = False
_groq_tpd_exhausted_3 = False
# Track Gemini billing exhaustion — credits depleted won't reset until topped up.
_gemini_credits_exhausted = False


def _parse_retry_after(error_str: str) -> float:
    match = re.search(r'try again in ([\d.]+)s', str(error_str), re.IGNORECASE)
    if match:
        return float(match.group(1)) + 1.5
    return RETRY_WAIT


def _is_tpd_error(error_str: str) -> bool:
    """Return True if the Groq error is a tokens-per-day exhaustion (not just RPM)."""
    s = str(error_str).lower()
    return "tokens per day" in s or "tpd" in s


def call_llm(system_prompt: str, user_prompt: str, max_tokens: int = 800) -> str:
    """
    Call the configured LLM. Falls back through: Groq 1 → Groq 2 → Groq 3 → Gemini.
    """
    global _groq_tpd_exhausted, _groq_tpd_exhausted_2, _groq_tpd_exhausted_3, _gemini_credits_exhausted

    if LLM_PROVIDER == "anthropic" and ANTHROPIC_API_KEY:
        return _call_anthropic(system_prompt, user_prompt, max_tokens)

    # Primary: Groq account 1
    if GROQ_API_KEY and not _groq_tpd_exhausted:
        try:
            return _call_groq(system_prompt, user_prompt, max_tokens, GROQ_API_KEY)
        except RuntimeError as e:
            if _is_tpd_error(str(e)):
                logger.warning("Groq account 1 daily limit exhausted — trying account 2")
                _groq_tpd_exhausted = True
            else:
                raise

    # Fallback 1: Groq account 2
    if GROQ_API_KEY_2 and not _groq_tpd_exhausted_2:
        try:
            return _call_groq(system_prompt, user_prompt, max_tokens, GROQ_API_KEY_2)
        except RuntimeError as e:
            if _is_tpd_error(str(e)):
                logger.warning("Groq account 2 daily limit exhausted — trying account 3")
                _groq_tpd_exhausted_2 = True
            else:
                raise

    # Fallback 2: Groq account 3
    if GROQ_API_KEY_3 and not _groq_tpd_exhausted_3:
        try:
            return _call_groq(system_prompt, user_prompt, max_tokens, GROQ_API_KEY_3)
        except RuntimeError as e:
            if _is_tpd_error(str(e)):
                logger.warning("Groq account 3 daily limit exhausted — trying Gemini")
                _groq_tpd_exhausted_3 = True
            else:
                raise

    # Fallback 3: Gemini
    if GEMINI_API_KEY and not _gemini_credits_exhausted:
        try:
            return _call_gemini(system_prompt, user_prompt, max_tokens)
        except RuntimeError as e:
            if "credits exhausted" in str(e):
                _gemini_credits_exhausted = True
                logger.warning("Gemini prepaid credits exhausted — skipping for remainder of process")
            else:
                raise

    raise RuntimeError("No LLM available: all Groq accounts and Gemini exhausted.")


def _call_groq(system_prompt: str, user_prompt: str, max_tokens: int, api_key: str = None) -> str:
    try:
        from groq import Groq, RateLimitError, BadRequestError
    except ImportError:
        raise RuntimeError("groq package not installed. Run: pip install groq")

    client = Groq(api_key=api_key or GROQ_API_KEY)

    for attempt in range(MAX_RETRIES + 1):
        try:
            response = client.chat.completions.create(
                model=GROQ_MODEL,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user",   "content": user_prompt},
                ],
                max_tokens=max_tokens,
                temperature=0.3,
            )
            return response.choices[0].message.content.strip()

        except RateLimitError as e:
            err_str = str(e)
            if _is_tpd_error(err_str):
                raise RuntimeError(f"Groq TPD exhausted: {e}") from e
            wait = _parse_retry_after(err_str)
            if attempt < MAX_RETRIES:
                logger.warning(f"Groq RPM limit. Waiting {wait:.1f}s (retry {attempt+1}/{MAX_RETRIES})…")
                time.sleep(wait)
            else:
                raise RuntimeError(f"Groq rate limit exceeded after {MAX_RETRIES} retries: {e}") from e

        except BadRequestError as e:
            raise RuntimeError(f"Groq bad request: {e}") from e

        except Exception as e:
            if attempt < MAX_RETRIES:
                logger.warning(f"Groq call failed (attempt {attempt+1}): {e}. Retrying in {RETRY_WAIT}s…")
                time.sleep(RETRY_WAIT)
            else:
                raise RuntimeError(f"Groq call failed after {MAX_RETRIES} retries: {e}") from e


def _call_gemini(system_prompt: str, user_prompt: str, max_tokens: int) -> str:
    try:
        from google import genai
        from google.genai import types
    except ImportError:
        raise RuntimeError("google-genai not installed. Run: pip install google-genai")

    client = genai.Client(api_key=GEMINI_API_KEY)

    for attempt in range(MAX_RETRIES + 1):
        try:
            response = client.models.generate_content(
                model=GEMINI_MODEL,
                contents=user_prompt,
                config=types.GenerateContentConfig(
                    system_instruction=system_prompt,
                    max_output_tokens=max_tokens,
                    temperature=0.3,
                ),
            )
            return response.text.strip()
        except Exception as e:
            err = str(e).lower()
            # Permanent failures — don't retry
            if "limit: 0" in err or "limit\":0" in err:
                raise RuntimeError(f"Gemini API not enabled for this key (limit: 0): {e}") from e
            if "prepayment" in err or "credits are depleted" in err or "credits_depleted" in err:
                raise RuntimeError(f"Gemini credits exhausted — top up at ai.google.dev: {e}") from e
            # Transient rate limits — retry with backoff
            if "quota" in err or "rate" in err or "429" in err or "resource_exhausted" in err:
                wait = 60
                if attempt < MAX_RETRIES:
                    logger.warning(f"Gemini rate limit. Waiting {wait}s (retry {attempt+1}/{MAX_RETRIES})…")
                    time.sleep(wait)
                else:
                    raise RuntimeError(f"Gemini rate limit after {MAX_RETRIES} retries: {e}") from e
            elif attempt < MAX_RETRIES:
                logger.warning(f"Gemini call failed (attempt {attempt+1}): {e}. Retrying in {RETRY_WAIT}s…")
                time.sleep(RETRY_WAIT)
            else:
                raise RuntimeError(f"Gemini call failed after {MAX_RETRIES} retries: {e}") from e


def _call_anthropic(system_prompt: str, user_prompt: str, max_tokens: int) -> str:
    try:
        import anthropic
    except ImportError:
        raise RuntimeError("anthropic package not installed. Run: pip install anthropic")

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    for attempt in range(MAX_RETRIES + 1):
        try:
            response = client.messages.create(
                model=ANTHROPIC_MODEL,
                max_tokens=max_tokens,
                system=system_prompt,
                messages=[{"role": "user", "content": user_prompt}],
            )
            return response.content[0].text.strip()
        except anthropic.RateLimitError as e:
            if attempt < MAX_RETRIES:
                logger.warning(f"Anthropic rate limit. Waiting 60s (retry {attempt+1}/{MAX_RETRIES})…")
                time.sleep(60)
            else:
                raise RuntimeError(f"Anthropic rate limit after {MAX_RETRIES} retries: {e}") from e
        except Exception as e:
            if attempt < MAX_RETRIES:
                logger.warning(f"Anthropic call failed (attempt {attempt+1}): {e}. Retrying in {RETRY_WAIT}s…")
                time.sleep(RETRY_WAIT)
            else:
                raise RuntimeError(f"Anthropic call failed after {MAX_RETRIES} retries: {e}") from e


def get_provider_info() -> dict:
    return {
        "provider": LLM_PROVIDER,
        "model": ANTHROPIC_MODEL if LLM_PROVIDER == "anthropic" else GROQ_MODEL,
        "gemini_fallback": bool(GEMINI_API_KEY),
    }


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    info = get_provider_info()
    print(f"Primary: {info['provider']} ({info['model']})")
    print(f"Gemini fallback: {'enabled' if info['gemini_fallback'] else 'disabled'}")
    print("Testing Groq…")
    result = call_llm("You are a helpful assistant.", 'Reply with exactly: {"status": "ok"}', max_tokens=20)
    print(f"Groq response: {result}")
    if GEMINI_API_KEY:
        print("Testing Gemini fallback…")
        result2 = _call_gemini("You are a helpful assistant.", 'Reply with exactly: {"status": "ok"}', max_tokens=20)
        print(f"Gemini response: {result2}")
    print("Done.")
