"""
send_application_report.py — Send application run report via Gmail with attachments.

Reads the latest application_report_*.json from .tmp/, builds an HTML email
with a full job table, and attaches every tailored CV (DOCX + PDF) and
cover letter mentioned in the report.

Usage:
    python tools/send_application_report.py
    python tools/send_application_report.py --report .tmp/application_report_20260412_154024.json
"""

import os
import sys
import re
import json
import smtplib
import logging
import argparse
import mimetypes
from pathlib import Path
from datetime import date
from email.mime.multipart import MIMEMultipart
from email.mime.text   import MIMEText
from email.mime.base   import MIMEBase
from email              import encoders

from dotenv import load_dotenv
load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s [send_report] %(message)s")
logger = logging.getLogger(__name__)

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 587

STATUS_ICON  = {"submitted": "✅", "needs_review": "⚠️", "failed": "❌", "timeout": "⏱️", "error": "❌", "dry_run": "⭕"}
STATUS_COLOR = {"submitted": "#16a34a", "needs_review": "#d97706", "failed": "#dc2626", "timeout": "#7c3aed", "error": "#dc2626", "dry_run": "#6b7280"}


def _build_html(report: dict) -> str:
    jobs   = report.get("jobs", [])
    run_id = report.get("run_id", "")
    subject_prefix = os.getenv("EMAIL_SUBJECT_PREFIX", "Job Application")
    base_cv_name   = Path(os.getenv("CV_PATH", "cv.docx")).name

    counts = {}
    for j in jobs:
        counts[j["status"]] = counts.get(j["status"], 0) + 1

    submitted   = counts.get("submitted",    0)
    needs_review = counts.get("needs_review", 0)
    failed      = counts.get("failed", 0) + counts.get("timeout", 0) + counts.get("error", 0)

    # Summary cards
    cards = f"""
    <div style="display:flex;gap:12px;margin:20px 0;flex-wrap:wrap;">
      <div style="background:#eff6ff;padding:14px 22px;border-radius:8px;text-align:center;min-width:90px;">
        <div style="font-size:26px;font-weight:700;color:#1d4ed8;">{len(jobs)}</div>
        <div style="color:#6b7280;font-size:12px;">Qualifying Jobs</div>
      </div>
      <div style="background:#f0fdf4;padding:14px 22px;border-radius:8px;text-align:center;min-width:90px;">
        <div style="font-size:26px;font-weight:700;color:#16a34a;">{submitted}</div>
        <div style="color:#6b7280;font-size:12px;">Auto-Submitted</div>
      </div>
      <div style="background:#fffbeb;padding:14px 22px;border-radius:8px;text-align:center;min-width:90px;">
        <div style="font-size:26px;font-weight:700;color:#d97706;">{needs_review}</div>
        <div style="color:#6b7280;font-size:12px;">Needs Manual Apply</div>
      </div>
      <div style="background:#fef2f2;padding:14px 22px;border-radius:8px;text-align:center;min-width:90px;">
        <div style="font-size:26px;font-weight:700;color:#dc2626;">{failed}</div>
        <div style="color:#6b7280;font-size:12px;">Failed / Timeout</div>
      </div>
    </div>"""

    # Job rows
    rows = ""
    for j in jobs:
        status     = j.get("status", "")
        icon       = STATUS_ICON.get(status, "?")
        color      = STATUS_COLOR.get(status, "#6b7280")
        cv_docx    = Path(j["cv_docx"]).name  if j.get("cv_docx")            else "—"
        cv_pdf     = Path(j["cv_pdf"]).name   if j.get("cv_pdf")             else "—"
        cl         = Path(j["cover_letter_path"]).name if j.get("cover_letter_path") else "—"
        job_url    = j.get("url", "#")
        title_link = f'<a href="{job_url}" style="color:#1d4ed8;text-decoration:none;">{j.get("title","")}</a>'
        notes      = j.get("notes", "").replace("Apply manually at URL above.", "").strip()
        note_cell  = f'<span style="color:#6b7280;font-size:11px;">{notes[:80]}</span>' if notes else ""

        rows += f"""
        <tr>
          <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top;">{title_link}</td>
          <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top;">{j.get("company","")}</td>
          <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;text-align:center;vertical-align:top;">
            <strong style="color:#1d4ed8;">{j.get("score","")}/10</strong>
          </td>
          <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;text-align:center;vertical-align:top;">
            <span style="color:{color};font-weight:600;">{icon} {status.replace("_"," ").title()}</span>
            {note_cell}
          </td>
          <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;font-family:monospace;font-size:11px;vertical-align:top;color:#374151;">
            📄 {cv_docx}<br>
            🖨 {cv_pdf}
          </td>
          <td style="padding:10px 8px;border-bottom:1px solid #e5e7eb;font-family:monospace;font-size:11px;vertical-align:top;color:#374151;">
            ✉️ {cl}
          </td>
        </tr>"""

    # Manual review block
    manual_jobs = [j for j in jobs if j["status"] == "needs_review"]
    manual_block = ""
    if manual_jobs:
        manual_rows = ""
        for j in manual_jobs:
            manual_rows += f"""
            <tr>
              <td style="padding:8px;border-bottom:1px solid #fde68a;">
                <strong>{j.get("title","")}</strong><br>
                <span style="color:#6b7280;font-size:12px;">{j.get("company","")}</span>
              </td>
              <td style="padding:8px;border-bottom:1px solid #fde68a;font-size:12px;">
                <a href="{j.get('url','#')}" style="color:#1d4ed8;">{j.get('url','')[:60]}...</a>
              </td>
              <td style="padding:8px;border-bottom:1px solid #fde68a;font-family:monospace;font-size:11px;">
                {Path(j['cv_docx']).name if j.get('cv_docx') else '—'}<br>
                {Path(j['cv_pdf']).name  if j.get('cv_pdf')  else '—'}
              </td>
            </tr>"""

        manual_block = f"""
        <div style="margin-top:28px;padding:20px;background:#fffbeb;border-radius:8px;border-left:4px solid #f59e0b;">
          <h3 style="margin:0 0 12px 0;color:#92400e;">⚠️ Apply These Manually ({len(manual_jobs)} jobs)</h3>
          <p style="margin:0 0 12px 0;font-size:13px;color:#78350f;">
            Tailored CV + cover letter already prepared and attached. Open each link and upload the matching file.
          </p>
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr style="background:#fef3c7;">
                <th style="padding:8px;text-align:left;font-size:12px;">Job</th>
                <th style="padding:8px;text-align:left;font-size:12px;">Apply URL</th>
                <th style="padding:8px;text-align:left;font-size:12px;">CV Files</th>
              </tr>
            </thead>
            <tbody>{manual_rows}</tbody>
          </table>
        </div>"""

    return f"""<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;max-width:900px;margin:0 auto;padding:24px;color:#1f2937;">

  <h2 style="color:#1d4ed8;margin-bottom:4px;">
    {subject_prefix} — Application Run Report
  </h2>
  <p style="color:#6b7280;margin-top:0;font-size:13px;">
    Run ID: {run_id} &nbsp;·&nbsp;
    Keywords: {report.get("keywords","")} &nbsp;·&nbsp;
    Location: {report.get("location","")} &nbsp;·&nbsp;
    Threshold: {report.get("threshold",7)}/10
  </p>

  {cards}

  <p style="font-size:13px;color:#374151;margin:0 0 16px 0;">
    Every application below used a <strong>unique, job-tailored CV</strong> with a rewritten
    Professional Summary aligned to the specific role. The base CV
    (<em>{base_cv_name}</em>) was never submitted directly.
    All tailored files are attached to this email.
  </p>

  <table style="width:100%;border-collapse:collapse;font-size:13px;">
    <thead>
      <tr style="background:#f3f4f6;">
        <th style="padding:10px 8px;text-align:left;">Job Title</th>
        <th style="padding:10px 8px;text-align:left;">Company</th>
        <th style="padding:10px 8px;text-align:center;">Score</th>
        <th style="padding:10px 8px;text-align:center;">Status</th>
        <th style="padding:10px 8px;text-align:left;">CV Files</th>
        <th style="padding:10px 8px;text-align:left;">Cover Letter</th>
      </tr>
    </thead>
    <tbody>
      {rows}
    </tbody>
  </table>

  {manual_block}

  <p style="margin-top:32px;color:#9ca3af;font-size:11px;border-top:1px solid #e5e7eb;padding-top:16px;">
    AI Job Application System · Generated {date.today().isoformat()} ·
    {sum(1 for j in jobs if j.get("cv_docx"))} tailored CVs attached ·
    {sum(1 for j in jobs if j.get("cover_letter_path"))} cover letters attached
  </p>

</body>
</html>"""


