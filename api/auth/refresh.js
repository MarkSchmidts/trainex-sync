/** Uses the HttpOnly refresh token cookie to get a new access token. */
module.exports = async (req, res) => {
  const cookies      = parseCookies(req.headers.cookie || '');
  const refreshToken = cookies.gcal_refresh;

  if (!refreshToken) return res.status(401).json({ error: 'no_refresh_token' });

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type:    'refresh_token',
      }),
    });

    const tokens = await tokenRes.json();
    if (tokens.error) return res.status(401).json({ error: tokens.error });

    const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
    const secure = appUrl.startsWith('https');

    res.setHeader('Set-Cookie',
      `gcal_token=${encodeURIComponent(tokens.access_token)}; Max-Age=${tokens.expires_in || 3599}; Path=/; SameSite=Lax${secure ? '; Secure' : ''}`
    );
    res.json({ ok: true });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

function parseCookies(str) {
  const out = {};
  for (const part of str.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) try { out[k.trim()] = decodeURIComponent(v.join('=')); } catch {}
  }
  return out;
}
