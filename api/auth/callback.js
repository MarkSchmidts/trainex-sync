/** Exchanges OAuth code for tokens server-side. Client Secret never leaves here. */
module.exports = async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.redirect(`/?gcal_error=${encodeURIComponent(error || 'no_code')}`);
  }

  const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
  const secure = appUrl.startsWith('https');

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  `${appUrl}/api/auth/callback`,
        grant_type:    'authorization_code',
      }),
    });

    const tokens = await tokenRes.json();

    if (tokens.error) {
      return res.redirect(`/?gcal_error=${encodeURIComponent(tokens.error_description || tokens.error)}`);
    }

    const cookieBase = `Path=/; SameSite=Lax${secure ? '; Secure' : ''}`;
    const cookies = [
      `gcal_token=${encodeURIComponent(tokens.access_token)}; Max-Age=${tokens.expires_in || 3599}; ${cookieBase}`,
    ];
    if (tokens.refresh_token) {
      cookies.push(
        `gcal_refresh=${encodeURIComponent(tokens.refresh_token)}; HttpOnly; Max-Age=7776000; ${cookieBase}`
      );
    }
    res.setHeader('Set-Cookie', cookies);
    res.redirect('/#gcal-connected');

  } catch (err) {
    res.redirect(`/?gcal_error=${encodeURIComponent(err.message)}`);
  }
};
