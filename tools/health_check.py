#!/usr/bin/env python3
"""
health_check.py — Daily pipeline health monitor for ApplyExpress.

Runs 8 checks, auto-fixes safe infra issues, emails a summary.
Schedule: 0 6 * * * (6am daily, 1hr before first pipeline run)
"""

import os
import sys
import json
import time
import subprocess
import smtplib
import logging
from datetime import datetime, timezone
from pathlib import Path
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

ROOT = Path("/opt/applyexpress")
sys.path.insert(0, str(ROOT))
os.chdir(str(ROOT))

from dotenv import load_dotenv
load_dotenv(ROOT / ".env")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [health] %(message)s")
log = logging.getLogger(__name__)

now = time.time()
results = []   # list of {"check": str, "status": str, "action": str, "detail": str}
issues = 0


def record(check, ok, action="—", detail=""):
    global issues
    status = "OK" if ok else "FAIL"
    if not ok:
        issues += 1
    results.append({"check": check, "status": status, "action": action, "detail": detail})
    emoji = "✅" if ok else "❌"
    log.info(f"{emoji} {check}: {status}{' — ' + action if action != '—' else ''}")


def warn(check, action="—", detail=""):
    results.append({"check": check, "status": "WARN", "action": action, "detail": detail})
    log.info(f"⚠️  {check}: WARN{' — ' + action if action != '—' else ''}")


# ── Check 1: Node.js script syntax ────────────────────────────────────────────
JS_SCRIPTS = [
    "tools/apply_reed_playwright.js",
    "tools/apply_linkedin.js",
    "tools/apply_indeed.js",
    "tools/apply_totaljobs.js",
    "tools/apply_greenhouse_playwright.js",
    "tools/apply_lever_playwright.js",
]

for script in JS_SCRIPTS:
    path = ROOT / script
    if not path.exists():
        warn(f"syntax:{Path(script).stem}", detail="file not found — skipped")
        continue
    r = subprocess.run(["node", "--check", str(path)], capture_output=True, text=True)
    ok = r.returncode == 0
    detail = r.stderr.strip().split("\n")[0] if not ok else ""
    record(f"syntax:{Path(script).stem}", ok, detail=detail)

# ── Check 2: Xvfb virtual display ─────────────────────────────────────────────
xvfb_pid = subprocess.run(["pgrep", "Xvfb"], capture_output=True).stdout.strip()
if xvfb_pid:
    record("xvfb", True, detail=f"pid {xvfb_pid.decode()}")
