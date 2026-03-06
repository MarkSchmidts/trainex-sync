/**
 * iCal diff engine.
 * Parses two iCal strings and returns added, removed, and changed events.
 * Since TraiNex events have no UIDs, we generate stable fingerprints from content.
 */

const crypto = require('crypto');

/**
 * Parse a raw iCal string into an array of event objects.
 */
function parseIcal(icalStr) {
  const events = [];
  // Split into VEVENT blocks
  const blocks = icalStr.split(/BEGIN:VEVENT/g).slice(1);

  for (const block of blocks) {
    const end = block.indexOf('END:VEVENT');
    const content = end !== -1 ? block.substring(0, end) : block;

    const get = (key) => {
      // Handle potential line folding (lines starting with space/tab)
      const unfolded = content.replace(/\r?\n[ \t]/g, '');
      const match = unfolded.match(new RegExp(`^${key}[;:]([^\r\n]*)`, 'm'));
      return match ? match[1].trim() : '';
    };

    const summary  = get('SUMMARY');
    const dtstart  = get('DTSTART');
    const dtend    = get('DTEND');
    const location = get('LOCATION');
    const desc     = get('DESCRIPTION');

    if (!dtstart) continue;

    // Parse module code from summary (e.g. "BaMTVZ - M10 Grundlagen..." → "M10")
    const moduleMatch = summary.match(/\bM(\d+)\b/);
    const moduleCode  = moduleMatch ? `M${moduleMatch[1]}` : '';

    // Parse course type (Vorlesung, etc.) from description
    const typeMatch = desc.match(/(?:^|\s)(Vorlesung|Seminar|Praktikum|Übung|Tutorium|Kolloquium|Prüfung)/i);
    const courseType = typeMatch ? typeMatch[1] : '';

    // Stable fingerprint = hash of all key content (detects any change)
    const fingerprint = crypto
      .createHash('sha256')
      .update(`${dtstart}|${dtend}|${summary}|${location}`)
      .digest('hex')
      .substring(0, 16);

    // Identity key = what links the "same" event across runs (time + module)
    // Used to detect modifications vs pure add/remove
    const identity = crypto
      .createHash('sha256')
      .update(`${dtstart}|${moduleCode || summary.substring(0, 60)}`)
      .digest('hex')
      .substring(0, 16);

    events.push({
      fingerprint,
      identity,
      dtstart,
      dtend,
      summary,
      location,
      description: desc,
      moduleCode,
      courseType,
    });
  }

  return events;
}

/**
 * Parse a DTSTART string like "20260407T094500" into a Date.
 */
function parseDate(dtstr) {
  if (!dtstr) return null;
  const m = dtstr.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]));
}

/**
 * Format a Date to a human-readable German string.
 */
function formatDate(date) {
  if (!date) return '?';
  return date.toLocaleString('de-DE', {
    timeZone: 'Europe/Berlin',
    weekday: 'short',
    day:     '2-digit',
    month:   '2-digit',
    year:    'numeric',
    hour:    '2-digit',
    minute:  '2-digit',
  });
}

/**
 * Summarise a summary string to extract the readable course name.
 * "BaMTVZ - M10 Grundlagen der klinischen... - Schellerdamm 2.OG Hörsaal  -  T32_msh552"
 * → "M10 Grundlagen der klinischen..."
 */
function shortSummary(summary) {
  // Remove location part at the end (after last " - ")
  let s = summary.replace(/\s*-\s*T32_\w+\s*$/, '').trim();
  // Remove programme prefix like "BaMTVZ - "
  s = s.replace(/^Ba\w+\s*-\s*/i, '');
  // Trim to ~80 chars
  if (s.length > 90) s = s.substring(0, 87) + '...';
  return s;
}

/**
 * Compare two iCal strings and return diff results.
 *
 * @param {string|null} prevIcal  - previous iCal (null = first run)
 * @param {string}      nextIcal  - current/new iCal
 * @returns {{ added, removed, modified, unchanged, summary }}
 */
