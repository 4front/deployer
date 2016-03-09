var async = require('async');
var _ = require('lodash');
var manifest = require('./manifest');
var debug = require('debug')('4front:deployer:bundle');

require('simple-errors');

var buildEngines = {
  basic: require('../engines/basic'),
  jekyll: require('../engines/jekyll'),
  hugo: require('../engines/hugo')
};

module.exports = function(settings) {
  var versions = require('./versions')(settings);

  _.defaults(settings, {
    gzipStaticAssets: false
  });

  return function(sourceBundle, context, callback) {
    settings.logger.debug('start deploy of bundle for app %s', sourceBundle.appId);

    // Default to the basic build engine
    _.defaults(sourceBundle, {
      buildConfig: {
        engine: 'basic'
      }
    });

    var deployedVersion, versionError;
    var appId = context.virtualApp.appId;

    sourceBundle.virtualApp = context.virtualApp;

    async.series([
      function(cb) {
        // Check that there isn't already a version for this commit and
        // also that there isn't a deployment already underway.
        settings.database.listVersions(appId, {excludeIncomplete: false}, function(err, existingVersions) {
          if (err) return cb(err);

          if (_.some(existingVersions, {commit: sourceBundle.commit})) {
            return cb(Error.create('There is already a deployment for this commit', {
              commit: sourceBundle.commit,
              code: 'versionCommitExists'
            }));
          }

          if (_.some(existingVersions, {status: 'initiated'})) {
            return cb(Error.create('There is already a deployment of this app in-progress.', {
              code: 'deploymentInProgress'
            }));
          }

          cb();
        });
      },
      function(cb) {
        var versionData = {
          versionId: sourceBundle.versionId,
          message: sourceBundle.message,
          commit: sourceBundle.commit,
          appId: appId,
          virtualEnv: sourceBundle.virtualEnv,
          // No build log for basic deployments
          hasLog: sourceBundle.buildConfig.engine !== 'basic',
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
        // Try and create the buildEngine
        settings.logger.info('use build engine %s', sourceBundle.buildConfig.engine);
        var buildEngine = buildEngines[sourceBundle.buildConfig.engine];
        if (!buildEngine) {
          versionError = new Error('Invalid build engine ' + sourceBundle.buildConfig.engine);
          return cb();
        }

        sourceBundle.packageJsonManifestKey = settings.packageJsonManifestKey;
        buildEngine(settings)(sourceBundle, appId, deployedVersion.versionId, function(err) {
          if (err) {
            versionError = err;
            return cb();
          }

          cb();
        });
      },
      function(cb) {
        if (sourceBundle.deploymentStopped === true || versionError) return cb();

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
          settings.logger.error('error deploying version: %s', versionError.message);

          deployedVersion.status = 'failed';
          deployedVersion.error = versionError.message;
        } else if (sourceBundle.deploymentStopped === true) {
          settings.logger.error('deployment timed out');
          deployedVersion.status = 'timedOut';
        } else {
          settings.logger.info('done deploying %s files', deployedVersion.fileCount);
          deployedVersion.status = 'complete';
        }

        versions.updateStatus(deployedVersion, context, {}, cb);
      }
    ], function(err) {
      if (!err) {
        settings.logger.info('new versionId is %s', deployedVersion.versionId);
      }
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
