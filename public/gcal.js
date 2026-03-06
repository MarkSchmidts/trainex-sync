/**
 * Google Calendar sync — server-side OAuth edition.
 *
 * Auth is handled by /api/auth/* (Client ID + Secret live in server env vars).
 * This file makes direct Google Calendar REST API calls using the access token
 * stored in a browser cookie after the server-side OAuth flow completes.
 *
 * No Google scripts loaded. No Client ID in source code.
 */

const GCAL_STORAGE_KEY  = 'msh_gcal_synced_events';
const GCAL_CALENDAR_KEY = 'msh_gcal_calendar_id';
const TIMEZONE          = 'Europe/Berlin';
const GCAL_API          = 'https://www.googleapis.com/calendar/v3';

// ── Token / connection ─────────────────────────────────────────────────────────

function gcalGetToken() {
  const m = document.cookie.match(/(?:^|;\s*)gcal_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function gcalIsConnected() {
  return !!gcalGetToken();
}

function getCalendarId() {
  return localStorage.getItem(GCAL_CALENDAR_KEY) || 'primary';
}

function setCalendarId(id) {
  localStorage.setItem(GCAL_CALENDAR_KEY, id);
}

/** Starts server-side OAuth — redirects the browser to Google sign-in. */
function gcalConnect() {
  window.location.href = '/api/auth/google';
}

async function gcalDisconnect() {
  try { await fetch('/api/auth/disconnect', { method: 'POST' }); } catch {}
  document.cookie = 'gcal_token=; Max-Age=0; Path=/';
  window.dispatchEvent(new Event('gcal:disconnected'));
}

// ── Authenticated fetch (auto-refreshes on 401) ────────────────────────────────

async function gcalFetch(url, opts = {}, _retried = false) {
  const token = gcalGetToken();
  if (!token) throw new Error('Nicht verbunden — bitte mit Google verbinden.');

  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });

  if (res.status === 401 && !_retried) {
    const ref = await fetch('/api/auth/refresh', { method: 'POST' });
    if (!ref.ok) {
      await gcalDisconnect();
      throw new Error('Sitzung abgelaufen — bitte erneut verbinden.');
    }
    return gcalFetch(url, opts, true);
  }

  return res;
}

// ── User info ──────────────────────────────────────────────────────────────────

async function gcalGetUserInfo() {
  try {
    const r = await gcalFetch('https://www.googleapis.com/oauth2/v3/userinfo');
    return r.ok ? r.json() : null;
  } catch { return null; }
}

// ── Calendar list ──────────────────────────────────────────────────────────────

async function gcalListCalendars() {
  const r = await gcalFetch(`${GCAL_API}/users/me/calendarList?minAccessRole=writer`);
  const d = await r.json();
  return d.items || [];
}

// ── Sync ───────────────────────────────────────────────────────────────────────

const DASHBOARD_URL  = 'https://trainex-sync-mark-schmidts-projects.vercel.app';
const EVENT_DELAY_MS = 200;  // ms between sequential creates (5 req/s, safely under 10/s quota)

/**
 * Sync MSH schedule events to Google Calendar.
 * @param {{ resync?: boolean, onProgress?: function }} opts
 */
