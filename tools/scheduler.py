"""
scheduler.py — Keeps the pipeline running daily at 7:23am.

Usage:
    # Run in background (survives terminal close):
    nohup .venv/bin/python tools/scheduler.py &

    # Check it's running:
    cat .tmp/scheduler.pid

    # Stop it:
    kill $(cat .tmp/scheduler.pid)
"""

import os
import time
import logging
import subprocess
from datetime import datetime
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [scheduler] %(message)s",
    handlers=[
        logging.FileHandler(".tmp/scheduler.log"),
        logging.StreamHandler(),
    ]
)
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).parent.parent
PYTHON   = BASE_DIR / ".venv/bin/python"
SCRIPT   = BASE_DIR / "tools/run_pipeline.py"
LOG_FILE = BASE_DIR / ".tmp/cron.log"
PID_FILE = BASE_DIR / ".tmp/scheduler.pid"

RUN_HOUR   = 7
RUN_MINUTE = 23


def write_pid():
    PID_FILE.parent.mkdir(exist_ok=True)
    PID_FILE.write_text(str(os.getpid()))


def should_run_now():
    now = datetime.now()
    return now.hour == RUN_HOUR and now.minute == RUN_MINUTE


def run_pipeline():
    logger.info("=== Triggering daily pipeline ===")
    with open(LOG_FILE, "a") as log:
        result = subprocess.run(
            [str(PYTHON), str(SCRIPT)],
            cwd=str(BASE_DIR),
            stdout=log,
            stderr=log,
        )
    logger.info(f"Pipeline finished (exit code {result.returncode})")


def main():
    write_pid()
    logger.info(f"Scheduler started (PID {os.getpid()}) — pipeline fires daily at {RUN_HOUR:02d}:{RUN_MINUTE:02d}")

    last_run_date = None

    while True:
        now = datetime.now()
        today = now.date()

        if should_run_now() and last_run_date != today:
            last_run_date = today
            run_pipeline()

        # Sleep until the next minute boundary
        seconds_to_next_minute = 60 - now.second
        time.sleep(seconds_to_next_minute)


if __name__ == "__main__":
    main()
