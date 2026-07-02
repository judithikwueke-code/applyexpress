"""
app.py — ApplyExpress SaaS Platform

A self-contained Flask web application:
  - User signup / login (SQLite, no external DB)
  - CV upload (stored in data/users/<id>/)
  - Profile & job-search preferences
  - Pipeline trigger — runs fetch → score → tailor CV → cover letter
    then emails the full report automatically
  - REST API for the Chrome extension

Deploy FREE on Fly.io (see fly.toml + Dockerfile).
Local dev:
    python app.py
"""

import os, sys, json, sqlite3, secrets, hashlib, threading, time, logging, re
from pathlib import Path
from datetime import datetime
from functools import wraps

from dotenv import load_dotenv
load_dotenv()

from flask import (Flask, request, jsonify, session,
                   redirect, url_for, g)
from flask_cors import CORS

# ── Project setup ─────────────────────────────────────────────────────────────

ROOT        = Path(__file__).parent
DATA_DIR    = Path(os.getenv("DATA_DIR", str(ROOT / "data")))
DB_PATH     = DATA_DIR / "autoapply.db"
TOOLS_DIR   = ROOT / "tools"

DATA_DIR.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(ROOT))

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [autoapply] %(message)s")
log = logging.getLogger(__name__)

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", secrets.token_hex(32))
CORS(app, supports_credentials=True, origins="*")

# ── Database ──────────────────────────────────────────────────────────────────

def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(str(DB_PATH), check_same_thread=False)
        g.db.row_factory = sqlite3.Row
    return g.db

@app.teardown_appcontext
def close_db(_):
    db = g.pop("db", None)
    if db: db.close()

def init_db():
    db = sqlite3.connect(str(DB_PATH))
    db.executescript("""
    CREATE TABLE IF NOT EXISTS users (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        email           TEXT UNIQUE NOT NULL,
        password_hash   TEXT NOT NULL,
        first_name      TEXT DEFAULT '',
        last_name       TEXT DEFAULT '',
        phone           TEXT DEFAULT '',
        location        TEXT DEFAULT 'United Kingdom',
        api_key         TEXT UNIQUE NOT NULL,
        created_at      TEXT NOT NULL,

        -- Job search prefs
        keywords        TEXT DEFAULT 'compliance analyst',
        search_location TEXT DEFAULT 'London',
        threshold       INTEGER DEFAULT 7,
        email_subject   TEXT DEFAULT 'Job Application',

        -- Credentials (job boards)
        linkedin_email  TEXT DEFAULT '',
        linkedin_pass   TEXT DEFAULT '',
        reed_email      TEXT DEFAULT '',
        reed_pass       TEXT DEFAULT '',
        indeed_email    TEXT DEFAULT '',
        indeed_pass     TEXT DEFAULT '',

        -- Gmail app password for reports
        smtp_password   TEXT DEFAULT '',

        -- Pipeline state
        last_run        TEXT DEFAULT '',
        last_run_status TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL,
        run_id      TEXT NOT NULL,
        started_at  TEXT NOT NULL,
        finished_at TEXT DEFAULT '',
        status      TEXT DEFAULT 'running',
        jobs_found  INTEGER DEFAULT 0,
        jobs_applied INTEGER DEFAULT 0,
        report_json TEXT DEFAULT '',
        specialty_id INTEGER DEFAULT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS specialties (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         INTEGER NOT NULL,
        name            TEXT NOT NULL,
        slug            TEXT NOT NULL,
        keywords        TEXT DEFAULT '',
        search_location TEXT DEFAULT '',
        threshold       INTEGER DEFAULT 7,
        created_at      TEXT NOT NULL,
        UNIQUE(user_id, slug),
        FOREIGN KEY(user_id) REFERENCES users(id)
    );
    """)
    # Migrate existing DBs — add new columns if missing
    existing = {r[1] for r in db.execute("PRAGMA table_info(users)").fetchall()}
    for col, defn in [
        ("linkedin_email", "TEXT DEFAULT ''"),
        ("reed_email",     "TEXT DEFAULT ''"),
        ("indeed_email",   "TEXT DEFAULT ''"),
    ]:
        if col not in existing:
            db.execute(f"ALTER TABLE users ADD COLUMN {col} {defn}")
    existing_run_cols = {r[1] for r in db.execute("PRAGMA table_info(runs)").fetchall()}
    if "specialty_id" not in existing_run_cols:
        db.execute("ALTER TABLE runs ADD COLUMN specialty_id INTEGER DEFAULT NULL")
    db.commit()
    db.close()
    log.info(f"DB ready: {DB_PATH}")

# ── Auth helpers ──────────────────────────────────────────────────────────────

