var async = require('async');
var fs = require('fs-extra');
var path = require('path');
var glob = require('glob');
var debug = require('debug')('4front:deployer:copy');

require('simple-errors');

var blacklistedExtensions = ['php', 'asp'];

// Copy deploy engine that deploys files exactly as they appear in
// the source bundle without any pre-processing.
module.exports = function(settings) {
  return function(params, callback) {
    var deployDirectory;
    if (params.virtualApp.deployDirectory) {
      deployDirectory = path.join(params.sourceDirectory, params.virtualApp.deployDirectory);
    } else {
      deployDirectory = params.sourceDirectory;
    }

    async.waterfall([
      function(cb) {
        params.buildLog.info('Ensuring deployDirectory exists');
        fs.stat(deployDirectory, function(err, stat) {
          if (err) {
            if (err.code === 'ENOENT') {
              return invalidDeployDirectory(params, cb);
            }
            return cb(err);
          }
          if (stat.isDirectory() !== true) {
            return invalidDeployDirectory(params, cb);
          }
          cb();
        });
      },
      function(cb) {
        async.each(blacklistedExtensions, function(ext, next) {
          params.buildLog.debug('Deleting .%s files', ext);
          deleteBlacklistedFiles(ext, deployDirectory, next);
        }, cb);
      }
    ], function(err) {
      if (err) return callback(err);
      callback(null, deployDirectory);
    });
  };

  function invalidDeployDirectory(params, callback) {
    return callback(Error.create('Deploy directory ' + params.virtualApp.deployDirectory +
      ' is invalid.', {code: 'invalidDeployDirectory'}));
  }

  function deleteBlacklistedFiles(ext, deployDirectory, callback) {
    async.waterfall([
      function(cb) {
        glob('**/*.' + ext, {cwd: deployDirectory}, cb);
      },
      function(files, cb) {
        async.each(files, function(filePath, next) {
          fs.remove(path.join(deployDirectory, filePath), next);
        }, cb);
      }
    ], callback);
  }
};
