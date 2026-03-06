# MSH TraiNex Schedule Sync 🎓

Automatically monitors your MSH Medical School Hamburg TraiNex schedule for changes, notifies you via GitHub Issues (email), and provides a dashboard with a calendar view.

**Live dashboard:** https://trainex-sync-mark-schmidts-projects.vercel.app

---

## Features

- 🔄 **Daily automated check** — downloads iCal from TraiNex at 06:00
- 🔍 **Change detection** — detects added, removed, and modified events
- 📬 **GitHub Issue notifications** — creates issues with change summaries (triggers GitHub email)
- 📅 **Dashboard** — calendar view, event details popup, change history
- ⬇️ **Clean iCal export** — `[MSH]` tagged events for Google Calendar (clean titles, no programme codes)
- 🏃 **Tests** — 34 unit tests for the diff engine

---

## Architecture

```
GitHub Actions (cron 06:00 UTC)
  └── src/check.js          ← scrapes TraiNex, diffs, notifies
       ├── src/scraper.js   ← headless HTTP login + iCal download
       ├── src/diff.js      ← change detection + iCal cleanup
       ├── src/store.js     ← file-based storage (data/)
       └── src/notify.js    ← GitHub Issues + optional SMTP

Vercel (auto-deploys on each push)
  └── public/index.html     ← dashboard SPA
       ├── api/state.js     ← GET /api/state
       ├── api/schedule.js  ← GET /api/schedule
       ├── api/diff.js      ← GET /api/diff/latest
       ├── api/download.js  ← GET /api/download (cleaned iCal)
       └── api/trigger.js   ← POST /api/trigger (dispatch workflow)
```

---

## Setup

### 1. GitHub Secrets (already configured)
| Secret | Description |
|--------|-------------|
| `TRAINEX_USER` | TraiNex username |
| `TRAINEX_PASS` | TraiNex password |
| `VERCEL_TOKEN` | Vercel deploy token |
| `VERCEL_ORG_ID` | Vercel team ID |
| `VERCEL_PROJECT_ID` | Vercel project ID |
| `SMTP_HOST` | *(optional)* SMTP for email |
| `NOTIFY_EMAIL` | *(optional)* Email address |

### 2. ⚠️ Cloudflare Workaround — Self-Hosted Runner

GitHub Actions' datacenter IPs are blocked by Cloudflare on the TraiNex server. You need to run the check from your own IP.

**Option A: Self-hosted GitHub Actions runner (recommended)**

This runs the GitHub Actions workflow on your own Mac/PC:

```bash
# 1. Go to: https://github.com/MarkSchmidts/trainex-sync/settings/actions/runners
# 2. Click "New self-hosted runner" → choose your OS → follow the setup commands
# 3. Start the runner (it runs in background):
./run.sh &
```

Once configured, the `daily-check.yml` workflow runs on your machine at 06:00 UTC.

**Option B: Local cron job (macOS)**

```bash
# 1. Clone the repo and set up .env
cp .env.example .env
# Edit .env with your credentials

# 2. Test manually
./scripts/local-cron.sh

# 3. Set up macOS launchctl (auto-runs at 06:05 even after sleep)
# Edit scripts/com.trainex-sync.plist — replace /Users/yourname with your path
cp scripts/com.trainex-sync.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.trainex-sync.plist

# Verify
launchctl list | grep trainex
```

**Option C: crontab (Mac/Linux)**

```bash
crontab -e
# Add:
5 6 * * * /path/to/trainex-sync/scripts/local-cron.sh >> /tmp/trainex-sync.log 2>&1
```

### 3. Local Development

```bash
npm install
cp .env.example .env
# Edit .env with credentials

# Run a check now
npm run check

# Start local dashboard (http://localhost:3000)
npm run dashboard
```

### 4. Importing to Google Calendar

1. Click **⬇ iCal herunterladen** on the dashboard
2. Open Google Calendar → Other calendars → Import
3. Select the downloaded `msh-stundenplan.ics`
4. Events will appear with `[MSH]` prefix — easy to identify/delete later

---

## Notifications

When schedule changes are detected, a **GitHub Issue comment** is posted to [#1 MSH TraiNex – Stundenplan-Tracking](https://github.com/MarkSchmidts/trainex-sync/issues/1).

**To get email notifications:** Watch the issue or "Watch" the repository → receive an email for each new comment.

Optional: Configure `SMTP_*` secrets for direct email delivery.

---

## Tests

```bash
npm test
# 34 unit tests for the diff engine
```
