/**
 * Google Calendar sync module.
 * Runs entirely in the browser using Google Identity Services (GIS) + gapi.
 * No server-side credentials needed — works with any Google account.
 *
 * Required: a Google OAuth Client ID (see README for setup).
 * The Client ID is entered by the user in the dashboard and stored in localStorage.
 */

const GCAL_STORAGE_KEY  = 'msh_gcal_synced_events'; // localStorage: array of {id, fingerprint}
const GCAL_CLIENT_KEY   = 'msh_gcal_client_id';
const GCAL_CALENDAR_KEY = 'msh_gcal_calendar_id';   // which calendar to sync to
const TIMEZONE          = 'Europe/Berlin';

let _gapiReady = false;
let _gisReady  = false;
let _tokenClient = null;
let _accessToken = null;

// ── Initialisation ────────────────────────────────────────────────────────────

function getClientId()   { return localStorage.getItem(GCAL_CLIENT_KEY) || ''; }
function getCalendarId() { return localStorage.getItem(GCAL_CALENDAR_KEY) || 'primary'; }

function setClientId(id)   { localStorage.setItem(GCAL_CLIENT_KEY, id); }
function setCalendarId(id) { localStorage.setItem(GCAL_CALENDAR_KEY, id); }

function onGapiLoaded() {
  gapi.load('client', async () => {
    await gapi.client.init({});
    await gapi.client.load('https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest');
    _gapiReady = true;
    gcalCheckReady();
  });
}

function onGisLoaded() {
  const clientId = getClientId();
  if (!clientId) { _gisReady = false; return; }
  _tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.readonly',
    ].join(' '),
    callback: (resp) => {
      if (resp.error) {
        gcalOnError('OAuth error: ' + resp.error);
        return;
      }
      _accessToken = resp.access_token;
      gapi.client.setToken({ access_token: _accessToken });
      gcalOnConnected();
    },
  });
  _gisReady = true;
  gcalCheckReady();
}

function gcalCheckReady() {
  if (_gapiReady && _gisReady) {
    window.dispatchEvent(new Event('gcal:ready'));
  }
}

/** Re-initialise GIS when client ID changes. */
function gcalSetClientId(id) {
  setClientId(id);
  _gisReady = false;
  onGisLoaded(); // re-init with new ID
}

/** Request an access token (shows OAuth popup if needed). */
async function gcalConnect() {
  if (!_tokenClient) {
    throw new Error('Google client not initialized. Set a valid Client ID first.');
  }
  return new Promise((resolve, reject) => {
    const originalCb = _tokenClient.callback;
    _tokenClient.callback = (resp) => {
      if (originalCb) originalCb(resp);
      if (resp.error) reject(new Error(resp.error));
      else resolve(resp);
    };
    if (gapi.client.getToken() === null) {
      _tokenClient.requestAccessToken({ prompt: 'consent' });
    } else {
      _tokenClient.requestAccessToken({ prompt: '' });
    }
  });
}

function gcalDisconnect() {
  if (_accessToken) {
    google.accounts.oauth2.revoke(_accessToken);
    _accessToken = null;
  }
  gapi.client.setToken(null);
  window.dispatchEvent(new Event('gcal:disconnected'));
}

function gcalIsConnected() {
  return !!gapi.client.getToken()?.access_token;
}

// ── Calendar list ─────────────────────────────────────────────────────────────

async function gcalListCalendars() {
  const resp = await gapi.client.calendar.calendarList.list({ minAccessRole: 'writer' });
  return resp.result.items || [];
}

// ── Sync ──────────────────────────────────────────────────────────────────────

/**
 * Fetch all events from the API and sync to Google Calendar.
 * @param {{ resync?: bool, onProgress?: fn }} opts
 */
