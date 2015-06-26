var _ = require('lodash');
var path = require('path');
var stream = require('stream');
var urljoin = require('url-join');
var fs = require('fs');
var zlib = require('zlib');
var through = require('through2');
var debug = require('debug')('4front:deployer:deploy');

var compressExtensions = ['.css', '.js', '.json', '.txt', '.svg'];

// Deploy an individual file
module.exports = function(settings) {
  return function(appId, versionId, fileInfo, callback) {
    debug('deploying file %s', fileInfo.path);

    var deployFile = {
      maxAge: fileInfo.maxAge || settings.defaultMaxAge
      // size: fileInfo.size
    };

    var compress = false; //_.contains(compressExtensions, path.extname(fileInfo.path));
    if (compress) {
      debug("gzipping file %s", fileInfo.path);
      deployFile.contents = fileInfo.contents.pipe(zlib.createGzip()).on('error', function(err) {
        settings.logger.error("Error gzipping file %s", fileInfo.path);
        return callback(err);
      });

      deployFile.gzipEncoded = true;
    }
    else {
      deployFile.contents = fileInfo.contents.pipe(through(function(chunk, enc, cb) {
        this.push(chunk);
        cb();
      });
    }

    // Prepend the appId/versionId to the filePath
    deployFile.path = urljoin(appId, versionId, fileInfo.path.replace(/\\/g, '/'));

    settings.storage.writeStream(deployFile, function(err) {
      if (err) {
        debug("error writing file %s: %o", file.path, err);
        return callback(err);
      }

      debug("done deploying file %s", deployFile.path);
      callback();
    });
  };
};
