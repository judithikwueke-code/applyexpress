"""
send_notification.py — Daily pipeline digest via Gmail SMTP.

Sends an HTML email summarising what the pipeline found and applied to.

Setup:
  - SMTP_EMAIL: your Gmail address
  - SMTP_PASSWORD: Gmail App Password (not your account password)
    Enable 2FA → Google Account → Security → App Passwords → Mail
  - SMTP_TO: recipient email (can be the same as SMTP_EMAIL)

Import:
    from tools.send_notification import send_notification
    send_notification(summary_dict)

Standalone test:
    python tools/send_notification.py --test
"""

import os
import sys
import json
import smtplib
import logging
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from datetime import date
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s [send_notification] %(message)s")
logger = logging.getLogger(__name__)

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 587


def _build_html(summary: dict) -> str:
    jobs = summary.get("jobs", [])
    errors = summary.get("errors", [])

    job_rows = ""
    for j in jobs:
        decision_color = {"yes": "#22c55e", "maybe": "#f59e0b", "no": "#ef4444"}.get(
            j.get("apply_decision", "no"), "#6b7280"
        )
        job_rows += f"""
        <tr>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;">{j.get('title','')}</td>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;">{j.get('company','')}</td>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:center;">
            <strong style="color:{decision_color};">{j.get('score','')}/10</strong>
          </td>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:center;">
            <span style="color:{decision_color};font-weight:bold;">{j.get('apply_decision','').upper()}</span>
          </td>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;">
            {j.get('status','Pending Review')}
          </td>
        </tr>"""

    error_block = ""
    if errors:
        error_list = "".join(f"<li>{e}</li>" for e in errors)
        error_block = f"""
        <div style="margin-top:24px;padding:16px;background:#fef2f2;border-radius:8px;border-left:4px solid #ef4444;">
          <strong>Errors ({len(errors)}):</strong>
          <ul style="margin:8px 0 0 0;">{error_list}</ul>
        </div>"""

    return f"""<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;padding:24px;color:#1f2937;">
  <h2 style="color:#1d4ed8;margin-bottom:4px;">Job Pipeline Report</h2>
  <p style="color:#6b7280;margin-top:0;">{summary.get('date', date.today().isoformat())}</p>

  <div style="display:flex;gap:16px;margin:20px 0;">
    <div style="background:#eff6ff;padding:16px 24px;border-radius:8px;text-align:center;">
      <div style="font-size:28px;font-weight:bold;color:#1d4ed8;">{summary.get('total_fetched',0)}</div>
      <div style="color:#6b7280;font-size:13px;">Jobs Fetched</div>
    </div>
    <div style="background:#f0fdf4;padding:16px 24px;border-radius:8px;text-align:center;">
      <div style="font-size:28px;font-weight:bold;color:#16a34a;">{summary.get('qualifying_jobs',0)}</div>
      <div style="color:#6b7280;font-size:13px;">Qualifying (≥{summary.get('threshold',7)})</div>
    </div>
    <div style="background:#fefce8;padding:16px 24px;border-radius:8px;text-align:center;">
      <div style="font-size:28px;font-weight:bold;color:#ca8a04;">{summary.get('applied',0)}</div>
      <div style="color:#6b7280;font-size:13px;">Applied</div>
    </div>
    <div style="background:#fff7ed;padding:16px 24px;border-radius:8px;text-align:center;">
      <div style="font-size:28px;font-weight:bold;color:#ea580c;">{summary.get('escalated',0)}</div>
      <div style="color:#6b7280;font-size:13px;">Need Review</div>
    </div>
  </div>

  {'<table style="width:100%;border-collapse:collapse;margin-top:16px;"><thead><tr style="background:#f3f4f6;"><th style="padding:10px 8px;text-align:left;">Job Title</th><th style="padding:10px 8px;text-align:left;">Company</th><th style="padding:10px 8px;text-align:center;">Score</th><th style="padding:10px 8px;text-align:center;">Decision</th><th style="padding:10px 8px;text-align:left;">Status</th></tr></thead><tbody>' + job_rows + '</tbody></table>' if jobs else '<p style="color:#6b7280;">No qualifying jobs found today.</p>'}

  {error_block}

  <p style="margin-top:32px;color:#9ca3af;font-size:12px;">
    AI Job Application System · {summary.get('runtime_seconds', 0)}s runtime ·
    Check your Google Sheet for full details.
  </p>
</body>
</html>"""


def _build_plain(summary: dict) -> str:
    jobs = summary.get("jobs", [])
    lines = [
        f"Job Pipeline Report — {summary.get('date', date.today().isoformat())}",
        f"Fetched: {summary.get('total_fetched', 0)} | Qualifying: {summary.get('qualifying_jobs', 0)} | Applied: {summary.get('applied', 0)} | Need Review: {summary.get('escalated', 0)}",
        "",
    ]
    for j in jobs:
        lines.append(f"[{j.get('score', 0)}/10 {j.get('apply_decision','').upper()}] {j.get('title','')} @ {j.get('company','')} — {j.get('status','')}")
    if summary.get("errors"):
        lines.append(f"\nErrors: {len(summary['errors'])}")
        for e in summary["errors"]:
            lines.append(f"  - {e}")
    return "\n".join(lines)


def send_notification(summary: dict) -> dict:
    """
    Send an HTML email digest of the pipeline run.
    Returns {"success": True} or {"success": False, "error": str}
    """
    smtp_email = os.getenv("SMTP_EMAIL", "")
    smtp_password = os.getenv("SMTP_PASSWORD", "")
    smtp_to = os.getenv("SMTP_TO", smtp_email)

    if not smtp_email or not smtp_password:
        logger.warning("SMTP_EMAIL or SMTP_PASSWORD not set — skipping email notification")
        return {"success": False, "error": "SMTP credentials not configured"}

    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = f"Job Pipeline: {summary.get('qualifying_jobs', 0)} qualifying jobs — {summary.get('date', date.today().isoformat())}"
        msg["From"] = smtp_email
        msg["To"] = smtp_to

        msg.attach(MIMEText(_build_plain(summary), "plain"))
        msg.attach(MIMEText(_build_html(summary), "html"))

        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
            server.starttls()
            server.login(smtp_email, smtp_password)
            server.sendmail(smtp_email, smtp_to, msg.as_string())

        logger.info(f"Notification sent to {smtp_to}")
        return {"success": True}

    except Exception as e:
        logger.error(f"send_notification failed: {e}")
        return {"success": False, "error": str(e)}


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Send pipeline notification email")
    parser.add_argument("--test", action="store_true", help="Send a test email")
    args = parser.parse_args()

    if args.test:
        test_summary = {
            "date": date.today().isoformat(),
            "total_fetched": 42,
            "qualifying_jobs": 5,
            "applied": 3,
            "escalated": 2,
            "threshold": 7,
            "runtime_seconds": 87,
            "errors": [],
            "jobs": [
                {"title": "Senior Python Engineer", "company": "Acme Corp", "score": 9, "apply_decision": "yes", "status": "Applied"},
                {"title": "Staff Engineer", "company": "Beta Ltd", "score": 8, "apply_decision": "yes", "status": "Applied"},
                {"title": "Data Engineer", "company": "Gamma Inc", "score": 7, "apply_decision": "maybe", "status": "Needs Review"},
            ],
        }
        print("Sending test email...")
        result = send_notification(test_summary)
        print(json.dumps(result, indent=2))
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
