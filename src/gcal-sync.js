/**
 * Google Calendar sync core — pure logic, no browser APIs.
 * Used by public/gcal.js (browser) and test/gcal-sync.test.js (Node).
 */

const TIMEZONE = 'Europe/Berlin';
const GCAL_API = 'https://www.googleapis.com/calendar/v3';

function parseDtstring(dt) {
  if (!dt) return null;
  const m = dt.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]));
}

function buildEventResource(e, startDt, endDt) {
  const instructor = (e.description || '').match(/Dozent:\s*([^|]+)/)?.[1]?.trim() || '';
  const room       = (e.location || '').split(' – ')[0].split(' - ')[0].trim();
  return {
    summary: e.shortTitle || e.summary,   // no prefix — plain title
    description: [
      e.moduleCode ? `Modul: ${e.moduleCode}` : null,
      instructor   ? `Dozent: ${instructor}` : null,
      room         ? `Raum: ${room}`         : null,
      '',
      'Aktuelle Termine immer im TraiNex prüfen.',
      'Änderungen: https://trainex-sync-mark-schmidts-projects.vercel.app',
    ].filter(l => l !== null).join('\n'),
    location: room
      ? `${room}, MSH Medical School Hamburg, Am Kaiserkai 1, 20457 Hamburg`
      : undefined,
    start:   { dateTime: startDt.toISOString(), timeZone: TIMEZONE },
    end:     { dateTime: endDt.toISOString(),   timeZone: TIMEZONE },
    colorId: '9',
    extendedProperties: {
      private: {
        mshSync:        '1',
        mshFingerprint: e.fingerprint  || '',
        mshModule:      e.moduleCode   || '',
      },
    },
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Create a single calendar event with exponential-backoff retry on 429.
 *
 * @param {string}   calendarId
 * @param {object}   resource   - event body
 * @param {function} fetchFn    - authenticated fetch (url, opts) => Response
 * @param {object}   [opts]
 * @param {number}   [opts.maxRetries=4]
 * @param {number}   [opts.baseDelayMs=1000]
 * @returns {string|null} created event id, or null on permanent failure
 */
async function createEvent(calendarId, resource, fetchFn, { maxRetries = 4, baseDelayMs = 1000 } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let r;
    try {
      r = await fetchFn(
        `${GCAL_API}/calendars/${encodeURIComponent(calendarId)}/events`,
        { method: 'POST', body: JSON.stringify(resource) }
      );
    } catch (err) {
      if (attempt < maxRetries) { await sleep(baseDelayMs); continue; }
      return null;
    }

    if (r.status === 429 || r.status === 503) {
      if (attempt < maxRetries) {
        await sleep(baseDelayMs * Math.pow(2, attempt)); // 1s, 2s, 4s, 8s
        continue;
      }
      return null;
    }

    if (r.status === 401) return null; // caller handles token refresh

    const d = await r.json();
    return d.id || null;
  }
  return null;
}

/**
 * Sync all events in controlled batches, retrying rate-limited requests.
 *
 * @param {Array}    events      - MSH schedule events
 * @param {string}   calendarId
 * @param {function} fetchFn     - authenticated fetch
 * @param {object}   [opts]
 * @param {number}   [opts.batchSize=8]        - parallel requests per batch
 * @param {number}   [opts.batchDelayMs=800]   - pause between batches (ms)
 * @param {function} [opts.onProgress]
 * @returns {{ id, fingerprint }[]}
 */
async function batchSync(events, calendarId, fetchFn, {
  batchSize    = 8,
  batchDelayMs = 800,
  onProgress   = () => {},
} = {}) {
  const synced = [];
  let done = 0;

  for (let i = 0; i < events.length; i += batchSize) {
    const batch   = events.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (e) => {
      const startDt = parseDtstring(e.dtstart);
      const endDt   = parseDtstring(e.dtend);
      if (!startDt || !endDt) return null;

      const resource = buildEventResource(e, startDt, endDt);
      const id       = await createEvent(calendarId, resource, fetchFn);
      if (id) return { id, fingerprint: e.fingerprint };
      return null;
    }));

    synced.push(...results.filter(Boolean));
    done += batch.length;
    onProgress({ done, total: events.length, synced: synced.length });

    // Pause between batches to stay within Google's 10 req/s quota
    if (i + batchSize < events.length) await sleep(batchDelayMs);
  }

  return synced;
}

// Export for Node (tests). In browser, gcal.js inlines these.
if (typeof module !== 'undefined') {
  module.exports = { parseDtstring, buildEventResource, createEvent, batchSync, sleep };
}
