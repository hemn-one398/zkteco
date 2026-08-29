const { app, ready } = require('../server')

module.exports = async (req, res) => {
  await ready
  return app(req, res)
}
