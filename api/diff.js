const store = require('../src/store');
const { diffIcal, formatDate, parseDate, shortSummary } = require('../src/diff');

module.exports = (req, res) => {
  const prev = store.readPrevious();
  const curr = store.readLatest();
  if (!curr) return res.json({ hasChanges: false, stats: {} });

  const diff = diffIcal(prev, curr);
  const enrich = (e) => ({
    ...e,
    startFormatted: formatDate(parseDate(e.dtstart)),
    endFormatted:   formatDate(parseDate(e.dtend)),
    shortTitle:     shortSummary(e.summary),
  });

  res.json({
    ...diff,
    added:    diff.added.map(enrich),
    removed:  diff.removed.map(enrich),
    modified: diff.modified.map(m => ({ old: enrich(m.old), new: enrich(m.new) })),
  });
};