def _build_plain(report: dict) -> str:
    jobs = report.get("jobs", [])
    lines = [
        f"MLRO / AML Application Report — {report.get('run_id','')}",
        f"Keywords: {report.get('keywords','')} | Location: {report.get('location','')}",
        f"Qualifying jobs: {len(jobs)}",
        "",
        f"{'TITLE':<50} {'COMPANY':<28} {'SCORE':>6}  STATUS",
        "-" * 100,
    ]
    for j in jobs:
        icon = {"submitted":"✓","needs_review":"⚠","failed":"✗","timeout":"⏱"}.get(j["status"],"?")
        lines.append(f"{icon} {j.get('title','')[:48]:<50} {j.get('company','')[:26]:<28} {j.get('score',0):>5}/10  {j['status']}")
        lines.append(f"  CV:  {Path(j['cv_docx']).name if j.get('cv_docx') else 'N/A'}")
        lines.append(f"  PDF: {Path(j['cv_pdf']).name  if j.get('cv_pdf')  else 'N/A'}")
        lines.append(f"  CL:  {Path(j['cover_letter_path']).name if j.get('cover_letter_path') else 'N/A'}")
        lines.append("")

    manual = [j for j in jobs if j["status"] == "needs_review"]
    if manual:
        lines.append("\n--- APPLY MANUALLY (CV + cover letter attached) ---")
        for j in manual:
            lines.append(f"  {j.get('title','')} @ {j.get('company','')}")
            lines.append(f"  URL: {j.get('url','')}")
            lines.append("")
    return "\n".join(lines)


