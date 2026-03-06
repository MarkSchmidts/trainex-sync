/**
 * TraiNex Scraper
 * Logs into MSH TraiNex and downloads the iCal schedule export.
 *
 * Navigation chain:
 *   1. GET login.cfm  (establish CF cookie + check page)
 *   2. POST start.cfm (login → 302 to frameset or direct 200 with redirect)
 *   3. GET frameset   (extract fresh tokens from FRAME SRC attributes)
 *   4. GET nav_kt_links (extract next tokens, proves we're in Kursraum)
 *   5. GET listenansicht (extract iCal link)
 *   6. GET iCal export
 */

const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

const BASE = 'https://www.trainex32.de/msh-trainex';

// Full browser headers to pass Cloudflare checks from CI/datacenter IPs
const BROWSER_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection':      'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest':  'document',
  'Sec-Fetch-Mode':  'navigate',
  'Sec-Fetch-Site':  'none',
  'Cache-Control':   'no-cache',
};

function createClient() {
  const jar = new CookieJar();
  return wrapper(axios.create({
    jar,
    withCredentials: true,
    headers: BROWSER_HEADERS,
    maxRedirects: 5,
    validateStatus: (s) => s < 500,
    timeout: 30000,
  }));
}

/** Extract TokCF19 / IDphp17 / sec18m from a URL or HTML string. */
function extractTokens(str) {
  const tok = str.match(/TokCF19=([^&"'\s<>]+)/);
  const id  = str.match(/IDphp17=([^&"'\s<>]+)/);
  const sec = str.match(/sec18m=([^&"'\s<>]+)/);
  if (!tok || !id || !sec) return null;
  return { TokCF19: tok[1], IDphp17: id[1], sec18m: sec[1] };
}

/** Return true if the HTML looks like a Cloudflare JS challenge page (not just CF beacon script). */
function isCfChallenge(html) {
  // Real CF challenges show one of these — NOT the beacon script that appears on all pages
  return html.includes('Checking if the site connection is secure') ||
         html.includes('cf-browser-verification') ||
         html.includes('Just a moment') ||
         html.includes('cf_chl_prog');
}

/** Return true if the response looks like the TraiNex login form (not logged in). */
function isLoginPage(html) {
  return html.includes('name="einloggen"') || html.includes('name="Passwort"');
}

/**
 * Full login + iCal download flow.
 * @returns {string} raw iCal text
 */
async function downloadIcal({ username, password }) {
  const client = createClient();

  // ── Step 1: GET login page to warm up CF cookies ──────────────────────
  console.log('[scraper] Fetching login page...');
  const loginPageResp = await client.get(`${BASE}/login.cfm`, {
    headers: { ...BROWSER_HEADERS, 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate' },
  });

  if (isCfChallenge(loginPageResp.data)) {
    console.warn('[scraper] Cloudflare challenge on login page — waiting 3s and retrying...');
    await new Promise(r => setTimeout(r, 3000));
    await client.get(`${BASE}/login.cfm`);
  }
  console.log('[scraper] Login page OK (status:', loginPageResp.status, ')');

  // ── Step 2: POST credentials ──────────────────────────────────────────
  console.log('[scraper] Posting credentials...');
  const postBody = new URLSearchParams({
    Login:      username,
    Passwort:   password,
    Domaene:    '0',
    einloggen:  'Anmelden',
  }).toString();

  const loginResp = await client.post(`${BASE}/start.cfm?eng=0`, postBody, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer':      `${BASE}/login.cfm`,
      'Origin':       'https://www.trainex32.de',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-User': '?1',
    },
    maxRedirects: 5,  // follow to frameset
  });

  console.log('[scraper] Login response status:', loginResp.status);

  // Check for Cloudflare challenge on the login response
  if (typeof loginResp.data === 'string' && isCfChallenge(loginResp.data)) {
    throw new Error('Cloudflare challenge on login response. Try running from a different IP.');
  }

  // Detect still on login page (bad credentials or other error)
  if (typeof loginResp.data === 'string' && isLoginPage(loginResp.data)) {
    throw new Error('Login failed: still on login page. Check TRAINEX_USER and TRAINEX_PASS secrets.');
  }

  // After following redirects, we should be at the frameset.
  // Extract tokens from the current response (frameset HTML).
  let tokens = extractTokens(loginResp.data || '');

  // If tokens not in body, try to get the final URL
  if (!tokens && loginResp.request) {
    const finalUrl = loginResp.request.path || loginResp.request.responseURL || '';
    tokens = extractTokens(finalUrl);
  }

  if (!tokens) {
    // Last resort: access the frameset directly using CFID/CFTOKEN cookies
    console.log('[scraper] Tokens not in redirect — fetching frameset directly...');
    const fsResp = await client.get(`${BASE}/navigation/frameset.cfm?area=start`);
    tokens = extractTokens(fsResp.data);
  }

  if (!tokens) {
    const snippet = typeof loginResp.data === 'string'
      ? loginResp.data.substring(0, 300)
      : JSON.stringify(loginResp.data);
    throw new Error(`Could not extract session tokens. Response snippet: ${snippet}`);
  }

  console.log('[scraper] Session tokens obtained:', tokens.TokCF19);

  // ── Step 3: GET nav_kt_links with current tokens ──────────────────────
  console.log('[scraper] Fetching navigation (nav_kt_links)...');
  const navResp = await client.get(`${BASE}/navigation/nav_kt_links.cfm`, {
    params: {
      TokCF19: tokens.TokCF19,
      IDphp17: tokens.IDphp17,
      sec18m:  tokens.sec18m,
      area:    'Kursraum',
      subarea: '',
    },
    headers: { Referer: `${BASE}/navigation/frameset.cfm` },
  });

  const navTokens = extractTokens(navResp.data);
  if (!navTokens) {
    throw new Error('Could not extract tokens from nav_kt_links');
  }
  console.log('[scraper] Nav tokens:', navTokens.TokCF19);

  // ── Step 4: GET Stundenplan ───────────────────────────────────────────
  console.log('[scraper] Fetching Stundenplan...');
  const spResp = await client.get(
    `${BASE}/cfm/einsatzplan/einsatzplan_stundenplan.cfm`, {
      params: {
        TokCF19:      navTokens.TokCF19,
        IDphp17:      navTokens.IDphp17,
        sec18m:       navTokens.sec18m,
        area:         'Kursraum',
        subarea:      'studienplan',
        kid_sec_stud: '236088270',
        kid:          '810',
      },
      headers: { Referer: `${BASE}/navigation/nav_kt_links.cfm` },
    }
  );

  const spTokens = extractTokens(spResp.data);
  if (!spTokens) {
    throw new Error('Could not extract tokens from Stundenplan');
  }

  // ── Step 5: GET Listenansicht ─────────────────────────────────────────
  console.log('[scraper] Fetching Listenansicht...');
  const today  = new Date();
  const anfDat = `{ts '${today.getFullYear()}-01-01 00:00:00'}`;

  const laResp = await client.get(
    `${BASE}/cfm/einsatzplan/einsatzplan_listenansicht_kt.cfm`, {
      params: {
        TokCF19:      spTokens.TokCF19,
        IDphp17:      spTokens.IDphp17,
        sec18m:       spTokens.sec18m,
        anf_dat:      anfDat,
        kid_fremd:    '810',
        kid_sec_stud: '236088270',
      },
      headers: { Referer: `${BASE}/cfm/einsatzplan/einsatzplan_stundenplan.cfm` },
    }
  );

  // Extract iCal link and its tokens
  const icalMatch = laResp.data.match(
    /href="(einsatzplan_listenansicht_iCal\.cfm\?[^"]+)"/
  );
  if (!icalMatch) {
    throw new Error('iCal export link not found in Listenansicht. Is the account still active?');
  }

  const icalTokens = extractTokens(icalMatch[1]);
  if (!icalTokens) {
    throw new Error('Could not extract tokens from iCal link');
  }

  // ── Step 6: Download iCal ─────────────────────────────────────────────
  console.log('[scraper] Downloading iCal...');
  const icalResp = await client.get(
    `${BASE}/cfm/einsatzplan/einsatzplan_listenansicht_iCal.cfm`, {
      params: {
        TokCF19: icalTokens.TokCF19,
        IDphp17: icalTokens.IDphp17,
        sec18m:  icalTokens.sec18m,
        utag:    today.getDate(),
        umonat:  today.getMonth() + 1,
        ujahr:   today.getFullYear(),
        ics:     '1',
      },
      headers: { Referer: `${BASE}/cfm/einsatzplan/einsatzplan_listenansicht_kt.cfm` },
    }
  );

  const ical = icalResp.data;
  if (typeof ical !== 'string' || !ical.includes('BEGIN:VCALENDAR')) {
    throw new Error(`Downloaded content is not valid iCal. Got: ${String(ical).substring(0, 200)}`);
  }

  const count = (ical.match(/BEGIN:VEVENT/g) || []).length;
  console.log(`[scraper] Downloaded iCal with ${count} events`);
  return ical;
}

module.exports = { downloadIcal };
