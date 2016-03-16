var _ = require('lodash');
var async = require('async');
var path = require('path');
var os = require('os');
var fs = require('fs-extra');
var rimraf = require('rimraf');
var common = require('./common');

module.exports = function(settings) {
  var deploy = require('../lib/deploy')(settings);

  return function(sourceBundle, appId, versionId, callback) {
    settings.logger.info('start wintersmith deployment');

    var buildDirectory = path.join(os.tmpdir(), versionId);
    var params = _.assign({}, sourceBundle, {
      buildDirectory: buildDirectory,
      appId: appId,
      versionId: versionId,
    }, _.pick(settings, 'logger'));

    async.series([
      function(cb) {
        common.makeTempDirs(params, cb);
      },
      function(cb) {
        common.unpackSourceBundle(params, cb);
      },
      function(cb) {
        common.runNpmInstall(params, cb);
      },
      function(cb) {
        installPlugins(params, cb);
      },
      function(cb) {
        runWintersmithBuild(params, cb);
      },
      function(cb) {
        // Copy the package.json to the build output directory
        common.copyPackageJsonToOutput(params, cb);
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
      }
    ], function(err) {
      if (err) {
        settings.logger.error(err);
        return callback(err);
      }

      callback();
    });
  };

  function installPlugins(params, callback) {
    async.waterfall([
      function(cb) {
        params.logger.info('reading wintersmith config.json file');
        fs.readJson(path.join(params.sourceDirectory, 'config.json'), cb);
      },
      function(config, cb) {
        if (!_.isArray(config.plugins)) return cb();
        params.logger.info('installing wintersmith plugins');
        async.each(config.plugins, function(plugin, next) {
          // Plugins come in two flavors: npm modules and local files.
          // If the plugin has an extname, then nothing to install.
          if (!_.isEmpty(path.extname(plugin))) return next();

          common.runNpmInstall(params, plugin, next);
        }, cb);
      }
    ], callback);
  }

  function runWintersmithBuild(params, callback) {
    settings.logger.info('running hugo build');
    var args = [
      'build',
      '--output', params.outputDirectory
    ];

    var spawnParams = {
      executable: path.join(__dirname, '../node_modules/.bin/wintersmith'),
      logger: params.logger,
      args: args,
      stdioFilter: function() {
        // Filter out the ominous sounding baseurl warning. This is what we want.
        return true;
      },
      cwd: params.sourceDirectory, // run the command from the source directory
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
};
