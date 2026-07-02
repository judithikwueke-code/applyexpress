"""
parse_cv.py — Parse a CV file and fill candidate_profile.md automatically.

Accepts a PDF or Word (.docx) CV. Extracts the text, uses AI to parse every
section, and writes a fully populated candidate_profile.md.

A backup of the original profile is saved to .tmp/candidate_profile_backup.md
before overwriting.

Supported formats: .pdf, .docx, .doc (plain text fallback)

Usage:
    python tools/parse_cv.py --cv-path /path/to/your_cv.pdf
    python tools/parse_cv.py --cv-path /path/to/your_cv.docx
    python tools/parse_cv.py --cv-path /path/to/your_cv.pdf --output candidate_profile.md
"""

import os
import sys
import json
import re
import logging
import argparse
import shutil
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s [parse_cv] %(message)s")
logger = logging.getLogger(__name__)

sys.path.insert(0, str(Path(__file__).parent.parent))
from tools.llm_client import call_llm

TMP_DIR = Path(".tmp")
TMP_DIR.mkdir(exist_ok=True)


# ---------------------------------------------------------------------------
# Text extraction
# ---------------------------------------------------------------------------

def extract_text_from_pdf(path: Path) -> str:
    try:
        import pdfplumber
        text_parts = []
        with pdfplumber.open(path) as pdf:
            for page in pdf.pages:
                text = page.extract_text()
                if text:
                    text_parts.append(text)
        full_text = "\n\n".join(text_parts)
        logger.info(f"Extracted {len(full_text)} chars from PDF ({len(pdf.pages)} pages)")
        return full_text
    except ImportError:
        raise RuntimeError("pdfplumber not installed. Run: pip install pdfplumber")
    except Exception as e:
        raise RuntimeError(f"PDF extraction failed: {e}")


def extract_text_from_docx(path: Path) -> str:
    try:
        from docx import Document
        doc = Document(path)
        paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
        full_text = "\n\n".join(paragraphs)
        logger.info(f"Extracted {len(full_text)} chars from DOCX ({len(paragraphs)} paragraphs)")
        return full_text
    except ImportError:
        raise RuntimeError("python-docx not installed. Run: pip install python-docx")
    except Exception as e:
        raise RuntimeError(f"DOCX extraction failed: {e}")


def extract_text(cv_path: Path) -> str:
    suffix = cv_path.suffix.lower()
    if suffix == ".pdf":
        return extract_text_from_pdf(cv_path)
    elif suffix in (".docx", ".doc"):
        return extract_text_from_docx(cv_path)
    elif suffix in (".txt", ".md"):
        return cv_path.read_text()
    else:
        raise ValueError(f"Unsupported file type: {suffix}. Supported: .pdf, .docx, .txt")


# ---------------------------------------------------------------------------
# AI parsing
# ---------------------------------------------------------------------------

EXTRACT_SYSTEM_PROMPT = """You are an expert CV parser. You extract structured information from CV text
and output it as clean, well-formatted JSON.
You are precise — you only include information that is actually in the CV.
For fields that are not mentioned in the CV, use an empty string "".
You respond ONLY with valid JSON. No other text."""

EXTRACT_USER_PROMPT = """Parse this CV and extract all available information into the JSON structure below.

CV TEXT:
{cv_text}

Extract into this exact JSON structure:

{{
  "personal": {{
    "name": "",
    "email": "",
    "phone": "",
    "location": "",
    "linkedin": "",
    "github_portfolio": ""
  }},
  "target_roles": {{
    "job_titles": "",
    "industries": "",
    "work_arrangement": "",
    "seniority_level": "",
    "salary_expectations": "",
    "availability": "",
    "open_to_relocation": "",
    "right_to_work": ""
  }},
  "cv_summary": "",
  "work_experience": [
    {{
      "title": "",
      "company": "",
      "period": "",
      "achievements": ["", ""]
    }}
  ],
  "education": [
    {{
      "degree": "",
      "institution": "",
      "year": "",
      "notes": ""
    }}
  ],
  "skills": {{
    "languages": "",
    "frameworks": "",
    "databases": "",
    "infrastructure": "",
    "tools": "",
    "other": ""
  }},
  "achievements": ["", ""],
  "career_goals": ""
}}

PARSING RULES:
- personal.name: Full name from the top of the CV
- personal.email: Email address
- personal.phone: Phone number
- personal.location: City, Country
- personal.linkedin: LinkedIn URL if present
- personal.github_portfolio: GitHub or portfolio URL if present
- target_roles.job_titles: Infer from most recent/senior roles (e.g. "Senior Backend Engineer")
- target_roles.seniority_level: Infer from experience level (Junior/Mid/Senior/Lead/Staff)
- target_roles.work_arrangement: Infer if mentioned, otherwise "Hybrid"
- cv_summary: Use the profile summary/objective if present, otherwise write a 2–3 sentence summary based on the CV
- work_experience: All roles, most recent first. achievements as bullet points, each 1 sentence
- skills.languages: Programming languages only
- skills.frameworks: Frameworks and libraries
- skills.databases: Database technologies
- skills.infrastructure: Cloud, DevOps, CI/CD tools
- skills.tools: Other tools (monitoring, project management, etc.)
- career_goals: Extract from objective/summary section or infer from career trajectory

Return ONLY the JSON object. No other text."""


