var async = require('async');
var _ = require('lodash');
var tar = require('tar');
var zlib = require('zlib');
var path = require('path');
var manifest = require('./manifest');

require('simple-errors');

var deployableFileExtensions = ['html', 'css', 'js', 'png', 'gif', 'jpg', 'jpeg',
  'json', 'ico', 'woff', 'otf', 'ttf', 'eot', 'mp3', 'pdf', 'xml', 'csv', 'tsv',
  'svg', 'woff2', 'md', 'markdown'];

module.exports = function(settings) {
  var versions = require('./versions')(settings);
  var deploy = require('./deploy')(settings);

  return function(sourceBundle, context, callback) {
    settings.logger.debug('start deploy of bundle for app %s', sourceBundle.appId);

    var deployedVersion, versionError;
    var appId = context.virtualApp.appId;

    async.series([
      function(cb) {
        var versionData = {
          message: sourceBundle.message,
          commit: sourceBundle.commit,
          appId: appId,
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
        deployBundle(sourceBundle, deployedVersion.versionId, appId, function(err) {
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
        deployedVersion.fileCount = sourceBundle.fileCount;

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

      manifest(data, callback);
    });
  }

  function deployBundle(sourceBundle, versionId, appId, callback) {
    var uploadsStarted = 0;
    var callbackCalled = false;

    sourceBundle.fileCount = 0;

    // Remove any leading or trailing slashes from the deployDirectory
    var rootDirectory = null;
    if (sourceBundle.deployDirectory) {
      rootDirectory = sourceBundle.deployDirectory;
      if (rootDirectory[0] === '/') {
        rootDirectory = rootDirectory.slice(1);
      }
      if (rootDirectory.slice(-1) === '/') {
        rootDirectory = rootDirectory.slice(0, -1);
      }
    }

    settings.logger.debug('gunzip and parse tarball stream %s', sourceBundle.key);

    var readStream = sourceBundle.readStream()
      .on('error', function(err) {
        settings.logger.error('failed to read the bundle');
        callbackCalled = true;
        return callback(Error.create('Could not read bundle', {retryable: true}, err));
      });

    var gunzip = zlib.createGunzip()
     .on('error', function(err) {
       settings.logger.error('error parsing zip file: %s', err.stack);
       callbackCalled = true;
       return callback(err);
     })
     .on('end', function() {
       settings.logger.debug('done gunzipping source bundle %s', sourceBundle.key);
     });

    /* eslint-disable */
    var parser = tar.Parse();
    /* eslint-enable */

    parser.on('entry', function(entry) {
      if (callbackCalled) return;

      var _this = this;
      // Check if the queue has been killed or this isn't a file.
      if (entry.type !== 'File' || sourceBundle.deploymentStopped === true) return;

      var deployFile = getDeployFile(entry, rootDirectory);
      if (!deployFile) return;

      var extname = path.extname(deployFile.path);
      if (deployableFileExtensions.indexOf(extname.slice(1)) === -1) {
        settings.logger.debug('skipping file %s', deployFile.path);
        return;
      }

      if (_.isFunction(sourceBundle.shouldStop)) {
        // Check if the bundle stop deploying any additional files.
        if (sourceBundle.shouldStop(entry) === true) {
          // Set the deploymentStopped property, force the end of the stream,
          // and invoke callback right away.
          settings.logger.info('stopping deployment of', sourceBundle.key);

          sourceBundle.deploymentStopped = true;
          callbackCalled = true;
          callback();

          _this.end();
          return;
        }
      }

      uploadsStarted++;
      deploy(appId, versionId, deployFile, function(err) {
        if (err) {
          settings.logger.warn('error deploying file %s: %o', deployFile.path, err.stack);
          callbackCalled = true;
          callback(err);
          return;
        }

        // Increment the completed uploads count
        sourceBundle.fileCount++;
      });
    })
    .on('error', function(err) {
      if (callbackCalled === true) return;

      settings.logger.error('error parsing zip file: %s', err.stack);
      callbackCalled = true;
      callback(err);
      return;
    })
    .on('end', function() {
      // If the deployment was stopped, the callback has already been invoked,
      // so just exit out.
      if (sourceBundle.deploymentStopped === true || callbackCalled === true) return;

      settings.logger.debug('end of tar stream reached, waiting for all uploads to finish');

      if (uploadsStarted === 0) {
        callback(new Error('No files found to deploy'));
        return;
      }

      // Wait until the last upload has completed.
      async.until(function() {
        return sourceBundle.fileCount >= uploadsStarted;
      }, function(cb) {
        setTimeout(cb, 100);
      }, callback);
    });

    readStream
      .pipe(gunzip)
      .pipe(parser);
  }

  function getDeployFile(entry, rootDirectory) {
    // Chop off the root directory
    entry.path = entry.path.slice(entry.path.indexOf('/') + 1);

    if (entry.path !== 'package.json' && rootDirectory) {
      // Check if entry.path is nested beneath the root directory.
      // Then convert to a path relative to the root.
      var relativePath = path.relative(rootDirectory, entry.path);

      // If the file is above the root, then relativePath will look
      // like "../file.html". Return null to indicate this file
      // should not be deployed.
      if (relativePath.substring(0, 2) === '..') return null;

      entry.path = relativePath;
    }

    return {
      path: entry.path,
      contents: entry
    };
  }
};
