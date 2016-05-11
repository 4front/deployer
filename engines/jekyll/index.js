var assign = require('lodash.assign');
var pick = require('lodash.pick');
var async = require('async');
var path = require('path');
var fs = require('fs');
var os = require('os');
var rimraf = require('rimraf');
var yaml = require('js-yaml');
var common = require('../common');
var installGems = require('./lib/install-gems');

module.exports = function(settings) {
  var deploy = require('../../lib/deploy')(settings);

  return function(sourceBundle, appId, versionId, callback) {
    settings.logger.info('start jekyll deployment');

    var buildDirectory = path.join(os.tmpdir(), versionId);
    var params = assign({}, sourceBundle, {
      buildDirectory: buildDirectory
    }, pick(settings, 'logger', 'rubyPath', 'rubyVersion',
      'systemGemPath', 'defaultJekyllVersion'));

    async.series([
      function(cb) {
        common.makeTempDirs(params, cb);
      },
      function(cb) {
        common.unpackSourceBundle(params, cb);
      },
      function(cb) {
        modifyConfigYaml(params, cb);
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
        // Copy the package.json to the build output directory
        common.copyPackageJsonToOutput(params, cb);
      },
      function(cb) {
        // Recursively deploy the entire destDirectory
        settings.logger.info('deploying compiled jekyll site');
        var directoryInfo = {type: 'Directory',
          path: params.outputDirectory, fileFilter: '!Gemfile*'};

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

  function modifyConfigYaml(params, callback) {
    var configYml = path.join(params.sourceDirectory, '_config.yml');
    var config;
    async.series([
      function(cb) {
        fs.readFile(configYml, function(err, data) {
          if (err) {
            if (err.code === 'ENOENT') {
              config = {};
            } else {
              return cb(new Error('Error reading _config.yml: ' + err.message));
            }
          } else {
            try {
              config = yaml.safeLoad(data.toString(), {json: true});
            } catch (ymlErr) {
              return cb(new Error('Could not parse _config.yml'));
            }
          }

          // Overwrite the url in config to the placeholder. The baseurl
          // should be a '/' since all sites are mounted at the root of the
          // domain.
          config.url = common.BASEURL_PLACEHOLDER;
          config.baseurl = '/';
          cb();
        });
      },
      function(cb) {
        fs.writeFile(configYml, yaml.safeDump(config), cb);
      }
    ], callback);
  }

  function runJekyllBuild(params, callback) {
    var jekyllExecutable = path.join(params.rubyPath, 'jekyll');

    var jekyllArgs = [
      'build',
      '--source',
      params.sourceDirectory,
      '--destination',
      params.outputDirectory
    ];

    settings.logger.info('running jekyll build');
    var spawnParams = {
      executable: jekyllExecutable,
      logger: params.logger,
      args: jekyllArgs,
      cwd: params.buildDirectory, // run the command from the temp directory
      // Tack the temporary gem path onto the default gem path
      env: assign({}, process.env, {
        GEM_PATH: params.systemGemPath + ':' + params.localGemsDirectory,
        JEKYLL_ENV: 'production',
        LC_ALL: 'en_US.UTF-8'
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
