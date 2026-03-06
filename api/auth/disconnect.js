/** Revokes Google token and clears auth cookies. */
module.exports = async (req, res) => {
  const cookies = parseCookies(req.headers.cookie || '');
  const token   = cookies.gcal_token;

  if (token) {
    fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' })
      .catch(() => {});
  }

  const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
  const secure = appUrl.startsWith('https');
  const expire = `Path=/; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=0`;

  res.setHeader('Set-Cookie', [
    `gcal_token=; ${expire}`,
    `gcal_refresh=; HttpOnly; ${expire}`,
  ]);
  res.json({ ok: true });
};

function parseCookies(str) {
  const out = {};
  for (const part of str.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) try { out[k.trim()] = decodeURIComponent(v.join('=')); } catch {}
  }
  return out;
}