def _extract_json(text: str) -> dict:
    # Try to find JSON object
    match = re.search(r'\{.*\}', text, re.DOTALL)
    if not match:
        raise ValueError(f"No JSON found in response: {text[:300]}")
    try:
        return json.loads(match.group())
    except json.JSONDecodeError as e:
        # Try to clean up common LLM JSON issues
        cleaned = match.group().replace('\n', ' ').replace('\t', ' ')
        return json.loads(cleaned)


def parse_cv_with_ai(cv_text: str) -> dict:
    """Use AI to parse CV text into structured data."""
    # Truncate very long CVs to avoid token limits (keep first 6000 chars — plenty for a CV)
    truncated = cv_text[:6000] if len(cv_text) > 6000 else cv_text

    user_prompt = EXTRACT_USER_PROMPT.format(cv_text=truncated)

    logger.info("Parsing CV with AI...")
    response = call_llm(EXTRACT_SYSTEM_PROMPT, user_prompt, max_tokens=2000)
    return _extract_json(response)


# ---------------------------------------------------------------------------
# Profile builder
# ---------------------------------------------------------------------------

def build_profile_markdown(data: dict) -> str:
    """Convert parsed CV data into the candidate_profile.md format."""
    personal = data.get("personal", {})
    target = data.get("target_roles", {})
    skills = data.get("skills", {})
    work_exp = data.get("work_experience", [])
    education = data.get("education", [])
    achievements = data.get("achievements", [])

    # --- Personal Info ---
    lines = ["# Candidate Profile", "", "## Personal Info"]
    lines.append(f"- Name: {personal.get('name', '[Your Full Name]')}")
    lines.append(f"- Email: {personal.get('email', '[your.email@example.com]')}")
    lines.append(f"- Phone: {personal.get('phone', '[+44 7700 000000]')}")
    lines.append(f"- Location: {personal.get('location', '[City, Country]')}")

    linkedin = personal.get("linkedin", "")
    lines.append(f"- LinkedIn: {linkedin if linkedin else '[https://linkedin.com/in/yourprofile]'}")

    github = personal.get("github_portfolio", "")
    lines.append(f"- GitHub/Portfolio: {github if github else '[https://github.com/yourusername]'}")

    # --- Target Roles ---
    lines += ["", "## Target Roles"]
    lines.append(f"- Job titles I'm targeting: {target.get('job_titles', '[e.g. Senior Backend Engineer]')}")
    lines.append(f"- Industries preferred: {target.get('industries', '[e.g. Fintech, SaaS, AI/ML]')}")
    lines.append(f"- Work arrangement: {target.get('work_arrangement', 'Hybrid')}")
    lines.append(f"- Seniority level: {target.get('seniority_level', '[Mid / Senior / Lead]')}")
    lines.append(f"- Salary expectations: {target.get('salary_expectations', '[e.g. £70,000–£90,000]')}")
    lines.append(f"- Notice period / Availability: {target.get('availability', '[e.g. 2 weeks]')}")
    lines.append(f"- Open to relocation: {target.get('open_to_relocation', '[Yes / No]')}")
    lines.append(f"- Right to work: {target.get('right_to_work', '[e.g. UK citizen, no sponsorship required]')}")

    # --- CV Summary ---
    cv_summary = data.get("cv_summary", "")
    lines += ["", "## CV Summary"]
    lines.append(cv_summary if cv_summary else "[Write your 2–3 sentence professional summary here]")

    # --- Work Experience ---
    lines += ["", "## Work Experience"]
    if work_exp:
        for role in work_exp:
            title = role.get("title", "")
            company = role.get("company", "")
            period = role.get("period", "")
            header = f"### {title} — {company}"
            if period:
                header += f" ({period})"
            lines.append(header)
            for achievement in role.get("achievements", []):
                if achievement.strip():
                    lines.append(f"- {achievement.strip()}")
            lines.append("")
    else:
        lines += [
            "### [Job Title] — [Company Name] ([Start] – [End])",
            "- [Achievement]",
            "",
        ]

    # --- Education ---
    lines.append("## Education")
    lines.append("")
    if education:
        for edu in education:
            degree = edu.get("degree", "")
            institution = edu.get("institution", "")
            year = edu.get("year", "")
            header = f"### {degree} — {institution}"
            if year:
                header += f" ({year})"
            lines.append(header)
            notes = edu.get("notes", "")
            if notes:
                lines.append(f"- {notes}")
            lines.append("")
    else:
        lines += [
            "### [Degree] — [Institution] ([Year])",
            "",
        ]

    # --- Skills ---
    lines.append("## Skills")
    lines.append("")

    def skill_line(label, value, placeholder):
        return f"- **{label}:** {value if value else placeholder}"

    lines.append(skill_line("Languages", skills.get("languages"), "[e.g. Python, TypeScript, Go]"))
    lines.append(skill_line("Frameworks", skills.get("frameworks"), "[e.g. FastAPI, Django, React]"))
    lines.append(skill_line("Databases", skills.get("databases"), "[e.g. PostgreSQL, MongoDB, Redis]"))
    lines.append(skill_line("Infrastructure", skills.get("infrastructure"), "[e.g. AWS, Docker, Kubernetes]"))
    lines.append(skill_line("Tools", skills.get("tools"), "[e.g. GitHub Actions, Datadog, Kafka]"))
    lines.append(skill_line("Other", skills.get("other"), "[e.g. REST APIs, GraphQL, Agile]"))

    # --- Achievements ---
    lines += ["", "## Achievements & Highlights"]
    if achievements:
        for a in achievements:
            if a.strip():
                lines.append(f"- {a.strip()}")
    else:
        lines.append("- [e.g. Open source contribution, speaker, promotion, side project]")

    # --- Career Goals ---
    career_goals = data.get("career_goals", "")
    lines += ["", "## Career Goals"]
    lines.append(career_goals if career_goals else "[1–2 sentences on where you want to go in your career]")
    lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_cv(cv_path: Path, output_path: Path) -> dict:
    """
    Parse a CV file and write a populated candidate_profile.md.
    Returns the parsed data dict.
    """
    # Extract text
    logger.info(f"Extracting text from: {cv_path.name}")
    cv_text = extract_text(cv_path)

    # Save raw text to .tmp for inspection
    raw_path = TMP_DIR / "cv_raw_text.txt"
    raw_path.write_text(cv_text)
    logger.info(f"Raw text saved to {raw_path}")

    # Parse with AI
    parsed = parse_cv_with_ai(cv_text)

    # Save parsed JSON for inspection
    parsed_path = TMP_DIR / "cv_parsed.json"
    with open(parsed_path, "w") as f:
        json.dump(parsed, f, indent=2)
    logger.info(f"Parsed data saved to {parsed_path}")

    # Back up existing profile
    if output_path.exists():
        backup_path = TMP_DIR / f"candidate_profile_backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.md"
        shutil.copy(output_path, backup_path)
        logger.info(f"Existing profile backed up to {backup_path}")

    # Write new profile
    profile_markdown = build_profile_markdown(parsed)
    output_path.write_text(profile_markdown)
    logger.info(f"Profile written to {output_path}")

    return parsed


