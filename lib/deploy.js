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
  _.defaults(settings, {
    gzip: true
  });

  return function(appId, versionId, fileInfo, callback) {
    settings.logger.info('deploying file %s', fileInfo.path);

    try {
      var deployFile = {
        maxAge: fileInfo.maxAge || settings.defaultMaxAge
      };

      var compress = settings.gzip === true && _.contains(compressExtensions, path.extname(fileInfo.path));
      if (compress) {
        settings.logger.info("gzipping file %s", fileInfo.path);
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
        }));
      }

      // Prepend the appId/versionId to the filePath
      deployFile.path = urljoin(appId, versionId, fileInfo.path.replace(/\\/g, '/'));
    }
    catch (err) {
      settings.logger.error("erro deploying file %s", fileInfo.path);
      return callback(err);
    }

    settings.storage.writeStream(deployFile, callback);
  };
};
