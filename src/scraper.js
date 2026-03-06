/**
 * TraiNex Scraper
 * Logs into MSH TraiNex and downloads the iCal schedule export.
 * Navigation chain: login → nav_kt_links (shortcut) → stundenplan → listenansicht → iCal
 */

const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

const BASE_URL = 'https://www.trainex32.de/msh-trainex';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function createClient() {
  const jar = new CookieJar();
  const client = wrapper(axios.create({
    jar,
    withCredentials: true,
    headers: { 'User-Agent': USER_AGENT },
    maxRedirects: 0,        // handle redirects manually to capture location
    validateStatus: (s) => s < 500,
  }));
  return client;
}

/**
 * Extract tokens from a URL string or HTML content.
 * Returns { TokCF19, IDphp17, sec18m } or null.
 */
function extractTokens(str) {
  const tok = str.match(/TokCF19=([^&"'\s]+)/);
  const id  = str.match(/IDphp17=([^&"'\s]+)/);
  const sec = str.match(/sec18m=([^&"'\s]+)/);
  if (!tok || !id || !sec) return null;
  return { TokCF19: tok[1], IDphp17: id[1], sec18m: sec[1] };
}

/**
 * Full login + iCal download flow.
 * Returns the raw iCal string.
 */
async function downloadIcal({ username, password }) {
  const client = createClient();

  // ── Step 1: POST login form ──────────────────────────────────────────────
  console.log('[scraper] Logging in...');
  const loginResp = await client.post(
    `${BASE_URL}/start.cfm?eng=0`,
    new URLSearchParams({
      Login: username,
      Passwort: password,
      Domaene: '0',
      einloggen: 'Anmelden',
    }).toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: `${BASE_URL}/login.cfm`,
        Origin: 'https://www.trainex32.de',
      },
    }
  );

  const redirectUrl = loginResp.headers['location'];
  if (!redirectUrl) {
    throw new Error('Login failed: no redirect received. Check credentials.');
  }

  let tokens = extractTokens(redirectUrl);
  if (!tokens) {
    throw new Error(`Login failed: could not extract tokens from redirect: ${redirectUrl}`);
  }
  console.log('[scraper] Login OK, tokens:', tokens.TokCF19);

  // ── Step 2: GET nav_kt_links to get study-plan tokens ────────────────────
  console.log('[scraper] Fetching navigation...');
  const navResp = await client.get(
    `${BASE_URL}/navigation/nav_kt_links.cfm`,
    {
      params: {
        TokCF19: tokens.TokCF19,
        IDphp17: tokens.IDphp17,
        sec18m:  tokens.sec18m,
        area:    'Kursraum',
        subarea: '',
      },
    }
  );

  tokens = extractTokens(navResp.data);
  if (!tokens) {
    throw new Error('Could not extract tokens from nav_kt_links');
  }
  console.log('[scraper] Nav tokens:', tokens.TokCF19);

  // ── Step 3: GET Stundenplan (calendar overview) ──────────────────────────
  console.log('[scraper] Fetching Stundenplan...');
  const spResp = await client.get(
    `${BASE_URL}/cfm/einsatzplan/einsatzplan_stundenplan.cfm`,
    {
      params: {
        TokCF19:       tokens.TokCF19,
        IDphp17:       tokens.IDphp17,
        sec18m:        tokens.sec18m,
        area:          'Kursraum',
        subarea:       'studienplan',
        kid_sec_stud:  '236088270',
        kid:           '810',
      },
    }
  );

  tokens = extractTokens(spResp.data);
  if (!tokens) {
    throw new Error('Could not extract tokens from Stundenplan');
  }

  // ── Step 4: GET Listenansicht (list view) ────────────────────────────────
  console.log('[scraper] Fetching Listenansicht...');
  const today = new Date();
  // ColdFusion timestamp format: {ts '2026-03-06 00:00:00'}
  const anfDat = `{ts '${today.getFullYear()}-01-01 00:00:00'}`;

  const laResp = await client.get(
    `${BASE_URL}/cfm/einsatzplan/einsatzplan_listenansicht_kt.cfm`,
    {
      params: {
        TokCF19:      tokens.TokCF19,
        IDphp17:      tokens.IDphp17,
        sec18m:       tokens.sec18m,
        anf_dat:      anfDat,
        kid_fremd:    '810',
        kid_sec_stud: '236088270',
      },
    }
  );

  // Extract the iCal link from the listenansicht page
  const icalMatch = laResp.data.match(/href="(einsatzplan_listenansicht_iCal\.cfm\?[^"]+)"/);
  if (!icalMatch) {
    throw new Error('Could not find iCal export link in Listenansicht');
  }

  const icalRelUrl = icalMatch[1];
  const icalTokens = extractTokens(icalRelUrl);
  const icalParams = new URLSearchParams(icalRelUrl.split('?')[1]);

  // ── Step 5: Download iCal ────────────────────────────────────────────────
  console.log('[scraper] Downloading iCal...');
  const icalResp = await client.get(
    `${BASE_URL}/cfm/einsatzplan/einsatzplan_listenansicht_iCal.cfm`,
    {
      params: {
        TokCF19: icalTokens.TokCF19,
        IDphp17: icalTokens.IDphp17,
        sec18m:  icalTokens.sec18m,
        utag:    today.getDate(),
        umonat:  today.getMonth() + 1,
        ujahr:   today.getFullYear(),
        ics:     '1',
      },
    }
  );

  const ical = icalResp.data;
  if (!ical.includes('BEGIN:VCALENDAR')) {
    throw new Error('Downloaded content is not a valid iCal file');
  }

  const eventCount = (ical.match(/BEGIN:VEVENT/g) || []).length;
  console.log(`[scraper] Downloaded iCal with ${eventCount} events`);
  return ical;
}

module.exports = { downloadIcal };
