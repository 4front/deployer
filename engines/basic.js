var async = require('async');
var tar = require('tar');
var zlib = require('zlib');
var path = require('path');
var isFunction = require('lodash.isfunction');
var debug = require('debug')('4front:deployer:basic');

var blackListedExtensions = ['php', 'asp'];

// Basic deploy engine that deploys files exactly as they appear in
// the source bundle without any pre-processing. Files are piped
// directly from the source bundle to storage without ever touching disk.
module.exports = function(settings) {
  var deploy = require('../lib/deploy')(settings);

  return function(sourceBundle, appId, versionId, callback) {
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

      debug('parsed entry %s in archive', deployFile.path);

      var extname = path.extname(deployFile.path).toLowerCase();
      if (blackListedExtensions.indexOf(extname.slice(1)) !== -1) {
        settings.logger.debug('skipping file %s with blacklisted extension', deployFile.path);
        return;
      }

      if (isFunction(sourceBundle.shouldStop)) {
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
          debug('deploy error for file %s', deployFile.path);
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

      // Wait 500ms for an upload to start.
      setTimeout(function() {
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
      }, 500);
    });

    readStream
      .pipe(gunzip)
      .pipe(parser);
  };

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
