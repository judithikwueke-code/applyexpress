#!/usr/bin/env python3
"""session_alert.py — daily email when a user's job-board sessions are stale.

LinkedIn/Indeed sessions cannot be refreshed server-side (extension only):
alert when the session file is >5 days old. Reed is auto-refreshed every 3h
(refresh_reed_sessions.py): alert only if still dead after the last attempt.
Run once a day at 18:00 UTC. Emails each user at their own account address.
"""
import os, sys, time, sqlite3, smtplib, logging
from email.mime.text import MIMEText
from pathlib import Path

ROOT = Path("/opt/applyexpress")
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(ROOT / "tools"))
os.chdir(str(ROOT))
from dotenv import load_dotenv
load_dotenv(ROOT / ".env")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [session-alert] %(message)s")
log = logging.getLogger(__name__)

from refresh_reed_sessions import _session_hours_left  # noqa: E402

MAX_AGE_DAYS = 5


def stale_boards(uid: int) -> list:
    sdir = ROOT / "data" / "users" / str(uid) / "sessions"
    out = []
    for board in ("linkedin", "indeed"):
        f = sdir / f"{board}.json"
        if f.exists():
            age = (time.time() - f.stat().st_mtime) / 86400
            if age > MAX_AGE_DAYS:
                out.append(f"{board.title()} (uploaded {age:.0f} days ago)")
    if (sdir / "reed.json").exists() and _session_hours_left(uid) <= 0:
        out.append("Reed (expired; automatic refresh was blocked by Reed)")
    return out


def send(to: str, boards: list):
    smtp_email, pwd = os.getenv("SMTP_EMAIL", ""), os.getenv("SMTP_PASSWORD", "")
    if not (smtp_email and pwd):
        log.warning("SMTP not configured; cannot email %s", to)
        return
    body = ("Some of your job-board sessions have expired, so ApplyExpress cannot submit "
            "applications there:\n\n  - " + "\n  - ".join(boards) +
            "\n\nFix: open the board in desktop Chrome while logged in, then click the "
            "ApplyExpress extension to re-sync your session. Takes about a minute.\n")
    msg = MIMEText(body)
    msg["Subject"] = "ApplyExpress: job-board sessions need re-syncing"
    msg["From"] = smtp_email
    msg["To"] = to
    with smtplib.SMTP("smtp.gmail.com", 587) as s:
        s.starttls()
        s.login(smtp_email, pwd)
        s.sendmail(smtp_email, [to], msg.as_string())
    log.info("alert sent to %s: %s", to, boards)


def main():
    db = sqlite3.connect(str(ROOT / "data" / "autoapply.db"))
    db.row_factory = sqlite3.Row
    users = db.execute(
        "SELECT id, email FROM users WHERE keywords != '' AND "
        "(is_paid = 1 OR (trial_ends_at != '' AND trial_ends_at > datetime('now')))"
    ).fetchall()
    for u in users:
        if not (ROOT / "data" / "users" / str(u["id"]) / "cv.docx").exists():
            continue
        b = stale_boards(u["id"])
        log.info("user %s stale: %s", u["id"], b or "none")
        if b:
            try:
                send(u["email"], b)
            except Exception as e:
                log.error("send failed for user %s: %s", u["id"], e)


if __name__ == "__main__":
    main()
