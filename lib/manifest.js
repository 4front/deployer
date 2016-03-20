var _ = require('lodash');

var DEFAULT_MANIFEST = {
  router: [
    {
      module: 'webpage'
    }
  ]
};

var DEFAULT_PROPERTY = '_virtualApp';

module.exports = function(json, options, callback) {
  if (_.isFunction(options)) {
    callback = options;
    options = {};
  }

  if (_.isEmpty(json)) {
    return callback(null, _.cloneDeep(DEFAULT_MANIFEST));
  }

  var packageJson;
  try {
    packageJson = JSON.parse(json);
  } catch (err) {
    return callback(new Error('Cannot parse package.json'));
  }

  var manifest = null;
  if (!_.isEmpty(options.propertyName)) {
    manifest = packageJson[options.propertyName];
  }

  // If we didn't find the manifest with the option property
  // try the default property.
  if (!_.isObject(manifest)) {
    manifest = packageJson[DEFAULT_PROPERTY];
  }

  // If still haven't found the manifest, use the default manifest.
  if (_.isObject(manifest) === false) {
    manifest = _.cloneDeep(DEFAULT_MANIFEST);
  }

  return callback(null, manifest);
};

module.exports.defaultManifest = DEFAULT_MANIFEST;
