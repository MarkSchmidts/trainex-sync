/**
 * Tests for the diff engine.
 * Run with: node test/diff.test.js
 */

const { diffIcal, renderMarkdown, parseIcal, formatDate, parseDate } = require('../src/diff');

// ── Test fixtures ─────────────────────────────────────────────────────────────

function makeEvent({ dtstart, dtend, summary, location, description = '' } = {}) {
  return [
    'BEGIN:VEVENT',
    `SUMMARY:${summary}`,
    `DESCRIPTION:${description}`,
    `DTSTART:${dtstart}`,
    `DTEND:${dtend}`,
    `CATEGORIES:TraiNex`,
    `LOCATION:${location}`,
    'END:VEVENT',
  ].join('\n');
}

function makeIcal(events) {
  return ['BEGIN:VCALENDAR', ...events, 'END:VCALENDAR'].join('\n');
}

// Shared base events (stable across both old and new)
const UNCHANGED_1 = makeEvent({
  dtstart: '20260407T094500',
  dtend:   '20260407T111500',
  summary: 'BaMTVZ - M10 Grundlagen der klinischen Psychologie - Schellerdamm 2.OG Hörsaal  -  T32_msh552',
  location: 'Schellerdamm 2.OG Hörsaal',
});

const UNCHANGED_2 = makeEvent({
  dtstart: '20260407T134500',
  dtend:   '20260407T151500',
  summary: 'BaMTVZ - M08 Musiktherapie in pädagogischen Anwendungsfeldern - Studio 2  -  T32_msh552',
  location: 'Schellerdamm 3.OG Studio 2',
});

// Event that will be removed in the new schedule
const TO_BE_REMOVED = makeEvent({
  dtstart: '20260408T094500',
  dtend:   '20260408T111500',
  summary: 'BaMTVZ - M11 Musikalische Kernkompetenzen - Studio 2  -  T32_msh552',
  location: 'Schellerdamm 3.OG Studio 2',
  description: 'Musikalische Kernkompetenzen - Musiktherapie (WS24)/Christiane Ebeling  ab 09:45 Uhr',
});

// Event that will be added in the new schedule
const TO_BE_ADDED = makeEvent({
  dtstart: '20260409T094500',
  dtend:   '20260409T111500',
  summary: 'BaMTVZ - M17 Künstlerisches Portfolio - Schellerdamm 3.OG Studio 2  -  T32_msh552',
  location: 'Schellerdamm 3.OG Studio 2',
  description: 'Künstlerisches Portfolio/Prof. Dr. Jan Sonntag  ab 09:45 Uhr',
});

// Event that will change location in the new schedule (same time, same module)
const BEFORE_MODIFIED = makeEvent({
  dtstart: '20260410T094500',
  dtend:   '20260410T111500',
  summary: 'BaMTVZ - M20 Empirische Forschungsmethoden - Schellerdamm 2.OG Hörsaal  -  T32_msh552',
  location: 'Schellerdamm 2.OG Hörsaal',
  description: 'Empirische Forschungsmethoden der Künstlerischen Therapien - Musiktherapie (WS24)/Prof. Dr. Lars Tischler  ab 09:45 Uhr',
});

const AFTER_MODIFIED = makeEvent({
  dtstart: '20260410T094500',
  dtend:   '20260410T111500',
  summary: 'BaMTVZ - M20 Empirische Forschungsmethoden - Schellerdamm 3.OG Atelier 4  -  T32_msh552',
  location: 'Schellerdamm 3.OG Atelier 4',  // ← room changed!
  description: 'Empirische Forschungsmethoden der Künstlerischen Therapien - Musiktherapie (WS24)/Prof. Dr. Lars Tischler  ab 09:45 Uhr',
});

// ── Build test iCals ──────────────────────────────────────────────────────────

const OLD_ICAL = makeIcal([UNCHANGED_1, UNCHANGED_2, TO_BE_REMOVED, BEFORE_MODIFIED]);
const NEW_ICAL = makeIcal([UNCHANGED_1, UNCHANGED_2, TO_BE_ADDED, AFTER_MODIFIED]);

// ── Run tests ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

function test(name, fn) {
  console.log(`\n▶ ${name}`);
  try {
    fn();
  } catch (e) {
    console.error(`  ❌ EXCEPTION: ${e.message}`);
    failed++;
  }
}

