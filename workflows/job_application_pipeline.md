# Workflow: AI Job Application Pipeline

## Objective
Run daily to automatically find, score, and apply to relevant job openings.
Save all results to Google Sheets. Send an email digest.
Escalate to human only when the agent genuinely cannot proceed.

---

## Required Inputs

| Input | Where | Notes |
|-------|-------|-------|
| Candidate profile | `candidate_profile.md` | Fill this in completely before first run |
| LLM API key | `.env` → `GROQ_API_KEY` | Free at console.groq.com |
| Google Sheet ID | `.env` → `GOOGLE_SHEET_ID` | Run `setup_sheets.py` to get this |
| Service account | `service_account.json` | Download from Google Cloud Console |
| Gmail App Password | `.env` → `SMTP_PASSWORD` | Enable 2FA → App Passwords |
| Search config | `.env` | `JOB_SEARCH_KEYWORDS`, `JOB_SEARCH_LOCATION` |

---

## First-Time Setup (run once)

### 1. Fill in your candidate profile
```
candidate_profile.md
```
Replace ALL placeholder text. This is the single source of truth for every AI tool.
Be specific: quantified achievements, exact skill names, concrete salary range.

### 2. Install dependencies
```bash
pip install -r requirements.txt
npm install
npx playwright install chromium
```

### 2b. Authenticate Indeed and LinkedIn (one-time, headed browser)
Indeed and LinkedIn use Google OAuth / 2FA — session must be saved first:
```bash
# Opens headed browser — log in, then Ctrl+C
node tools/apply_indeed.js --login
node tools/apply_linkedin.js --login
```
Sessions saved to `.tmp/indeed_session/` and `.tmp/linkedin_session/`. Re-run `--login` if the session expires (~30–90 days).

### 3. Get a free Groq API key
- Go to https://console.groq.com
- Create an account (free, no credit card)
- Create an API key → paste into `.env` as `GROQ_API_KEY`

### 4. Set up Google Sheets
```bash
# a) Create a Google Cloud project and enable Sheets API
#    https://console.cloud.google.com → APIs & Services → Enable APIs → Google Sheets API

# b) Create a Service Account
#    IAM & Admin → Service Accounts → Create → download JSON key
#    Save as service_account.json in the project root

# c) Run the setup script
python tools/setup_sheets.py

# d) Copy the Sheet ID into .env
GOOGLE_SHEET_ID=<printed by setup_sheets.py>

# e) Share the sheet with your personal email (the service account owns it)
```

### 5. Set up Gmail notifications (optional)
- Enable 2FA on your Gmail account
- Google Account → Security → App Passwords → Mail → Generate
- Paste the 16-char password into `.env` as `SMTP_PASSWORD`

### 6. Configure your search
```bash
# In .env:
JOB_SEARCH_KEYWORDS=Senior Python Engineer
JOB_SEARCH_LOCATION=London
JOB_SEARCH_COUNT=30
SCORE_THRESHOLD=7          # 1–10. Jobs below this are skipped.
```

---

## Daily Run

```bash
# Full pipeline (fetch → score → generate → apply → save → email)
python tools/run_pipeline.py

# Dry run (fetch + score only, no apply or save — good for testing)
python tools/run_pipeline.py --dry-run

# Generate content but don't apply (review in Sheets first)
python tools/run_pipeline.py --skip-apply
```

---

## Pipeline Flow

```
fetch_jobs.py
  ↓ jobs_raw.json (.tmp/)
score_job.py × N (sequential, 0.5s gap)
  ↓ jobs_scored.json (.tmp/)
Filter: score >= SCORE_THRESHOLD
  ↓ qualifying jobs
[Parallel, max 3 workers] per job:
  ├── tailor_cv.py
  ├── generate_cover_letter.py
  ├── generate_application_answers.py
  ├── generate_linkedin_message.py
  └── recruiter_finder.py
  ↓ jobs_enriched.json (.tmp/)
apply_job.js (Playwright) → exit 0 (Applied) | exit 1 (Needs Review)
  ↓
save_to_sheets.py → Google Sheet
  ↓
send_notification.py → Gmail digest
```

---

## Individual Tool Testing

Test each tool in isolation before running the full pipeline:

```bash
# 1. Test LLM connection
python tools/llm_client.py

# 2. Fetch jobs only
python tools/fetch_jobs.py --keywords "Python engineer" --location "London" --count 5

# 3. Score a specific job (index 0 from the fetched list)
python tools/score_job.py --job-file .tmp/jobs_raw.json --job-index 0

# 4. Tailor CV for a job
python tools/tailor_cv.py --job-file .tmp/jobs_raw.json --job-index 0

# 5. Generate cover letter
python tools/generate_cover_letter.py --job-file .tmp/jobs_raw.json --job-index 0

# 6. Generate application answers
python tools/generate_application_answers.py --job-file .tmp/jobs_raw.json --job-index 0

# 7. Generate LinkedIn message
python tools/generate_linkedin_message.py --job-file .tmp/jobs_raw.json --job-index 0

# 8. Get recruiter strategy
python tools/recruiter_finder.py --job-file .tmp/jobs_raw.json --job-index 0

# 9. Test Sheets connection (writes a test row)
python tools/save_to_sheets.py --test

# 10. Test email (sends a test digest)
python tools/send_notification.py --test

# 11. Test Playwright apply (opens browser, attempts form fill)
node tools/apply_job.js \
  --url "https://example-job-url.com" \
  --name "Your Name" \
  --email "your@email.com" \
  --headed    # use --headed to watch what happens
```

