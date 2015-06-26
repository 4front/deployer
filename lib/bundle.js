var async = require('async');
var _ = require('lodash');
var shortid = require('shortid');
var through = require('through2');
var tar = require('tar');
var zlib = require('zlib');
var debug = require('debug')('4front:deployer:bundle');
var manifest = require('./manifest');

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
    var key = appId + '/' + versionId + '/package.json';
    settings.storage.readFile(key, function(err, data) {
      if (err) return callback(err);

      manifest(data, callback);
    });
  }

  function deployBundle(sourceBundle, versionId, appId, callback) {
    var exited = false,
      killed = false,
      filesDeployed = 0,
      filesQueued = 0,
      endOfBundleReached = false;

    var queue = async.queue(function(file, cb) {
      debug("deploy file %s", file.path);

      filesDeployed++;
      deploy(appId, versionId, file, cb);
    }, 100);

    queue.drain = function() {
      if (exited === true)
        return;

      // debug("queue is drained, endOfBundleReached=%s, filesQueued=%s, filesDeployed=%s",
      //   endOfBundleReached, filesQueued, filesDeployed);

      async.until(function() {
        if (exited === true || killed === true)
          return true;

        return endOfBundleReached === true &&
          queue.length() === 0 &&
          filesDeployed === filesQueued;
      }, function(cb) {
        setTimeout(cb, 200);
      }, function() {
        if (exited || killed) return;

        callback(null, filesDeployed);
      });
    };

    queue.saturated = function() {
      debug("the deploy worker is saturated");
    };

    // Remove any leading or trailing slashes from the deployDirectory
    var rootDirectory = null;
    if (sourceBundle.deployDirectory)
      rootDirectory = sourceBundle.deployDirectory.replace(/\//g, '');

    var gunzip = zlib.createGunzip()
     .on('error', function(err) {
       killed = true;
       debug("error parsing zip file: %s", err.stack);
       queue.kill();
       return callback(err);
     })
     .on('end', function() {
       settings.logger.info("done gunzipping source bundle");
     });

    sourceBundle.readStream
      .pipe(gunzip)
      .pipe(tar.Parse())
      .on('entry', function (entry) {

        // Check if the queue has been killed or this isn't a file.
        if (killed === true || entry.type !== 'File')
          return;

        var queued = queueFileForDeploy(entry, queue, rootDirectory, function(err) {
          if (err) {
            killed = true;
            debug("error encountered on file %s. Killing deployment", entry.path);
            queue.kill();
            return callback(err);
          }

          debug("done with file %s", entry.path);
        });

        // Save an indication that at least one file was queued.
        if (queued)
          filesQueued++;
      })
      .on('error', function(err) {
        killed = true;
        debug("error parsing zip file: %s", err.stack);
        queue.kill();
        return callback(err);
      })
      .on('end', function() {
        debug("end of tar stream reached");
        endOfBundleReached = true;

        if (filesQueued === 0) {
          exited = true;
          return callback(new Error("No files found to deploy"));
        }
      });
  }
}

function queueFileForDeploy(entry, queue, rootDirectory, onProcessed) {
  // Chop off the root directory
  entry.path = entry.path.slice(entry.path.indexOf('/') + 1);

  if (entry.path !== 'package.json' && rootDirectory) {
    // Check if the file is within the deploy directory like /build.
    // If so strip off the root directory.
    if (entry.path.slice(0, rootDirectory.length + 1) === rootDirectory + '/') {
      entry.path = entry.path.slice(entry.path.indexOf('/') + 1);
    }
    else {
      return false;
    }
  }

  debug("pushing %s onto queue", entry.path);
  queue.push({
    path: entry.path,
    size: entry.size,
    contents: entry
  }, onProcessed);

  return true;
}
