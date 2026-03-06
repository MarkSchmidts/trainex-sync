/** Redirects browser to Google OAuth — Client ID never touches the frontend. */
module.exports = (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const appUrl   = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;

  if (!clientId) {
    return res.status(500).send('GOOGLE_CLIENT_ID not configured on server.');
  }

  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  `${appUrl}/api/auth/callback`,
    response_type: 'code',
    scope: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ].join(' '),
    access_type: 'offline',
    prompt:      'consent',
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
};
