"""
api_server.py — REST API + Web Onboarding for the AutoApply system.

Routes:
  GET  /                  → Web onboarding form (for new users)
  POST /api/setup         → Create a new user from the form
  GET  /api/health        → Health check
  GET  /api/profile       → Candidate name, email, phone (per API key)
  GET  /api/cv            → Candidate CV as base64 (per API key)
  GET  /api/credentials   → Job board login credentials (per API key)
  GET  /api/jobs          → Jobs ready to apply (from local JSON or Google Sheet)
  POST /api/update_status → Update a job's status
  POST /api/log           → Receive logs from Chrome extension

Multi-user: the X-API-Key header maps to a user directory via users.json.
When GOOGLE_SHEET_ID is blank the /api/jobs endpoint reads from the user's
local .tmp/jobs_scored.json file (populated by run_applications.py).

Run:
    python tools/api_server.py
"""

import os
import sys
import json
import base64
import logging
import re
import secrets
from pathlib import Path
from functools import wraps

from dotenv import load_dotenv, dotenv_values

load_dotenv()

try:
    from flask import Flask, request, jsonify, redirect, url_for
    from flask_cors import CORS
except ImportError:
    print("Flask not installed. Run: pip install flask flask-cors", file=sys.stderr)
    sys.exit(1)

PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

logging.basicConfig(level=logging.INFO, format="%(asctime)s [api_server] %(message)s")
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app, origins="*")

ROOT_API_KEY = os.getenv("API_KEY", "autoapply-secret-2024")
PORT = int(os.getenv("API_PORT", "5001"))

# ── Multi-user map ────────────────────────────────────────────────────────────

_USERS_JSON = PROJECT_ROOT / "users.json"

def _load_user_map() -> dict:
    if _USERS_JSON.exists():
        try:
            return json.loads(_USERS_JSON.read_text())
        except Exception:
            return {}
    return {}

USER_MAP: dict = _load_user_map()


def _save_user_map():
    _USERS_JSON.write_text(json.dumps(USER_MAP, indent=2))


def _get_user_env(api_key: str) -> dict:
    username = USER_MAP.get(api_key)
    if not username:
        return {}
    p = PROJECT_ROOT / "users" / username / ".env"
    return dotenv_values(p) if p.exists() else {}


def _uenv(user_env: dict, key: str, default: str = "") -> str:
    return user_env.get(key) or os.getenv(key, default)


def _request_key() -> str:
    return request.headers.get("X-API-Key") or request.args.get("api_key", "")


# ── Profile helpers ───────────────────────────────────────────────────────────

def _extract_name(text):
    m = re.search(r"[-*]\s*Name:\s*(.+)", text, re.IGNORECASE)
    return m.group(1).strip() if m else ""

def _extract_email(text):
    m = re.search(r"[-*]\s*Email:\s*(\S+)", text, re.IGNORECASE)
    return m.group(1).strip() if m else ""

def _extract_phone(text):
    m = re.search(r"[-*]\s*Phone:\s*(\S+)", text, re.IGNORECASE)
    return m.group(1).strip() if m else ""


# ── Auth ──────────────────────────────────────────────────────────────────────

