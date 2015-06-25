var _ = require('lodash');
var path = require('path');
var stream = require('stream');
var urljoin = require('url-join');
var fs = require('fs');
var zlib = require('zlib');
var debug = require('debug')('4front:deployer:deploy');

var compressExtensions = ['.css', '.js', '.json', '.txt', '.svg'];

// Deploy an individual file
module.exports = function(settings) {
  return function(appId, versionId, fileInfo, callback) {
    debug('deploying file %s', fileInfo.path);

    getPayload(fileInfo, function(err, deployFile) {
      if (err) return callback(err);

      // Prepend the appId/versionId to the filePath
      deployFile.path = urljoin(appId, versionId, fileInfo.path);

      if (!fileInfo.maxAge)
        deployFile.maxAge = settings.defaultMaxAge;

      settings.storage.writeStream(deployFile, function(err) {
        if (err) {
          debug("error writing file %s: %o", file.path, err);
          return callback(err);
        }

        debug("done deploying file %s", fileInfo.path);
        callback();
      });
    });
  };

  function getPayload(fileInfo, callback) {
    var readableStream;
    if (fileInfo.contents instanceof stream.Stream)
      readableStream = fileInfo.contents;
    else
      readableStream = fs.createReadStream(fileInfo.fullPath);

    var compress = _.contains(compressExtensions, path.extname(fileInfo.path));
    if (compress) {
      debug('compressing file %s', fileInfo.path);

      // If the file is to be compressed, write the .gz file to disk alongside
      // the original and upload it. Trying to pipe the gzipped output directly
      // to the deploy command hangs.
      var compressError;

      readableStream
        .pipe(zlib.createGzip())
        .pipe(fs.createWriteStream(fileInfo.fullPath + '.gz'))
        .on('error', function(err) {
          compressError = true;
          return callback(Error.create("Error compressing file " + fileInfo.path, {}, err));
        })
        .on('finish', function() {
          if (compressError) return;

          debug('done writing gzip file %s', fileInfo.fullPath + '.gz');

          // Need to stat the new .gz file to get the updated size.
          fs.stat(fileInfo.fullPath + '.gz', function(err, stats) {
            if (err) return callback(err);

            return callback(null, {
              contents: fs.createReadStream(fileInfo.fullPath + '.gz'),
              size: stats.size,
              // Keep the original file name
              path: fileInfo.path.replace(/\\/g, '/'),
              gzipEncoded: true
            });
          });
        });
    }
    else {
      callback(null, {
        contents: readableStream,
        size: fileInfo.size || fileInfo.stat.size,
        path: fileInfo.path.replace(/\\/g, '/'),
        gzipEncoded: false
      });
    }
  }
};
