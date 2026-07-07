#!/usr/bin/env python3
"""
run_scheduled.py — Scheduled pipeline runner for ApplyExpress.
Each user's pipeline chain (default + specialties) runs in parallel with
other users. Within a user, runs are sequential (to share Groq token budget).
"""
import sys, os, sqlite3, subprocess, logging
from datetime import datetime
from pathlib import Path

ROOT    = Path("/opt/applyexpress")
DB_PATH = ROOT / "data" / "autoapply.db"
LOG_DIR = ROOT / "data"

logging.basicConfig(level=logging.INFO, format="%(asctime)s [scheduler] %(message)s")
log = logging.getLogger(__name__)

sys.path.insert(0, str(ROOT))
os.chdir(str(ROOT))

from dotenv import load_dotenv
load_dotenv(ROOT / ".env")

db = sqlite3.connect(str(DB_PATH))
db.row_factory = sqlite3.Row

users = db.execute(
    """SELECT id FROM users
       WHERE keywords IS NOT NULL AND keywords != ''
         AND (is_paid = 1 OR (trial_ends_at != '' AND trial_ends_at > ?))""",
    (datetime.utcnow().isoformat(),)
).fetchall()

log.info(f"Firing pipeline for {len(users)} active (paid/trial) user(s) in parallel")

seq_runner = ROOT / "tools" / "run_sequential_runner.py"

procs = []  # (proc, user_id, label)

for u in users:
    uid = u["id"]

    # Guard: skip this user entirely if they already have a running pipeline from a previous trigger
    active = db.execute(
        "SELECT id FROM runs WHERE user_id=? AND status='running'", (uid,)
    ).fetchone()
    if active:
        log.info(f"User {uid} already has a running pipeline (run {active['id']}) — skipping this trigger")
        continue

    # Build the list of run_db_id:spec_id pairs for this user
    pairs = []
    now_ts = datetime.utcnow().strftime("%Y%m%d_%H%M%S")

    # Default run
    row = db.execute(
        "INSERT INTO runs (user_id, run_id, started_at, status, specialty_id) VALUES (?,?,?,?,NULL) RETURNING id",
        (uid, now_ts, datetime.utcnow().isoformat(), "running")
    ).fetchone()
    db.commit()
    pairs.append(f"{row['id']}:")

    # Specialty runs
    specs = db.execute(
        "SELECT id, name FROM specialties WHERE user_id=?", (uid,)
    ).fetchall()
    for spec in specs:
        spec_run_id = now_ts + f"_s{spec['id']}"
        row = db.execute(
            "INSERT INTO runs (user_id, run_id, started_at, status, specialty_id) VALUES (?,?,?,?,?) RETURNING id",
            (uid, spec_run_id, datetime.utcnow().isoformat(), "running", spec["id"])
        ).fetchone()
        db.commit()
        pairs.append(f"{row['id']}:{spec['id']}")

    # Log file for the sequential runner itself
    seq_log = LOG_DIR / f"seq_runner_u{uid}_{now_ts}.log"
    log.info(f"User {uid}: launching {len(pairs)} run(s) in sequence: {pairs}")

    proc = subprocess.Popen(
        [sys.executable, str(seq_runner), str(uid), str(DB_PATH), str(ROOT), str(LOG_DIR)] + pairs,
        stdout=open(str(seq_log), "w"),
        stderr=subprocess.STDOUT,
        start_new_session=True,  # detach so timer doesn't block
    )
    procs.append((proc, uid, pairs))

db.close()

if not procs:
    log.info("No pipelines started.")
    sys.exit(0)

log.info(f"Started {len(procs)} parallel user pipeline(s). Waiting up to 90 min each...")

# Wait for all user chains with a 90-minute global timeout per user
import time
deadline = time.time() + 90 * 60
for proc, uid, pairs in procs:
    remaining = max(10, deadline - time.time())
    try:
        proc.wait(timeout=remaining)
        log.info(f"User {uid}: pipeline chain finished (exit={proc.returncode})")
    except subprocess.TimeoutExpired:
        log.warning(f"User {uid}: pipeline chain exceeded 90 min — killing")
        proc.kill()

log.info("All user pipeline chains complete.")
