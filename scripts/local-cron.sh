#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────────────────
# local-cron.sh — Alternative to GitHub Actions self-hosted runner.
# Run this on YOUR machine (Mac/Linux) via cron or launchctl.
#
# It runs the TraiNex check locally (bypassing Cloudflare), commits the data,
# and pushes to GitHub. The push triggers a Vercel redeploy automatically.
#
# Setup:
#   1. Copy .env.example to .env and fill in your credentials.
#   2. Run: chmod +x scripts/local-cron.sh
#   3. Test manually: ./scripts/local-cron.sh
#   4. Add to cron (runs at 06:05 daily):
#        crontab -e
#        5 6 * * * /path/to/trainex-sync/scripts/local-cron.sh >> /tmp/trainex-sync.log 2>&1
#
# macOS launchctl (runs at 06:05 daily even after sleep):
#   See scripts/com.trainex-sync.plist
# ────────────────────────────────────────────────────────────────────────────

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
LOG_PREFIX="[trainex-sync $(date '+%Y-%m-%d %H:%M:%S')]"

echo "$LOG_PREFIX Starting local check..."
cd "$REPO_DIR"

# Pull latest changes first
git pull --quiet origin main || echo "$LOG_PREFIX Warning: git pull failed"

# Install/update dependencies
npm ci --quiet

# Run the check (reads .env automatically via dotenv)
npm run check

# Commit updated data if any
git config user.name  "trainex-sync"
git config user.email "trainex-sync@local"
git add data/
if git diff --staged --quiet; then
  echo "$LOG_PREFIX No schedule changes."
else
  git commit -m "chore: update schedule snapshot $(date -u '+%Y-%m-%d')"
  git push origin main
  echo "$LOG_PREFIX Changes committed and pushed → Vercel will redeploy."
fi

echo "$LOG_PREFIX Done."
