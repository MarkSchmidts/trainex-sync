/**
 * Cron daemon — runs inside the Docker "checker" container.
 * Runs check.js daily at the schedule defined by CRON_SCHEDULE env var.
 * After a successful run with changes, commits data/ and pushes to GitHub.
 */

const { execSync } = require('child_process');
const path = require('path');

const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 6 * * *'; // default: 06:00 daily

// Parse a simple cron expression "min hour * * *" to milliseconds until next run
function msUntilNext(cronExpr) {
  const [min, hour] = cronExpr.split(' ').map(Number);
  const now  = new Date();
  const next = new Date();
  next.setUTCHours(hour, min, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}

function runCheck() {
  console.log(`[daemon] ${new Date().toISOString()} — running check...`);
  try {
    execSync('node src/check.js', {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
      env: process.env,
    });
    // Commit + push any updated data files
    try {
      execSync('git add data/', { cwd: path.join(__dirname, '..') });
      const diff = execSync('git diff --staged --stat', { cwd: path.join(__dirname, '..') }).toString();
      if (diff.trim()) {
        execSync(`git commit -m "chore: update schedule snapshot $(date -u '+%Y-%m-%d')"`, {
          cwd: path.join(__dirname, '..'),
          stdio: 'inherit',
          shell: true,
        });
        execSync('git push origin main', { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
        console.log('[daemon] Pushed updated data to GitHub.');
      } else {
        console.log('[daemon] No data changes to commit.');
      }
    } catch (gitErr) {
      console.warn('[daemon] Git push failed (non-fatal):', gitErr.message);
    }
  } catch (err) {
    console.error('[daemon] Check failed:', err.message);
  }

  scheduleNext();
}

function scheduleNext() {
  const ms = msUntilNext(CRON_SCHEDULE);
  const next = new Date(Date.now() + ms);
  console.log(`[daemon] Next run scheduled at ${next.toUTCString()} (in ${Math.round(ms/60000)} min)`);
  setTimeout(runCheck, ms);
}

console.log(`[daemon] Starting — schedule: ${CRON_SCHEDULE}`);
scheduleNext();

// Keep the process alive
process.on('SIGTERM', () => { console.log('[daemon] SIGTERM received, shutting down.'); process.exit(0); });