async function gcalSync({ resync = false, onProgress = () => {} } = {}) {
  if (!gcalIsConnected()) { gcalConnect(); return; }

  const calendarId = getCalendarId();

  // 1. Fetch schedule
  onProgress({ step: 'fetch', msg: 'Lade Stundenplan...' });
  const resp = await fetch('/api/schedule');
  const { events } = await resp.json();
  if (!events?.length) throw new Error('Keine Termine im Stundenplan gefunden.');

  // 2. Delete old events (resync)
  if (resync) {
    onProgress({ step: 'delete', msg: 'Lösche alte Termine...' });
    await gcalDeleteSynced(calendarId, onProgress);
  }

  // 3. Create new events
  const toSync = resync ? events : events.filter(e => !isSynced(e.fingerprint));

  if (!toSync.length) {
    onProgress({ step: 'done', msg: '✅ Alle Termine bereits synchronisiert', done: 0, total: 0 });
    return { synced: 0 };
  }

  onProgress({ step: 'create', msg: `Erstelle ${toSync.length} Termine...`, total: toSync.length, done: 0 });

  let synced = [];
  let syncError = null;
  try {
    synced = await _sequentialSync(toSync, calendarId, (created, attempted, total) => {
      onProgress({ step: 'create', msg: `Erstelle Termine... ${created} erstellt (${attempted}/${total})`, total, done: attempted });
    });
  } catch (err) {
    syncError = err;
  }

  // 4. Persist whatever was synced (even partial)
  if (synced.length > 0) storeSynced(synced, resync);

  if (syncError) {
    onProgress({ step: 'error', msg: `⚠️ Sync unterbrochen: ${syncError.message} (${synced.length} gespeichert)`, done: synced.length, total: toSync.length });
    throw syncError;
  }

  onProgress({ step: 'done', msg: `✅ ${synced.length} Termine synchronisiert`, done: synced.length, total: toSync.length });
  return { synced: synced.length };
}

/**
 * Sequential sync — one event at a time with a small delay.
 * Avoids parallel retry storms that cause persistent rate-limit failures.
 */
async function _sequentialSync(events, calendarId, onProgress) {
  const synced = [];
  for (let i = 0; i < events.length; i++) {
    // throws if token is gone — propagates to gcalSync to save partial results
    const result = await _createEvent(calendarId, events[i]);
    if (result) synced.push(result);
    onProgress(synced.length, i + 1, events.length);
    if (i + 1 < events.length) await _sleep(EVENT_DELAY_MS);
  }
  return synced;
}