def _friendly_name(filepath: str, job: dict = None) -> str:
    """
    Convert a raw tmp filename into a human-readable attachment name.
    Reads CANDIDATE_FIRST_NAME / CANDIDATE_LAST_NAME from env so it works for any user.
    e.g. cv_apex_group_compliance.docx → Smith_Alice_CV_Apex_Group_Compliance_Officer.docx
    """
    p = Path(filepath)
    first = re.sub(r"[^\w]", "_", os.getenv("CANDIDATE_FIRST_NAME", "Candidate")).strip("_")
    last  = re.sub(r"[^\w]", "_", os.getenv("CANDIDATE_LAST_NAME",  "")).strip("_")
    name_prefix = f"{last}_{first}" if last else first

    if job:
        company = re.sub(r"[^\w\s]", "", job.get("company", "")).strip().replace(" ", "_")[:25]
        title   = re.sub(r"[^\w\s]", "", job.get("title",   "")).strip().replace(" ", "_")[:25]
        if p.suffix in (".docx",):
            return f"{name_prefix}_CV_{company}_{title}{p.suffix}"
        if p.suffix in (".pdf",) and p.stem.startswith("cv_"):
            return f"{name_prefix}_CV_{company}_{title}{p.suffix}"
        if p.suffix in (".pdf", ".txt") and p.stem.startswith("cl_"):
            return f"{name_prefix}_CoverLetter_{company}_{title}.pdf"
    return p.name