async function gcalSync({ resync = false, onProgress = () => {} } = {}) {
  if (!gcalIsConnected()) await gcalConnect();

  const calendarId = getCalendarId();

  // 1. Fetch current MSH events
  onProgress({ step: 'fetch', msg: 'Lade Stundenplan...' });
  const resp = await fetch('/api/schedule');
  const { events } = await resp.json();
  if (!events?.length) throw new Error('No events to sync');

  // 2. If resync: delete all previously synced events (by stored IDs)
  if (resync) {
    onProgress({ step: 'delete', msg: 'Lösche alte Termine...' });
    await gcalDeleteSynced(calendarId, onProgress);
  }

  // 3. Create new events
  onProgress({ step: 'create', msg: `Erstelle ${events.length} Termine...`, total: events.length, done: 0 });

  const synced = [];
  let done = 0;

  for (const e of events) {
    const startDt = parseDtstring(e.dtstart);
    const endDt   = parseDtstring(e.dtend);
    if (!startDt || !endDt) continue;

    // Skip events already synced (if not resyncing)
    if (!resync && isSynced(e.fingerprint)) continue;

    const instructor = extractInstructor(e.description || '');
    const room       = (e.location || '').split(' – ')[0].split(' - ')[0].trim();

    const resource = {
      summary: `[MSH] ${e.shortTitle || e.summary}`,
      description: [
        e.moduleCode  ? `Modul: ${e.moduleCode}` : null,
        instructor    ? `Dozent: ${instructor}`   : null,
        room          ? `Raum: ${room}`           : null,
        '',
        'Aktuelle Termine immer im TraiNex prüfen.',
      ].filter(l => l !== null).join('\n'),
      location: room ? `${room}, MSH Medical School Hamburg, Am Kaiserkai 1, 20457 Hamburg` : undefined,
      start: { dateTime: startDt.toISOString(), timeZone: TIMEZONE },
      end:   { dateTime: endDt.toISOString(),   timeZone: TIMEZONE },
      colorId: '9',  // blueberry — stands out as MSH events
      extendedProperties: {
        private: {
          mshSync: '1',
          mshFingerprint: e.fingerprint || '',
          mshModule: e.moduleCode || '',
        },
      },
    };

    try {
      const created = await gapi.client.calendar.events.insert({
        calendarId,
        resource,
      });
      synced.push({ id: created.result.id, fingerprint: e.fingerprint });
    } catch (err) {
      console.warn('[gcal] Failed to create event:', e.shortTitle, err.message);
    }

    done++;
    onProgress({ step: 'create', msg: `Erstelle Termine... (${done}/${events.length})`, total: events.length, done });
  }

  // 4. Store synced event IDs
  storeSynced(synced, resync);

  onProgress({ step: 'done', msg: `✅ ${done} Termine synchronisiert`, done, total: events.length });
  return { synced: done };
}

/**
 * Delete all previously synced [MSH] events from Google Calendar.
 * Uses stored event IDs + falls back to searching by title prefix.
 */
async function gcalDeleteSynced(calendarId, onProgress = () => {}) {
  const stored = getSyncedEvents();
  let deleted = 0;

  // Delete by stored IDs
  for (const { id } of stored) {
    try {
      await gapi.client.calendar.events.delete({ calendarId, eventId: id });
      deleted++;
    } catch (err) {
      // Already deleted or not found — ignore
    }
  }

  // Fallback: search for remaining [MSH] events by extended property
  try {
    const search = await gapi.client.calendar.events.list({
      calendarId,
      privateExtendedProperty: 'mshSync=1',
      singleEvents: true,
      maxResults: 2500,
    });
    for (const evt of (search.result.items || [])) {
      try {
        await gapi.client.calendar.events.delete({ calendarId, eventId: evt.id });
        deleted++;
      } catch {}
    }
  } catch {}

  clearSynced();
  onProgress({ step: 'delete', msg: `Gelöscht: ${deleted} alte Termine` });
  return deleted;
}

// ── localStorage helpers ──────────────────────────────────────────────────────

function getSyncedEvents() {
  try { return JSON.parse(localStorage.getItem(GCAL_STORAGE_KEY) || '[]'); }
  catch { return []; }
}

function isSynced(fingerprint) {
  return getSyncedEvents().some(e => e.fingerprint === fingerprint);
}

function storeSynced(newItems, replace = false) {
  const existing = replace ? [] : getSyncedEvents();
  const merged   = [...existing.filter(e => !newItems.find(n => n.fingerprint === e.fingerprint)), ...newItems];
  localStorage.setItem(GCAL_STORAGE_KEY, JSON.stringify(merged));
}

function clearSynced() {
  localStorage.removeItem(GCAL_STORAGE_KEY);
}

function getSyncStats() {
  return { syncedCount: getSyncedEvents().length };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function parseDtstring(dt) {
  if (!dt) return null;
  const m = dt.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]));
}

function extractInstructor(desc) {
  const m = desc.match(/Dozent:\s*([^|]+)/);
  return m ? m[1].trim() : '';
}

// ── Callbacks (override in dashboard) ────────────────────────────────────────
function gcalOnConnected() { window.dispatchEvent(new Event('gcal:connected')); }
function gcalOnError(msg)  { window.dispatchEvent(new CustomEvent('gcal:error', { detail: msg })); }
