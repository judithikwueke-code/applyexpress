"""
run_sequential_runner.py — Run pipeline workers one at a time.

Spawned by app.py instead of N parallel subprocesses. Runs each specialty
sequentially so they share Groq's daily token budget without racing each other.
After the last scheduled run of the day (19:00 UTC), sends one daily digest email.

Usage (internal — called by app.py):
    python3 tools/run_sequential_runner.py <user_id> <db_path> <root> <data_dir> \
        <run_db_id_1>:<spec_id_1> <run_db_id_2>:<spec_id_2> ...
    spec_id is empty string for the default (no-specialty) run.
"""

import sys
import sqlite3
import subprocess
import logging
from datetime import datetime, timezone
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s [seq-runner] %(message)s")
log = logging.getLogger(__name__)

# Send daily digest after the 19:00 UTC scheduled run (last of the day)
DAILY_DIGEST_HOUR = 19


def main():
    if len(sys.argv) < 6:
        print("Usage: run_sequential_runner.py user_id db_path root data_dir run_id:spec_id ...")
        sys.exit(1)

    user_id  = sys.argv[1]
    db_path  = sys.argv[2]
    root     = sys.argv[3]
    data_dir = Path(sys.argv[4])
    pairs    = sys.argv[5:]
    start_hour = datetime.now(timezone.utc).hour

    worker = Path(root) / "tools" / "run_pipeline_worker.py"

    for pair in pairs:
        run_db_id, spec_id = pair.split(":", 1)
        log_path = str(data_dir / f"pipeline_{run_db_id}.log")
        log.info(f"Starting run {run_db_id} (specialty={spec_id or 'default'})")
        with open(log_path, "w") as lf:
            proc = subprocess.run(
                [sys.executable, str(worker), user_id, run_db_id, db_path, root, spec_id],
                stdout=lf, stderr=lf,
            )
        log.info(f"Finished run {run_db_id} exit_code={proc.returncode}")

    # Send daily digest only after the 19:00 UTC batch (last of the day)
    if start_hour >= DAILY_DIGEST_HOUR:
        try:
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
            conn.close()
            if not row:
                return
            u = dict(row)  # sqlite3.Row has no .get(); use a plain dict

            # Decrypt smtp password
            sys.path.insert(0, str(Path(root)))
            from app import _dec
            smtp_password = _dec(u["smtp_password"] or "")

            if smtp_password:
                from tools.send_application_report import send_daily_digest
                result = send_daily_digest(
                    user_id=int(user_id),
                    db_path=db_path,
                    smtp_email=u["email"],
                    smtp_password=smtp_password,
                    smtp_to=u["email"],
                    first_name=u.get("first_name", ""),
                    last_name=u.get("last_name", ""),
                )
                if result["success"]:
                    log.info(f"Daily digest sent: {result['jobs']} jobs across {result['runs']} runs")
                else:
                    log.warning(f"Daily digest failed: {result['error']}")
            else:
                log.info("No SMTP password configured — skipping daily digest")
        except Exception as e:
            log.error(f"Daily digest error: {e}", exc_info=True)


if __name__ == "__main__":
    main()
