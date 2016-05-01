var defaults = require('lodash.defaults');
var isEmpty = require('lodash.isempty');
var isObject = require('lodash.isobject');
var cloneDeep = require('lodash.clonedeep');
require('simple-errors');

var DEFAULT_MANIFEST = {
  router: [
    {
      module: 'webpage'
    }
  ],
  build: {
    engine: 'copy'
  }
};

var DEFAULT_PROPERTY = '_virtualApp';

module.exports = function(json, options) {
  options = defaults({}, options, {
    propertyName: DEFAULT_PROPERTY
  });

  if (isEmpty(json)) {
    return cloneDeep(DEFAULT_MANIFEST);
  }

  var packageJson;
  if (isObject(json)) {
    packageJson = json;
  } else {
    try {
      packageJson = JSON.parse(json);
    } catch (err) {
      throw Error.create('Cannot parse package.json', {code: 'malformedPackageJson'});
    }
  }

  var manifest = null;
  if (!isEmpty(options.propertyName)) {
    manifest = packageJson[options.propertyName];
  }

  // If we didn't find the manifest with the option property
  // try the default property.
  if (!isObject(manifest)) {
    manifest = packageJson[DEFAULT_PROPERTY];
  }

  // If still haven't found the manifest, use the default manifest.
  if (isObject(manifest) === false) {
    manifest = cloneDeep(DEFAULT_MANIFEST);
  }

  // If there is no build object on the manifest, default to the copy engine.
  if (isObject(manifest.build) === false) {
    manifest.build = {
      engine: 'copy'
    };
  }

  // If an invalid engine was specified, use the copy engine.
  if (isEmpty(manifest.build.engine)) {
    manifest.build.engine = 'copy';
  }

  return manifest;
};

module.exports.defaultManifest = DEFAULT_MANIFEST;
