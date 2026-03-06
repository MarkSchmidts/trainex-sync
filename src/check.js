/**
 * Main check script — run daily by GitHub Actions.
 * 1. Download iCal from TraiNex
 * 2. Diff against previous
 * 3. Notify via GitHub Issue + optional email
 * 4. Save new iCal snapshot
 */

require('dotenv').config();

const scraper = require('./scraper');
const { diffIcal, renderMarkdown } = require('./diff');
const store   = require('./store');
const { notifyGitHub, notifyEmail } = require('./notify');

async function main() {
  const username  = process.env.TRAINEX_USER;
  const password  = process.env.TRAINEX_PASS;
  const githubToken = process.env.GITHUB_TOKEN;
  const githubRepo  = process.env.GITHUB_REPOSITORY || 'MarkSchmidts/trainex-sync';

  if (!username || !password) {
    console.error('ERROR: TRAINEX_USER and TRAINEX_PASS environment variables are required');
    process.exit(1);
  }

  console.log(`[check] Starting TraiNex check at ${new Date().toISOString()}`);

  // ── 1. Download fresh iCal ─────────────────────────────────────────────
  let newIcal;
  try {
    newIcal = await scraper.downloadIcal({ username, password });
  } catch (err) {
    console.error('[check] Scraper failed:', err.message);

    // Notify about scraper failure
    const failMsg = `## ⚠️ TraiNex Check Fehlgeschlagen\n\n**Fehler:** ${err.message}\n**Zeit:** ${new Date().toISOString()}`;
    if (githubToken) {
      await notifyGitHub(failMsg, store, githubRepo, githubToken).catch(console.error);
    }
    process.exit(1);
  }

  // ── 2. Compare with previous ───────────────────────────────────────────
  const prevIcal = store.readLatest();
  const diff     = diffIcal(prevIcal, newIcal);

  console.log(`[check] Diff: +${diff.stats.added} / -${diff.stats.removed} / ~${diff.stats.modified} / =${diff.stats.unchanged} unchanged`);

  // ── 3. Save new snapshot ───────────────────────────────────────────────
  store.saveIcal(newIcal);

  if (!diff.hasChanges) {
    console.log('[check] No changes detected.');
    store.recordCheck();
    process.exit(0);
  }

  // ── 4. Prepare notification ────────────────────────────────────────────
  console.log('[check] Changes detected! Preparing notifications...');
  const markdown = renderMarkdown(diff, new Date().toISOString());
  store.recordChange(diff, markdown);

  // ── 5. GitHub Issue notification ───────────────────────────────────────
  try {
    await notifyGitHub(markdown, store, githubRepo, githubToken);
  } catch (err) {
    console.error('[check] GitHub notification failed:', err.message);
  }

  // ── 6. Optional: SMTP email ────────────────────────────────────────────
  try {
    await notifyEmail(markdown);
  } catch (err) {
    console.error('[check] Email notification failed:', err.message);
  }

  console.log('[check] Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[check] Unexpected error:', err);
  process.exit(1);
});
