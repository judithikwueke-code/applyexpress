"""
sponsor_check.py — Check if a company holds a UK visa sponsorship licence.

Loads data/sponsor_list.json (built by download_sponsor_list.py) and performs
tiered matching:

  Tier 1 — Exact cleaned name match
  Tier 2 — Exact significant-word-set match (same words, different legal suffixes)
            Handles: "AJ Bell" → "AJ Bell PLC", "Elliptic" → "Elliptic Enterprises Ltd"
            Correctly rejects: "Sardine" ≠ "The Sardine Factory Restaurant" (extra words)
  Tier 3 — Abbreviation word-boundary match for all-caps 2–5 char names
            Handles: SGN → "Scotia Gas Networks Ltd t/a SGN"
  Tier 4 — Multi-word companies: ALL rare job-name words (freq < 30) must appear
            in the sponsor's word set.
            Handles: "Santander Consumer Finance" → "Santander UK PLC" (via "santander")
            Correctly rejects: "Hunter Savage" (requires BOTH words in sponsor)

Usage:
    from tools.sponsor_check import is_sponsor
    matched, canonical = is_sponsor("AJ Bell")
    # → (True, "aj bell plc")
"""

import re
import json
from functools import lru_cache
from pathlib import Path

# Legal + generic professional-service words stripped before comparison
_SUFFIX_RE = re.compile(
    r"\b(ltd|limited|plc|llp|llc|inc|corp|corporation|group|holding|holdings|"
    r"uk|gb|global|europe|european|international|services|solutions|consulting|"
    r"management|investments|ventures|capital|trust|foundation|association|"
    r"enterprises|company|agency|associates|partnership|partners|advisory|"
    r"recruitment|resourcing|staffing|search|resources|resource|bank|banking)\b\.?",
    re.IGNORECASE,
)

_LIST_PATH = Path("data/sponsor_list.json")
_NOISE_WORDS = {"the", "and", "for", "not", "are", "was", "its", "our", "has", "t/a"}

# Words appearing in fewer than this many sponsors are treated as brand identifiers
_BRAND_FREQ_THRESHOLD = 30


@lru_cache(maxsize=1)
def _load() -> tuple:
    """Return (frozenset of raw names, word→frequency dict)."""
    if not _LIST_PATH.exists():
        return frozenset(), {}
    raw_list = json.loads(_LIST_PATH.read_text())
    freq: dict[str, int] = {}
    for name in raw_list:
        for w in _sig_words(name):
            freq[w] = freq.get(w, 0) + 1
    return frozenset(raw_list), freq


def _sig_words(name: str) -> frozenset:
    """Significant words: 4+ chars, legal/generic suffixes removed, noise excluded."""
    cleaned = _SUFFIX_RE.sub(" ", name.strip().lower())
    return frozenset(
        w for w in re.split(r"[\s\-&,./()]+", cleaned)
        if len(w) >= 4 and w not in _NOISE_WORDS
    )


def _clean(name: str) -> str:
    return " ".join(_SUFFIX_RE.sub(" ", name.strip().lower()).split())


def is_sponsor(company: str) -> tuple[bool, str]:
    """
    Check if a company name matches a licensed UK visa sponsor.

    Returns (matched: bool, canonical_name: str).
    canonical_name is the raw registered name from the gov.uk list (lowercased).
    """
    sponsors, freq = _load()
    if not sponsors:
        return False, ""

    job_words = _sig_words(company)
    job_clean = _clean(company)
    is_abbrev = bool(re.match(r"^[A-Z]{2,5}$", company.strip()))

    for raw_name in sponsors:
        sp_words = _sig_words(raw_name)
        sp_clean = _clean(raw_name)

        # Tier 1 — exact cleaned names (e.g. "Ageas Insurance Limited" → exact)
        if job_clean and sp_clean and job_clean == sp_clean:
            return True, raw_name

        # Tier 2 — exact word-set match (same brand, different legal suffix)
        # Rejects "Sardine" vs "Sardine Factory Restaurant" because sp_words differs
        if job_words and job_words == sp_words:
            return True, raw_name

        # Tier 3 — abbreviation word-boundary match
        if is_abbrev:
            abbrev_lower = company.strip().lower()
            if re.search(r"\b" + re.escape(abbrev_lower) + r"\b", raw_name.lower()):
                return True, raw_name

    # Tier 4 — multi-word company: brand-word matching
    # Strategy: find the RAREST word in the job name.
    # If it's also the FIRST significant word (left-to-right), it's the lead brand
    # identifier — match any sponsor that contains it.
    # Otherwise (rare word is buried after a common first word, e.g. "Hunter Savage"),
    # require ALL rare words to appear together in one sponsor, preventing single-word
    # false positives from coincidental name overlap.
    if len(job_words) >= 2:
        ordered = [
            w for w in re.split(r"[\s\-&,./()]+", _SUFFIX_RE.sub(" ", company.strip().lower()))
            if len(w) >= 4 and w not in _NOISE_WORDS
        ]
        if ordered:
            rarest = min(ordered, key=lambda w: freq.get(w, 0))
            rarest_freq = freq.get(rarest, 0)
            is_first = (ordered[0] == rarest)

            if rarest_freq <= 5 and is_first:
                # Lead brand is very rare — match on it alone (e.g. "Santander Consumer Finance")
                for raw_name in sponsors:
                    if rarest in _sig_words(raw_name):
                        return True, raw_name
            else:
                # Require ALL rare words together (e.g. "Hunter Savage" needs both
                # "hunter" AND "savage" in the same sponsor — no sponsor has both)
                rare = frozenset(w for w in job_words if freq.get(w, 0) < _BRAND_FREQ_THRESHOLD)
                if rare:
                    for raw_name in sponsors:
                        if rare.issubset(_sig_words(raw_name)):
                            return True, raw_name

    return False, ""


def sponsor_list_loaded() -> bool:
    return _LIST_PATH.exists() and bool(_load()[0])


if __name__ == "__main__":
    import sys
    if not sponsor_list_loaded():
        print(f"ERROR: {_LIST_PATH} not found — run: python3 tools/download_sponsor_list.py")
        sys.exit(1)
    names = sys.argv[1:] or [
        "HSBC", "Deloitte", "Accenture", "Reed", "FakeCompanyXYZ999",
        "EY", "PwC", "Barclays", "KPMG", "FDM Group",
    ]
    for name in names:
        matched, canonical = is_sponsor(name)
        status = f"MATCH → {canonical}" if matched else "no match"
        print(f"  {name:40s} {status}")