---

## Edge Cases

| Situation | What the agent does |
|-----------|---------------------|
| All jobs score below threshold | Sends notification with 0 qualifying jobs, exits cleanly |
| A job source API is down | Logs warning, continues with other sources |
| LLM call fails | Retries twice with 10s wait. Falls back to safe default (empty field), logs error |
| Groq rate limit hit | Waits 10s, retries once. Switches to Anthropic if `LLM_PROVIDER=anthropic` |
| CAPTCHA on application | Saves screenshot → marks job "Needs Review" in Sheet → email alert |
| Login required to apply | Escalates same as CAPTCHA |
| Google Sheet save fails | Logs error, continues to next job. Reports in email. |
| Email send fails | Logs warning, continues. Pipeline output still in .tmp/ |
| No CV path set | Skips CV upload, attempts rest of form |
| candidate_profile.md has placeholders | Logs warning, continues with whatever is there |

---

## Known Constraints

| Constraint | Detail |
|-----------|--------|
| Groq free tier | 30 req/min, 500k tokens/day. Enough for ~400 full pipeline runs/day |
| Adzuna free tier | 250 API calls/month. One pipeline run = 1 call. Optional source. |
| RemoteOK | 1 request per run (courtesy). Results are remote-only. |
| Playwright + Workday | Workday uses shadow DOM — auto-apply often fails. Escalates to human. |
| Playwright + LinkedIn Easy Apply | Requires saved session (`--login`). If session expired, escalates to "Needs Review". |
| Playwright + Indeed Easy Apply | Requires saved session (`--login`). Same Google OAuth constraint. |
| Gmail SMTP | Requires App Password (not account password). Rate: 500 emails/day free. |
| Google Sheets API | Free tier: 300 requests/minute, 60 seconds/minute. No practical limit for this use case. |

---

## Maintenance

### Update your search keywords
```bash
# Edit .env:
JOB_SEARCH_KEYWORDS=Staff Engineer
JOB_SEARCH_LOCATION=Remote
```

### Adjust the score threshold
```bash
# Edit .env:
SCORE_THRESHOLD=8    # Stricter — only near-perfect matches
SCORE_THRESHOLD=6    # More permissive — include partial matches
```

### Update your candidate profile
Edit `candidate_profile.md` directly. All AI tools read it fresh on each run.

### Switch from Groq to Claude (for better output quality)
```bash
# Edit .env:
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```
Cost: ~$0.05 per full pipeline run with Haiku.

### Add a cron job for daily automation
```bash
# Run at 7:30 AM every day
crontab -e

# Add this line:
30 7 * * * cd /home/judithikwueke/Agentic\ Workflow\ Done && python tools/run_pipeline.py >> .tmp/cron.log 2>&1
```

### Review escalated applications
- Check Google Sheet for rows with Status = "Needs Review"
- Screenshot in `.tmp/escalation_*.png`
- Apply manually at the URL in column E

---

## Self-Improvement Loop

When the pipeline fails or produces poor results:

1. **Check the log**: `.tmp/pipeline.log`
2. **Check scored jobs**: `.tmp/jobs_scored.json` — are scores accurate?
3. **Test the failing tool in isolation** (see testing commands above)
4. **Fix the tool** (update prompt, fix selector, handle new API response shape)
5. **Re-test the tool independently**
6. **Update this workflow** with what you learned
7. Re-run the pipeline

---

## File Reference

```
candidate_profile.md          ← Fill this in. Single source of truth.
.env                          ← All secrets and config
requirements.txt              ← Python deps (pip install -r requirements.txt)
package.json                  ← Node.js deps (npm install)
service_account.json          ← Google service account (gitignored, get from GCP)

tools/
  llm_client.py               ← LLM wrapper: groq (free) | anthropic (fallback)
  fetch_jobs.py               ← Fetches from The Muse, RemoteOK, Arbeitnow, Adzuna
  score_job.py                ← AI scores job 1–10, returns apply decision
  tailor_cv.py                ← AI rewrites CV summary for ATS match
  generate_cover_letter.py    ← AI writes 3-paragraph cover letter
  generate_application_answers.py ← AI answers 7 standard form questions
  generate_linkedin_message.py    ← AI writes ≤150 word outreach message
  recruiter_finder.py         ← AI generates recruiter targeting strategy
  save_to_sheets.py           ← Saves enriched job row to Google Sheet
  send_notification.py        ← Sends HTML email digest via Gmail SMTP
  setup_sheets.py             ← One-time: creates sheet with headers
  run_pipeline.py             ← MAIN ORCHESTRATOR — run this daily
  apply_job.js                     ← Generic Playwright fallback
  apply_greenhouse_playwright.js   ← Greenhouse (reCAPTCHA bypass via Gmail security code)
  apply_lever_playwright.js        ← Lever (hCaptcha + 2captcha fallback)
  apply_totaljobs.js               ← Totaljobs Quick Apply
  apply_indeed.js                  ← Indeed Easy Apply (persistent session — run --login first)
  apply_linkedin.js                ← LinkedIn Easy Apply (persistent session — run --login first)
  apply_reed_playwright.js         ← Reed.co.uk (if exists)

.tmp/
  jobs_raw.json               ← Raw fetched jobs
  jobs_scored.json            ← Jobs with AI scores
  jobs_enriched.json          ← Jobs with all AI-generated content
  pipeline.log                ← Full run log
  escalation_*.png            ← Screenshots from failed applies
  cron.log                    ← Cron output log
```
