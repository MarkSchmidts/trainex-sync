const store = require('../src/store');
const { parseIcal, parseDate, shortSummary } = require('../src/diff');

module.exports = (req, res) => {
  const ical = store.readLatest();
  if (!ical) return res.json({ events: [] });
  const events = parseIcal(ical).map(e => ({
    ...e,
    startDate:  parseDate(e.dtstart)?.toISOString(),
    endDate:    parseDate(e.dtend)?.toISOString(),
    shortTitle: shortSummary(e.summary),
  }));
  res.json({ events, total: events.length });
};