else:
    subprocess.run(["rm", "-f", "/tmp/.X99-lock"], check=False)
    proc = subprocess.Popen(
        ["/usr/bin/Xvfb", ":99", "-screen", "0", "1280x900x24"],
        start_new_session=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(2)
    still_up = proc.poll() is None
    record("xvfb", still_up,
           action="Auto-restarted" if still_up else "Restart failed",
           detail=f"new pid {proc.pid}" if still_up else "")

# ── Check 3: Flask app responding ─────────────────────────────────────────────
try:
    import urllib.request
    urllib.request.urlopen("http://localhost:8080/", timeout=6)
    record("flask_app", True)
except Exception as e:
    log.warning(f"Flask not responding: {e} — attempting restart")
    r = subprocess.run(["systemctl", "restart", "applyexpress"], capture_output=True)
    time.sleep(5)
    try:
        urllib.request.urlopen("http://localhost:8080/", timeout=6)
        record("flask_app", False, action="Auto-restarted", detail="was down, now up")
    except Exception:
        record("flask_app", False, action="Restart attempted", detail="still not responding")

# ── Check 4: Stale Chromium lock files ────────────────────────────────────────
locks = list((ROOT / "data" / "users").rglob("SingletonLock"))
locks += list((ROOT / ".tmp").rglob("SingletonLock"))
if locks:
    for lock in locks:
        lock.unlink(missing_ok=True)
    record("chromium_locks", True, action=f"Cleared {len(locks)} stale lock(s)")
else:
    record("chromium_locks", True, detail="none found")

# ── Check 5: Session cookie health (expiry + auto-refresh for Reed) ──────────
def _count_expired_cookies(session_file: Path) -> tuple[int, int]:
    """Return (expired_count, total_count) for a sessions JSON file."""
    try:
        cookies = json.loads(session_file.read_text())
        ts_now = time.time()
        expired = sum(1 for c in cookies if c.get("expires", -1) > 0 and c["expires"] < ts_now)
        return expired, len(cookies)
    except Exception:
        return 0, 0

def _refresh_reed_session(uid_dir: Path) -> bool:
    """Try to re-login Reed using DB credentials for this user. Returns True on success."""
    try:
        import sqlite3 as _sqlite3
        db = _sqlite3.connect(str(ROOT / "data" / "autoapply.db"))
        uid = uid_dir.name  # "1" or "2"
        row = db.execute("SELECT reed_email, reed_pass FROM users WHERE id=?", (uid,)).fetchone()
        db.close()
        if not row or not row[0] or not row[1]:
            return False
        email, enc_pass = row
        # Decrypt password
        try:
            from cryptography.fernet import Fernet
            cred_key = os.getenv("CREDENTIAL_KEY", "").encode()
            password = Fernet(cred_key).decrypt(enc_pass.encode()).decode()
        except Exception:
            password = enc_pass  # plaintext fallback

        # Build a one-shot login script inline using node
        tmp_dir = uid_dir / ".tmp"
        session_dir = tmp_dir / "reed_session"
        sessions_file = uid_dir / "sessions" / "reed.json"
        # Remove stale lock if present
        (session_dir / "SingletonLock").unlink(missing_ok=True)

        js = f"""
require('dotenv').config({{ path: '/opt/applyexpress/.env' }});
const {{ chromium }} = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
chromium.use(stealth());
const fs = require('fs');
const path = require('path');
const SESSION_DIR = {json.dumps(str(session_dir))};
const SESSIONS_FILE = {json.dumps(str(sessions_file))};
const EMAIL = {json.dumps(email)};
const PASSWORD = {json.dumps(password)};
(async () => {{
  const ctx = await chromium.launchPersistentContext(SESSION_DIR, {{
    headless: !process.env.DISPLAY,
    args: ['--no-sandbox','--disable-dev-shm-usage'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: {{ width: 1280, height: 900 }},
  }});
  const page = await ctx.newPage();
  await page.goto('https://www.reed.co.uk/account/signin', {{ waitUntil: 'domcontentloaded', timeout: 30000 }});
  await page.waitForTimeout(2000);
  const acceptBtn = page.locator('button[id*="accept"], button:has-text("Accept all")').first();
  if (await acceptBtn.isVisible({{ timeout: 3000 }}).catch(()=>false)) await acceptBtn.click();
  await page.fill('input[name="email"]', EMAIL).catch(()=>{{}});
  await page.fill('input[name="password"]', PASSWORD).catch(()=>{{}});
  await page.click('button[type="submit"]').catch(()=>{{}});
  await page.waitForTimeout(5000);
  const locked = (await page.innerText('body').catch(()=>'')).includes('locked');
  if (locked) {{ console.error('LOCKED'); await ctx.close(); process.exit(2); }}
  const cookies = await ctx.cookies();
  fs.mkdirSync(path.dirname(SESSIONS_FILE), {{ recursive: true }});
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(cookies, null, 2));
  console.log('SAVED:' + cookies.length);
  await ctx.close();
}})().catch(e => {{ console.error('FATAL:' + e.message); process.exit(1); }});
"""
        tmp_js = Path("/tmp/reed_refresh_health.js")
        tmp_js.write_text(js)
        env = dict(os.environ, DISPLAY=":99")
        r = subprocess.run(
            ["node", str(tmp_js)],
            capture_output=True, text=True, timeout=90, env=env,
            cwd=str(ROOT)
        )
        tmp_js.unlink(missing_ok=True)
        if r.returncode == 0 and "SAVED:" in r.stdout:
            n = r.stdout.strip().split("SAVED:")[-1].strip()
            log.info(f"Reed session refreshed for user {uid}: {n} cookies saved")
            return True
        log.warning(f"Reed refresh failed for user {uid}: {r.stderr.strip()[:200]}")
        return False
    except Exception as e:
        log.warning(f"Reed auto-refresh exception: {e}")
        return False

for uid_dir in sorted((ROOT / "data" / "users").iterdir()):
    if not uid_dir.is_dir():
        continue
    sessions_dir = uid_dir / "sessions"
    uid = uid_dir.name

    # Reed: check actual cookie expiry + auto-refresh
    reed_f = sessions_dir / "reed.json"
    if not reed_f.exists():
        record(f"session:reed:user{uid}", False, action="Re-sync Reed session", detail="no session file")
    else:
        expired, total = _count_expired_cookies(reed_f)
        pct = (expired / total * 100) if total else 0
        age_days = (now - reed_f.stat().st_mtime) / 86400
        if expired == 0:
            record(f"session:reed:user{uid}", True, detail=f"{total} cookies valid, {age_days:.0f}d old")
        elif pct < 30:
            warn(f"session:reed:user{uid}", detail=f"{expired}/{total} cookies expired ({pct:.0f}%) — refreshing soon")
        else:
            # Auto-refresh using stored credentials
            log.warning(f"Reed session for user {uid} is {pct:.0f}% expired — attempting auto-refresh")
            success = _refresh_reed_session(uid_dir)
            if success:
                record(f"session:reed:user{uid}", True, action="Auto-refreshed", detail=f"was {pct:.0f}% expired")
            else:
                record(f"session:reed:user{uid}", False, action="Auto-refresh failed — re-sync via extension",
                       detail=f"{expired}/{total} cookies expired")

    # LinkedIn + Indeed: age-based check only (extension-managed)
    for platform, warn_days in [("linkedin", 300), ("indeed", 25)]:
        f = sessions_dir / f"{platform}.json"
        if not f.exists():
            warn(f"session:{platform}:user{uid}", detail="no session file")
            continue
        age_days = (now - f.stat().st_mtime) / 86400
        ok = age_days < warn_days
        detail = f"{age_days:.0f} days old"
        if ok:
            record(f"session:{platform}:user{uid}", True, detail=detail)
        else:
            record(f"session:{platform}:user{uid}", False, action="Re-sync via browser extension", detail=detail)

# ── Check 5b: Gemini credits ───────────────────────────────────────────────────
gemini_key = os.getenv("GEMINI_API_KEY", "")
if gemini_key:
    try:
        from google import genai
        from google.genai import types as _gtypes
        _gclient = genai.Client(api_key=gemini_key)
        _gresp = _gclient.models.generate_content(
            model="gemini-2.0-flash",
            contents="Reply: ok",
            config=_gtypes.GenerateContentConfig(max_output_tokens=5),
        )
        record("gemini_credits", True, detail="API responsive")
    except Exception as e:
        err = str(e).lower()
        if "prepayment" in err or "credits are depleted" in err:
            record("gemini_credits", False, action="Top up at ai.google.dev — Groq is primary fallback",
                   detail="Prepaid credits exhausted")
        else:
            warn("gemini_credits", detail=str(e)[:100])

# ── Check 6: Groq API key smoke test ──────────────────────────────────────────
groq_key = os.getenv("GROQ_API_KEY", "")
if not groq_key:
    record("groq_api", False, detail="GROQ_API_KEY not set")
else:
    try:
        from groq import Groq
        client = Groq(api_key=groq_key)
        resp = client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[{"role": "user", "content": "Reply: ok"}],
            max_tokens=5,
        )
        record("groq_api", True, detail=resp.choices[0].message.content.strip()[:20])
    except Exception as e:
        msg = str(e)
        if "tokens per day" in msg.lower() or "tpd" in msg.lower() or "rate_limit" in msg.lower():
            warn("groq_api", detail="Daily quota hit — resets at midnight UTC (not critical)")
        else:
            record("groq_api", False, detail=msg[:120])

