var _ = require('lodash');
var async = require('async');
var path = require('path');
var os = require('os');
var fs = require('fs-extra');
var rimraf = require('rimraf');
var common = require('../common');
var fileExists = require('file-exists');
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
      // function(cb) {
      //   settings.logger.info('list local gems');
      //   common.spawnProcess({
      //     executable: 'find',
      //     cwd: params.buildDirectory,
      //     args: ['gems', '-type', 'd', '-print'],
      //     logger: params.logger
      //   }, cb);
      // },
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
    var gemBinDirectory = path.join(params.localGemsDirectory, 'ruby', params.rubyVersion, 'bin');

    var jekyllExecutable = path.join(gemBinDirectory, 'jekyll');

    // Figure out which jekyll version to use
    // If there is no jekyll file, create it.
    async.series([
      function(cb) {
        fs.ensureDir(gemBinDirectory, cb);
      },
      function(cb) {
        if (fileExists(jekyllExecutable)) {
          settings.logger.debug('jekyll executable %s already exists', jekyllExecutable);
          return cb();
        }

        settings.logger.debug('writing file %s', jekyllExecutable);
        var contents = [
          '#!' + params.rubyPath + '/ruby',
          'require "rubygems"',
          'gem "jekyll", "' + params.defaultJekyllVersion + '"',
          'load Gem.bin_path("jekyll", "jekyll", "' + params.defaultJekyllVersion + '")'
        ].join('\n');

        fs.writeFile(jekyllExecutable, contents, {mode: parseInt('0755', 8)}, cb);
      },
      function(cb) {
        settings.logger.info('running jekyll build');
        var spawnParams = {
          executable: jekyllExecutable,
          logger: params.logger,
          args: ['build', '--source', 'source', '--destination', '_site'],
          cwd: params.buildDirectory, // run the command from the temp directory
          // Tack the temporary gem path onto the default gem path
          env: _.extend({}, process.env, {
            GEM_PATH: params.localGemsDirectory
          }, params.untrustedRoleEnv)
        };

        common.spawnProcess(spawnParams, cb);
      }
    ], callback);
  }
};
