var fs = require('fs');
var path = require('path');
var forEach = require('lodash.foreach');
var semver = require('semver');

// Update the package.json dependency sections with local filesystem paths
// for those modules where the tarball exists locally and the version satisifes
// the specified semver in pacakge.json.
module.exports = function(options) {
  var localModules = loadLocalNpmManifest(options.npmTarballDirectory);

  return function(packageJson) {
    forEach(['dependencies', 'devDependencies', 'optionalDependencies'], function(section) {
      var deps = packageJson[section];
      if (deps) {
        forEach(deps, function(version, module) {
          if (localModules[module]) {
            var localVersion = localModules[module];
            if (semver.satisfies(localVersion, version)) {
              options.logger.info('update dependency %s to local tarball', module);
              var localPath = path.join(options.npmTarballDirectory,
                module + '-' + localVersion + '.tgz');
              deps[module] = localPath;
            }
          }
        });
      }
    });
  };
};

function loadLocalNpmManifest(dir) {
  var manifest = {};
  var modules = fs.readdirSync(dir);
  modules.forEach(function(file) {
    // File name is in the form "grunt-0.4.5.tgz". Split apart the name and the version.
    if (path.extname(file) === '.tgz') {
      var basename = path.basename(file, '.tgz');
      var lastDashIndex = basename.lastIndexOf('-');
      var moduleName = basename.substr(0, lastDashIndex);
      var version = basename.substr(lastDashIndex + 1);
      manifest[moduleName] = version;
    }
  });

  return manifest;
}
