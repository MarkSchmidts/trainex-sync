const store = require('../src/store');

module.exports = (req, res) => {
  const ical = store.readLatest();
  if (!ical) return res.status(404).send('No iCal available yet. Wait for the first daily check.');
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="msh-stundenplan.ics"');
  res.send(ical);
};