def attach_file(msg: MIMEMultipart, filepath: str, display_name: str = None):
    """Attach a single file to the email message."""
    p = Path(filepath)
    if not p.exists():
        logger.warning(f"Attachment not found: {filepath}")
        return

    mime_type, _ = mimetypes.guess_type(str(p))
    if not mime_type:
        if p.suffix == ".docx":
            mime_type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        elif p.suffix == ".pdf":
            mime_type = "application/pdf"
        elif p.suffix == ".txt":
            mime_type = "application/pdf"   # cover letters sent as PDF
        else:
            mime_type = "application/octet-stream"

    # For .txt cover letters we convert to a minimal PDF first so it opens everywhere
    if p.suffix == ".txt":
        pdf_bytes = _txt_to_pdf_bytes(p.read_text(encoding="utf-8", errors="replace"))
        data = pdf_bytes
        mime_type = "application/pdf"
    else:
        with open(str(p), "rb") as f:
            data = f.read()

    maintype, subtype = mime_type.split("/", 1)

    fname = display_name or p.name
    part = MIMEBase(maintype, subtype)
    part.set_payload(data)
    encoders.encode_base64(part)
    part.add_header("Content-Disposition", "attachment", filename=fname)
    part.add_header("Content-Type", mime_type, name=fname)
    msg.attach(part)
    logger.info(f"  Attached: {fname} ({len(data) // 1024}KB)")


def _txt_to_pdf_bytes(text: str) -> bytes:
    """Convert a plain-text cover letter to a simple PDF (bytes)."""
    from fpdf import FPDF
    from fpdf.enums import XPos, YPos
    import io

    def _safe(t):
        replacements = {"\u2013":"-","\u2014":"-","\u2018":"'","\u2019":"'",
                        "\u201c":'"',"\u201d":'"',"\u2022":"*","\u2026":"...","\u00a0":" "}
        for s, d in replacements.items():
            t = t.replace(s, d)
        return t.encode("latin-1", errors="replace").decode("latin-1")

    pdf = FPDF()
    pdf.add_page()
    pdf.set_margins(20, 20, 20)
    pdf.set_auto_page_break(auto=True, margin=20)
    pdf.set_font("Helvetica", "", 10)
    for line in text.splitlines():
        line = _safe(line)
        if line.strip():
            pdf.multi_cell(0, 5.5, line)
        else:
            pdf.ln(3)
    return pdf.output()


def send_report(report: dict) -> dict:
    smtp_email    = os.getenv("SMTP_EMAIL", "")
    smtp_password = os.getenv("SMTP_PASSWORD", "")
    smtp_to       = os.getenv("SMTP_TO", smtp_email)

    if not smtp_email or not smtp_password:
        return {"success": False, "error": "SMTP_EMAIL or SMTP_PASSWORD not set in .env"}

    jobs = report.get("jobs", [])

    # Build message
    msg = MIMEMultipart("mixed")
    subject_prefix = os.getenv("EMAIL_SUBJECT_PREFIX", "Job Application")
    msg["Subject"] = f"{subject_prefix} — Application Run Report — {date.today().isoformat()}"
    msg["From"]    = smtp_email
    msg["To"]      = smtp_to

    # Body (plain + HTML alternative)
    body_part = MIMEMultipart("alternative")
    body_part.attach(MIMEText(_build_plain(report), "plain", "utf-8"))
    body_part.attach(MIMEText(_build_html(report),  "html",  "utf-8"))
    msg.attach(body_part)

    # Attachments: CV DOCX, CV PDF, cover letter — one set per job
    attached = set()
    for j in jobs:
        for field in ("cv_docx", "cv_pdf", "cover_letter_path"):
            fpath = j.get(field)
            if fpath and fpath not in attached:
                friendly = _friendly_name(fpath, j)
                attach_file(msg, fpath, display_name=friendly)
                attached.add(fpath)

    logger.info(f"Total attachments: {len(attached)}")

    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
            server.ehlo()
            server.starttls()
            server.login(smtp_email, smtp_password)
            server.send_message(msg)    # safer than sendmail(msg.as_string())

        logger.info(f"Report sent to {smtp_to}")
        return {"success": True, "attachments": len(attached), "to": smtp_to}

    except Exception as e:
        logger.error(f"Send failed: {e}")
        return {"success": False, "error": str(e)}


