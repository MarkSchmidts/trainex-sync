module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  });
};