# ── Check 7: Recent pipeline activity ─────────────────────────────────────────
log_files = list((ROOT / "data").glob("pipeline_*.log"))
if not log_files:
    record("pipeline_activity", False, detail="No pipeline logs found")
else:
    most_recent = max(log_files, key=lambda f: f.stat().st_mtime)
    age_hours = (now - most_recent.stat().st_mtime) / 3600
    ok = age_hours < 25
    detail = f"Last run {age_hours:.1f}h ago ({most_recent.name})"
    action = "Check scheduler / cron" if not ok else "—"
    record("pipeline_activity", ok, action=action, detail=detail)

# ── Check 8: Adzuna credentials ───────────────────────────────────────────────
adzuna_id = os.getenv("ADZUNA_APP_ID", "")
adzuna_key = os.getenv("ADZUNA_APP_KEY", "")
if adzuna_id and adzuna_key:
    record("adzuna_creds", True, detail=f"app_id={adzuna_id}")
else:
    record("adzuna_creds", False, detail="ADZUNA_APP_ID or ADZUNA_APP_KEY missing from .env")

# ── Check 9: Sponsor list freshness (weekly refresh) ─────────────────────────
sponsor_list_path = Path(ROOT) / "data" / "sponsor_list.json"
SEVEN_DAYS = 7 * 86400
if not sponsor_list_path.exists():
    r = subprocess.run(
        [sys.executable, str(Path(ROOT) / "tools" / "download_sponsor_list.py")],
        capture_output=True, text=True, cwd=ROOT, timeout=120
    )
    if r.returncode == 0:
        record("sponsor_list", True, action="AUTO-DOWNLOADED",
               detail="First-time download complete")
    else:
        record("sponsor_list", False, action="Download failed — run manually",
               detail=(r.stderr or r.stdout)[-200:])
elif (now - sponsor_list_path.stat().st_mtime) > SEVEN_DAYS:
    age_days = (now - sponsor_list_path.stat().st_mtime) / 86400
    r = subprocess.run(
        [sys.executable, str(Path(ROOT) / "tools" / "download_sponsor_list.py")],
        capture_output=True, text=True, cwd=ROOT, timeout=120
    )
    if r.returncode == 0:
        record("sponsor_list", True, action="AUTO-REFRESHED",
               detail=f"Was {age_days:.0f} days old — refreshed")
    else:
        record("sponsor_list", False, action="Refresh failed — run manually",
               detail=(r.stderr or r.stdout)[-200:])