/** Create one event with exponential-backoff retry on 429/503. */
async function _createEvent(calendarId, e, maxRetries = 6) {
  const startDt = parseDtstring(e.dtstart);
  const endDt   = parseDtstring(e.dtend);
  if (!startDt || !endDt) return null;

  // TraiNex description format: ".../ Prof. Dr. XYZ  ab 09:45 Uhr - ..."
  const instrRaw   = (e.description || '').split('/').pop() || '';
  const instructor = instrRaw.split(/\s+ab\s+/)[0].trim();
  const room       = (e.location || '').split(' – ')[0].split(' - ')[0].trim();

  const body = {
    summary: e.shortTitle || e.summary,   // no prefix, no tag
    description: [
      e.moduleCode ? `Modul: ${e.moduleCode}` : null,
      instructor   ? `Dozent: ${instructor}`  : null,
      room         ? `Raum: ${room}`          : null,
      '',
      'Aktuelle Termine immer im TraiNex prüfen.',
      `Änderungen: ${DASHBOARD_URL}`,
    ].filter(l => l !== null).join('\n'),
    location: room ? `${room}, MSH Medical School Hamburg, Am Kaiserkai 1, 20457 Hamburg` : undefined,
    start: { dateTime: startDt.toISOString(), timeZone: TIMEZONE },
    end:   { dateTime: endDt.toISOString(),   timeZone: TIMEZONE },
    colorId: '9',
    extendedProperties: {
      private: { mshSync: '1', mshFingerprint: e.fingerprint || '', mshModule: e.moduleCode || '' },
    },
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let r;
    try {
      r = await gcalFetch(
        `${GCAL_API}/calendars/${encodeURIComponent(calendarId)}/events`,
        { method: 'POST', body: JSON.stringify(body) }
      );
    } catch (err) {
      // If we're disconnected, throw immediately — retrying is pointless
      if (!gcalIsConnected()) throw err;
      if (attempt < maxRetries) { await _sleep(1000); continue; }
      console.warn('[gcal] Network error:', e.shortTitle, err.message);
      return null;
    }

    if (r.status === 429 || r.status === 503) {
      if (attempt < maxRetries) { await _sleep(1000 * Math.pow(2, attempt) + Math.random() * 500); continue; }
      console.warn('[gcal] Rate limited, giving up on:', e.shortTitle);
      return null;
    }
    if (r.status === 401) return null; // token refresh handled by gcalFetch caller

    const d = await r.json();
    if (!d.id) {
      console.warn('[gcal] Event creation failed:', r.status, e.shortTitle || e.summary, JSON.stringify(d).slice(0, 300));
      return null;
    }
    return { id: d.id, fingerprint: e.fingerprint };
  }
  return null;
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Delete all synced MSH events from Google Calendar. */
async function gcalDeleteSynced(calendarId, onProgress = () => {}) {
  let deleted = 0;

  // Helper: delete one event by ID, returns true on success (204) or already-gone (404/410)
  async function _deleteOne(id) {
    try {
      const r = await gcalFetch(
        `${GCAL_API}/calendars/${encodeURIComponent(calendarId)}/events/${id}`,
        { method: 'DELETE' }
      );
      if (r.status === 204 || r.status === 404 || r.status === 410) {
        deleted++;
        return true;
      }
      // 429 or other — caller should retry
      return false;
    } catch {
      return false;
    }
  }

  // Phase 1: delete stored IDs from localStorage
  const stored = getSyncedEvents();
  for (let i = 0; i < stored.length; i++) {
    const ok = await _deleteOne(stored[i].id);
    if (!ok) {
      // Rate limited — back off and retry once
      await _sleep(2000);
      await _deleteOne(stored[i].id);
    }
    if (i % 10 === 0) onProgress({ step: 'delete', msg: `Lösche Termine... ${deleted}/${stored.length}` });
    await _sleep(150);
  }

  // Phase 2: fallback search — catch any events not in localStorage (e.g. from old sessions)
  // Paginate through all results
  let pageToken = '';
  do {
    try {
      const url = `${GCAL_API}/calendars/${encodeURIComponent(calendarId)}/events` +
        `?privateExtendedProperty=mshSync%3D1&maxResults=250` +
        (pageToken ? `&pageToken=${pageToken}` : '');
      const r = await gcalFetch(url);
      const d = await r.json();
      pageToken = d.nextPageToken || '';
      for (const evt of (d.items || [])) {
        await _deleteOne(evt.id);
        await _sleep(150);
      }
    } catch {
      break;
    }
  } while (pageToken);

  clearSynced();
  onProgress({ step: 'delete', msg: `Gelöscht: ${deleted} Termine` });
  return deleted;
}

// ── localStorage helpers ───────────────────────────────────────────────────────

function getSyncedEvents() {
  try { return JSON.parse(localStorage.getItem(GCAL_STORAGE_KEY) || '[]'); } catch { return []; }
}
function isSynced(fp) { return getSyncedEvents().some(e => e.fingerprint === fp); }
function storeSynced(items, replace = false) {
  const base   = replace ? [] : getSyncedEvents();
  const merged = [...base.filter(e => !items.find(n => n.fingerprint === e.fingerprint)), ...items];
  localStorage.setItem(GCAL_STORAGE_KEY, JSON.stringify(merged));
}
function clearSynced()  { localStorage.removeItem(GCAL_STORAGE_KEY); }
function getSyncStats() { return { syncedCount: getSyncedEvents().length }; }

// ── Utilities ──────────────────────────────────────────────────────────────────

function parseDtstring(dt) {
  if (!dt) return null;
  const m = dt.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]));
}

// ── Handle OAuth return ────────────────────────────────────────────────────────
// gcal.js loads before the main script, so we set a flag instead of dispatching
// events (listeners aren't ready yet). gcalInit() in index.html checks the flag.

window._gcalJustConnected = false;
window._gcalError         = null;

(function detectOAuthReturn() {
  if (window.location.hash === '#gcal-connected') {
    history.replaceState(null, '', window.location.pathname);
    window._gcalJustConnected = true;
  }
  const p = new URLSearchParams(window.location.search);
  if (p.has('gcal_error')) {
    window._gcalError = p.get('gcal_error');
    history.replaceState(null, '', window.location.pathname);
  }
})();