def _hash(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()

def _user_dir(user_id: int) -> Path:
    d = DATA_DIR / "users" / str(user_id)
    d.mkdir(parents=True, exist_ok=True)
    (d / ".tmp").mkdir(exist_ok=True)
    return d

def _specialty_dir(user_id: int, slug: str) -> Path:
    d = _user_dir(user_id) / "specialties" / slug
    d.mkdir(parents=True, exist_ok=True)
    return d

def _extract_cv_profile(cv_path: Path, user, keywords: str, location: str) -> str:
    """Extract text from a .docx CV and return a candidate_profile.md string."""
    from docx import Document as DocxDocument
    doc = DocxDocument(str(cv_path))
    cv_text = "\n".join(p.text for p in doc.paragraphs if p.text.strip())
    return f"""## Personal Info
- Name: {user['first_name']} {user['last_name']}
- Email: {user['email']}
- Phone: {user.get('phone','') or ''}
- Location: {user.get('location','United Kingdom') or 'United Kingdom'}

## Target Roles
- Job titles: {keywords}
- Work arrangement: Hybrid
- Right to work in UK: Yes

## Full CV Text
{cv_text}
"""

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if "user_id" not in session:
            if request.path.startswith("/api/"):
                return jsonify({"error": "Unauthorized"}), 401
            return redirect(url_for("login_page"))
        return f(*args, **kwargs)
    return decorated

def api_key_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        key = request.headers.get("X-API-Key") or request.args.get("api_key", "")
        db  = get_db()
        row = db.execute("SELECT * FROM users WHERE api_key=?", (key,)).fetchone()
        if not row:
            return jsonify({"error": "Unauthorized"}), 401
        g.api_user = dict(row)
        return f(*args, **kwargs)
    return decorated

def current_user():
    if "user_id" not in session:
        return None
    db  = get_db()
    row = db.execute("SELECT * FROM users WHERE id=?", (session["user_id"],)).fetchone()
    return dict(row) if row else None

# ── HTML helpers ──────────────────────────────────────────────────────────────

def _page(title, body, user=None, extra_head=""):
    nav_links = (
        f'<a href="/dashboard">Dashboard</a>'
        f'<a href="/profile">Profile</a>'
        f'<a href="/logout" style="color:#f87171;">Sign out</a>'
    ) if user else (
        f'<a href="/login">Log in</a>'
        f'<a href="/signup" class="btn-nav">Get started free</a>'
    )
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} · ApplyExpress</title>
{extra_head}
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;color:#1e293b;line-height:1.6}}
a{{color:#3b82f6;text-decoration:none}}a:hover{{text-decoration:underline}}
nav{{background:#fff;border-bottom:1px solid #e2e8f0;padding:0 32px;display:flex;align-items:center;justify-content:space-between;height:60px;position:sticky;top:0;z-index:100}}
.nav-brand{{font-weight:800;font-size:18px;color:#1e293b;letter-spacing:-.5px}}
.nav-links{{display:flex;gap:24px;align-items:center;font-size:14px}}
.btn-nav{{background:#3b82f6;color:#fff!important;padding:8px 18px;border-radius:8px;font-weight:600}}
.btn-nav:hover{{background:#2563eb;text-decoration:none!important}}
.container{{max-width:860px;margin:0 auto;padding:40px 20px}}
.card{{background:#fff;border-radius:14px;box-shadow:0 1px 4px rgba(0,0,0,.08);padding:32px;margin-bottom:24px}}
h1{{font-size:28px;font-weight:800;margin-bottom:6px}}
h2{{font-size:20px;font-weight:700;margin-bottom:16px;color:#1e293b}}
h3{{font-size:15px;font-weight:700;margin-bottom:10px;color:#334155}}
.label{{font-size:13px;font-weight:600;color:#475569;margin-bottom:5px;display:block}}
input[type=text],input[type=email],input[type=password],input[type=tel],input[type=file],select,textarea{{width:100%;padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#1e293b;outline:none;transition:.15s}}
input:focus,select:focus,textarea:focus{{border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.15)}}
textarea{{resize:vertical;min-height:64px}}
.row{{display:grid;grid-template-columns:1fr 1fr;gap:16px}}
.field{{margin-bottom:16px}}
.btn{{display:inline-flex;align-items:center;justify-content:center;padding:11px 24px;border-radius:9px;font-size:14px;font-weight:700;cursor:pointer;border:none;transition:.15s}}
.btn-primary{{background:#3b82f6;color:#fff}}.btn-primary:hover{{background:#2563eb}}
.btn-success{{background:#10b981;color:#fff}}.btn-success:hover{{background:#059669}}
.btn-outline{{background:#fff;color:#374151;border:1px solid #d1d5db}}.btn-outline:hover{{background:#f9fafb}}
.btn-danger{{background:#ef4444;color:#fff}}.btn-danger:hover{{background:#dc2626}}
.btn-full{{width:100%}}
.badge{{display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600}}
.badge-green{{background:#d1fae5;color:#065f46}}
.badge-yellow{{background:#fef3c7;color:#92400e}}
.badge-red{{background:#fee2e2;color:#991b1b}}
.badge-blue{{background:#dbeafe;color:#1e40af}}
.badge-gray{{background:#f1f5f9;color:#64748b}}
.alert{{padding:12px 16px;border-radius:8px;font-size:13px;margin-bottom:20px}}
.alert-error{{background:#fee2e2;color:#991b1b;border:1px solid #fca5a5}}
.alert-success{{background:#d1fae5;color:#065f46;border:1px solid #6ee7b7}}
.alert-info{{background:#dbeafe;color:#1e40af;border:1px solid #93c5fd}}
.stat-row{{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:24px}}
.stat{{background:#fff;border-radius:12px;padding:20px 24px;box-shadow:0 1px 4px rgba(0,0,0,.07);text-align:center}}
.stat-num{{font-size:32px;font-weight:800;color:#3b82f6;line-height:1}}
.stat-label{{font-size:12px;color:#94a3b8;margin-top:4px}}
table{{width:100%;border-collapse:collapse;font-size:13px}}
th{{padding:10px 12px;text-align:left;border-bottom:2px solid #e2e8f0;font-weight:600;color:#475569}}
td{{padding:10px 12px;border-bottom:1px solid #f1f5f9;vertical-align:top}}
tr:hover td{{background:#f8fafc}}
.mono{{font-family:monospace;font-size:12px;background:#f1f5f9;padding:10px 14px;border-radius:6px;word-break:break-all}}
footer{{text-align:center;padding:32px;color:#94a3b8;font-size:12px}}
.info-tip{{background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:12px 16px;font-size:13px;color:#1e40af;margin-bottom:16px}}
</style>
</head>
<body>
<nav>
  <a class="nav-brand" href="/">🚀 ApplyExpress</a>
  <div class="nav-links">{nav_links}</div>
</nav>
{body}
<footer>ApplyExpress © {datetime.now().year} · Low-cost AI job application automation</footer>
</html>"""


# ── Landing page ──────────────────────────────────────────────────────────────

@app.route("/")
def landing():
    u = current_user()
    if u:
        return redirect(url_for("dashboard"))
    body = """
    <div style="background:linear-gradient(135deg,#1e40af,#4f46e5);color:#fff;padding:80px 20px;text-align:center">
      <h1 style="font-size:48px;font-weight:900;color:#fff;margin-bottom:16px">
        Apply to 10× more jobs.<br>In half the time.
      </h1>
      <p style="font-size:18px;opacity:.85;max-width:540px;margin:0 auto 32px">
        ApplyExpress tailors your CV for every role, writes a personalised cover letter,
        and applies automatically — then emails you the full report.
      </p>
      <a href="/signup" class="btn" style="font-size:16px;padding:14px 36px;background:#fff;color:#1e40af;font-weight:800">
        Get started free →
      </a>
    </div>

    <div class="container">
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin:48px 0">
        <div class="card" style="text-align:center">
          <div style="font-size:40px;margin-bottom:12px">📄</div>
          <h3>Tailored CV per job</h3>
          <p style="font-size:13px;color:#64748b">Every application gets a unique CV with a rewritten summary aligned to that specific role. Your base CV is never sent as-is.</p>
        </div>
        <div class="card" style="text-align:center">
          <div style="font-size:40px;margin-bottom:12px">✉️</div>
          <h3>Auto cover letters</h3>
          <p style="font-size:13px;color:#64748b">AI writes a 3-paragraph cover letter for each job using your experience and the job description. No templates, no clichés.</p>
        </div>
        <div class="card" style="text-align:center">
          <div style="font-size:40px;margin-bottom:12px">📬</div>
          <h3>Full report by email</h3>
          <p style="font-size:13px;color:#64748b">After every run you receive an email with a table of all jobs applied to, their status, and every tailored CV attached.</p>
        </div>
      </div>

      <div class="card">
        <h2 style="text-align:center;margin-bottom:24px">How it works</h2>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px">
          <div>
            <div style="background:#dbeafe;color:#1e40af;font-weight:800;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin-bottom:10px">1</div>
            <h3>Sign up &amp; upload your CV</h3>
            <p style="font-size:13px;color:#64748b">Create an account, upload your master CV (.docx), and tell us what kinds of roles you're looking for.</p>
          </div>
          <div>
            <div style="background:#d1fae5;color:#065f46;font-weight:800;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin-bottom:10px">2</div>
            <h3>Run the pipeline</h3>
            <p style="font-size:13px;color:#64748b">Click "Run now" — ApplyExpress searches job boards, scores each role against your profile, and generates tailored applications.</p>
          </div>
          <div>
            <div style="background:#fce7f3;color:#9d174d;font-weight:800;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin-bottom:10px">3</div>
            <h3>Get your report</h3>
            <p style="font-size:13px;color:#64748b">A full HTML report lands in your inbox with every application listed, all tailored CVs attached, and next steps for manual ones.</p>
          </div>
        </div>
      </div>

      <div style="text-align:center;margin:40px 0">
        <a href="/signup" class="btn btn-primary" style="font-size:16px;padding:14px 40px">Create your free account →</a>
      </div>
    </div>"""
    return _page("AI Job Applications on Autopilot", body)


# ── Auth ──────────────────────────────────────────────────────────────────────

@app.route("/signup", methods=["GET", "POST"])
def signup():
    error = ""
    if request.method == "POST":
        first  = request.form.get("first_name", "").strip()
        last   = request.form.get("last_name",  "").strip()
        email  = request.form.get("email",  "").strip().lower()
        pwd    = request.form.get("password", "")
        keywords = request.form.get("keywords", "").strip()
        location = request.form.get("location", "London").strip()

        if not all([first, last, email, pwd]):
            error = "All fields are required."
        elif len(pwd) < 6:
            error = "Password must be at least 6 characters."
        else:
            db  = get_db()
            exists = db.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
            if exists:
                error = "An account with that email already exists."
            else:
                api_key = f"aa-{secrets.token_urlsafe(24)}"
                db.execute("""
                    INSERT INTO users
                      (email, password_hash, first_name, last_name, api_key,
                       keywords, search_location, email_subject, created_at)
                    VALUES (?,?,?,?,?,?,?,?,?)
                """, (email, _hash(pwd), first, last, api_key,
                      keywords or "compliance analyst", location,
                      (keywords.split(",")[0].strip().title() if keywords else "Job Application"),
                      datetime.utcnow().isoformat()))
                db.commit()
                row = db.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
                session["user_id"] = row["id"]
                return redirect(url_for("dashboard") + "?welcome=1")

    form = f"""
    <div class="container" style="max-width:480px">
      <div class="card">
        <h2>Create your account</h2>
        {"<div class='alert alert-error'>"+error+"</div>" if error else ""}
        <form method="POST">
          <div class="row">
            <div class="field"><label class="label">First name</label>
              <input type="text" name="first_name" required placeholder="Alice"></div>
            <div class="field"><label class="label">Last name</label>
              <input type="text" name="last_name" required placeholder="Smith"></div>
          </div>
          <div class="field"><label class="label">Email address</label>
            <input type="email" name="email" required placeholder="alice@gmail.com"></div>
          <div class="field"><label class="label">Password</label>
            <input type="password" name="password" required placeholder="At least 6 characters"></div>
          <div class="field"><label class="label">Job titles you want <span style="font-weight:400;color:#94a3b8">(comma-separated)</span></label>
            <input type="text" name="keywords" placeholder="e.g. AML Compliance, MLRO, Risk Analyst"></div>
          <div class="field"><label class="label">Location</label>
            <input type="text" name="location" value="London"></div>
          <button type="submit" class="btn btn-primary btn-full" style="margin-top:8px">Create account →</button>
        </form>
        <p style="font-size:13px;color:#64748b;margin-top:16px;text-align:center">
          Already have an account? <a href="/login">Log in</a>
        </p>
      </div>
    </div>"""
    return _page("Sign up", form)


@app.route("/login", methods=["GET", "POST"])
def login_page():
    error = ""
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        pwd   = request.form.get("password", "")
        db    = get_db()
        row   = db.execute("SELECT * FROM users WHERE email=? AND password_hash=?",
                           (email, _hash(pwd))).fetchone()
        if row:
            session["user_id"] = row["id"]
            return redirect(url_for("dashboard"))
        error = "Invalid email or password."

    form = f"""
    <div class="container" style="max-width:420px">
      <div class="card">
        <h2>Log in</h2>
        {"<div class='alert alert-error'>"+error+"</div>" if error else ""}
        <form method="POST">
          <div class="field"><label class="label">Email</label>
            <input type="email" name="email" required autofocus></div>
          <div class="field"><label class="label">Password</label>
            <input type="password" name="password" required></div>
          <button type="submit" class="btn btn-primary btn-full">Log in →</button>
        </form>
        <p style="font-size:13px;color:#64748b;margin-top:16px;text-align:center">
          No account? <a href="/signup">Sign up free</a>
        </p>
      </div>
    </div>"""
    return _page("Log in", form)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("landing"))


# ── One-click extension connect ───────────────────────────────────────────────

@app.route("/connect/<token>")
def connect_extension(token):
    """Opened by dashboard button. content.js detects the meta tag and auto-configures."""
    db  = get_db()
    row = db.execute("SELECT id FROM users WHERE api_key=?", (token,)).fetchone()
    if not row:
        return "Invalid link.", 403
    server_url = request.host_url.rstrip("/")
    return f"""<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta name="applyexpress-connect" data-server-url="{server_url}" data-api-key="{token}">
<title>Connecting ApplyExpress Extension…</title>
<style>body{{font-family:-apple-system,sans-serif;display:flex;flex-direction:column;
align-items:center;justify-content:center;height:100vh;background:#eff6ff;text-align:center;margin:0}}</style>
</head><body>
<div style="font-size:48px;margin-bottom:16px">⏳</div>
<h2 style="color:#1e40af">Connecting extension…</h2>
<p style="color:#64748b">Make sure the ApplyExpress extension is installed in Chrome.</p>
</body></html>"""


# ── Dashboard ─────────────────────────────────────────────────────────────────

@app.route("/dashboard")
@login_required
def dashboard():
    u    = current_user()
    db   = get_db()
    runs = db.execute(
        "SELECT * FROM runs WHERE user_id=? ORDER BY started_at DESC LIMIT 10",
        (u["id"],)
    ).fetchall()

    welcome = '<div class="alert alert-success">🎉 Welcome! Upload your CV and set your preferences to get started.</div>' \
              if request.args.get("welcome") else ""

    # Stats
    total_applied = sum(r["jobs_applied"] for r in runs)
    total_found   = sum(r["jobs_found"]   for r in runs)
    run_count     = len(runs)

    stats = f"""
    <div class="stat-row">
      <div class="stat"><div class="stat-num">{run_count}</div><div class="stat-label">Pipeline runs</div></div>
      <div class="stat"><div class="stat-num">{total_found}</div><div class="stat-label">Jobs found</div></div>
      <div class="stat"><div class="stat-num">{total_applied}</div><div class="stat-label">Applications sent</div></div>
    </div>"""

    # CV status
    cv_path = _user_dir(u["id"]) / "cv.docx"
    cv_status = (
        f'<span class="badge badge-green">✓ CV uploaded</span>'
        if cv_path.exists() else
        f'<span class="badge badge-red">No CV — <a href="/profile#cv">upload one</a></span>'
    )

    # Run button — with specialty picker if user has specialties
    dash_specialties = db.execute(
        "SELECT * FROM specialties WHERE user_id=? ORDER BY name", (u["id"],)).fetchall()
    spec_options = '<option value="">— Default CV —</option>' + \
        "".join(f'<option value="{s["id"]}">{s["name"]}</option>' for s in dash_specialties)
    run_btn = f"""
    <form action="/run" method="POST" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <select name="specialty_id"
        style="padding:8px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;background:#fff">
        {spec_options}
      </select>
      <button type="submit" class="btn btn-success">▶ Run now</button>
    </form>"""

    # Last run status
    last_run_badge = ""
    if runs:
        last = runs[0]
        status_map = {"running":"badge-blue","completed":"badge-green","failed":"badge-red","interrupted":"badge-yellow"}
        cls = status_map.get(last["status"], "badge-gray")
        last_run_badge = f'Last run: <span class="badge {cls}">{last["status"]}</span> · {last["started_at"][:16]}'

    # Runs table
    rows_html = ""
    for r in runs:
        status_map = {"running":"badge-blue","completed":"badge-green","failed":"badge-red","interrupted":"badge-yellow"}
        cls = status_map.get(r["status"], "badge-gray")
        view_link = f'<a href="/run/{r["id"]}">View →</a>' if r["report_json"] else ""
        rows_html += f"""<tr>
          <td>{r["started_at"][:16]}</td>
          <td><span class="badge {cls}">{r["status"]}</span></td>
          <td>{r["jobs_found"]}</td>
          <td>{r["jobs_applied"]}</td>
          <td>{view_link}</td>
        </tr>"""
    runs_table = f"""
    <table><thead><tr><th>Date</th><th>Status</th><th>Jobs found</th><th>Applied</th><th></th></tr></thead>
    <tbody>{rows_html if rows_html else '<tr><td colspan=5 style="color:#94a3b8;text-align:center;padding:20px">No runs yet. Click "Run now" to start.</td></tr>'}</tbody></table>"""

    body = f"""
    <div class="container">
      {welcome}
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px">
        <div>
          <h1>Hi, {u["first_name"]} 👋</h1>
          <p style="color:#64748b;font-size:14px">{cv_status} &nbsp;·&nbsp; {last_run_badge}</p>
        </div>
        {run_btn}
      </div>
      {stats}
      <div class="card">
        <h2>Recent runs</h2>
        {runs_table}
      </div>
      <div class="card" style="text-align:center;padding:32px 40px">
        <div style="font-size:40px;margin-bottom:12px">🔌</div>
        <h2 style="margin-bottom:8px">Connect the Chrome Extension</h2>
        <p style="font-size:14px;color:#64748b;max-width:420px;margin:0 auto 24px">
          Click the button below — it will open a page that automatically configures
          the extension with your server and API key. No copying or pasting needed.
        </p>
        <a href="/connect/{u["api_key"]}" target="_blank"
           class="btn btn-primary" style="font-size:15px;padding:13px 32px">
          Connect extension in one click →
        </a>
        <p style="font-size:12px;color:#94a3b8;margin-top:16px">
          Make sure the ApplyExpress extension is installed in Chrome before clicking.
          After connecting, press <strong>Start</strong> in the extension popup to begin applying.
        </p>
      </div>
    </div>"""

    # Auto-refresh every 8s while a run is active
    is_running = runs and runs[0]["status"] == "running"
    extra_head = '<meta http-equiv="refresh" content="8">' if is_running else ""
    return _page("Dashboard", body, user=u, extra_head=extra_head)


# ── Run detail ────────────────────────────────────────────────────────────────

@app.route("/run/<int:run_db_id>")
@login_required
def run_detail(run_db_id):
    u  = current_user()
    db = get_db()
    r  = db.execute("SELECT * FROM runs WHERE id=? AND user_id=?", (run_db_id, u["id"])).fetchone()
    if not r:
        return redirect(url_for("dashboard"))

    report = json.loads(r["report_json"]) if r["report_json"] else {"jobs": []}
    jobs   = report.get("jobs", [])

    status_map = {"running":"badge-blue","completed":"badge-green","failed":"badge-red","interrupted":"badge-yellow"}
    cls = status_map.get(r["status"], "badge-gray")

    cards = ""
    for j in jobs:
        score   = j.get("score", "—")
        cv_name = Path(j["cv_docx"]).name if j.get("cv_docx") else "original CV"
        notes   = j.get("notes", "") or ""
        cl_text = ""
        if j.get("cover_letter_path") and Path(j["cover_letter_path"]).exists():
            cl_text = Path(j["cover_letter_path"]).read_text().strip()
        cl_html = (
            f'<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;'
            f'padding:16px;font-size:13px;line-height:1.7;white-space:pre-wrap;margin-top:8px">'
            f'{cl_text}</div>'
        ) if cl_text else '<p style="font-size:13px;color:#94a3b8;margin-top:8px">No cover letter generated.</p>'
        score_color = "#15803d" if isinstance(score, int) and score >= 8 else "#b45309" if isinstance(score, int) and score >= 6 else "#dc2626"
        notes_html  = f'<p style="font-size:12px;color:#f59e0b;margin-top:8px">⚠ {notes}</p>' if notes else ""
        cards += f"""
        <div class="card" style="margin-bottom:20px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px">
            <div>
              <h3 style="margin:0 0 4px">{j.get('title','—')}</h3>
              <p style="font-size:13px;color:#64748b;margin:0">{j.get('company','—')} · {j.get('source','')}
                &nbsp;·&nbsp; <a href="{j.get('url','#')}" target="_blank">View job →</a></p>
            </div>
            <div style="text-align:right">
              <div style="font-size:28px;font-weight:800;color:{score_color}">{score}<span style="font-size:14px;color:#94a3b8">/10</span></div>
              <div style="font-size:11px;color:#94a3b8">match score</div>
            </div>
          </div>
          {notes_html}
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0">
          <p style="font-size:12px;color:#64748b;margin-bottom:12px">
            <strong>Tailored CV:</strong> <code style="background:#f1f5f9;padding:2px 6px;border-radius:4px">{cv_name}</code>
          </p>
          <p style="font-size:13px;font-weight:600;margin:0 0 4px">Cover letter</p>
          {cl_html}
        </div>"""

    spec_badge = ""
    if r["specialty_id"]:
        spec_row = db.execute("SELECT name FROM specialties WHERE id=?", (r["specialty_id"],)).fetchone()
        spec_badge = f'<span class="badge badge-blue">{spec_row["name"] if spec_row else "Specialty"}</span>'

    body = f"""
    <div class="container" style="max-width:800px">
      <p style="margin-bottom:16px"><a href="/dashboard">← Dashboard</a></p>
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:24px;flex-wrap:wrap">
        <h1 style="margin:0">Run {r["started_at"][:16]}</h1>
        <span class="badge {cls}">{r["status"]}</span>
        {spec_badge}
      </div>
      <div class="stat-row" style="margin-bottom:24px">
        <div class="stat"><div class="stat-num">{r["jobs_found"]}</div><div class="stat-label">Jobs found</div></div>
        <div class="stat"><div class="stat-num">{r["jobs_applied"]}</div><div class="stat-label">Processed</div></div>
        <div class="stat"><div class="stat-num">{len(jobs)}</div><div class="stat-label">CVs tailored</div></div>
      </div>
      {"<p style='color:#94a3b8;text-align:center;padding:40px'>No job details available for this run.</p>" if not jobs else cards}
    </div>"""
    return _page(f"Run {r['started_at'][:10]}", body, user=u)


# ── Profile / settings ────────────────────────────────────────────────────────

@app.route("/profile", methods=["GET", "POST"])
@login_required
def profile():
    u   = current_user()
    db  = get_db()
    msg = ""

    if request.method == "POST":
        action = request.form.get("action", "profile")

        if action == "profile":
            db.execute("""UPDATE users SET first_name=?,last_name=?,phone=?,location=?,
                          keywords=?,search_location=?,threshold=?,email_subject=?
                          WHERE id=?""",
                (request.form.get("first_name","").strip(),
                 request.form.get("last_name","").strip(),
                 request.form.get("phone","").strip(),
                 request.form.get("location","").strip(),
                 request.form.get("keywords","").strip(),
                 request.form.get("search_location","").strip(),
                 int(request.form.get("threshold", 7)),
                 request.form.get("keywords","Job Application").split(",")[0].strip().title(),
                 u["id"]))
            db.commit()
            msg = "Profile saved."
            u = current_user()

        elif action == "cv":
            cv_file = request.files.get("cv")
            if cv_file and cv_file.filename.endswith(".docx"):
                cv_path = _user_dir(u["id"]) / "cv.docx"
                cv_file.save(str(cv_path))
                try:
                    profile_text_content = _extract_cv_profile(cv_path, u, u["keywords"], u["search_location"])
                    (_user_dir(u["id"]) / "candidate_profile.md").write_text(profile_text_content)
                    msg = "CV uploaded and profile updated from CV content."
                except Exception as e:
                    msg = f"CV uploaded. (Profile extraction failed: {e})"
            else:
                msg = "Please upload a .docx file."

        elif action == "add_specialty":
            spec_name  = request.form.get("specialty_name","").strip()
            spec_slug  = re.sub(r"[^\w]", "_", spec_name.lower()).strip("_")[:30]
            spec_kw    = request.form.get("spec_keywords", u["keywords"]).strip()
            spec_loc   = request.form.get("spec_location", u["search_location"]).strip()
            spec_thr   = int(request.form.get("spec_threshold", u["threshold"]) or u["threshold"])
            if spec_name and spec_slug:
                db.execute("""INSERT OR IGNORE INTO specialties
                    (user_id,name,slug,keywords,search_location,threshold,created_at)
                    VALUES (?,?,?,?,?,?,?)""",
                    (u["id"], spec_name, spec_slug, spec_kw, spec_loc, spec_thr,
                     datetime.utcnow().isoformat()))
                db.commit()
                sdir    = _specialty_dir(u["id"], spec_slug)
                cv_file = request.files.get("specialty_cv")
                if cv_file and cv_file.filename.endswith(".docx"):
                    cv_path = sdir / "cv.docx"
                    cv_file.save(str(cv_path))
                    try:
                        (sdir / "profile.md").write_text(
                            _extract_cv_profile(cv_path, u, spec_kw, spec_loc))
                    except Exception:
                        pass
                msg = f'Specialty "{spec_name}" added.'
            else:
                msg = "Please enter a specialty name."

        elif action == "upload_specialty_cv":
            spec_id = request.form.get("spec_id","")
            spec    = db.execute("SELECT * FROM specialties WHERE id=? AND user_id=?",
                                 (spec_id, u["id"])).fetchone() if spec_id else None
            if spec:
                sdir    = _specialty_dir(u["id"], spec["slug"])
                cv_file = request.files.get("specialty_cv")
                if cv_file and cv_file.filename.endswith(".docx"):
                    cv_path = sdir / "cv.docx"
                    cv_file.save(str(cv_path))
                    try:
                        (sdir / "profile.md").write_text(
                            _extract_cv_profile(cv_path, u, spec["keywords"], spec["search_location"]))
                    except Exception:
                        pass
                    msg = f'CV updated for "{spec["name"]}".'
                else:
                    msg = "Please upload a .docx file."
            else:
                msg = "Specialty not found."

        elif action == "save_specialty_profile":
            spec_id = request.form.get("spec_id","")
            spec    = db.execute("SELECT * FROM specialties WHERE id=? AND user_id=?",
                                 (spec_id, u["id"])).fetchone() if spec_id else None
            if spec:
                (_specialty_dir(u["id"], spec["slug"]) / "profile.md").write_text(
                    request.form.get("profile_text","").replace("\r\n","\n"))
                msg = f'Profile saved for "{spec["name"]}".'
            else:
                msg = "Specialty not found."

        elif action == "delete_specialty":
            spec_id = request.form.get("spec_id","")
            spec    = db.execute("SELECT * FROM specialties WHERE id=? AND user_id=?",
                                 (spec_id, u["id"])).fetchone() if spec_id else None
            if spec:
                import shutil
                shutil.rmtree(str(_specialty_dir(u["id"], spec["slug"])), ignore_errors=True)
                db.execute("DELETE FROM specialties WHERE id=?", (spec_id,))
                db.commit()
                msg = f'Specialty "{spec["name"]}" deleted.'

        elif action == "profile_text":
            profile_path = _user_dir(u["id"]) / "candidate_profile.md"
            profile_path.write_text(request.form.get("profile_text", "").replace("\r\n", "\n"))
            msg = "Profile content saved."

        elif action == "credentials":
            db.execute("""UPDATE users SET smtp_password=?,
                          linkedin_email=?,linkedin_pass=?,
                          reed_email=?,reed_pass=?,
                          indeed_email=?,indeed_pass=?
                          WHERE id=?""",
                (request.form.get("smtp_password","").strip(),
                 request.form.get("linkedin_email","").strip(),
                 request.form.get("linkedin_pass","").strip(),
                 request.form.get("reed_email","").strip(),
                 request.form.get("reed_pass","").strip(),
                 request.form.get("indeed_email","").strip(),
                 request.form.get("indeed_pass","").strip(),
                 u["id"]))
            db.commit()
            msg = "Credentials saved."
            u = current_user()

    profile_md_path = _user_dir(u["id"]) / "candidate_profile.md"
    profile_md_text = profile_md_path.read_text() if profile_md_path.exists() else ""
    specialties_list = db.execute(
        "SELECT * FROM specialties WHERE user_id=? ORDER BY name", (u["id"],)).fetchall()

    cv_path   = _user_dir(u["id"]) / "cv.docx"
    cv_status = (
        f'<span class="badge badge-green">✓ {cv_path.stat().st_size // 1024}KB uploaded '
        f'({datetime.fromtimestamp(cv_path.stat().st_mtime).strftime("%d %b %Y")})</span>'
        if cv_path.exists() else
        '<span class="badge badge-yellow">No CV uploaded yet</span>'
    )

    alert = f'<div class="alert alert-success">{msg}</div>' if msg else ""

    body = f"""
    <div class="container" style="max-width:640px">
      {alert}
      <h1 style="margin-bottom:24px">Settings</h1>

      <!-- Profile -->
      <div class="card">
        <h2>Your details</h2>
        <form method="POST">
          <input type="hidden" name="action" value="profile">
          <div class="row">
            <div class="field"><label class="label">First name</label>
              <input type="text" name="first_name" value="{u['first_name']}" required></div>
            <div class="field"><label class="label">Last name</label>
              <input type="text" name="last_name" value="{u['last_name']}" required></div>
          </div>
          <div class="field"><label class="label">Phone</label>
            <input type="tel" name="phone" value="{u['phone']}" placeholder="+447700900000"></div>
          <div class="field"><label class="label">Location (for profile)</label>
            <input type="text" name="location" value="{u['location']}"></div>
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0">
          <h3>Job search preferences</h3>
          <div class="field"><label class="label">Job titles / keywords <span style="font-weight:400;color:#94a3b8">(comma-separated)</span></label>
            <input type="text" name="keywords" value="{u['keywords']}"></div>
          <div class="row">
            <div class="field"><label class="label">Search location</label>
              <input type="text" name="search_location" value="{u['search_location']}"></div>
            <div class="field"><label class="label">Minimum match score (1-10)</label>
              <input type="number" name="threshold" value="{u['threshold']}" min="1" max="10"></div>
          </div>
          <button type="submit" class="btn btn-primary">Save profile</button>
        </form>
      </div>

      <!-- CV upload -->
      <div class="card" id="cv">
        <h2>Your CV</h2>
        <p style="margin-bottom:16px;font-size:14px">{cv_status}</p>
        <form method="POST" enctype="multipart/form-data">
          <input type="hidden" name="action" value="cv">
          <div class="field">
            <label class="label">Upload master CV (.docx)</label>
            <input type="file" name="cv" accept=".docx" required>
          </div>
          <button type="submit" class="btn btn-primary">Upload CV</button>
        </form>
      </div>

      <!-- Specialties -->
      <div class="card" id="specialties">
        <h2>Specialties <span style="font-weight:400;font-size:14px;color:#64748b">(multiple CVs for different roles)</span></h2>
        <p style="font-size:13px;color:#64748b;margin-bottom:20px">
          Add a specialty for each type of role you apply to. Each specialty has its own CV, profile, keywords, and location.
          Choose which specialty to use when you click "Run now" on the dashboard.
        </p>

        {''.join(f"""
        <div style="border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:16px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px">
            <div>
              <strong style="font-size:15px">{s['name']}</strong>
              <span style="font-size:12px;color:#94a3b8;margin-left:8px">({s['slug']})</span><br>
              <span style="font-size:13px;color:#64748b">Keywords: {s['keywords'] or '—'} &nbsp;·&nbsp; Location: {s['search_location'] or '—'} &nbsp;·&nbsp; Threshold: {s['threshold']}/10</span><br>
              <span style="font-size:12px;color:#94a3b8">CV: {'✓ uploaded' if (_specialty_dir(u['id'], s['slug']) / 'cv.docx').exists() else '✗ not uploaded'}</span>
            </div>
            <form method="POST" style="display:inline">
              <input type="hidden" name="action" value="delete_specialty">
              <input type="hidden" name="spec_id" value="{s['id']}">
              <button type="submit" style="background:#fee2e2;color:#dc2626;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:13px"
                onclick="return confirm('Delete {s['name']}?')">Delete</button>
            </form>
          </div>
          <details style="margin-top:14px">
            <summary style="cursor:pointer;font-size:13px;color:#3b82f6;font-weight:600">Edit profile content</summary>
            <form method="POST" style="margin-top:10px">
              <input type="hidden" name="action" value="save_specialty_profile">
              <input type="hidden" name="spec_id" value="{s['id']}">
              <textarea name="profile_text" rows="12"
                style="width:100%;font-family:monospace;font-size:12px;line-height:1.6;border:1px solid #e2e8f0;border-radius:8px;padding:12px;resize:vertical">{((_specialty_dir(u['id'], s['slug']) / 'profile.md').read_text() if (_specialty_dir(u['id'], s['slug']) / 'profile.md').exists() else '')}</textarea>
              <button type="submit" class="btn btn-primary" style="margin-top:8px">Save profile</button>
            </form>
          </details>
          <details style="margin-top:8px">
            <summary style="cursor:pointer;font-size:13px;color:#3b82f6;font-weight:600">Replace CV</summary>
            <form method="POST" enctype="multipart/form-data" style="margin-top:10px;display:flex;gap:8px;align-items:center">
              <input type="hidden" name="action" value="upload_specialty_cv">
              <input type="hidden" name="spec_id" value="{s['id']}">
              <input type="file" name="specialty_cv" accept=".docx" required style="font-size:13px">
              <button type="submit" class="btn btn-primary">Upload</button>
            </form>
          </details>
        </div>""" for s in specialties_list)}

        <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0">
        <h3 style="margin-bottom:16px">Add a new specialty</h3>
        <form method="POST" enctype="multipart/form-data">
          <input type="hidden" name="action" value="add_specialty">
          <div class="field"><label class="label">Specialty name</label>
            <input type="text" name="specialty_name" placeholder="e.g. Field Engineer, Project Manager, Data Analyst" required></div>
          <div class="row">
            <div class="field"><label class="label">Keywords <span style="font-weight:400;color:#94a3b8">(comma-separated)</span></label>
              <input type="text" name="spec_keywords" value="{u['keywords']}" placeholder="e.g. field engineer, maintenance"></div>
            <div class="field"><label class="label">Search location</label>
              <input type="text" name="spec_location" value="{u['search_location']}"></div>
          </div>
          <div class="field" style="max-width:200px"><label class="label">Min score (1–10)</label>
            <input type="number" name="spec_threshold" value="{u['threshold']}" min="1" max="10"></div>
          <div class="field"><label class="label">CV for this specialty (.docx)</label>
            <input type="file" name="specialty_cv" accept=".docx"></div>
          <button type="submit" class="btn btn-primary">Add specialty</button>
        </form>
      </div>

      <!-- Profile content (extracted from CV) -->
      <div class="card" id="profile-content">
        <h2>Profile content <span style="font-weight:400;font-size:14px;color:#64748b">(used for scoring &amp; cover letters)</span></h2>
        <p style="font-size:13px;color:#64748b;margin-bottom:16px">
          This is automatically populated when you upload your CV. Review it and correct anything the AI should know about you —
          your real skills, experience, and career history. The more detail here, the better the job matching and cover letters.
        </p>
        <form method="POST">
          <input type="hidden" name="action" value="profile_text">
          <div class="field">
            <textarea name="profile_text" rows="18"
              style="width:100%;font-family:monospace;font-size:12px;line-height:1.6;
                     border:1px solid #e2e8f0;border-radius:8px;padding:12px;resize:vertical"
              placeholder="Upload your CV above — your profile will be extracted here automatically.">{profile_md_text}</textarea>
          </div>
          <button type="submit" class="btn btn-primary">Save profile content</button>
        </form>
      </div>

      <!-- Credentials -->
      <div class="card">
        <h2>Email &amp; job board credentials</h2>
        <div class="info-tip">
          <b>📬 Gmail App Password <span style="font-weight:400">(optional)</span>:</b>
          If you want reports emailed to <strong>{u['email']}</strong> after each run,
          go to <a href="https://myaccount.google.com/apppasswords" target="_blank">myaccount.google.com/apppasswords</a>
          → create one called "ApplyExpress" → paste the 16-char code below.
          You can skip this and still run the pipeline — results will appear on your dashboard.
        </div>
        <form method="POST">
          <input type="hidden" name="action" value="credentials">
          <div class="field"><label class="label">Gmail App Password <span style="font-weight:400;color:#94a3b8">(optional — leave blank to skip email reports)</span></label>
            <input type="password" name="smtp_password" value="{u['smtp_password']}" placeholder="xxxx xxxx xxxx xxxx"></div>

          <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0">
          <p style="font-size:13px;color:#64748b;margin-bottom:16px">Enter your username and password for each job board you want to auto-apply on. Leave blank to skip that board.</p>

          <label class="label" style="margin-bottom:8px">LinkedIn</label>
          <div class="row">
            <div class="field"><label class="label" style="font-weight:400">Username / Email</label>
              <input type="email" name="linkedin_email" value="{u['linkedin_email']}" placeholder="your@email.com"></div>
            <div class="field"><label class="label" style="font-weight:400">Password</label>
              <input type="password" name="linkedin_pass" value="{u['linkedin_pass']}" placeholder="Leave blank to skip"></div>
          </div>

          <label class="label" style="margin-bottom:8px">Reed.co.uk</label>
          <div class="row">
            <div class="field"><label class="label" style="font-weight:400">Username / Email</label>
              <input type="email" name="reed_email" value="{u['reed_email']}" placeholder="your@email.com"></div>
            <div class="field"><label class="label" style="font-weight:400">Password</label>
              <input type="password" name="reed_pass" value="{u['reed_pass']}" placeholder="Leave blank to skip"></div>
          </div>

          <label class="label" style="margin-bottom:8px">Indeed</label>
          <div class="row">
            <div class="field"><label class="label" style="font-weight:400">Username / Email</label>
              <input type="email" name="indeed_email" value="{u['indeed_email']}" placeholder="your@email.com"></div>
            <div class="field"><label class="label" style="font-weight:400">Password</label>
              <input type="password" name="indeed_pass" value="{u['indeed_pass']}" placeholder="Leave blank to skip"></div>
          </div>
          <button type="submit" class="btn btn-primary">Save credentials</button>
        </form>
      </div>
    </div>"""
    return _page("Settings", body, user=u)


# ── Pipeline trigger ──────────────────────────────────────────────────────────

def _run_pipeline_bg(user_id: int, run_db_id: int):
    """Background thread: fetch → score → tailor → cover letter → email report."""
    import sqlite3 as _sq3

    conn = _sq3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = _sq3.Row

    def update(status, **kw):
        sets = ", ".join(f"{k}=?" for k in kw)
        vals = list(kw.values()) + [run_db_id]
        conn.execute(f"UPDATE runs SET {sets} WHERE id=?", vals)
        conn.commit()

    try:
        u = dict(conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone())
        user_dir = _user_dir(user_id)
        tmp_dir  = user_dir / ".tmp"

        # Write a temporary .env-like env for the tools
        env_patch = {
            "CANDIDATE_FIRST_NAME": u["first_name"],
            "CANDIDATE_LAST_NAME":  u["last_name"],
            "CANDIDATE_EMAIL":      u["email"],
            "CANDIDATE_PHONE":      u["phone"],
            "CV_PATH":              str(user_dir / "cv.docx"),
            "TMP_DIR":              str(tmp_dir),
            "CANDIDATE_PROFILE_PATH": str(user_dir / "candidate_profile.md"),
            "JOB_SEARCH_KEYWORDS":  u["keywords"],
            "JOB_SEARCH_LOCATION":  u["search_location"],
            "SCORE_THRESHOLD":      str(u["threshold"]),
            "EMAIL_SUBJECT_PREFIX": u["email_subject"] or "Job Application",
            "SMTP_EMAIL":           u["email"],
            "SMTP_PASSWORD":        u["smtp_password"],
            "SMTP_TO":              u["email"],
            "LINKEDIN_EMAIL":       u["linkedin_email"] or u["email"],
            "LINKEDIN_PASSWORD":    u["linkedin_pass"],
            "REED_EMAIL":           u["reed_email"] or u["email"],
            "REED_PASSWORD":        u["reed_pass"],
            "INDEED_EMAIL":         u["indeed_email"] or u["email"],
            "INDEED_PASSWORD":      u["indeed_pass"],
        }
        # Patch environment for this thread
        os.environ.update({k: v or "" for k, v in env_patch.items()})

        # Write candidate_profile.md if missing
        profile_path = user_dir / "candidate_profile.md"
        if not profile_path.exists():
            profile_path.write_text(f"""## Personal Info
- Name: {u['first_name']} {u['last_name']}
- Email: {u['email']}
- Phone: {u['phone'] or ''}
- Location: {u['location'] or 'United Kingdom'}

## Target Roles
- Job titles: {u['keywords']}
- Work arrangement: Hybrid
- Seniority level:
- Salary expectations:
- Right to work in UK: Yes

## CV Summary
(Auto-generated on first run.)

## Career Goals
- Seeking: {u['keywords']}
- Location: {u['search_location']}
""")

        run_id = conn.execute("SELECT run_id FROM runs WHERE id=?", (run_db_id,)).fetchone()["run_id"]

        # ── 1. Fetch ──────────────────────────────────────────────────────────
        update(status="running", jobs_found=0)
        from tools.fetch_jobs import fetch_all_jobs
        jobs_raw = fetch_all_jobs(
            u["keywords"],
            u["search_location"],
            int(os.getenv("JOB_SEARCH_COUNT", "15"))
        )
        (tmp_dir / "jobs_raw.json").write_text(json.dumps(jobs_raw, indent=2))
        update(status="running", jobs_found=len(jobs_raw))

        # ── 2. Score ──────────────────────────────────────────────────────────
        from tools.score_job import score_job
        profile_text = profile_path.read_text()
        threshold    = u["threshold"]
        scored = []
        for job in jobs_raw:
            try:
                result = score_job(job, profile_text)
                job["score"] = result.get("score", 0)
                job["score_reason"] = result.get("reason", "")
            except Exception as e:
                job["score"] = 0
                job["score_reason"] = str(e)
            scored.append(job)
            time.sleep(2)  # Groq free tier: ~30 req/min — 2s gap keeps well within limit

        (tmp_dir / "jobs_scored.json").write_text(json.dumps(scored, indent=2))
        qualifying = [j for j in scored if j["score"] >= threshold]
        # Cap at 5 jobs to keep runtime under 15 minutes on Groq free tier
        qualifying = sorted(qualifying, key=lambda j: j["score"], reverse=True)[:5]

        if not qualifying:
            update(status="completed", finished_at=datetime.utcnow().isoformat(),
                   jobs_applied=0, report_json=json.dumps({"jobs": [], "run_id": run_id}))
            conn.close()
            return

        # ── 3. Tailor CV + cover letter ───────────────────────────────────────
        from tools.tailor_cv_docx    import tailor_cv_docx
        from tools.generate_cv_pdf   import generate_cv_pdf
        from tools.generate_cover_letter import generate_cover_letter

        def _slug(t, n=22):
            return re.sub(r"[^\w]", "_", t.lower())[:n].strip("_")

        report = {"run_id": run_id, "keywords": u["keywords"],
                  "location": u["search_location"], "threshold": threshold, "jobs": []}

        for job in qualifying:
            title   = job.get("title", "Unknown")
            company = job.get("company", "Unknown")
            desc    = job.get("description", "")

            record = {
                "title": title, "company": company,
                "url": job.get("url",""), "source": job.get("source",""),
                "score": job.get("score", 0),
                "cv_docx": None, "cv_pdf": None, "cover_letter_path": None,
                "status": "needs_review", "ats": "unknown", "notes": "",
            }

            cv_out = str(tmp_dir / f"cv_{_slug(company)}_{_slug(title)}.docx")
            try:
                tailor_cv_docx(title, company, desc, cv_out)
                record["cv_docx"] = cv_out
            except Exception as e:
                record["cv_docx"] = str(user_dir / "cv.docx")
                record["notes"] += f"CV tailor error: {e}. "

            if record["cv_docx"]:
                pdf_out = record["cv_docx"].replace(".docx", ".pdf")
                try:
                    generate_cv_pdf(record["cv_docx"], pdf_out)
                    record["cv_pdf"] = pdf_out
                except Exception as e:
                    record["notes"] += f"PDF error: {e}. "

            time.sleep(2)  # gap between tailor and cover letter LLM calls
            cl_out = str(tmp_dir / f"cl_{_slug(company)}_{_slug(title)}.txt")
            try:
                cover_letter = generate_cover_letter(job, profile_text)
                Path(cl_out).write_text(cover_letter)
                record["cover_letter_path"] = cl_out
            except Exception as e:
                record["notes"] += f"Cover letter error: {e}. "

            report["jobs"].append(record)
            time.sleep(2)  # gap between jobs

        # ── 4. Save report + email ────────────────────────────────────────────
        report_path = tmp_dir / f"application_report_{run_id}.json"
        report_path.write_text(json.dumps(report, indent=2))

        if u["smtp_password"]:
            try:
                from tools.send_application_report import send_report
                send_report(report)
                log.info(f"Report emailed to {u['email']}")
            except Exception as e:
                log.warning(f"Email failed: {e}")

        applied = len([j for j in report["jobs"] if j["status"] != "needs_review"])
        update(status="completed", finished_at=datetime.utcnow().isoformat(),
               jobs_applied=len(qualifying), report_json=report_path.read_text())

    except Exception as e:
        log.error(f"Pipeline failed for user {user_id}: {e}")
        try:
            update(status="failed", finished_at=datetime.utcnow().isoformat())
        except Exception:
            pass
    finally:
        conn.close()


@app.route("/run", methods=["POST"])
@login_required
def trigger_run():
    u            = current_user()
    db           = get_db()
    specialty_id = request.form.get("specialty_id","").strip() or None

    # Determine which CV to check
    if specialty_id:
        spec     = db.execute("SELECT * FROM specialties WHERE id=? AND user_id=?",
                              (specialty_id, u["id"])).fetchone()
        cv_check = _specialty_dir(u["id"], spec["slug"]) / "cv.docx" if spec else None
        if not cv_check or not cv_check.exists():
            return redirect(url_for("profile") + "#specialties")
    else:
        if not (_user_dir(u["id"]) / "cv.docx").exists():
            return redirect(url_for("profile") + "#cv")

    run_id = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    row = db.execute("""
        INSERT INTO runs (user_id, run_id, started_at, status, specialty_id)
        VALUES (?,?,?,?,?) RETURNING id
    """, (u["id"], run_id, datetime.utcnow().isoformat(), "running", specialty_id)).fetchone()
    db.commit()
    run_db_id = row["id"]

    import subprocess
    worker = Path(__file__).parent / "tools" / "run_pipeline_worker.py"
    subprocess.Popen(
        [sys.executable, str(worker), str(u["id"]), str(run_db_id),
         str(DB_PATH), str(ROOT), str(specialty_id or "")],
        start_new_session=True,
        stdout=open(str(DATA_DIR / f"pipeline_{run_db_id}.log"), "w"),
        stderr=subprocess.STDOUT,
    )

    return redirect(url_for("dashboard") + "?running=1")


# ── Chrome Extension API ──────────────────────────────────────────────────────

@app.route("/api/health")
def api_health():
    return jsonify({"status": "ok", "service": "ApplyExpress SaaS"})


@app.route("/api/profile")
@api_key_required
def api_profile():
    u = g.api_user
    return jsonify({
        "firstName": u["first_name"], "lastName":  u["last_name"],
        "fullName":  f"{u['first_name']} {u['last_name']}".strip(),
        "email":     u["email"],      "phone":     u["phone"],
    })


@app.route("/api/cv")
@api_key_required
def api_cv():
    import base64
    u       = g.api_user
    cv_path = _user_dir(u["id"]) / "cv.docx"
    if not cv_path.exists():
        return jsonify({"error": "No CV uploaded"}), 404
    mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    data = base64.b64encode(cv_path.read_bytes()).decode("utf-8")
    return jsonify({"filename": cv_path.name, "mime": mime,
                    "data": f"data:{mime};base64,{data}", "size": cv_path.stat().st_size})


@app.route("/api/credentials")
@api_key_required
def api_credentials():
    u = g.api_user
    return jsonify({"reed": {"email": u["email"], "password": u["reed_pass"] or ""}})


@app.route("/api/jobs")
@api_key_required
def api_jobs():
    u       = g.api_user
    limit   = int(request.args.get("limit", 20))
    tmp_dir = _user_dir(u["id"]) / ".tmp"
    scored  = tmp_dir / "jobs_scored.json"

    if not scored.exists():
        return jsonify({"jobs": [], "count": 0,
                        "note": "No jobs yet. Trigger a run from your dashboard."})
    try:
        all_jobs = json.loads(scored.read_text())
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    result = []
    for i, job in enumerate(all_jobs[:limit]):
        if job.get("score", 0) < u["threshold"]:
            continue
        result.append({
            "row": i + 2, "title": job.get("title",""),
            "company": job.get("company",""), "location": job.get("location",""),
            "url": job.get("url",""), "score": job.get("score",0),
            "cover_letter": job.get("cover_letter",""),
            "status": "Pending Review", "_state": "pending",
        })
    return jsonify({"jobs": result, "count": len(result)})


@app.route("/api/update_status", methods=["POST"])
@api_key_required
def api_update_status():
    # In sheet-free mode just acknowledge (local JSON is source of truth)
    data = request.get_json(force=True) or {}
    log.info(f"Status update: row={data.get('row')} → {data.get('status')}")
    return jsonify({"success": True})


@app.route("/privacy")
def privacy_policy():
    return """<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy Policy — ApplyExpress</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 24px;color:#1e293b;line-height:1.7}
  h1{color:#1d4ed8}h2{margin-top:2em;color:#1e40af}
  a{color:#1d4ed8}
</style></head><body>
<h1>Privacy Policy</h1>
<p><strong>Last updated: April 2026</strong></p>

<h2>1. Overview</h2>
<p>ApplyExpress ("we", "us") provides a Chrome extension and web platform that helps users auto-fill
job applications. This policy explains what data we collect, why, and how it is used.</p>

<h2>2. Data We Collect</h2>
<ul>
  <li><strong>Account data</strong>: email address and hashed password, stored securely in our database.</li>
  <li><strong>Profile data</strong>: name, phone number, and job preferences you enter in your profile.</li>
  <li><strong>CV / resume</strong>: the document you upload is stored on our server solely to auto-fill applications on your behalf.</li>
  <li><strong>Application activity</strong>: a log of jobs applied to, scores, and pipeline results, visible only to you.</li>
</ul>

<h2>3. Data We Do NOT Collect</h2>
<ul>
  <li>We do not track browsing history.</li>
  <li>We do not sell, share, or transfer your data to third parties.</li>
  <li>We do not use your data for advertising or creditworthiness purposes.</li>
  <li>The Chrome extension stores only your server URL and API key in <code>chrome.storage.local</code> on your device.</li>
</ul>

<h2>4. How Data Is Used</h2>
<p>Your data is used exclusively to operate the ApplyExpress service: filling in your name, email,
phone, and CV on job application forms you choose to apply to.</p>

<h2>5. Data Retention</h2>
<p>Your data is retained while your account is active. You may delete your account and all associated
data at any time by contacting us.</p>

<h2>6. Security</h2>
<p>Passwords are hashed before storage. All connections use HTTPS. CV files are stored in a
private directory not accessible to other users.</p>

<h2>7. Contact</h2>
<p>For questions about this policy, email:
<a href="mailto:support@applyexpress.io">support@applyexpress.io</a></p>
</body></html>"""


@app.route("/api/log", methods=["POST"])
@api_key_required
def api_log():
    data = request.get_json(force=True) or {}
    log.info(f"[EXT] {data.get('level','info').upper()}: {data.get('message','')}")
    return jsonify({"ok": True})


# ── Boot ──────────────────────────────────────────────────────────────────────
# init_db() runs at import time so gunicorn workers also create the schema
init_db()

# Mark any runs that were "running" when the server last died as interrupted
def _cleanup_orphaned_runs():
    try:
        db = sqlite3.connect(str(DB_PATH))
        db.execute(
            "UPDATE runs SET status='interrupted', finished_at=? WHERE status='running'",
            (datetime.utcnow().isoformat(),)
        )
        db.commit()
        db.close()
    except Exception:
        pass

_cleanup_orphaned_runs()

if __name__ == "__main__":
    port = int(os.getenv("PORT", "5001"))
    log.info(f"ApplyExpress SaaS starting on http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, debug=False)
