/**
 * File-based storage for iCal snapshots and change history.
 * Data lives in ./data/ — committed to the repo so GitHub Actions can read/write it.
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR      = path.join(__dirname, '..', 'data');
const SNAPSHOTS_DIR = path.join(DATA_DIR, 'snapshots');
const LATEST_ICS    = path.join(DATA_DIR, 'latest.ics');
const PREVIOUS_ICS  = path.join(DATA_DIR, 'previous.ics');
const STATE_FILE    = path.join(DATA_DIR, 'state.json');

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
}

/** Read the latest stored iCal. Returns null if none exists. */
function readLatest() {
  ensureDirs();
  if (!fs.existsSync(LATEST_ICS)) return null;
  return fs.readFileSync(LATEST_ICS, 'utf8');
}

/** Read the previous (one-before-latest) iCal. Returns null if none exists. */
function readPrevious() {
  ensureDirs();
  if (!fs.existsSync(PREVIOUS_ICS)) return null;
  return fs.readFileSync(PREVIOUS_ICS, 'utf8');
}

/**
 * Save a new iCal: rotate latest → previous, write new latest,
 * and archive a timestamped snapshot.
 */
function saveIcal(icalStr) {
  ensureDirs();

  // Rotate: latest → previous
  if (fs.existsSync(LATEST_ICS)) {
    fs.copyFileSync(LATEST_ICS, PREVIOUS_ICS);
  }

  // Write new latest
  fs.writeFileSync(LATEST_ICS, icalStr, 'utf8');

  // Archive snapshot
  const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  fs.writeFileSync(path.join(SNAPSHOTS_DIR, `${ts}.ics`), icalStr, 'utf8');
}

/** Read the current state JSON. */
function readState() {
  ensureDirs();
  if (!fs.existsSync(STATE_FILE)) {
    return { lastCheck: null, lastChange: null, history: [], issueNumber: null };
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

/** Write the state JSON. */
function writeState(state) {
  ensureDirs();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Append a change record to history.
 * @param {object} diff - result of diffIcal()
 * @param {string} markdown - rendered markdown summary
 */
function recordChange(diff, markdown) {
  const state = readState();
  const now   = new Date().toISOString();

  const record = {
    date:     now,
    stats:    diff.stats,
    added:    diff.added.map(e => ({ dtstart: e.dtstart, summary: e.summary, location: e.location })),
    removed:  diff.removed.map(e => ({ dtstart: e.dtstart, summary: e.summary })),
    modified: diff.modified.map(m => ({
      dtstart:     m.new.dtstart,
      summary:     m.new.summary,
      oldDtstart:  m.old.dtstart,
      oldLocation: m.old.location,
      newLocation: m.new.location,
    })),
    markdown,
  };

  state.lastCheck  = now;
  state.lastChange = now;
  state.history    = [record, ...(state.history || [])].slice(0, 50); // keep last 50
  writeState(state);
  return record;
}

/** Update just the lastCheck timestamp (no changes). */
function recordCheck() {
  const state  = readState();
  state.lastCheck = new Date().toISOString();
  writeState(state);
}

/** Store the GitHub issue number for the tracking issue. */
function setIssueNumber(n) {
  const state = readState();
  state.issueNumber = n;
  writeState(state);
}

module.exports = {
  readLatest,
  readPrevious,
  saveIcal,
  readState,
  writeState,
  recordChange,
  recordCheck,
  setIssueNumber,
};
