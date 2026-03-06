const store = require('../src/store');
const { cleanIcal } = require('../src/diff');

module.exports = (req, res) => {
  const raw = store.readLatest();
  if (!raw) return res.status(404).send('No iCal available yet. Wait for the first daily check.');

  const ical = cleanIcal(raw, '[MSH]');
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="msh-stundenplan.ics"');
  res.send(ical);
};
