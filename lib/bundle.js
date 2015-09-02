var async = require('async');
var _ = require('lodash');
// var tar = require('tar');
// var zlib = require('zlib');
var targz = require('tar.gz');
var path = require('path');
var manifest = require('./manifest');

require('simple-errors');

// var MAX_READ_STREAM_ATTEMPTS = 3;

var deployableFileExtensions = ['html', 'css', 'js', 'png', 'gif', 'jpg', 'jpeg',
  'json', 'woff', 'otf', 'ttf', 'eot', 'mp3', 'pdf', 'xml', 'csv', 'tsv'];

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
        // if (sourceBundle.versionId) {
        //   settings.database.getVersion(appId, sourceBundle.versionId, function(err, version) {
        //     if (err) return cb(err);
        //
        //     if (!version) {
        //       return cb(new Error("Existing version " +
        //         sourceBundle.versionId + " does not exist"));
        //     }
        //
        //     if (_.any(version.deploymentParts, {partNumber: sourceBundle.partNumber})) {
        //       return cb(Error.create("Deployment part number %s already exists", {
        //         level: 'warn'
        //       }));
        //     }
        //
        //     // version.deploymentParts.push({
        //     //   partNumber: sourceBundle.partNumber,
        //     //   started: Date.now()
        //     // });
        //
        //     deployedVersion = version;
        //     cb();
        //   });
        // }
        // else {
        // sourceBundle.partNumber = 1;
        var versionData = {
          message: sourceBundle.message,
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
        // }
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
        }
        else
          cb();
      },
      function(cb) {
        // var deploymentPart = _.find(deployedVersion.deploymentParts, {
        //   partNumber: sourceBundle.partNumber
        // });

        // _.extend(deploymentPart, {
        //   fileCount: sourceBundle.fileCount,
        //   lastFile: sourceBundle.lastDeployAttempt,
        //   stopped: Date.now()
        // });

        // debugger;
        deployedVersion.fileCount = sourceBundle.fileCount;

        if (versionError) {
          var errorMetadata = _.extend(Error.toJson(versionError), {
            key: sourceBundle.key
          });

          settings.logger.error("error deploying version: %s",
            JSON.stringify(errorMetadata));

          deployedVersion.status = 'failed';
          deployedVersion.error = versionError.message;
        }
        else if (sourceBundle.deploymentStopped === true) {
          debugger;
          deployedVersion.status = 'timedOut';
        }
        else {
          deployedVersion.status = 'complete';
        }

        versions.updateStatus(deployedVersion, context, {}, cb);
      }
    ], function(err) {
      debugger;
      callback(err, deployedVersion);
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

  // function deployBundle(sourceBundle, versionId, appId, callback) {
  //   var attempt = 1;
  //   var success = false;
  //
  //   async.until(function() {
  //     return success === true;
  //   }, function(cb) {
  //     settings.logger.debug("attempt %s at deploying bundle", attempt);
  //     tryDeployBundle(sourceBundle, versionId, appId, function(err) {
  //       if (err) {
  //         if (err.retryable === true) {
  //           if (attempt === MAX_READ_STREAM_ATTEMPTS) {
  //             return cb(Error.create("Tried " + MAX_READ_STREAM_ATTEMPTS +
  //               " to read stream without success", {}, err));
  //           }
  //
  //           // Pause before trying again.
  //           attempt++;
  //           settings.logger.warn("Error on attempt %s, trying again in 200 ms", attempt);
  //           return setTimeout(cb, 200);
  //         }
  //         return cb(err);
  //       }
  //
  //       success = true;
  //       cb();
  //     });
  //   }, callback);
  // }

  function deployBundle(sourceBundle, versionId, appId, callback) {
    var uploadsStarted = 0;
    var callbackCalled = false;

    sourceBundle.fileCount = 0;

    // Remove any leading or trailing slashes from the deployDirectory
    var rootDirectory = null;
    if (sourceBundle.deployDirectory)
      rootDirectory = sourceBundle.deployDirectory.replace(/\//g, '');

    // var gunzip = zlib.createGunzip()
    //  .on('error', function(err) {
    //    settings.logger.error("error parsing zip file: %s", err.stack);
    //    callbackCalled = true;
    //    return callback(err);
    //  })
    //  .on('end', function() {
    //    settings.logger.debug("done gunzipping source bundle %s", sourceBundle.key);
    //  });

    settings.logger.debug("gunzip and parse tarball stream %s", sourceBundle.key);
    // settings.logger.debug("scan ahead to file %s", sourceBundle.lastDeployAttempt);

    // Create a deploy queue with a concurrency of 20
    var deployQueue = async.queue(function(deployFile, cb) {
      if (sourceBundle.deploymentStopped === true)
        return cb();

      deploy(appId, versionId, deployFile, cb);
    }, 20);

    var readStream = sourceBundle.readStream()
      .on('error', function(err) {
        settings.logger.error("failed to read the bundle");
        callbackCalled = true;
        return callback(Error.create("Could not read bundle", {retryable: true}, err));
      });

      // .pipe(gunzip)
      // .pipe(tar.Parse())
      //
    var parse = targz().createParseStream();

    parse.on('entry', function(entry) {
      if (callbackCalled)
        return;

      var _this = this;
      // Check if the queue has been killed or this isn't a file.
      if (entry.type !== 'File' || sourceBundle.deploymentStopped === true)
        return;

      var deployFile = getDeployFile(entry, rootDirectory);
      if (!deployFile)
        return;

      var extname = path.extname(deployFile.path);
      if (deployableFileExtensions.indexOf(extname.slice(1)) === -1) {
        settings.logger.debug("skipping file %s", deployFile.path);
        return;
      }

      // If this is a continuation of an existing deployment, check if we've
      // scanned through the tarball to the file where it last left off.
      // if (sourceBundle.partNumber > 1) {
      //   if (sourceBundle.startedDeploying !== true) {
      //     if (sourceBundle.lastDeployAttempt === deployFile.path) {
      //       settings.logger.info("continuing deployment of %s with file %s",
      //         sourceBundle.key, sourceBundle.lastDeployAttempt);
      //
      //       sourceBundle.startedDeploying = true;
      //     }
      //     else {
      //       settings.logger.debug("already deployed file %s from %s",
      //         deployFile.path, sourceBundle.key);
      //
      //       return;
      //     }
      //   }
      // }

      // sourceBundle.lastDeployAttempt = deployFile.path;

      if (_.isFunction(sourceBundle.shouldStop)) {
        // Check if the bundle stop deploying any additional files.
        if (sourceBundle.shouldStop(entry) === true) {
          // Set the deploymentStopped property, force the end of the stream,
          // and invoke callback right away.
          settings.logger.info("stopping deployment of", sourceBundle.key);

          sourceBundle.deploymentStopped = true;
          callbackCalled = true;
          callback();

          _this.end();
          return;
        }
      }

      deployQueue.push(deployFile, function(err) {
        // console.log('finished processing foo');
        debugger;
        if (err) {
          settings.logger.warn("error deploying file %s: %o", deployFile.path, err.stack);
          deployQueue.kill();
          callbackCalled = true;
          _this.end();
          return callback(err);
        }

        // Increment the completed uploads count
        sourceBundle.fileCount++;
      });

      // uploadsStarted++;
      // deploy(appId, versionId, deployFile, function(err) {
      //   if (err) {
      //     settings.logger.warn("error deploying file %s: %o", deployFile.path, err.stack);
      //     callbackCalled = true;
      //     return callback(err);
      //   }
      //
      //   // Increment the completed uploads count
      //   sourceBundle.fileCount++;
      // });
    })
    .on('error', function(err) {
      if (callbackCalled === true)
        return;

      settings.logger.error("error parsing zip file: %s", err.stack);
      callbackCalled = true;
      return callback(err);
    })
    .on('end', function() {
      // If the deployment was stopped, the callback has already been invoked,
      // so just exit out.
      if (sourceBundle.deploymentStopped === true || callbackCalled === true)
        return;

      settings.logger.debug("end of tar stream reached, waiting for all uploads to finish");

      if (uploadsStarted === 0) {
        return callback(new Error("No files found to deploy"));
      }

      // Wait until the last upload has completed.
      async.until(function() {
        debugger;
        return deployQueue.idle();
        // return sourceBundle.fileCount === uploadsStarted;
      }, function(cb) {
        setTimeout(cb, 100);
      }, callback);
    });

    readStream.pipe(parse);
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