// ── Test suite ────────────────────────────────────────────────────────────────

test('parseIcal: parses events correctly', () => {
  const events = parseIcal(OLD_ICAL);
  assert(events.length === 4, `parsed 4 events (got ${events.length})`);
  assert(events[0].dtstart === '20260407T094500', 'first event dtstart correct');
  assert(events[0].moduleCode === 'M10', `module code extracted (got ${events[0].moduleCode})`);
  assert(events[0].fingerprint.length === 16, 'fingerprint is 16 chars');
  assert(events[0].identity.length === 16, 'identity is 16 chars');
});

test('diffIcal: no changes when same iCal', () => {
  const diff = diffIcal(OLD_ICAL, OLD_ICAL);
  assert(!diff.hasChanges, 'no changes detected');
  assert(diff.stats.unchanged === 4, `4 unchanged (got ${diff.stats.unchanged})`);
  assert(diff.stats.added === 0, 'no added');
  assert(diff.stats.removed === 0, 'no removed');
  assert(diff.stats.modified === 0, 'no modified');
});

test('diffIcal: detects added event', () => {
  const diff = diffIcal(OLD_ICAL, NEW_ICAL);
  assert(diff.added.length === 1, `1 added event (got ${diff.added.length})`);
  assert(diff.added[0].summary.includes('M17'), `added event is M17 (got: ${diff.added[0].summary.substring(0,60)})`);
});

test('diffIcal: detects removed event', () => {
  const diff = diffIcal(OLD_ICAL, NEW_ICAL);
  assert(diff.removed.length === 1, `1 removed event (got ${diff.removed.length})`);
  assert(diff.removed[0].summary.includes('M11'), `removed event is M11 (got: ${diff.removed[0].summary.substring(0,60)})`);
});

test('diffIcal: detects modified event (room change)', () => {
  const diff = diffIcal(OLD_ICAL, NEW_ICAL);
  assert(diff.modified.length === 1, `1 modified event (got ${diff.modified.length})`);
  assert(diff.modified[0].old.location === 'Schellerdamm 2.OG Hörsaal', 'old location correct');
  assert(diff.modified[0].new.location === 'Schellerdamm 3.OG Atelier 4', 'new location correct');
});

test('diffIcal: unchanged events are correctly tracked', () => {
  const diff = diffIcal(OLD_ICAL, NEW_ICAL);
  assert(diff.unchanged.length === 2, `2 unchanged (got ${diff.unchanged.length})`);
});

test('diffIcal: first run (no previous iCal) treats all as unchanged', () => {
  const diff = diffIcal(null, NEW_ICAL);
  assert(!diff.hasChanges, 'no changes on first run');
  assert(diff.stats.unchanged === 4, `4 unchanged on first run (got ${diff.stats.unchanged})`);
  assert(diff.stats.added === 0, 'nothing marked added on first run');
});

test('renderMarkdown: generates report with all sections', () => {
  const diff = diffIcal(OLD_ICAL, NEW_ICAL);
  const md   = renderMarkdown(diff, '2026-03-06T06:00:00.000Z');

  assert(md.includes('MSH TraiNex'), 'has title');
  assert(md.includes('Neu hinzugekommen'), 'has added section');
  assert(md.includes('Entfernt'), 'has removed section');
  assert(md.includes('Geändert'), 'has modified section');
  assert(md.includes('M17'), 'mentions added module M17');
  assert(md.includes('M11'), 'mentions removed module M11');
  assert(md.includes('Atelier 4'), 'mentions new room');

  // Print a preview
  console.log('\n  📋 Markdown preview (first 10 lines):');
  md.split('\n').slice(0, 10).forEach(l => console.log('    ' + l));
});

test('parseDate: parses iCal date strings', () => {
  const d = parseDate('20260407T094500');
  assert(d !== null, 'parsed successfully');
  assert(d.getUTCFullYear() === 2026, 'year is 2026');
  assert(d.getUTCMonth() === 3, 'month is April (index 3)');
  assert(d.getUTCDate() === 7, 'day is 7');
  assert(d.getUTCHours() === 9, 'hour is 9');
  assert(d.getUTCMinutes() === 45, 'minute is 45');
});

// ── Results ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error('\n❌ Some tests failed!');
  process.exit(1);
} else {
  console.log('\n✅ All tests passed!');
  process.exit(0);
}
