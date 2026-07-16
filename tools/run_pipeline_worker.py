"""
Standalone pipeline worker — runs as a detached subprocess so it survives gunicorn restarts.

Usage (called by app.py):
    python3 tools/run_pipeline_worker.py <user_id> <run_db_id> <db_path> <root_path> [specialty_id]
"""

import sys, os, json, time, re, logging
from pathlib import Path
from datetime import datetime, timedelta

def _dec(ciphertext: str) -> str:
    """Decrypt a Fernet-encrypted credential. Falls back to plaintext if key missing."""
    if not ciphertext:
        return ""
    try:
        from cryptography.fernet import Fernet
        key = os.getenv("CREDENTIAL_KEY", "").encode()
        if not key:
            return ciphertext
        if not ciphertext.startswith("gAAAAA"):
            return ciphertext  # plaintext (pre-migration)
        return Fernet(key).decrypt(ciphertext.encode()).decode()
    except Exception:
        return ""

logging.basicConfig(level=logging.INFO, format="%(asctime)s [pipeline] %(message)s")
log = logging.getLogger(__name__)

def main():
    if len(sys.argv) < 5:
        print("Usage: run_pipeline_worker.py <user_id> <run_db_id> <db_path> <root_path> [specialty_id]")
        sys.exit(1)

    user_id      = int(sys.argv[1])
    run_db_id    = int(sys.argv[2])
    db_path      = sys.argv[3]
    root_path    = sys.argv[4]
    specialty_id = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] else None

    # Add project root to path so tools/ imports work
    sys.path.insert(0, root_path)
    os.chdir(root_path)

    # Load root .env for LLM keys
    from dotenv import load_dotenv
    load_dotenv(Path(root_path) / ".env")

    import sqlite3
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row

    def update(**kw):
        sets = ", ".join(f"{k}=?" for k in kw)
        vals = list(kw.values()) + [run_db_id]
        conn.execute(f"UPDATE runs SET {sets} WHERE id=?", vals)
        conn.commit()

    def user_dir(uid):
        d = Path(db_path).parent / "users" / str(uid)
        d.mkdir(parents=True, exist_ok=True)
        (d / ".tmp").mkdir(exist_ok=True)
        return d

    try:
        u = dict(conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone())
        udir   = user_dir(user_id)
        tmpdir = udir / ".tmp"

        # Resolve specialty paths if a specialty was selected
        if specialty_id:
            spec = conn.execute("SELECT * FROM specialties WHERE id=?", (specialty_id,)).fetchone()
            if spec:
                spec = dict(spec)
                sdir             = udir / "specialties" / spec["slug"]
                cv_path_use      = str(sdir / "cv.docx")
                profile_path_use = str(sdir / "profile.md")
                keywords_use     = spec["keywords"] or u["keywords"]
                location_use     = spec["search_location"] or u["search_location"]
                threshold_use    = spec["threshold"]
                log.info(f"Running with specialty: {spec['name']} (slug={spec['slug']})")
            else:
                specialty_id = None  # fallback to default if specialty not found

        if not specialty_id:
            cv_path_use      = str(udir / "cv.docx")
            profile_path_use = str(udir / "candidate_profile.md")
            keywords_use     = u["keywords"]
            location_use     = u["search_location"]
            threshold_use    = u["threshold"]
            log.info("Running with default CV and profile")

        # Patch environment for tools
        os.environ.update({k: v or "" for k, v in {
            "CANDIDATE_FIRST_NAME": u["first_name"],
            "CANDIDATE_LAST_NAME":  u["last_name"],
            "CANDIDATE_EMAIL":      u["email"],
            "CANDIDATE_PHONE":      u.get("phone", ""),
            "CV_PATH":              cv_path_use,
            "TMP_DIR":              str(tmpdir),
            "CANDIDATE_PROFILE_PATH": profile_path_use,
            "JOB_SEARCH_KEYWORDS":  keywords_use,
            "JOB_SEARCH_LOCATION":  location_use,
            "SCORE_THRESHOLD":      str(threshold_use),
            "EMAIL_SUBJECT_PREFIX": u.get("email_subject") or "Job Application",
            "SMTP_EMAIL":           u["email"],
            "SMTP_PASSWORD":        _dec(u.get("smtp_password", "")),
            "SMTP_TO":              u["email"],
            "LINKEDIN_EMAIL":       u.get("linkedin_email") or u["email"],
            "LINKEDIN_PASSWORD":    _dec(u.get("linkedin_pass", "")),
            "REED_EMAIL":           u.get("reed_email") or u["email"],
            "REED_PASSWORD":        _dec(u.get("reed_pass", "")),
            "INDEED_EMAIL":         u.get("indeed_email") or u["email"],
            "INDEED_PASSWORD":      _dec(u.get("indeed_pass", "")),
            "TWOCAPTCHA_API_KEY":   u.get("twocaptcha_key", ""),
        }.items()})

        # Write profile if missing
        profile_path = Path(profile_path_use)
        if not profile_path.exists():
            profile_path.write_text(f"""## Personal Info
- Name: {u['first_name']} {u['last_name']}
- Email: {u['email']}
- Phone: {u.get('phone') or ''}
- Location: {u.get('location') or 'United Kingdom'}

## Target Roles
- Job titles: {keywords_use}
- Work arrangement: Hybrid
- Right to work in UK: Yes

## Career Goals
- Seeking: {keywords_use}
- Location: {location_use}
""")

        run_id = conn.execute("SELECT run_id FROM runs WHERE id=?", (run_db_id,)).fetchone()["run_id"]
        log.info(f"Pipeline started: user={user_id} run={run_id}")

        # ── 1. Fetch ──────────────────────────────────────────────────────────
        update(status="running", jobs_found=0)
        from tools.fetch_jobs import fetch_all_jobs
        _sess_dir = Path(db_path).parent / "users" / str(user_id) / "sessions"
        _indeed_cookies = str(_sess_dir / "indeed.json") if (_sess_dir / "indeed.json").exists() else ""
        jobs_raw = fetch_all_jobs(keywords_use, location_use,
                                  int(os.getenv("JOB_SEARCH_COUNT", "15")),
                                  indeed_cookies=_indeed_cookies)
        (tmpdir / "jobs_raw.json").write_text(json.dumps(jobs_raw, indent=2))
        update(status="running", jobs_found=len(jobs_raw))
        log.info(f"Fetched {len(jobs_raw)} jobs")

        # Only skip jobs that were SUCCESSFULLY applied — "Needs Review" jobs should be retried
        applied_urls = set(
            r[0] for r in conn.execute(
                "SELECT url FROM applications WHERE user_id=? AND url != '' AND status='applied'",
                (user_id,)
            ).fetchall()
        )
        jobs_raw = [j for j in jobs_raw if j.get("url", "") not in applied_urls]
        if not jobs_raw:
            update(status="completed", finished_at=datetime.utcnow().isoformat(),
                   jobs_applied=0, report_json='{"jobs":[],"note":"all jobs already applied"}')
            conn.close()
            log.info("All fetched jobs already applied this run — no new jobs")
            return
        log.info(f"After duplicate filter: {len(jobs_raw)} new jobs to score")

        # ── 2. Score ──────────────────────────────────────────────────────────
        from tools.score_job import score_job
        import random as _random
        profile_text = profile_path.read_text()[:1500]   # cap to keep Groq tokens low
        threshold    = threshold_use
        # Interleave sources before capping so Greenhouse/Ashby jobs get scored
        # (Reed alone can fill 100+ slots — without shuffling, direct-apply ATS
        # jobs never reach the scorer, and every run applies only to Reed listings
        # that have no Quick Apply, wasting time and producing 0 auto-submits).
        _by_source = {}
        for _j in jobs_raw:
            _by_source.setdefault(_j.get("source", "other"), []).append(_j)
        _interleaved = []
        while any(_by_source.values()):
            for _src in list(_by_source.keys()):
                if _by_source[_src]:
                    _interleaved.append(_by_source[_src].pop(0))
        jobs_raw = _interleaved
        jobs_to_score = jobs_raw[:50]
        if len(jobs_raw) > 50:
            log.info(f"Capping scoring at 50 of {len(jobs_raw)} fetched jobs (interleaved by source)")

        # Score cache — the same jobs come back from the boards run after run,
        # and re-scoring them burns the daily LLM budget (the #1 cause of runs
        # ending with 0 applies). Cache per user+specialty for 7 days.
        conn.execute("""CREATE TABLE IF NOT EXISTS job_scores (
            user_id      INTEGER NOT NULL,
            specialty_id TEXT    NOT NULL DEFAULT '',
            url          TEXT    NOT NULL,
            score        INTEGER NOT NULL,
            reason       TEXT    DEFAULT '',
            scored_at    TEXT    NOT NULL,
            PRIMARY KEY (user_id, specialty_id, url)
        )""")
        conn.commit()
        _spec_key = str(specialty_id or "")
        _cache_cutoff = (datetime.utcnow() - timedelta(days=7)).isoformat()

        scored = []
        _cache_hits = 0
        for job in jobs_to_score:
            _url = job.get("url", "")
            cached = conn.execute(
                "SELECT score, reason FROM job_scores WHERE user_id=? AND specialty_id=? AND url=? AND scored_at > ?",
                (user_id, _spec_key, _url, _cache_cutoff)).fetchone() if _url else None
            if cached:
                job["score"] = cached["score"]
                job["score_reason"] = cached["reason"]
                _cache_hits += 1
                scored.append(job)
                continue
            try:
                result = score_job(job, profile_text)
                job["score"] = result.get("score", 0)
                job["score_reason"] = result.get("reason", "")
                if _url:
                    conn.execute(
                        "INSERT OR REPLACE INTO job_scores (user_id, specialty_id, url, score, reason, scored_at) VALUES (?,?,?,?,?,?)",
                        (user_id, _spec_key, _url, job["score"], job["score_reason"][:300],
                         datetime.utcnow().isoformat()))
                    conn.commit()
            except Exception as e:
                # Do NOT cache failures — scoring must be retried when the LLM recovers
                job["score"] = 0
                job["score_reason"] = str(e)
            scored.append(job)
            time.sleep(2)   # 2s between calls keeps us under Groq TPM
        if _cache_hits:
            log.info(f"Score cache: {_cache_hits}/{len(jobs_to_score)} jobs served from cache")

        (tmpdir / "jobs_scored.json").write_text(json.dumps(scored, indent=2))
        qualifying = [j for j in scored if j["score"] >= threshold]
        qualifying = sorted(qualifying, key=lambda j: j["score"], reverse=True)[:15]

        # Guarantee LinkedIn Easy Apply and Indeed jobs get slots even if outscored by Reed.
        # These are the most automatable sources — Reed descriptions score higher because
        # they include recruiter notes, but LinkedIn/Indeed Easy Apply is faster to submit.
        # nhs jobs can't auto-apply (Trac) but must reach tailoring so they land
        # in the sponsor-review digest with a CV + cover letter attached
        _PLATFORM_RESERVE = {"linkedin": 3, "indeed": 2, "nhs": 3}
        _qualifying_urls = {j.get("url", "") for j in qualifying}
        for _src, _slots in _PLATFORM_RESERVE.items():
            _src_in_qualifying = sum(1 for j in qualifying if j.get("source") == _src)
            _needed = _slots - _src_in_qualifying
            if _needed > 0:
                _candidates = [
                    j for j in scored
                    if j.get("source") == _src
                    and j.get("score", 0) >= max(threshold - 2, 1)
                    and j.get("url", "") not in _qualifying_urls
                ]
                _candidates.sort(key=lambda j: j["score"], reverse=True)
                for _j in _candidates[:_needed]:
                    qualifying.append(_j)
                    _qualifying_urls.add(_j.get("url", ""))
                    log.info(f"Reserved slot for {_src}: {_j.get('title','')} @ {_j.get('company','')} (score={_j.get('score',0)})")

        qualifying = sorted(qualifying, key=lambda j: j["score"], reverse=True)[:18]
        log.info(f"Qualifying jobs: {len(qualifying)} (threshold={threshold})")

        if not qualifying:
            update(status="completed", finished_at=datetime.utcnow().isoformat(),
                   jobs_applied=0, report_json=json.dumps({"jobs": [], "run_id": run_id}))
            conn.close()
            log.info("No qualifying jobs — pipeline complete")
            return

        # ── 3. Tailor CV + cover letter ───────────────────────────────────────
        from tools.tailor_cv_docx        import tailor_cv_docx
        from tools.generate_cv_pdf       import generate_cv_pdf
        from tools.generate_cover_letter import generate_cover_letter

        def _slug(t, n=22):
            return re.sub(r"[^\w]", "_", t.lower())[:n].strip("_")

        report = {"run_id": run_id, "keywords": u["keywords"],
                  "location": u["search_location"], "threshold": threshold, "jobs": []}

        for job in qualifying:
            title   = job.get("title", "Unknown")
            company = job.get("company", "Unknown")
            desc    = job.get("description", "")
            log.info(f"Processing: {title} @ {company}")

            record = {
                "title": title, "company": company,
                "url": job.get("url", ""), "source": job.get("source", ""),
                "score": job.get("score", 0),
                "cv_docx": None, "cv_pdf": None, "cover_letter_path": None,
                "supporting_statement_path": None,
                "status": "needs_review", "ats": "unknown", "notes": "",
            }

            is_nhs = job.get("source") == "nhs"

            # NHS/Trac applications use the structured Trac form + a supporting
            # statement — they take no CV or cover letter, so skip both (saves
            # LLM budget) and produce only the anonymised supporting statement.
            if is_nhs:
                try:
                    from tools.generate_supporting_statement import generate_supporting_statement
                    cv_text = ""
                    try:
                        from docx import Document as _Doc
                        cv_text = "\n".join(p.text for p in _Doc(str(udir / "cv.docx")).paragraphs if p.text.strip())
                    except Exception:
                        pass
                    stmt = generate_supporting_statement(
                        job, profile_text, cv_text,
                        first_name=u.get("first_name", ""), last_name=u.get("last_name", ""))
                    ss_out = str(tmpdir / f"supporting_statement_{_slug(company)}_{_slug(title)}.txt")
                    Path(ss_out).write_text(stmt)
                    record["supporting_statement_path"] = ss_out
                    log.info(f"Supporting statement generated for NHS role: {title} @ {company}")
                except Exception as e:
                    record["notes"] += f"Supporting statement error: {e}. "
                report["jobs"].append(record)
                time.sleep(2)
                continue

            cv_out = str(tmpdir / f"cv_{_slug(company)}_{_slug(title)}.docx")
            try:
                tailor_cv_docx(title, company, desc, cv_out)
                record["cv_docx"] = cv_out
            except Exception as e:
                record["cv_docx"] = str(udir / "cv.docx")
                record["notes"] += f"CV tailor error: {e}. "

            if record["cv_docx"]:
                pdf_out = record["cv_docx"].replace(".docx", ".pdf")
                try:
                    generate_cv_pdf(record["cv_docx"], pdf_out)
                    # A healthy CV PDF is >4KB; ~1.5KB means no extractable
                    # content — submit the .docx instead of a blank PDF.
                    if os.path.getsize(pdf_out) < 2500:
                        record["notes"] += "PDF looked empty — submitting .docx instead. "
                        log.warning(f"Blank CV PDF detected ({os.path.getsize(pdf_out)}B) for {title} @ {company} — falling back to docx")
                    else:
                        record["cv_pdf"] = pdf_out
                except Exception as e:
                    record["notes"] += f"PDF error: {e}. "

            time.sleep(2)
            cl_out = str(tmpdir / f"cl_{_slug(company)}_{_slug(title)}.txt")
            try:
                cover_letter = generate_cover_letter(job, profile_text)
                Path(cl_out).write_text(cover_letter)
                record["cover_letter_path"] = cl_out
            except Exception as e:
                record["notes"] += f"Cover letter error: {e}. "

            report["jobs"].append(record)
            time.sleep(2)

        # ── 4. Submit applications server-side via Playwright (headless) ─────────
        import subprocess as _sp

        def _send_sponsor_digest(matches: list, smtp_email: str, smtp_password: str):
            """Send one batched email after the run listing all visa-sponsor matches."""
            import smtplib
            from email.mime.multipart import MIMEMultipart
            from email.mime.text import MIMEText
            from email.mime.base import MIMEBase
            from email import encoders as _enc2

            n = len(matches)
            msg = MIMEMultipart("mixed")
            msg["Subject"] = f"Visa Sponsor Matches: {n} job{'s' if n != 1 else ''} found — {datetime.utcnow().strftime('%d %b %Y')}"
            msg["From"]    = smtp_email
            msg["To"]      = smtp_email

            rows_html = ""
            for i, (record, canonical) in enumerate(matches, 1):
                bg = '#f9f4ff' if i % 2 == 1 else '#ffffff'
                rows_html += f"""
<tr style="background:{bg}">
  <td style="padding:10px;font-weight:bold;font-size:15px" colspan="2">
    {i}. {record['title']} &mdash; {record['company']}
    <span style="font-weight:normal;color:#6200ea;font-size:12px">(registered: {canonical})</span>
  </td>
</tr>
<tr style="background:{bg}">
  <td style="padding:4px 10px;color:#555;width:90px">Score</td>
  <td style="padding:4px 10px">{record.get('score','?')}/10</td>
</tr>
<tr style="background:{bg}">
  <td style="padding:4px 10px 10px;color:#555">Apply at</td>
  <td style="padding:4px 10px 10px"><a href="{record['url']}" style="color:#1976d2">{record['url']}</a></td>
</tr>""" + (f"""
<tr style="background:{bg}">
  <td style="padding:4px 10px 10px;color:#555">NHS statement</td>
  <td style="padding:4px 10px 10px;color:#388e3c">&#9989; Anonymised supporting statement attached (paste into the Trac form)</td>
</tr>""" if record.get("supporting_statement_path") else "")

            html = f"""<html><body style="font-family:Arial,sans-serif;color:#222;max-width:640px">
<h2 style="color:#6200ea">&#127919; Visa Sponsor Report — {n} match{'es' if n != 1 else ''} this run</h2>
<p>The following jobs were found at <strong>UK-licensed visa sponsors</strong>.<br>
<strong style="color:#d32f2f">None were auto-submitted.</strong>
Relevant documents are attached per role — tailored CV and cover letter for standard
employers; an anonymised supporting statement for NHS/Trac roles (which take no CV).
Apply manually using the links below.</p>
<table style="border-collapse:collapse;width:100%;margin:16px 0;border:1px solid #e0e0e0">
{rows_html}
</table>
<h3 style="color:#388e3c">How to apply for each role:</h3>
<ol>
  <li>Find the matching CV and cover letter in the attachments (named by company)</li>
  <li>For NHS roles, open the attached supporting statement — it is anonymised (no name or personal details, as Trac requires) and written against the job's person specification. Log in to Trac, use "populate from a previous application" for your history and referees, and paste the statement into the supporting-information box.</li>
  <li>Click the job link and apply directly</li>
</ol>
<p style="color:#757575;font-size:12px;margin-top:24px">
  All {n} job{'s are' if n != 1 else ' is'} logged as <em>sponsor_review</em> in your ApplyExpress dashboard.
</p>
</body></html>"""
            msg.attach(MIMEText(html, "html"))

            seen_files: set = set()
            for record, _ in matches:
                for path_key in ("cv_docx", "cv_pdf", "cover_letter_path", "supporting_statement_path"):
                    fpath = record.get(path_key) or ""
                    if fpath and fpath not in seen_files and Path(fpath).exists():
                        seen_files.add(fpath)
                        with open(fpath, "rb") as f:
                            part = MIMEBase("application", "octet-stream")
                            part.set_payload(f.read())
                        _enc2.encode_base64(part)
                        part.add_header("Content-Disposition", "attachment",
                                        filename=Path(fpath).name)
                        msg.attach(part)

            try:
                with smtplib.SMTP("smtp.gmail.com", 587) as srv:
                    srv.starttls()
                    srv.login(smtp_email, smtp_password)
                    srv.sendmail(smtp_email, smtp_email, msg.as_string())
                log.info(f"Sponsor digest sent: {n} match(es)")
            except Exception as mail_err:
                log.warning(f"Sponsor digest email failed: {mail_err}")

        def _route_apply(job_url: str) -> list:
            """Return the Node script and extra args for this job URL."""
            u_lower = job_url.lower()
            if "greenhouse.io" in u_lower:
                return ["node", "tools/apply_greenhouse_playwright.js"]
            if "lever.co" in u_lower:
                return ["node", "tools/apply_lever_playwright.js"]
            if "reed.co.uk" in u_lower:
                return ["node", "tools/apply_reed_playwright.js"]
            if "indeed" in u_lower:
                return ["node", "tools/apply_indeed.js"]
            if "linkedin.com" in u_lower:
                return ["node", "tools/apply_linkedin.js"]
            if "workable.com" in u_lower or "ashbyhq.com" in u_lower or "totaljobs.com" in u_lower:
                return ["node", "tools/apply_job.js"]
            return None  # unsupported — mark needs_review

        # Session cookie files per platform (uploaded via dashboard)
        sessions_dir = Path(db_path).parent / "users" / str(user_id) / "sessions"
        def _cookies_path(platform: str) -> str:
            p = sessions_dir / f"{platform}.json"
            return str(p) if p.exists() else ""

        applied_count = 0
        sponsor_matches: list = []
        for record in report["jobs"]:
            job_url      = record.get("url", "")
            cv_path      = record.get("cv_pdf") or record.get("cv_docx") or cv_path_use
            cl_path      = record.get("cover_letter_path", "")
            cover_text   = Path(cl_path).read_text() if cl_path and Path(cl_path).exists() else ""
            title        = record.get("title", "")
            company      = record.get("company", "")

            # Skip only if successfully applied or already forwarded as sponsor in a previous run
            if job_url:
                already = conn.execute(
                    "SELECT id FROM applications WHERE user_id=? AND url=? AND status IN ('applied','sponsor_review') AND run_db_id != ?",
                    (user_id, job_url, run_db_id)).fetchone()
                if already:
                    log.info("Skipping duplicate (already applied): %s @ %s", title, company)
                    record["notes"] += "Already applied in a previous run. "
                    record["status"] = "skipped"
                    continue

                # Skip Greenhouse/Ashby jobs that previously failed with security code
                # (requires Gmail App Password — user must set it in profile to unblock)
                if "greenhouse.io" in job_url.lower() or "ashbyhq.com" in job_url.lower():
                    prev = conn.execute(
                        "SELECT notes FROM applications WHERE user_id=? AND url=? AND run_db_id != ? ORDER BY id DESC LIMIT 1",
                        (user_id, job_url, run_db_id)).fetchone()
                    _skip_terms = ("security code", "no smtp", "captcha blocked", "recaptcha required")
                    if prev and prev["notes"] and any(t in prev["notes"].lower() for t in _skip_terms):
                        log.info("Skipping %s @ %s — previously CAPTCHA/security-code blocked", title, company)
                        record["notes"] += "CAPTCHA or email verification blocked previous attempt — needs manual apply. "
                        record["status"] = "skipped"
                        continue

            # ── NHS/Trac jobs: never auto-applied (manual Trac submission). ──
            # Always forward to the review digest with the supporting statement,
            # regardless of sponsor_check or name-matching the sponsor list —
            # every NHS employer is a licensed visa sponsor.
            if record.get("source") == "nhs":
                sponsor_matches.append((record, "NHS (licensed sponsor)"))
                record["status"] = "sponsor_review"
                record["notes"] += "NHS role — supporting statement ready; apply manually via Trac. "
                try:
                    conn.execute(
                        """INSERT OR IGNORE INTO applications
                           (user_id, run_db_id, title, company, url, status, notes, applied_at)
                           VALUES (?,?,?,?,?,?,?,?)""",
                        (user_id, run_db_id, title, company, job_url, "sponsor_review",
                         record.get("notes", "")[:500], datetime.utcnow().isoformat()))
                    conn.commit()
                except Exception as db_err:
                    log.warning(f"DB insert failed for NHS sponsor_review {title}: {db_err}")
                log.info(f"NHS role forwarded for manual Trac apply: {title} @ {company}")
                continue

            # ── Sponsor licence check (only for users with sponsor_check=1) ──
            if u.get("sponsor_check") and record.get("cover_letter_path"):
                try:
                    from tools.sponsor_check import is_sponsor, sponsor_list_loaded
                    if sponsor_list_loaded():
                        matched, canonical = is_sponsor(company)
                        if matched:
                            sponsor_matches.append((record, canonical))
                            record["status"] = "sponsor_review"
                            record["notes"] += f"Visa sponsor match ({canonical}) — forwarded for manual review. "
                            try:
                                conn.execute(
                                    """INSERT OR IGNORE INTO applications
                                       (user_id, run_db_id, title, company, url, status, notes, applied_at)
                                       VALUES (?,?,?,?,?,?,?,?)""",
                                    (user_id, run_db_id, title, company, job_url, "sponsor_review",
                                     record.get("notes", "")[:500], datetime.utcnow().isoformat()))
                                conn.commit()
                            except Exception as db_err:
                                log.warning(f"DB insert failed for sponsor_review {title}: {db_err}")
                            log.info(f"Sponsor match — forwarded for review: {title} @ {company} ({canonical})")
                            continue
                except Exception as sc_err:
                    log.warning(f"Sponsor check error for {company}: {sc_err}")

            cmd_base = _route_apply(job_url)
            if not cmd_base:
                record["notes"] += "Unsupported ATS — needs manual apply. "
                log.info("Skipping unsupported URL: %s", job_url)
                continue

            # Resolve session cookies file for this platform
            u_lower = job_url.lower()
            if "reed.co.uk" in u_lower:
                cookies_file = _cookies_path("reed")
            elif "indeed" in u_lower:
                cookies_file = _cookies_path("indeed")
            elif "linkedin.com" in u_lower:
                cookies_file = _cookies_path("linkedin")
            else:
                cookies_file = ""

            cmd = cmd_base + [
                "--url",          job_url,
                "--cv-path",      cv_path,
                "--cover-letter", cover_text,
                "--first-name",   u["first_name"],
                "--last-name",    u["last_name"],
                "--email",        u["email"],
                "--phone",        u.get("phone", ""),
                "--job-title",    title,
                "--company",      company,
            ]
            if cookies_file:
                cmd += ["--cookies-path", cookies_file]
                log.info(f"Using session cookies: {cookies_file}")

            log.info(f"Submitting [{record.get('source','?')}]: {title} @ {company}")
            try:
                result = _sp.run(
                    cmd, capture_output=True, text=True,
                    timeout=300, cwd=root_path,
                )
                stdout = result.stdout.strip()[-500:]
                stderr = result.stderr.strip()[-300:]
                code   = result.returncode

                if code == 0:
                    record["status"] = "applied"
                    applied_count += 1
                    log.info(f"Applied: {title} @ {company}")
                elif code == 2:
                    record["status"] = "needs_review"
                    record["notes"] += "External ATS redirect — needs manual apply. "
                    log.info(f"External ATS redirect: {title} @ {company}")
                elif code == 3:
                    record["status"] = "needs_review"
                    record["notes"] += "CAPTCHA blocked — needs manual apply. "
                    log.info(f"CAPTCHA blocked: {title} @ {company}")
                else:
                    record["status"] = "needs_review"
                    # JS scripts log to stdout (console.log), Python to stderr — capture both
                    detail = (stderr or stdout)[-200:]
                    record["notes"] += f"Apply failed (exit {code}): {detail}. "
                    log.warning(f"Apply failed exit={code}: {title} @ {company} | {detail}")

            except _sp.TimeoutExpired:
                record["status"] = "needs_review"
                record["notes"] += "Apply timed out after 5 min. "
                log.warning(f"Apply timed out: {title} @ {company}")
            except Exception as e:
                record["status"] = "needs_review"
                record["notes"] += f"Apply error: {e}. "
                log.warning(f"Apply error: {title} @ {company}: {e}")

            # Save to applications table (so History page reflects server-side runs)
            final_status = record.get('status', 'needs_review')
            if final_status == 'applied':
                db_status = 'applied'
            elif final_status == 'sponsor_review':
                db_status = 'sponsor_review'
            else:
                db_status = 'failed'
            try:
                conn.execute(
                    """INSERT OR IGNORE INTO applications
                       (user_id, run_db_id, title, company, url, status, notes, applied_at)
                       VALUES (?,?,?,?,?,?,?,?)""",
                    (user_id, run_db_id, title, company, job_url, db_status,
                     record.get('notes', '')[:500], datetime.utcnow().isoformat()))
                conn.commit()
            except Exception as db_err:
                log.warning(f"DB insert failed for {title}: {db_err}")

            time.sleep(3)

        # ── Detect expired job-board sessions and alert the user (once/day) ──
        _login_markers = ("still on login page", "login_blocked", "auto-login failed",
                          "no saved session", "login page", "captcha detected")
        _dead_platforms = set()
        for record in report["jobs"]:
            n = (record.get("notes") or "").lower()
            if any(m in n for m in _login_markers):
                src = (record.get("source") or "").lower()
                u_lower = (record.get("url") or "").lower()
                if "reed" in src or "reed.co.uk" in u_lower:
                    _dead_platforms.add("Reed")
                elif "linkedin" in src or "linkedin.com" in u_lower:
                    _dead_platforms.add("LinkedIn")
                elif "indeed" in src or "indeed" in u_lower:
                    _dead_platforms.add("Indeed")
        if _dead_platforms:
            _flag = tmpdir / f"session_alert_{datetime.utcnow().strftime('%Y%m%d')}.flag"
            _smtp_pw = _dec(u.get("smtp_password", ""))
            if not _flag.exists() and _smtp_pw:
                try:
                    import smtplib
                    from email.mime.text import MIMEText
                    plats = ", ".join(sorted(_dead_platforms))
                    body = (f"Hi {u['first_name']},\n\n"
                            f"ApplyExpress could not log in to: {plats}.\n"
                            f"Your saved session has expired, so applications on "
                            f"{'these platforms' if len(_dead_platforms) > 1 else 'this platform'} are failing.\n\n"
                            f"To fix it: log in to {plats} in Chrome, then use the ApplyExpress "
                            f"extension (or dashboard > Sessions) to re-upload your session.\n\n"
                            f"— ApplyExpress")
                    msg = MIMEText(body)
                    msg["Subject"] = f"Action needed: {plats} session expired — applications are failing"
                    msg["From"] = u["email"]
                    msg["To"] = u["email"]
                    with smtplib.SMTP("smtp.gmail.com", 587) as srv:
                        srv.starttls()
                        srv.login(u["email"], _smtp_pw)
                        srv.sendmail(u["email"], u["email"], msg.as_string())
                    _flag.write_text(plats)
                    log.info(f"Session-expired alert emailed for: {plats}")
                except Exception as mail_err:
                    log.warning(f"Session-expired alert failed: {mail_err}")
            else:
                log.info(f"Expired sessions detected ({', '.join(sorted(_dead_platforms))}) — alert already sent today or SMTP unset")

        # ── Send batched sponsor digest (one email per pipeline run) ──────────
        if sponsor_matches:
            smtp_em = os.getenv("SMTP_EMAIL", "")
            smtp_pw = os.getenv("SMTP_PASSWORD", "")
            if smtp_em and smtp_pw:
                _send_sponsor_digest(sponsor_matches, smtp_em, smtp_pw)
            else:
                log.warning(f"{len(sponsor_matches)} sponsor match(es) found but SMTP not configured")

        # ── 5. Save report and email ──────────────────────────────────────────
        report_path = tmpdir / f"application_report_{run_id}.json"
        report_path.write_text(json.dumps(report, indent=2))

        # Email is handled by run_sequential_runner.py as one daily digest — not per run

        update(status="completed", finished_at=datetime.utcnow().isoformat(),
               jobs_applied=applied_count,
               report_json=report_path.read_text())
        log.info(f"Pipeline complete: {applied_count} applied, "
                 f"{len(report['jobs']) - applied_count} needs review")

    except Exception as e:
        log.error(f"Pipeline failed for user {user_id}: {e}", exc_info=True)
        try:
            update(status="failed", finished_at=datetime.utcnow().isoformat())
        except Exception:
            pass
    finally:
        conn.close()


if __name__ == "__main__":
    main()
