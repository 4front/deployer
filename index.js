var assign = require('lodash.assign');
var defaults = require('lodash.defaults');
var debug = require('debug')('4front:deployer');

module.exports = function(settings) {
  if (!settings.database) throw new Error('Missing database option');

  if (!settings.storage) throw new Error('Missing storage option');

  if (settings.localMachine === true) {
    debug('use local machine build runtimes');
    assign(settings, require('./local-ruby-config'), {
      hugoBinary: 'hugo'
    });
  }

  defaults(settings, {
    defaultMaxAge: 31557600 // one year
  });

  var exports = {};

  // Deploy an app source bundle
  exports.bundle = require('./lib/bundle')(settings);

  // Create,update, and delete versions
  exports.versions = require('./lib/versions')(settings);

  // Serve deployed static assets
  exports.serve = require('./lib/serve')(settings);

  exports.deploy = require('./lib/deploy')(settings);

  return exports;
};