function diffIcal(prevIcal, nextIcal) {
  // First run — no baseline to compare against; seed silently.
  if (!prevIcal) {
    const events = parseIcal(nextIcal);
    return {
      added: [], removed: [], modified: [], unchanged: events,
      hasChanges: false,
      stats: { total: events.length, added: 0, removed: 0, modified: 0, unchanged: events.length },
    };
  }

  const prevEvents = parseIcal(prevIcal);
  const nextEvents = parseIcal(nextIcal);

  const prevByFP    = new Map(prevEvents.map(e => [e.fingerprint, e]));
  const nextByFP    = new Map(nextEvents.map(e => [e.fingerprint, e]));
  const prevByIdent = new Map(prevEvents.map(e => [e.identity, e]));
  const nextByIdent = new Map(nextEvents.map(e => [e.identity, e]));

  const added    = [];
  const removed  = [];
  const modified = [];
  const unchanged = [];

  // Find added and modified
  for (const evt of nextEvents) {
    if (prevByFP.has(evt.fingerprint)) {
      unchanged.push(evt);
    } else if (prevByIdent.has(evt.identity)) {
      // Same time slot + module, but different content → modified
      const old = prevByIdent.get(evt.identity);
      modified.push({ old, new: evt });
    } else {
      added.push(evt);
    }
  }

  // Find removed
  for (const evt of prevEvents) {
    if (!nextByFP.has(evt.fingerprint) && !nextByIdent.has(evt.identity)) {
      removed.push(evt);
    }
  }

  const hasChanges = added.length > 0 || removed.length > 0 || modified.length > 0;

  return {
    added,
    removed,
    modified,
    unchanged,
    hasChanges,
    stats: {
      total:     nextEvents.length,
      added:     added.length,
      removed:   removed.length,
      modified:  modified.length,
      unchanged: unchanged.length,
    },
  };
}

/**
 * Render a human-readable Markdown summary of the diff for email/GitHub issue.
 */
function renderMarkdown(diff, checkDate) {
  const d = checkDate ? new Date(checkDate) : new Date();
  const dateStr = d.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'full', timeStyle: 'short' });

  const lines = [
    `## 📅 MSH TraiNex – Stundenplan-Änderungen`,
    ``,
    `**Geprüft am:** ${dateStr}`,
    `**Änderungen:** ${diff.stats.added} neu | ${diff.stats.removed} entfernt | ${diff.stats.modified} geändert`,
    ``,
  ];

  if (diff.added.length > 0) {
    lines.push('### ✅ Neu hinzugekommen');
    for (const e of diff.added) {
      const start = formatDate(parseDate(e.dtstart));
      const end   = formatDate(parseDate(e.dtend));
      lines.push(`- **${shortSummary(e.summary)}**`);
      lines.push(`  📆 ${start} – ${end.split(', ').pop()}`);
      if (e.location) lines.push(`  📍 ${e.location.split(' - ')[0]}`);
    }
    lines.push('');
  }

  if (diff.removed.length > 0) {
    lines.push('### ❌ Entfernt / Ausgefallen');
    for (const e of diff.removed) {
      const start = formatDate(parseDate(e.dtstart));
      lines.push(`- **${shortSummary(e.summary)}**`);
      lines.push(`  📆 ${start}`);
      if (e.location) lines.push(`  📍 ${e.location.split(' - ')[0]}`);
    }
    lines.push('');
  }

  if (diff.modified.length > 0) {
    lines.push('### ✏️ Geändert');
    for (const m of diff.modified) {
      const oldStart = formatDate(parseDate(m.old.dtstart));
      const newStart = formatDate(parseDate(m.new.dtstart));
      lines.push(`- **${shortSummary(m.new.summary)}**`);
      if (m.old.dtstart !== m.new.dtstart || m.old.dtend !== m.new.dtend) {
        lines.push(`  ⏰ Vorher: ${oldStart}`);
        lines.push(`  ⏰ Jetzt:  ${newStart}`);
      }
      if (m.old.location !== m.new.location) {
        lines.push(`  📍 Vorher: ${m.old.location?.split(' - ')[0]}`);
        lines.push(`  📍 Jetzt:  ${m.new.location?.split(' - ')[0]}`);
      }
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('*Automatisch erstellt von [trainex-sync](https://github.com/MarkSchmidts/trainex-sync)*');

  return lines.join('\n');
}

module.exports = { diffIcal, parseIcal, renderMarkdown, parseDate, formatDate, shortSummary };
