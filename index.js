var exports = {};
exports.build = require('./lib/build');

// Create,update, and delete versions
exports.versions = require('./lib/versions');

exports.deploy = require('./lib/deploy');

module.exports = exports;
