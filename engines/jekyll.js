var spawn = require('child_process').spawn;
var async = require('async');
var path = require('path');
var os = require('os');
var fs = require('fs');
var tar = require('tar');
var zlib = require('zlib');

module.exports = function(settings) {
  var deploy = require('../lib/deploy')(settings);

  return function(sourceBundle, versionId, appId, callback) {
    settings.logger.info('deploy app with the jekyll deployer');

    // Create a temporary directory on disk.
    var tempDir = path.join(os.tmpdir(), versionId);
    var sourceDirectory = path.join(tempDir, 'source');
    var destDirectory = path.join(tempDir, '_site');

    var jekyllPath = settings.jekyllPath || 'jekyll';

    settings.logger.info('jekyllPath: %s', jekyllPath);

    async.series([
      function(cb) {
        settings.logger.info('making temp directory: %s', tempDir);
        async.eachSeries([tempDir, sourceDirectory, destDirectory], function(dir, next) {
          fs.mkdir(dir, next);
        }, cb);
      },
      function(cb) {
        // Unpack the sourceBundle to the source directory.
        sourceBundle.readStream()
          .pipe(zlib.createGunzip())
          .pipe(tar.Extract({  // eslint-disable-line
            path: sourceDirectory,
            strip: 1
          }))
          .on('error', function(err) {
            cb(err);
          })
          .on('end', function() {
            cb();
          });
      },
      function(cb) {
        // TODO: Assume a different role that has no AWS permissions.
        // That way we can safely install custom gems and not worry about
        // them being able to access AWS resources. What about a gem that
        // runs bash commands?
        cb();
      },
      function(cb) {
        // TODO: Check for a Gemfile and install any gems
        cb();
      },
      function(cb) {
        var jekyllArgs = [
          'build',
          '--source',
          sourceDirectory,
          '--destination',
          destDirectory
        ];

        settings.logger.info('invoking jekyll with args %s', jekyllArgs.join(' '));

        var processExited = false;
        var jekyllProcess = spawn(jekyllPath, jekyllArgs, {stdio: 'pipe'});
        jekyllProcess.stdout.on('data', function(data) {
          settings.logger.info(data.toString());
        });
        jekyllProcess.stderr.on('data', function(data) {
          settings.logger.warn(data.toString());
        });
        jekyllProcess.on('error', function(err) {
          settings.logger.error(err.stack);
          if (processExited) return;
          processExited = true;
          cb(new Error('Error returned from jekyll process: ' + err.stack));
        });
        jekyllProcess.on('exit', function(code) {
          if (processExited) return;
          processExited = true;
          if (code !== 0) {
            settings.logger.error('jekyll failed with code %s', code);
            cb(new Error('Error from jekyll'));
          } else {
            settings.logger.info('jekyll complete');
            cb();
          }
        });
      },
      function(cb) {
        // Recursively deploy the entire destDirectory
        var directoryInfo = {type: 'Directory', path: destDirectory};
        deploy(appId, versionId, directoryInfo, cb);
      }
    ], function(err) {
      if (err) {
        settings.logger.error(err);
        return callback(err);
      }
      callback();
    });
  };
};
