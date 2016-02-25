var _ = require('lodash');
var async = require('async');
var path = require('path');
var os = require('os');
var fs = require('fs');
var rimraf = require('rimraf');
var yaml = require('js-yaml');
var common = require('../common');

module.exports = function(settings) {
  var deploy = require('../../lib/deploy')(settings);

  return function(sourceBundle, appId, versionId, callback) {
    settings.logger.info('start jekyll deployment');

    // Create a temporary directory on disk.
    var tempDir = path.join(os.tmpdir(), versionId);
    var sourceDirectory = path.join(tempDir, 'source');
    var destDirectory = path.join(tempDir, '_site');
    var gemsDirectory = path.join(tempDir, 'gems');
    var jekyllConfig;

    async.series([
      function(cb) {
        settings.logger.debug('making temp directory: %s', tempDir);
        async.eachSeries([tempDir, sourceDirectory, destDirectory], function(dir, next) {
          fs.mkdir(dir, next);
        }, cb);
      },
      function(cb) {
        common.unpackSourceBundle(sourceBundle, sourceDirectory, cb);
      },
      function(cb) {
        settings.logger.debug('make the custom gem directory');
        fs.mkdir(path.join(tempDir, 'gems'), cb);
      },
      function(cb) {
        loadJekyllConfig(sourceDirectory, function(err, config) {
          if (err) return cb(err);
          jekyllConfig = config;
          cb();
        });
      },
      function(cb) {
        settings.logger.debug('gem install plugins to %s', gemsDirectory);
        gemInstallPlugins(jekyllConfig, sourceBundle, gemsDirectory, cb);
      },
      function(cb) {
        // TODO: Assume a different role that has no AWS permissions.
        // That way we can safely install custom gems and not worry about
        // them being able to access AWS resources. What about a gem that
        // runs bash commands?
        cb();
      },
      function(cb) {
        runJekyllBuild(sourceBundle, tempDir, gemsDirectory, cb);
      },
      function(cb) {
        // Recursively deploy the entire destDirectory
        settings.logger.info('deploying compiled jekyll site');
        var directoryInfo = {type: 'Directory', path: destDirectory};
        deploy(appId, versionId, directoryInfo, function(err, results) {
          if (err) return cb(err);
          sourceBundle.fileCount = results.filesDeployed;
          cb();
        });
      },
      function(cb) {
        settings.logger.debug('deleting the temporary directory');
        rimraf(tempDir, cb);
      }
    ], function(err) {
      if (err) {
        settings.logger.error(err);
        return callback(err);
      }

      callback();
    });
  };

  function loadJekyllConfig(sourceDirectory, callback) {
    settings.logger.info('loading jekyll _config.yml');
    // Look for a _config.yml file
    fs.readFile(path.join(sourceDirectory, '_config.yml'), function(err, data) {
      if (err) {
        // If the _config.yml file doesn't exist return an empty object.
        if (err.code === 'ENOENT') {
          settings.logger.warn('no _config.yml file found, continuing without it');
          return callback(null, {});
        }
        return callback(err);
      }

      var jekyllConfig;
      var validYaml;
      try {
        jekyllConfig = yaml.safeLoad(data.toString());
        validYaml = true;
      } catch (yamlErr) {
        validYaml = false;
      }

      if (!validYaml) {
        return callback(new Error('Could not parse _config.yml'));
      }

      callback(null, jekyllConfig);
    });
  }

  function gemInstallPlugins(jekyllConfig, sourceBundle, gemsDirectory, callback) {
    if (!_.isArray(jekyllConfig.gems) || jekyllConfig.gems.length === 0) {
      return callback();
    }

    var gemExecutable = path.join(settings.rubyPath, 'gem');

    async.each(jekyllConfig.gems, function(gemName, cb) {
      // Replace forward slashes with dashes. Some gems, jekyll-tagging for one,
      // has to be represented in the gems array of _config.yml with a forward
      // slash. Not sure why this is or if it's widespread or specific to jekyll-tagging.
      // https://github.com/pattex/jekyll-tagging/issues/47
      gemName = gemName.replace(/\//g, '-');

      settings.logger.info('installing gem %s', gemName);
      // http://guides.rubygems.org/command-reference/#gem-install
      var spawnParams = {
        executable: gemExecutable,
        args: [
          'install', gemName,
          '--install-dir', gemsDirectory,
          '--no-ri',
          '--no-rdoc',
          '--force',
          '--conservative'],
        logger: settings.logger,
        env: _.extend({}, process.env, sourceBundle.untrustedRoleEnv)
      };

      common.spawnProcess(spawnParams, cb);
    }, callback);
  }

  function runJekyllBuild(sourceBundle, tempDirectory, gemsDirectory, callback) {
    settings.logger.info('running jekyll build');

    var spawnParams = {
      executable: settings.jekyllExecutable,
      logger: settings.logger,
      args: ['build', '--source', 'source', '--destination', '_site'],
      cwd: tempDirectory, // run the command from the temp directory
      // Tack the temporary gem path onto the default gem path
      env: _.extend({}, process.env, {
        GEM_PATH: settings.gemPath + ':' + gemsDirectory
      }, sourceBundle.untrustedRoleEnv)
    };

    common.spawnProcess(spawnParams, callback);
  }
};