else:
    age_days = (now - sponsor_list_path.stat().st_mtime) / 86400
    record("sponsor_list", True, detail=f"{age_days:.0f} days old")

# ── Build and send email ───────────────────────────────────────────────────────
smtp_email = os.getenv("SMTP_EMAIL", "")
smtp_password = os.getenv("SMTP_PASSWORD", "")
smtp_to = os.getenv("SMTP_TO", smtp_email)

ok_count = sum(1 for r in results if r["status"] == "OK")
fail_count = sum(1 for r in results if r["status"] == "FAIL")
warn_count = sum(1 for r in results if r["status"] == "WARN")
total = len(results)

if fail_count == 0:
    subject = f"ApplyExpress Health: All {ok_count} checks OK ✅"
else:
    subject = f"ApplyExpress Health: {fail_count} issue(s) need attention ❌"

def _row_color(status):
    return {"OK": "#f0fdf4", "FAIL": "#fef2f2", "WARN": "#fffbeb"}.get(status, "#f9fafb")

def _status_badge(status):
    colors = {"OK": "#16a34a", "FAIL": "#dc2626", "WARN": "#d97706"}
    c = colors.get(status, "#6b7280")
    return f'<span style="color:{c};font-weight:bold;">{status}</span>'

rows = ""
for r in results:
    rows += f"""
    <tr style="background:{_row_color(r['status'])};">
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">{r['check']}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center;">{_status_badge(r['status'])}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">{r['action']}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:12px;">{r['detail']}</td>
    </tr>"""

html = f"""<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;max-width:750px;margin:0 auto;padding:24px;color:#1f2937;">
  <h2 style="margin-bottom:4px;">ApplyExpress Daily Health Check</h2>
  <p style="color:#6b7280;margin-top:0;">{datetime.now().strftime('%Y-%m-%d %H:%M')} UTC</p>

  <div style="display:flex;gap:12px;margin:20px 0;">
    <div style="background:#f0fdf4;padding:12px 20px;border-radius:8px;text-align:center;">
      <div style="font-size:24px;font-weight:bold;color:#16a34a;">{ok_count}</div>
      <div style="color:#6b7280;font-size:12px;">OK</div>
    </div>
    <div style="background:#fffbeb;padding:12px 20px;border-radius:8px;text-align:center;">
      <div style="font-size:24px;font-weight:bold;color:#d97706;">{warn_count}</div>
      <div style="color:#6b7280;font-size:12px;">WARN</div>
    </div>
    <div style="background:#fef2f2;padding:12px 20px;border-radius:8px;text-align:center;">
      <div style="font-size:24px;font-weight:bold;color:#dc2626;">{fail_count}</div>
      <div style="color:#6b7280;font-size:12px;">FAIL</div>
    </div>
  </div>

  <table style="width:100%;border-collapse:collapse;">
    <thead>
      <tr style="background:#f3f4f6;">
        <th style="padding:10px 12px;text-align:left;">Check</th>
        <th style="padding:10px 12px;text-align:center;">Status</th>
        <th style="padding:10px 12px;text-align:left;">Action Taken</th>
        <th style="padding:10px 12px;text-align:left;">Detail</th>
      </tr>
    </thead>
    <tbody>{rows}</tbody>
  </table>

  <p style="margin-top:24px;color:#9ca3af;font-size:12px;">
    ApplyExpress Health Monitor · Runs daily at 06:00 UTC
  </p>
</body>
</html>"""

plain = f"ApplyExpress Health {datetime.now().strftime('%Y-%m-%d')}: {ok_count} OK / {warn_count} WARN / {fail_count} FAIL\n\n"
for r in results:
    plain += f"[{r['status']}] {r['check']}"
    if r['action'] != "—":
        plain += f" → {r['action']}"
    if r['detail']:
        plain += f" ({r['detail']})"
    plain += "\n"

if smtp_email and smtp_password:
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = smtp_email
        msg["To"] = smtp_to
        msg.attach(MIMEText(plain, "plain"))
        msg.attach(MIMEText(html, "html"))
        with smtplib.SMTP("smtp.gmail.com", 587) as srv:
            srv.starttls()
            srv.login(smtp_email, smtp_password)
            srv.sendmail(smtp_email, [smtp_to], msg.as_string())
        log.info(f"Health report emailed to {smtp_to}")
    except Exception as e:
        log.error(f"Email failed: {e}")
else:
    log.warning("SMTP not configured — printing report only")
    print(plain)

log.info(f"Health check complete: {ok_count}/{total} OK, {warn_count} WARN, {fail_count} FAIL")
sys.exit(0 if fail_count == 0 else 1)
