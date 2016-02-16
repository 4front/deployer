var async = require('async');
var _ = require('lodash');
var manifest = require('./manifest');

require('simple-errors');

module.exports = function(settings) {
  var versions = require('./versions')(settings);

  _.defaults(settings, {
    gzipStaticAssets: false
  });

  return function(sourceBundle, context, callback) {
    settings.logger.debug('start deploy of bundle for app %s', sourceBundle.appId);

    // If there is no sourceBuilder, default to using the bundle-nobuild
    // which just deploys the files as-is.
    _.defaults(sourceBundle, {
      deployer: require('./bundle-nobuild')(settings)
    });

    var deployedVersion, versionError;
    var appId = context.virtualApp.appId;

    async.series([
      function(cb) {
        var versionData = {
          message: sourceBundle.message,
          commit: sourceBundle.commit,
          appId: appId,
          virtualEnv: sourceBundle.virtualEnv,
          manifest: {}
        };

        versions.create(versionData, context, function(err, version) {
          if (err) return cb(err);

          sourceBundle.versionId = version.versionId;
          sourceBundle.fileCount = 0;
          deployedVersion = version;

          cb();
        });
      },
      function(cb) {
        // First check for a sourceBuilder function, then fallback to deployBundle.
        sourceBundle.deployer(sourceBundle, deployedVersion.versionId, appId, function(err) {
          if (err) {
            versionError = err;
            return cb();
          }

          cb();
        });
      },
      function(cb) {
        if (sourceBundle.deploymentStopped !== true && !versionError) {
          // Download the manifest that was just deployed to S3
          downloadManifest(appId, deployedVersion.versionId, function(err, manifestJson) {
            if (err) return cb(err);

            // The onManifest function allows the client to do something to the
            // manifest object before it is officially deployed.
            if (_.isFunction(context.onManifest)) {
              context.onManifest(context.organization, context.virtualApp, manifestJson);
            }

            deployedVersion.manifest = manifestJson;
            cb();
          });
        } else {
          cb();
        }
      },
      function(cb) {
        // Seems counter-intuitive, but make sure the deployment runs for at least 15 seconds to make the
        // dashboard seem more impressive so the spinner can display for at least a few seconds.
        deployedVersion.duration = Date.now() - deployedVersion.created;
        if (deployedVersion.duration < 10000) {
          setTimeout(function() {
            deployedVersion.duration += Date.now() - deployedVersion.created;
            cb();
          }, 10000 - deployedVersion.duration);
        } else {
          cb();
        }
      },
      function(cb) {
        _.extend(deployedVersion, {
          fileCount: sourceBundle.fileCount,
          virtualEnv: sourceBundle.virtualEnv
        });

        if (versionError) {
          var errorMetadata = _.extend(Error.toJson(versionError), {
            key: sourceBundle.key
          });

          settings.logger.error('error deploying version: %s',
            JSON.stringify(errorMetadata));

          deployedVersion.status = 'failed';
          deployedVersion.error = versionError.message;
        } else if (sourceBundle.deploymentStopped === true) {
          deployedVersion.status = 'timedOut';
        } else {
          deployedVersion.status = 'complete';
        }

        versions.updateStatus(deployedVersion, context, {}, cb);
      }
    ], function(err) {
      callback(err, deployedVersion);
    });
  };

  function downloadManifest(appId, versionId, callback) {
    settings.logger.debug('downloading package.json manifest');

    var key = appId + '/' + versionId + '/package.json';
    settings.storage.readFile(key, function(err, data) {
      if (err) return callback(err);

      manifest(data, {propertyName: settings.packageJsonManifestKey}, callback);
    });
  }
};
