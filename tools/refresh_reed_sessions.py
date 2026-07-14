#!/usr/bin/env python3
"""refresh_reed_sessions.py — daily server-side Reed re-login for every user.

Reed session cookies only survive a few days; once they lapse, every Reed
apply fails with "Session cookies expired" until someone notices. Cron runs
this before the first pipeline of the day (05:30 UTC), re-logging each user
in with their stored credentials and rewriting
data/users/<id>/sessions/reed.json.

Exit codes from reed_login_once.js: 0 = refreshed, 3 = CAPTCHA (needs the
browser extension), anything else = failed.
"""
import os
import sys
import sqlite3
import subprocess
import logging
from pathlib import Path

ROOT = Path("/opt/applyexpress")
sys.path.insert(0, str(ROOT))
os.chdir(str(ROOT))

from dotenv import load_dotenv
load_dotenv(ROOT / ".env")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [reed-refresh] %(message)s")
log = logging.getLogger(__name__)


def _dec(ciphertext: str) -> str:
    if not ciphertext:
        return ""
    try:
        from cryptography.fernet import Fernet
        key = os.getenv("CREDENTIAL_KEY", "").encode()
        if not key or not ciphertext.startswith("gAAAAA"):
            return ciphertext
        return Fernet(key).decrypt(ciphertext.encode()).decode()
    except Exception:
        return ""


def main():
    db = sqlite3.connect(str(ROOT / "data" / "autoapply.db"))
    db.row_factory = sqlite3.Row
    users = db.execute(
        """SELECT id, email, reed_email, reed_pass FROM users
           WHERE reed_pass != ''
             AND (is_paid = 1 OR (trial_ends_at != '' AND trial_ends_at > datetime('now')))"""
    ).fetchall()
    db.close()

    failures = 0
    for u in users:
        uid = u["id"]
        email = u["reed_email"] or u["email"]
        password = _dec(u["reed_pass"])
        if not password:
            log.warning(f"user {uid}: could not decrypt Reed password — skipping")
            continue

        tmp_dir = ROOT / "data" / "users" / str(uid) / ".tmp"
        tmp_dir.mkdir(parents=True, exist_ok=True)
        env = os.environ.copy()
        env.update({"TMP_DIR": str(tmp_dir), "REED_EMAIL": email, "REED_PASSWORD": password})

        log.info(f"user {uid}: refreshing Reed session ({email})")
        try:
            r = subprocess.run(
                ["node", "tools/reed_login_once.js"],
                env=env, capture_output=True, text=True, timeout=240, cwd=str(ROOT),
            )
            tail = (r.stdout or r.stderr).strip().splitlines()[-1:] or [""]
            if r.returncode == 0:
                log.info(f"user {uid}: refreshed OK — {tail[0]}")
            elif r.returncode == 3:
                failures += 1
                log.warning(f"user {uid}: CAPTCHA — needs manual refresh via extension. {tail[0]}")
            else:
                failures += 1
                log.warning(f"user {uid}: refresh failed (exit {r.returncode}) — {tail[0]}")
        except subprocess.TimeoutExpired:
            failures += 1
            log.warning(f"user {uid}: refresh timed out after 240s")

    log.info(f"Done: {len(users)} user(s), {failures} failure(s)")
    sys.exit(1 if failures and failures == len(users) else 0)


if __name__ == "__main__":
    main()
