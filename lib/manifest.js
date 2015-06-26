var fs = require('fs');
var path = require('path');
var _ = require('lodash');
var stream = require('stream');
var debug = require('debug')('4front:deployer:manifest');
var through = require('through2');

var DEFAULT_MANIFEST = {
  router: [
    {
      module: "webpage"
    }
  ]
};

module.exports = function(json, callback) {
  if (_.isEmpty(json))
    return callback(null, DEFAULT_MANIFEST);

  var packageJson;
  try {
    packageJson = JSON.parse(json);
  }
  catch(err) {
    return callback(null, DEFAULT_MANIFEST);
  }

  if (_.isObject(packageJson._virtualApp) === false)
    return callback(null, DEFAULT_MANIFEST);

  return callback(null, packageJson._virtualApp)
};

module.exports.defaultManifest = DEFAULT_MANIFEST;
