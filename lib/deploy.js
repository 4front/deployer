var defaults = require('lodash.defaults');
var async = require('async');
var fs = require('fs');
var path = require('path');
var urljoin = require('url-join');
var zlib = require('zlib');
var through = require('through2');
var mime = require('mime');
var readdirp = require('readdirp');
var compressible = require('compressible');
var debug = require('debug')('4front:deployer:deploy');

// Deploy an individual file
module.exports = function(settings) {
  defaults(settings, {
    gzipStaticAssets: false
  });

  return function(appId, versionId, fileInfo, callback) {
    // If this is a directory, recurse through and deploy each file.
    var deployFunc = fileInfo.type === 'Directory' ? deployDirectory : deployFile;

    try {
      deployFunc(appId, versionId, fileInfo, callback);
    } catch (err) {
      settings.logger.error('error deploying %s', fileInfo.path);
      return callback(err);
    }
  };

  function deployFile(appId, versionId, fileInfo, callback) {
    settings.logger.debug('deploying file %s', fileInfo.path);
    var deployParams = {
      maxAge: fileInfo.maxAge || settings.defaultMaxAge
    };

    if (shouldCompress(fileInfo) === true) {
      settings.logger.debug('gzipping file %s', fileInfo.path);

      deployParams.contents = fileInfo.contents.pipe(zlib.createGzip()).on('error', function(err) {
        settings.logger.error('Error gzipping file %s', fileInfo.path);
        return callback(err);
      });

      deployParams.gzipEncoded = true;
    } else {
      deployParams.contents = fileInfo.contents.pipe(through(function(chunk, enc, cb) {
        this.push(chunk);
        cb();
      }));

      deployParams.gzipEncoded = fileInfo.gzipEncoded === true;
    }

    // Prepend the appId/versionId to the nfilePath
    deployParams.path = urljoin(appId, versionId, fileInfo.path.replace(/\\/g, '/'));
    settings.storage.writeStream(deployParams, callback);
  }

  function deployDirectory(appId, versionId, directoryInfo, callback) {
    settings.logger.info('deploying directory %s', directoryInfo.path);
    var filesQueued = 0;
    var filesDeployed = 0;

    var queue = async.queue(function(fileInfo, done) {
      deployFile(appId, versionId, fileInfo, function(err) {
        if (err) {
          debug('error deploying file');
          return done(err);
        }
        filesDeployed++;
        done();
      });
    }, 10);

    var callbackInvoked = false;
    var options = {
      root: directoryInfo.path,
      fileFilter: directoryInfo.fileFilter
    };

    readdirp(options)
      .on('data', function(entry) {
        if (callbackInvoked) return;

        // Turn the entry into a fileInfo expected by the deployFile function
        debug('queue file %s', entry.path);
        queue.push({
          contents: fs.createReadStream(entry.fullPath),
          type: 'File',
          path: entry.path
        }, function(err) {
          if (err) {
            if (callbackInvoked) return;
            debug('queue push callback error');
            queue.kill();
            callbackInvoked = true;
            callback(err);
          }
        });

        filesQueued++;
      })
      .on('error', function(err) {
        if (callbackInvoked) return;
        queue.kill();
        callbackInvoked = true;
        callback(err);
      })
      .on('end', function() {
        // Wait for the queue to be drained.
        async.until(function() {
          // we're done when the number of files deployed equals
          // the number of files queued or an error has occurred.
          debug('filesQueued=%s, filesDeployed=%s', filesQueued, filesDeployed);
          return callbackInvoked || filesDeployed === filesQueued;
        }, function(cb) {
          debug('waiting 100ms for queue to drain');
          setTimeout(cb, 100);
        }, function() {
          if (callbackInvoked) return;
          callbackInvoked = true;
          callback(null, {filesDeployed: filesDeployed});
        });
      });
  }

  // If the file is not already gzip encoded and gzip encoding is enabled
  // and the file type is one that should be gzipped, compress it.
  function shouldCompress(fileInfo) {
    // If the file is already gzipEncoded, don't double encode.
    if (fileInfo.gzipEncoded === true) return false;

    if (settings.gzipStaticAssets !== true) return false;

    // Don't gzip package.json or .html files since they need to be parsed by the server before
    // being piped down to the client. They'll get gzipped at that time.
    if (path.basename(fileInfo.path) === 'package.json' ||
      path.extname(fileInfo.path) === '.html') return false;

    return compressible(mime.lookup(fileInfo.path));
  }
};
