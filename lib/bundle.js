var async = require('async');
var _ = require('lodash');
var tar = require('tar');
var zlib = require('zlib');
// var debug = require('debug')('4front:deployer:bundle');
var manifest = require('./manifest');

require('simple-errors');

var MAX_READ_STREAM_ATTEMPTS = 3;

module.exports = function(settings) {
  var versions = require('./versions')(settings);
  var deploy = require('./deploy')(settings);

  return function(sourceBundle, context, callback) {
    settings.logger.debug("start deploy of bundle for app %s", sourceBundle.appId);

    var deployedVersion, versionError;
    var appId = context.virtualApp.appId;

    async.series([
      function(cb) {
        // If the sourceBundle specifies a versionId, this must be a continuation of an
        // existing version rather than a version that needs to be created from scratch.
        if (sourceBundle.versionId) {
          settings.database.getVersion(sourceBundle.versionId, function(err, version) {
            if (err) return cb(err);

            if (!version) {
              return cb(new Error("Existing version " +
                sourceBundle.versionId + " does not exist"));
            }

            deployedVersion = version;
            cb();
          });
        }
        else {
          var versionData = {
            message: sourceBundle.message,
            appId: appId,
            manifest: {}
          };

          settings.logger.info("creating version");
          versions.create(versionData, context, function(err, version) {
            if (err) return cb(err);
            deployedVersion = version;
            cb();
          });
        }
      },
      function(cb) {
        // If this is a continuation of an existing deployment, find all the files
        // that have already been deployed so we don't try and redeploy them.
        if (sourceBundle.versionId) {
          var prefix = appId + '/' + sourceBundle.versionId;
          settings.storage.listFiles(prefix, function(err, files) {
            if (err) return cb(err);

            // Trim off the appId and versionId from each file
            sourceBundle.deployedFiles = _.map(files, function(key) {
              return key.slice(prefix.length + 1);
            });

            cb();
          });
        }
        else {
          sourceBundle.deployedFiles = [];
          cb();
        }
      },
      function(cb) {
        deployBundle(sourceBundle, deployedVersion.versionId, appId, function(err) {
          if (err) {
            versionError = err;
            return cb();
          }

          cb();
        });
      },
      function(cb) {
        if (sourceBundle.deploymentStopped !== true) {
          // Download the manifest that was just deployed to S3
          downloadManifest(appId, deployedVersion.versionId, function(err, manifestJson) {
            if (err) return cb(err);

            deployedVersion.manifest = manifestJson;
            cb();
          });
        }
        else
          cb();
      },
      function(cb) {
        if (versionError) {
          var errorMetadata = _.extend(Error.toJson(versionError), {
            key: sourceBundle.key
          });

          settings.logger.error("error deploying version: %s",
            JSON.stringify(errorMetadata));

          deployedVersion.status = 'failed';
          deployedVersion.error = versionError.message;
          versions.updateStatus(deployedVersion, context, {}, cb);
          return;
        }

        // If the deployment of the bundle was stopped, then do not
        // update the status.
        if (sourceBundle.deploymentStopped === true) {
          return cb();
        }

        deployedVersion.status = 'complete';
        versions.updateStatus(deployedVersion, context, {}, cb);
      }
    ], function(err) {
      if (err) return callback(err);

      callback(null, deployedVersion);
    });
  };

  function downloadManifest(appId, versionId, callback) {
    settings.logger.debug("downloading package.json manifest");

    var key = appId + '/' + versionId + '/package.json';
    settings.storage.readFile(key, function(err, data) {
      if (err) return callback(err);

      manifest(data, callback);
    });
  }

  function deployBundle(sourceBundle, versionId, appId, callback) {
    var attempt = 1;
    var success = false;

    async.until(function() {
      return success === true;
    }, function(cb) {
      settings.logger.debug("attempt %s at deploying bundle", attempt);
      tryDeployBundle(sourceBundle, versionId, appId, function(err) {
        if (err) {
          if (err.retryable === true) {
            if (attempt === MAX_READ_STREAM_ATTEMPTS) {
              return cb(Error.create("Tried " + MAX_READ_STREAM_ATTEMPTS +
                " to read stream without success", {}, err));
            }

            // Pause before trying again.
            attempt++;
            settings.logger.warn("Error on attempt %s, trying again in 200 ms", attempt);
            return setTimeout(cb, 200);
          }
          return cb(err);
        }

        success = true;
        cb();
      });
    }, callback);
  }

  function tryDeployBundle(sourceBundle, versionId, appId, callback) {
    var uploadsStarted = 0;
    var uploadsCompleted = 0;

    // Remove any leading or trailing slashes from the deployDirectory
    var rootDirectory = null;
    if (sourceBundle.deployDirectory)
      rootDirectory = sourceBundle.deployDirectory.replace(/\//g, '');

    var gunzip = zlib.createGunzip()
     .on('error', function(err) {
       settings.logger.error("error parsing zip file: %s", err.stack);
       return callback(err);
     })
     .on('end', function() {
       settings.logger.debug("done gunzipping source bundle");
     });

    settings.logger.debug("gunzip and parse tarball stream");
    sourceBundle.readStream()
      .on('error', function(err) {
        settings.logger.error("failed to read the bundle");
        return callback(Error.create("Could not read bundle", {retryable: true}, err));
      })
      .pipe(gunzip)
      .pipe(tar.Parse())
      .on('entry', function(entry) {
        // Check if the queue has been killed or this isn't a file.
        if (entry.type !== 'File' || sourceBundle.deploymentStopped === true)
          return;

        var deployFile = getDeployFile(entry, rootDirectory);

        if (deployFile) {
          // If this file has already been deployed, then skip it.
          if (_.contains(sourceBundle.deployedFiles, entry.path) === true) {
            settings.logger.debug("skipping already deployed file %s", deployFile.path);
            return;
          }

          if (_.isFunction(sourceBundle.shouldStop)) {
            // Check if the bundle stop deploying any additional files.
            if (sourceBundle.shouldStop(entry)) {
              // Set the deploymentStopped property and invoke callback right away.
              // The stream will continue to be read, but there is a check in the
              // end event to prevent the callback from getting called a second time.
              sourceBundle.deploymentStopped = true;
              return callback();
            }
          }

          uploadsStarted++;
          deploy(appId, versionId, deployFile, function(err) {
            if (err) {
              settings.logger.warn("error deploying file %s: %o", deployFile.path, err.stack);
              return callback(err);
            }

            // Increment the completed uploads count
            uploadsCompleted++;
            settings.logger.debug("done deploying file %s", deployFile.path);
          });
        }
      })
      .on('error', function(err) {
        settings.logger.error("error parsing zip file: %s", err.stack);
        return callback(err);
      })
      .on('end', function() {
        settings.logger.debug("end of tar stream reached, waiting for all uploads to finish");

        // If the deployment was stopped, the callback has already been invoked,
        // so just exit out.
        if (sourceBundle.deploymentStopped === true)
          return;

        if (uploadsStarted === 0) {
          return callback(new Error("No files found to deploy"));
        }

        // Wait until the last upload has completed.
        async.until(function() {
          return uploadsCompleted === uploadsStarted;
        }, function(cb) {
          setTimeout(cb, 100);
        }, callback);
      });
  }

  function getDeployFile(entry, rootDirectory) {
    // Chop off the root directory
    entry.path = entry.path.slice(entry.path.indexOf('/') + 1);

    if (entry.path !== 'package.json' && rootDirectory) {
      // Check if the file is within the deploy directory like /build.
      // If so strip off the root directory.
      if (entry.path.slice(0, rootDirectory.length + 1) === rootDirectory + '/') {
        entry.path = entry.path.slice(entry.path.indexOf('/') + 1);
      }
      else {
        return null;
      }
    }

    return {
      path: entry.path,
      contents: entry
    };
  }
}
