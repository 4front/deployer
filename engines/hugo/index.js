var _ = require('lodash');
var async = require('async');
var path = require('path');
var os = require('os');
var fs = require('fs-extra');
var rimraf = require('rimraf');
var common = require('../common');

module.exports = function(settings) {
  var deploy = require('../../lib/deploy')(settings);

  return function(sourceBundle, appId, versionId, callback) {
    settings.logger.info('start hugo deployment');

    var buildDirectory = path.join(os.tmpdir(), versionId);
    var params = _.extend({}, sourceBundle, {
      buildDirectory: buildDirectory,
      sourceDirectory: path.join(buildDirectory, 'source'),
      outputDirectory: path.join(buildDirectory, 'output'),
      logger: settings.logger
    }, _.pick(settings, 'logger', 'hugoBinary'));

    async.series([
      function(cb) {
        settings.logger.debug('making temp build directory: %s', buildDirectory);
        async.eachSeries([buildDirectory, params.sourceDirectory, params.outputDirectory], function(dir, next) {
          fs.mkdir(dir, next);
        }, cb);
      },
      function(cb) {
        common.unpackSourceBundle(params.readStream, params.sourceDirectory, cb);
      },
      function(cb) {
        installTheme(params, cb);
      },
      function(cb) {
        runHugoBuild(params, cb);
      },
      function(cb) {
        // Recursively deploy the entire destDirectory
        settings.logger.info('deploying compiled hugo site');
        var directoryInfo = {type: 'Directory', path: params.outputDirectory};

        deploy(appId, versionId, directoryInfo, function(err, results) {
          if (err) return cb(err);
          sourceBundle.fileCount = results.filesDeployed;
          cb();
        });
      },
      function(cb) {
        settings.logger.debug('deleting the temporary build directory');
        rimraf(params.buildDirectory, cb);
        cb();
      }
    ], function(err) {
      if (err) {
        settings.logger.error(err);
        return callback(err);
      }

      callback();
    });
  };

  function runHugoBuild(params, callback) {
    settings.logger.info('running hugo build');
    var spawnParams = {
      executable: params.hugoBinary,
      logger: params.logger,
      args: ['--source=source', '--destination=../output'],
      cwd: params.buildDirectory, // run the command from the temp directory
      env: _.extend({}, process.env, {
      }, params.untrustedRoleEnv)
    };

    common.spawnProcess(spawnParams, function(err) {
      if (err) {
        return callback(new Error('hugo build failure', {code: err.code}));
      }
      callback();
    });
  }

  function installTheme(params, callback) {
    if (!_.isString(params.buildConfig.themeUrl)) {
      params.logger.debug('no themeUrl in buildConfig');
      return callback();
    }

    var themesDirectory = path.join(params.sourceDirectory, 'themes');
    async.series([
      function(cb) {
        // Ensure the themes directory exists
        fs.ensureDir(themesDirectory, cb);
      },
      function(cb) {
        var spawnParams = {
          executable: 'git',
          logger: params.logger,
          args: ['clone', params.buildConfig.themeUrl],
          cwd: themesDirectory, // run the command from the temp directory
          env: _.extend({}, process.env, {
          }, params.untrustedRoleEnv)
        };

        // If there is a themeUrl, git clone it to the themes directory
        params.logger.info('cloning theme %s', params.buildConfig.themeUrl);
        common.spawnProcess(spawnParams, cb);
      }
    ], callback);
  }
};
