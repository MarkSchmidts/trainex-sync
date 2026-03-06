const store = require('../src/store');
const { parseIcal, parseDate, shortSummary, formatDate } = require('../src/diff');

module.exports = (req, res) => {
  const ical = store.readLatest();
  if (!ical) return res.json({ events: [] });
  const events = parseIcal(ical).map(e => ({
    ...e,
    startDate:      parseDate(e.dtstart)?.toISOString(),
    endDate:        parseDate(e.dtend)?.toISOString(),
    shortTitle:     shortSummary(e.summary),
    startFormatted: formatDate(parseDate(e.dtstart)),
    endFormatted:   formatDate(parseDate(e.dtend)),
  }));
  res.json({ events, total: events.length });
};
