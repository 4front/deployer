var _ = require('lodash');
var async = require('async');
var path = require('path');
var os = require('os');
var fs = require('fs-extra');
var rimraf = require('rimraf');
var common = require('../common');
// var fileExists = require('file-exists');
var installGems = require('./lib/install-gems');

module.exports = function(settings) {
  var deploy = require('../../lib/deploy')(settings);

  return function(sourceBundle, appId, versionId, callback) {
    settings.logger.info('start jekyll deployment');

    var buildDirectory = path.join(os.tmpdir(), versionId);
    var params = _.extend({}, sourceBundle, {
      buildDirectory: buildDirectory,
      sourceDirectory: path.join(buildDirectory, 'source'),
      outputDirectory: path.join(buildDirectory, '_site'),
      logger: settings.logger
    }, _.pick(settings, 'logger', 'rubyPath', 'rubyVersion', 'systemGemPath', 'defaultJekyllVersion'));

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
        installGems(params, function(err, localGemsDirectory) {
          if (err) return cb(err);
          params.localGemsDirectory = localGemsDirectory;
          cb();
        });
      },
      function(cb) {
        runJekyllBuild(params, cb);
      },
      function(cb) {
        // Recursively deploy the entire destDirectory
        settings.logger.info('deploying compiled jekyll site');
        var directoryInfo = {type: 'Directory', path: params.outputDirectory, fileFilter: '!Gemfile*'};

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

  function runJekyllBuild(params, callback) {
    // /var/task/customruby/lib/ruby/gems/2.3.0/gems/jekyll-3.1.2/bin
    // Create a jekyll file in bin
    // var gemBinDirectory = path.join(params.localGemsDirectory, 'ruby', params.rubyVersion, 'bin');

    var jekyllExecutable = path.join(params.rubyPath, 'jekyll');

    settings.logger.info('running jekyll build');
    var spawnParams = {
      executable: jekyllExecutable,
      logger: params.logger,
      args: ['build', '--source', 'source', '--destination', '_site'],
      cwd: params.buildDirectory, // run the command from the temp directory
      // Tack the temporary gem path onto the default gem path
      env: _.extend({}, process.env, {
        GEM_PATH: params.systemGemPath + ':' + params.localGemsDirectory
      }, params.untrustedRoleEnv)
    };

    common.spawnProcess(spawnParams, function(err) {
      if (err) {
        return callback(new Error('jekyll build failure', {code: err.code}));
      }
      callback();
    });
  }
};
