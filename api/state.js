const store = require('../src/store');
module.exports = (req, res) => {
  res.json(store.readState());
};
