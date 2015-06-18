var fs = require('fs');
var path = require('path');
var _ = require('lodash');

var DEFAULT_MANIFEST = {
  router: [
    {
      module: "webpage"
    }
  ]
};

module.exports = function(dir, callback) {
  fs.readFile(path.join(dir, 'package.json'), function(err, data) {
    if (err && err.code === 'ENOENT') {
      return callback(null, DEFAULT_MANIFEST);
    }

    var packageJson;
    try {
      packageJson = JSON.parse(data);
    }
    catch(err) {
      return callback(null, DEFAULT_MANIFEST);
    }

    if (_.isObject(packageJson._virtualApp) === false)
      return callback(null, DEFAULT_MANIFEST);

    return callback(null, packageJson._virtualApp)
  });
};

module.exports.defaultManifest = DEFAULT_MANIFEST;
