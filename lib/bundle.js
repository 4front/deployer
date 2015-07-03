var async = require('async');
var _ = require('lodash');
var shortid = require('shortid');
var through = require('through2');
var tar = require('tar');
var zlib = require('zlib');
var debug = require('debug')('4front:deployer:bundle');
var manifest = require('./manifest');

var MAX_READ_STREAM_ATTEMPTS = 3;

module.exports = function(settings) {
  var versions = require('./versions')(settings);
  var deploy = require('./deploy')(settings);

  return function(sourceBundle, context, callback) {
    settings.logger.info("start deploy of bundle for app %s", sourceBundle.appId);

    var deployedVersion, versionError;
    var appId = context.virtualApp.appId;

    async.series([
      function(cb) {
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
      },
      function(cb) {
        deployBundle(sourceBundle, deployedVersion.versionId, appId, function(err) {
          if (err) {
            versionError = err;
            return cb();
          }

          debug("done deploying version");
          cb();
        });
      },
      function(cb) {
        // Download the manifest that was just deployed to S3
        downloadManifest(appId, deployedVersion.versionId, function(err, manifestJson) {
          if (err) return cb(err);

          deployedVersion.manifest = manifestJson;
          cb();
        });
      },
      function(cb) {
        if (versionError) {
          if (_.isError(versionError))
            versionError = versionError.message;

          settings.logger.error("error deploying version: %s", versionError);

          deployedVersion.status = 'failed';
          deployedVersion.error = versionError;
        }
        else {
          deployedVersion.status = 'complete';
        }

        versions.updateStatus(deployedVersion, context, {}, cb);
      }
    ], function(err) {
      if (err) return callback(err);

      callback(null, deployedVersion);
    });
  };

  function downloadManifest(appId, versionId, callback) {
    settings.logger.info("downloading package.json manifest");

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
      return success === true || attempt > MAX_READ_STREAM_ATTEMPTS;
    }, function(cb) {
      settings.logger.info("attempt %s at deploying bundle", attempt);
      tryDeployBundle(sourceBundle, versionId, appId, function(err) {
        if (err) {
          if (err.retryable === true) {
            settings.logger.info("Error on attempt %s, trying again in 200 ms", attempt);
            attempt++;

            // Pause before trying again.
            return setTimeout(cb, 200);
          }
          else {
            return cb(err);
          }
        }

        success = true;
        cb();
      });
    }, function(err) {
      if (err)
        return callback(err);
      else if (success !== true)
        return callback(new Error("Tried " + MAX_READ_STREAM_ATTEMPTS + " to read stream without success"));
      else
        callback();
    });
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
       settings.logger.info("done gunzipping source bundle");
     });

    settings.logger.info("gunzip and parse tarball stream");
    sourceBundle.readStream()
      .on('error', function(err) {
        settings.logger.error("failed to read the bundle");
        return callback(Error.create("Could not read bundle", {retryable: true}));
      })
      .pipe(gunzip)
      .pipe(tar.Parse())
      .on('entry', function(entry) {
        // Check if the queue has been killed or this isn't a file.
        if (entry.type !== 'File')
          return;

        var deployFile = getDeployFile(entry, rootDirectory);
        if (deployFile) {
          uploadsStarted++;
          deploy(appId, versionId, deployFile, function(err) {
            if (err) {
              settings.logger.info("error deploying file %s: %o", deployFile.path, err.stack);
              return callback(err);
            }

            // Increment the completed uploads count
            uploadsCompleted++;
            settings.logger.info("done deploying file %s", deployFile.path);
          });
        }
      })
      .on('error', function(err) {
        settings.logger.error("error parsing zip file: %s", err.stack);
        return callback(err);
      })
      .on('end', function() {
        settings.logger.info("end of tar stream reached, waiting for all uploads to finish");

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
