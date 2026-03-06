/**
 * Local dashboard server.
 * Shows change history, current schedule, and manual trigger controls.
 * Run with: npm run dashboard  (defaults to http://localhost:3000)
 */

require('dotenv').config();

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const store   = require('./store');
const { diffIcal, parseIcal, renderMarkdown, parseDate, formatDate, shortSummary } = require('./diff');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── API endpoints ─────────────────────────────────────────────────────────────

/** GET /api/state — current state + change history */
app.get('/api/state', (req, res) => {
  const state = store.readState();
  res.json(state);
});

/** GET /api/schedule — parsed events from latest.ics */
app.get('/api/schedule', (req, res) => {
  const ical = store.readLatest();
  if (!ical) return res.json({ events: [] });

  const events = parseIcal(ical).map(e => ({
    ...e,
    startDate:  parseDate(e.dtstart)?.toISOString(),
    endDate:    parseDate(e.dtend)?.toISOString(),
    shortTitle: shortSummary(e.summary),
  }));
  res.json({ events, total: events.length });
});

/** GET /api/diff/latest — diff between previous and latest */
app.get('/api/diff/latest', (req, res) => {
  const prev = store.readPrevious();
  const curr = store.readLatest();
  if (!curr) return res.json({ hasChanges: false, stats: {} });

  const diff = diffIcal(prev, curr);
  // Add human-readable dates
  const enrich = (e) => ({
    ...e,
    startFormatted: formatDate(parseDate(e.dtstart)),
    endFormatted:   formatDate(parseDate(e.dtend)),
    shortTitle:     shortSummary(e.summary),
  });

  res.json({
    ...diff,
    added:    diff.added.map(enrich),
    removed:  diff.removed.map(enrich),
    modified: diff.modified.map(m => ({ old: enrich(m.old), new: enrich(m.new) })),
  });
});

/** POST /api/check — manually trigger a check */
app.post('/api/check', async (req, res) => {
  const { downloadIcal } = require('./scraper');
  const { notifyGitHub, notifyEmail } = require('./notify');

  const username = process.env.TRAINEX_USER;
  const password = process.env.TRAINEX_PASS;

  if (!username || !password) {
    return res.status(400).json({ error: 'TRAINEX_USER and TRAINEX_PASS not configured in .env' });
  }

  try {
    const newIcal = await downloadIcal({ username, password });
    const prev    = store.readLatest();
    const diff    = diffIcal(prev, newIcal);

    store.saveIcal(newIcal);

    if (diff.hasChanges) {
      const markdown = renderMarkdown(diff, new Date().toISOString());
      store.recordChange(diff, markdown);
    } else {
      store.recordCheck();
    }

    res.json({
      success:    true,
      hasChanges: diff.hasChanges,
      stats:      diff.stats,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/download — download latest iCal file */
app.get('/api/download', (req, res) => {
  const ical = store.readLatest();
  if (!ical) return res.status(404).send('No iCal available. Run a check first.');
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="msh-stundenplan.ics"');
  res.send(ical);
});

// ── Serve dashboard SPA ───────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🎓 MSH TraiNex Dashboard running at http://localhost:${PORT}\n`);
});