def require_api_key(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        key = _request_key()
        if key != ROOT_API_KEY and key not in USER_MAP:
            return jsonify({"error": "Unauthorized"}), 401
        return f(*args, **kwargs)
    return decorated


# ── Onboarding HTML ───────────────────────────────────────────────────────────

ONBOARDING_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AutoApply — Get Started</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         background: #f0f4ff; min-height: 100vh; padding: 32px 16px; color: #1f2937; }
  .card { background: #fff; max-width: 640px; margin: 0 auto; border-radius: 16px;
          box-shadow: 0 4px 24px rgba(0,0,0,0.10); overflow: hidden; }
  .header { background: linear-gradient(135deg, #1d4ed8, #4f46e5);
             padding: 32px 36px; color: #fff; }
  .header h1 { font-size: 24px; font-weight: 700; margin-bottom: 6px; }
  .header p  { font-size: 14px; opacity: 0.85; }
  .body { padding: 32px 36px; }
  .section { margin-bottom: 28px; }
  .section-title { font-size: 13px; font-weight: 700; color: #6b7280;
                   text-transform: uppercase; letter-spacing: .05em;
                   margin-bottom: 14px; padding-bottom: 6px;
                   border-bottom: 1px solid #e5e7eb; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .field { margin-bottom: 14px; }
  label { display: block; font-size: 13px; font-weight: 600; color: #374151;
          margin-bottom: 5px; }
  label span.opt { font-weight: 400; color: #9ca3af; font-size: 11px; }
  input[type=text], input[type=email], input[type=password], input[type=tel],
  select, textarea {
    width: 100%; padding: 10px 12px; border: 1px solid #d1d5db;
    border-radius: 8px; font-size: 14px; color: #1f2937;
    transition: border-color .15s, box-shadow .15s; outline: none; }
  input:focus, select:focus, textarea:focus {
    border-color: #1d4ed8; box-shadow: 0 0 0 3px rgba(29,78,216,.12); }
  textarea { resize: vertical; min-height: 70px; }
  .file-area { border: 2px dashed #d1d5db; border-radius: 10px; padding: 24px;
               text-align: center; cursor: pointer; transition: .15s; }
  .file-area:hover { border-color: #1d4ed8; background: #f0f4ff; }
  .file-area input[type=file] { display: none; }
  .file-area .icon { font-size: 32px; margin-bottom: 8px; }
  .file-area .label { font-size: 14px; font-weight: 600; color: #374151; }
  .file-area .hint  { font-size: 12px; color: #9ca3af; margin-top: 4px; }
  .file-area.has-file { border-color: #16a34a; background: #f0fdf4; }
  .file-area.has-file .icon::after { content: " ✓"; font-size: 20px; color: #16a34a; }
  .range-wrap { display: flex; align-items: center; gap: 12px; }
  input[type=range] { flex: 1; accent-color: #1d4ed8; }
  .range-val { min-width: 32px; text-align: center; font-weight: 700;
               color: #1d4ed8; font-size: 18px; }
  .info-box { background: #eff6ff; border-radius: 8px; padding: 12px 16px;
              font-size: 13px; color: #1e40af; margin-bottom: 20px; line-height: 1.6; }
  .info-box b { display: block; margin-bottom: 4px; }
  .submit-btn { width: 100%; padding: 14px; background: linear-gradient(135deg,#1d4ed8,#4f46e5);
                color: #fff; border: none; border-radius: 10px; font-size: 16px;
                font-weight: 700; cursor: pointer; transition: opacity .15s; }
  .submit-btn:hover { opacity: .92; }
  .submit-btn:disabled { opacity: .5; cursor: default; }
  .spinner { display: none; text-align: center; margin-top: 16px; color: #6b7280;
             font-size: 13px; }
  /* Success page */
  .success { padding: 40px 36px; text-align: center; }
  .success .tick { font-size: 56px; margin-bottom: 16px; }
  .success h2 { font-size: 22px; font-weight: 700; color: #16a34a; margin-bottom: 8px; }
  .success p  { color: #6b7280; font-size: 14px; margin-bottom: 24px; }
  .key-box { background: #1f2937; color: #86efac; font-family: monospace;
             font-size: 16px; padding: 16px 20px; border-radius: 8px;
             text-align: center; margin: 16px 0; word-break: break-all;
             cursor: pointer; position: relative; }
  .key-box:hover::after { content: "Click to copy";
    position: absolute; bottom: -24px; left: 50%; transform: translateX(-50%);
    font-size: 11px; color: #9ca3af; white-space: nowrap; }
  .steps { text-align: left; background: #f9fafb; border-radius: 10px;
           padding: 20px; margin-top: 20px; }
  .steps h3 { font-size: 14px; font-weight: 700; margin-bottom: 12px; }
  .step { display: flex; gap: 12px; margin-bottom: 12px; font-size: 13px; }
  .step-num { background: #1d4ed8; color: #fff; border-radius: 50%;
              width: 22px; height: 22px; flex-shrink: 0;
              display: flex; align-items: center; justify-content: center;
              font-size: 12px; font-weight: 700; }
</style>
</head>
<body>
<div class="card" id="main-card">
  <div class="header">
    <h1>🚀 AutoApply Setup</h1>
    <p>Fill in your details once. The system handles everything else.</p>
  </div>

  <div id="form-area" class="body">
    <form id="setup-form" enctype="multipart/form-data">

      <div class="section">
        <div class="section-title">Your Details</div>
        <div class="row">
          <div class="field">
            <label>First Name</label>
            <input type="text" name="first_name" placeholder="e.g. Alice" required>
          </div>
          <div class="field">
            <label>Last Name</label>
            <input type="text" name="last_name" placeholder="e.g. Smith" required>
          </div>
        </div>
        <div class="field">
          <label>Email Address</label>
          <input type="email" name="email" placeholder="you@gmail.com" required>
        </div>
        <div class="field">
          <label>Phone <span class="opt">(with country code)</span></label>
          <input type="tel" name="phone" placeholder="+447700900000">
        </div>
        <div class="field">
          <label>Location</label>
          <input type="text" name="location" placeholder="e.g. London" value="London">
        </div>
      </div>

      <div class="section">
        <div class="section-title">Your CV</div>
        <div class="file-area" id="cv-drop" onclick="document.getElementById('cv-file').click()">
          <input type="file" id="cv-file" name="cv" accept=".docx">
          <div class="icon">📄</div>
          <div class="label" id="cv-label">Click to upload your CV</div>
          <div class="hint">.docx format only</div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Job Search Preferences</div>
        <div class="field">
          <label>Job titles you want <span class="opt">(comma separated)</span></label>
          <input type="text" name="keywords"
                 placeholder="e.g. AML Compliance, MLRO, Compliance Manager" required>
        </div>
        <div class="field">
          <label>Search Location</label>
          <input type="text" name="search_location" placeholder="e.g. London" value="London">
        </div>
        <div class="field">
          <label>Minimum match score to apply
            <span class="opt">(1 = anything, 10 = perfect matches only)</span></label>
          <div class="range-wrap">
            <input type="range" name="threshold" min="5" max="10" value="7"
                   oninput="document.getElementById('thresh-val').textContent=this.value">
            <div class="range-val" id="thresh-val">7</div>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Email Reports</div>
        <div class="info-box">
          <b>📬 How to get your Gmail App Password:</b>
          Go to <strong>myaccount.google.com</strong> → Security → 2-Step Verification → App Passwords.
          Create one called "AutoApply". Paste the 16-character code below.
        </div>
        <div class="field">
          <label>Gmail App Password <span class="opt">(not your account password)</span></label>
          <input type="password" name="smtp_password" placeholder="xxxx xxxx xxxx xxxx">
        </div>
      </div>

      <div class="section">
        <div class="section-title">Job Board Login <span class="opt">(optional — for auto-apply)</span></div>
        <div class="field">
          <label>LinkedIn Password <span class="opt">(your LinkedIn password)</span></label>
          <input type="password" name="linkedin_password" placeholder="Leave blank to skip LinkedIn auto-apply">
        </div>
        <div class="field">
          <label>Reed Password <span class="opt">(reed.co.uk)</span></label>
          <input type="password" name="reed_password" placeholder="Leave blank to skip Reed auto-apply">
        </div>
      </div>

      <button type="submit" class="submit-btn" id="submit-btn">
        Create My Profile &amp; Get Started →
      </button>
      <div class="spinner" id="spinner">Setting up your profile… this takes a few seconds ⏳</div>
    </form>
  </div>
</div>

<script>
const cvFile = document.getElementById('cv-file');
cvFile.addEventListener('change', () => {
  const name = cvFile.files[0]?.name || '';
  const drop  = document.getElementById('cv-drop');
  const label = document.getElementById('cv-label');
  if (name) { label.textContent = name; drop.classList.add('has-file'); }
  else       { label.textContent = 'Click to upload your CV'; drop.classList.remove('has-file'); }
});

document.getElementById('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('submit-btn');
  const sp  = document.getElementById('spinner');
  btn.disabled = true;
  sp.style.display = 'block';

  const fd = new FormData(e.target);
  try {
    const res  = await fetch('/api/setup', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.error) { alert('Error: ' + data.error); btn.disabled = false; sp.style.display='none'; return; }
    showSuccess(data);
  } catch(err) {
    alert('Something went wrong: ' + err.message);
    btn.disabled = false; sp.style.display = 'none';
  }
});

function showSuccess(data) {
  document.getElementById('form-area').innerHTML = `
    <div class="success">
      <div class="tick">🎉</div>
      <h2>You're all set, ${data.first_name}!</h2>
      <p>Your profile has been created. Here is your personal API key —<br>
         copy it into the Chrome extension.</p>
      <div class="key-box" onclick="navigator.clipboard.writeText('${data.api_key}').then(()=>this.style.outline='2px solid #86efac')" title="Click to copy">
        ${data.api_key}
      </div>
      <div class="steps">
        <h3>Next steps</h3>
        <div class="step">
          <div class="step-num">1</div>
          <div>Install the <strong>AutoApply Chrome Extension</strong> (load unpacked from the chrome-extension folder)</div>
        </div>
        <div class="step">
          <div class="step-num">2</div>
          <div>Open the extension popup → enter server URL <code>http://localhost:5001</code> and paste your API key above → click Save</div>
        </div>
        <div class="step">
          <div class="step-num">3</div>
          <div>Run the pipeline:<br><code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:12px;">python tools/run_applications.py --user ${data.username}</code></div>
        </div>
        <div class="step">
          <div class="step-num">4</div>
          <div>Check your inbox at <strong>${data.email}</strong> — you'll receive a full report with your tailored CVs attached.</div>
        </div>
      </div>
    </div>
  `;
}
</script>
</body>
</html>
"""


# ── Routes — Onboarding ───────────────────────────────────────────────────────

@app.route("/")
def onboarding():
    return ONBOARDING_HTML


@app.route("/api/setup", methods=["POST"])
def setup_user():
    """Create a new user from the web onboarding form."""
    try:
        first_name = request.form.get("first_name", "").strip()
        last_name  = request.form.get("last_name",  "").strip()
        email      = request.form.get("email",       "").strip().lower()
        phone      = request.form.get("phone",       "").strip()
        location   = request.form.get("location",    "United Kingdom").strip()
        keywords   = request.form.get("keywords",    "").strip()
        search_loc = request.form.get("search_location", location).strip()
        threshold  = request.form.get("threshold",   "7").strip()
        smtp_pass  = request.form.get("smtp_password",   "").strip()
        li_pass    = request.form.get("linkedin_password","").strip()
        reed_pass  = request.form.get("reed_password",   "").strip()

        if not all([first_name, last_name, email]):
            return jsonify({"error": "First name, last name and email are required"}), 400

        # Build username from first+last, lowercased slug
        raw = f"{first_name}{last_name}".lower()
        username = re.sub(r"[^a-z0-9]", "", raw)[:20] or "user"
        # Make unique if taken
        if (PROJECT_ROOT / "users" / username).exists():
            username = f"{username}{secrets.token_hex(2)}"

        user_dir = PROJECT_ROOT / "users" / username
        user_dir.mkdir(parents=True, exist_ok=True)
        (user_dir / ".tmp").mkdir(exist_ok=True)

        # Save uploaded CV
        cv_file = request.files.get("cv")
        cv_path = str(user_dir / "cv.docx")
        if cv_file and cv_file.filename:
            cv_file.save(cv_path)
        else:
            cv_path = ""

        api_key = f"autoapply-{username}-{secrets.token_hex(4)}"

        # Subject prefix from keywords (first job title)
        subject_prefix = keywords.split(",")[0].strip().title() if keywords else "Job Application"

        env_content = f"""\
# ── Identity ─────────────────────────────────────────────────────────────────
CANDIDATE_FIRST_NAME={first_name}
CANDIDATE_LAST_NAME={last_name}
CANDIDATE_EMAIL={email}
CANDIDATE_PHONE={phone}

# ── Paths ─────────────────────────────────────────────────────────────────────
CANDIDATE_PROFILE_PATH=./users/{username}/candidate_profile.md
CV_PATH=./users/{username}/cv.docx
TMP_DIR=./users/{username}/.tmp

# ── Job board credentials ─────────────────────────────────────────────────────
LINKEDIN_EMAIL={email}
LINKEDIN_PASSWORD={li_pass}
REED_EMAIL={email}
REED_PASSWORD={reed_pass}
INDEED_EMAIL={email}
INDEED_PASSWORD=
TOTALJOBS_EMAIL={email}
TOTALJOBS_PASSWORD=

# ── Google Sheets (optional — leave blank to use local JSON) ──────────────────
GOOGLE_SHEET_ID=
GOOGLE_SERVICE_ACCOUNT_JSON=./users/{username}/service_account.json

# ── Email reports ─────────────────────────────────────────────────────────────
SMTP_EMAIL={email}
SMTP_PASSWORD={smtp_pass}
SMTP_TO={email}

# ── Job search preferences ────────────────────────────────────────────────────
JOB_SEARCH_KEYWORDS={keywords}
JOB_SEARCH_LOCATION={search_loc}
JOB_SEARCH_COUNT=30
SCORE_THRESHOLD={threshold}
EMAIL_SUBJECT_PREFIX={subject_prefix}

# ── API key ───────────────────────────────────────────────────────────────────
API_KEY={api_key}
"""
        (user_dir / ".env").write_text(env_content)

        # Write candidate_profile.md
        profile_content = f"""\
## Personal Info
- Name: {first_name} {last_name}
- Email: {email}
- Phone: {phone}
- Location: {location}
- LinkedIn:
- GitHub / Portfolio:

## Target Roles
- Job titles: {keywords}
- Industries: Financial Services, Fintech, Professional Services
- Work arrangement: Hybrid
- Seniority level:
- Salary expectations:
- Notice period: 1 month
- Open to relocation: No
- Right to work in UK: Yes

## CV Summary
(This will be auto-generated from your uploaded CV.)

## Work Experience
(Extracted from your CV during the first run.)

## Education
(Extracted from your CV during the first run.)

## Skills
(Extracted from your CV during the first run.)

## Career Goals
- Seeking roles in: {keywords}
- Preferred location: {location}
"""
        (user_dir / "candidate_profile.md").write_text(profile_content)

        # Register in users.json
        USER_MAP[api_key] = username
        _save_user_map()

        logger.info(f"New user created: {username} ({email}), api_key={api_key[:20]}...")
        return jsonify({
            "ok": True,
            "username":   username,
            "first_name": first_name,
            "email":      email,
            "api_key":    api_key,
        })

    except Exception as e:
        logger.error(f"setup_user failed: {e}")
        return jsonify({"error": str(e)}), 500


# ── Routes — API ──────────────────────────────────────────────────────────────

@app.route("/api/health")
def health():
    return jsonify({"status": "ok", "service": "AutoApply API", "users": len(USER_MAP)})


@app.route("/api/log", methods=["POST"])
@require_api_key
def receive_log():
    data  = request.get_json(force=True)
    msg   = data.get("message", "")
    level = data.get("level", "info")
    logger.info(f"[EXTENSION] [{level.upper()}] {msg}")
    return jsonify({"ok": True})


@app.route("/api/credentials")
@require_api_key
def get_credentials():
    uenv = _get_user_env(_request_key())
    return jsonify({
        "reed": {
            "email":    _uenv(uenv, "REED_EMAIL"),
            "password": _uenv(uenv, "REED_PASSWORD"),
        }
    })


@app.route("/api/cv")
@require_api_key
def get_cv():
    uenv    = _get_user_env(_request_key())
    cv_path = _uenv(uenv, "CV_PATH")
    if not cv_path or not Path(cv_path).exists():
        return jsonify({"error": f"CV not found at: {cv_path}"}), 404

    cv_file = Path(cv_path)
    data    = base64.b64encode(cv_file.read_bytes()).decode("utf-8")

    if cv_file.suffix.lower() == ".docx":
        mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    elif cv_file.suffix.lower() == ".pdf":
        mime = "application/pdf"
    else:
        mime = "application/octet-stream"

    logger.info(f"Serving CV: {cv_file.name} ({cv_file.stat().st_size} bytes)")
    return jsonify({
        "filename": cv_file.name,
        "mime":     mime,
        "data":     f"data:{mime};base64,{data}",
        "size":     cv_file.stat().st_size,
    })


@app.route("/api/profile")
@require_api_key
def get_profile():
    uenv  = _get_user_env(_request_key())
    first = _uenv(uenv, "CANDIDATE_FIRST_NAME")
    last  = _uenv(uenv, "CANDIDATE_LAST_NAME")
    email = _uenv(uenv, "CANDIDATE_EMAIL")
    phone = _uenv(uenv, "CANDIDATE_PHONE")

    if not all([first, last, email, phone]):
        profile_path = _uenv(uenv, "CANDIDATE_PROFILE_PATH", "./candidate_profile.md")
        p = Path(profile_path)
        if p.exists():
            text = p.read_text()
            full = _extract_name(text)
            if full and not (first and last):
                parts = full.rsplit(" ", 1)
                first = first or (parts[0] if len(parts) > 1 else full)
                last  = last  or (parts[1] if len(parts) > 1 else "")
            if not email: email = _extract_email(text)
            if not phone: phone = _extract_phone(text)

    full_name = f"{first} {last}".strip()
    logger.info(f"GET /api/profile → {full_name}")
    return jsonify({"firstName": first, "lastName": last,
                    "fullName": full_name, "email": email, "phone": phone})


@app.route("/api/jobs")
@require_api_key
def get_jobs():
    """
    Return jobs ready to apply.
    - If user has GOOGLE_SHEET_ID set: reads from Google Sheet.
    - Otherwise: reads from users/<username>/.tmp/jobs_scored.json (no Sheet needed).
    """
    uenv     = _get_user_env(_request_key())
    sheet_id = _uenv(uenv, "GOOGLE_SHEET_ID")
    status   = request.args.get("status", "Pending Review")
    limit    = int(request.args.get("limit", 20))

    # ── Sheet-free path ───────────────────────────────────────────────────────
    if not sheet_id:
        username = USER_MAP.get(_request_key(), "")
        tmp_dir  = PROJECT_ROOT / "users" / username / ".tmp" if username else PROJECT_ROOT / ".tmp"
        scored   = tmp_dir / "jobs_scored.json"
        if not scored.exists():
            return jsonify({"jobs": [], "count": 0,
                            "note": "No jobs_scored.json found yet. Run the pipeline first."})
        try:
            all_jobs = json.loads(scored.read_text())
        except Exception as e:
            return jsonify({"error": f"Could not read jobs_scored.json: {e}"}), 500

        # Map to the format the extension expects
        result = []
        for i, job in enumerate(all_jobs[:limit]):
            score = job.get("score", 0)
            if score < int(_uenv(uenv, "SCORE_THRESHOLD", "7")):
                continue
            result.append({
                "row":          i + 2,
                "title":        job.get("title", ""),
                "company":      job.get("company", ""),
                "location":     job.get("location", ""),
                "url":          job.get("url", ""),
                "score":        score,
                "cover_letter": job.get("cover_letter", ""),
                "cv_summary":   job.get("score_reason", ""),
                "status":       "Pending Review",
                "_state":       "pending",
            })
        logger.info(f"GET /api/jobs (local) → {len(result)} qualifying jobs")
        return jsonify({"jobs": result, "count": len(result)})

    # ── Google Sheet path ─────────────────────────────────────────────────────
    try:
        from tools.read_from_sheets import read_jobs
        jobs = read_jobs(status_filter=status, sheet_id=sheet_id or None)
        result = []
        for job in jobs[:limit]:
            result.append({
                "row":          job.get("_sheet_row"),
                "title":        job.get("Job Title", ""),
                "company":      job.get("Company", ""),
                "location":     job.get("Location", ""),
                "url":          job.get("URL", ""),
                "score":        job.get("Score", ""),
                "cover_letter": job.get("Cover Letter", ""),
                "cv_summary":   job.get("CV Summary", ""),
                "status":       job.get("Status", ""),
            })
        logger.info(f"GET /api/jobs (sheets) → {len(result)} jobs")
        return jsonify({"jobs": result, "count": len(result)})
    except Exception as e:
        logger.error(f"get_jobs (sheets) failed: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/update_status", methods=["POST"])
@require_api_key
def update_status():
    uenv     = _get_user_env(_request_key())
    sheet_id = _uenv(uenv, "GOOGLE_SHEET_ID")
    data     = request.get_json(force=True)
    row      = data.get("row")
    status   = data.get("status", "Applied")
    notes    = data.get("notes", "")

    if not row:
        return jsonify({"error": "row is required"}), 400

    # If no sheet, just log it (local JSON is read-only at this point)
    if not sheet_id:
        logger.info(f"[local mode] row {row} → {status} ({notes})")
        return jsonify({"success": True, "row": row, "status": status, "note": "local mode"})

    try:
        from tools.read_from_sheets import update_job_status
        update_job_status(int(row), status, notes, sheet_id=sheet_id or None)
        logger.info(f"Updated row {row} → {status}")
        return jsonify({"success": True, "row": row, "status": status})
    except Exception as e:
        logger.error(f"update_status failed: {e}")
        return jsonify({"error": str(e)}), 500


# ── Main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    logger.info(f"AutoApply API starting on port {PORT}")
    logger.info(f"Onboarding page: http://localhost:{PORT}/")
    logger.info(f"Users registered: {len(USER_MAP)}")
    app.run(host="0.0.0.0", port=PORT, debug=False)