def send_daily_digest(user_id: int, db_path: str, smtp_email: str, smtp_password: str,
                      smtp_to: str, first_name: str = "", last_name: str = "") -> dict:
    """Collect all completed runs for today, merge into one email, and send."""
    import sqlite3
    from datetime import timezone

    if not smtp_email or not smtp_password:
        return {"success": False, "error": "No SMTP credentials"}

    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT run_id, report_json, specialty_id FROM runs "
            "WHERE user_id=? AND status='completed' AND date(started_at)=date('now') "
            "AND report_json IS NOT NULL ORDER BY id",
            (user_id,)
        ).fetchall()
        conn.close()
    except Exception as e:
        return {"success": False, "error": f"DB error: {e}"}

    if not rows:
        logger.info("No completed runs today — skipping daily digest")
        return {"success": False, "error": "No runs to report"}

    # Merge all runs into one combined report
    all_jobs = []
    run_ids  = []
    for row in rows:
        try:
            r = json.loads(row["report_json"])
            jobs = r.get("jobs", [])
            spec_label = f" (specialty {row['specialty_id']})" if row["specialty_id"] else ""
            for j in jobs:
                j.setdefault("_run_id", row["run_id"] + spec_label)
            all_jobs.extend(jobs)
            run_ids.append(row["run_id"])
        except Exception:
            pass

    combined = {
        "run_id": f"Daily digest — {date.today().isoformat()} ({len(run_ids)} runs)",
        "keywords": "",
        "location": "",
        "threshold": 0,
        "jobs": all_jobs,
    }

    # Temporarily set env vars for attachment naming
    os.environ["CANDIDATE_FIRST_NAME"] = first_name
    os.environ["CANDIDATE_LAST_NAME"]  = last_name
    os.environ["SMTP_EMAIL"]    = smtp_email
    os.environ["SMTP_PASSWORD"] = smtp_password
    os.environ["SMTP_TO"]       = smtp_to

    subject_prefix = os.getenv("EMAIL_SUBJECT_PREFIX", "Job Application")
    counts = {}
    for j in all_jobs:
        counts[j.get("status", "")] = counts.get(j.get("status", ""), 0) + 1
    submitted    = counts.get("submitted", 0)
    needs_review = counts.get("needs_review", 0)
    failed       = counts.get("failed", 0) + counts.get("timeout", 0) + counts.get("error", 0)

    msg = MIMEMultipart("mixed")
    msg["Subject"] = (f"{subject_prefix} — Daily Digest {date.today().isoformat()} "
                      f"— {submitted} submitted, {needs_review} to review")
    msg["From"] = smtp_email
    msg["To"]   = smtp_to

    body_part = MIMEMultipart("alternative")
    body_part.attach(MIMEText(_build_plain(combined), "plain", "utf-8"))
    body_part.attach(MIMEText(_build_html(combined),  "html",  "utf-8"))
    msg.attach(body_part)

    # Attach all CV/cover letter files
    attached = set()
    for j in all_jobs:
        for key in ("cv_docx", "cv_pdf", "cover_letter_path"):
            fp = j.get(key, "")
            if fp and fp not in attached:
                attach_file(msg, fp, _friendly_name(fp, j))
                attached.add(fp)

    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
            server.starttls()
            server.login(smtp_email, smtp_password)
            server.sendmail(smtp_email, smtp_to, msg.as_string())
        logger.info(f"Daily digest sent to {smtp_to} — {len(all_jobs)} jobs across {len(run_ids)} runs")
        return {"success": True, "to": smtp_to, "runs": len(run_ids), "jobs": len(all_jobs)}
    except Exception as e:
        logger.error(f"Daily digest send failed: {e}")
        return {"success": False, "error": str(e)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", default=None, help="Path to application_report_*.json")
    args = parser.parse_args()

    # Find report file
    if args.report:
        report_path = Path(args.report)
    else:
        reports = sorted(Path(".tmp").glob("application_report_*.json"), reverse=True)
        if not reports:
            print("No application report found in .tmp/. Run run_applications.py first.")
            sys.exit(1)
        report_path = reports[0]

    logger.info(f"Loading report: {report_path}")
    report = json.loads(report_path.read_text())

    result = send_report(report)
    if result["success"]:
        print(f"✓ Email sent to {result['to']} with {result['attachments']} attachments")
    else:
        print(f"✗ Failed: {result['error']}")
        sys.exit(1)


if __name__ == "__main__":
    main()
