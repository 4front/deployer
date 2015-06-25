var async = require('async');
var _ = require('lodash');
var shortid = require('shortid');
var unzip = require('unzip2');
var debug = require('debug')('4front:deployer:bundle');
var manifest = require('./manifest');

module.exports = function(settings) {
  var versions = require('./versions')(settings);
  var deploy = require('./deploy')(settings);

  return function(sourceBundle, context, callback) {
    settings.logger.info("start deploy of bundle for app %s", sourceBundle.appId);

    var deployedVersion, versionManifest, versionError;

    async.series([
      function(cb) {
        var versionData = {
          message: sourceBundle.message,
          appId: context.virtualApp.appId
        };

        versions.create(versionData, context, function(err, version) {
          if (err) return cb(err);
          deployedVersion = version;
          cb();
        });
      },
      function(cb) {
        deployBundle(sourceBundle, deployedVersion.versionId, context.virtualApp.appId, function(err, manifestJson) {
          if (err) {
            versionError = err;
            return cb();
          }

          debug("done deploying version");
          versionManifest = manifestJson;
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

  function deployBundle(sourceBundle, versionId, appId, callback) {
    // Create the version
    var manifestJson;
    var exited = false, killed = false, filesDeployed = 0, filesQueued = 0;

    var queue = async.queue(function(file, cb) {
      // If the file is named package.json, try to load the manifest from it.
      if (file.path === 'package.json') {
        debug("loading manifest from package.json");
        debugger;
        manifest(file.contents, function(err, m) {
          if (err) return cb(err);

          debug("manifest loaded");
          manifestJson = m;
          cb();
        });
      }
      else {
        debug("deploy file %s", file.path);
        filesDeployed++;
        deploy(appId, versionId, file, cb);
      }
    }, 10);

    queue.drain = function() {
      if (exited === true)
        return;

      // Wait a bit and see if the queue is still drained.
      setTimeout(function() {
        if (exited === true)
          return;

        if (queue.length() === 0) {
          debug("the deploy queue is drained");
          exited = true;

          if (filesDeployed === 0)
            return callback(new Error("No files found to deploy"));

          settings.logger.info("%s files deployed", filesDeployed);
          callback(null, manifestJson);
        }
      }, 200);
    };

    queue.saturated = function() {
      debug("the deploy worker is saturated");
    };

    // Remove any leading or trailing slashes from the deployDirectory
    var rootDirectory = null;
    if (sourceBundle.deployDirectory)
      rootDirectory = sourceBundle.deployDirectory.replace(/\//g, '');

    sourceBundle.readStream.pipe(unzip.Parse())
      .on('entry', function (entry) {
        // Check if the queue has been killed or this isn't a file.
        if (killed === true || entry.type !== 'File')
          return entry.autodrain();

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
        if (!queued)
          filesQueued++;
        else
          entry.autodrain();
      })
      .on('close', function() {
        if (filesQueued === 0) {
          exited = true;
          return callback(new Error("No files found to deploy"));
        }

        debug("zip stream closed");
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
      entry.autodrain();
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