def main():
    parser = argparse.ArgumentParser(description="Parse a CV file and fill candidate_profile.md")
    parser.add_argument("--cv-path", required=True, help="Path to CV file (.pdf, .docx, or .txt)")
    parser.add_argument("--output", default=os.getenv("CANDIDATE_PROFILE_PATH", "./candidate_profile.md"),
                        help="Output path for candidate_profile.md")
    args = parser.parse_args()

    cv_path = Path(args.cv_path)
    if not cv_path.exists():
        print(f"ERROR: CV file not found at {cv_path}")
        sys.exit(1)

    output_path = Path(args.output)

    print(f"\nParsing CV: {cv_path.name}")
    print(f"Output: {output_path}")
    print("-" * 50)

    try:
        parsed = parse_cv(cv_path, output_path)

        name = parsed.get("personal", {}).get("name", "")
        email = parsed.get("personal", {}).get("email", "")
        roles_count = len(parsed.get("work_experience", []))

        print(f"\n✓ Profile generated successfully!")
        print(f"  Name:       {name or '(not found)'}")
        print(f"  Email:      {email or '(not found)'}")
        print(f"  Roles:      {roles_count} work experiences extracted")
        print(f"\nNext steps:")
        print(f"  1. Review {output_path} and fill in any remaining placeholders")
        print(f"     (especially: target roles, salary, availability, career goals)")
        print(f"  2. Run: python tools/run_pipeline.py --dry-run")
        print(f"\nBackup saved to: .tmp/candidate_profile_backup_*.md")

    except RuntimeError as e:
        print(f"\nERROR: {e}")
        print("\nInstall required packages:")
        print("  pip install pdfplumber python-docx")
        sys.exit(1)
    except Exception as e:
        print(f"\nERROR: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
