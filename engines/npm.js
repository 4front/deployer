var async = require('async');
var fs = require('fs');
var path = require('path');
var os = require('os');
var rimraf = require('rimraf');
var assign = require('lodash.assign');
var pick = require('lodash.pick');
var isEmpty = require('lodash.isempty');
var isObject = require('lodash.isobject');
var keys = require('lodash.keys');
var common = require('./common');

module.exports = function(settings) {
  var deploy = require('../lib/deploy')(settings);

  return function(sourceBundle, appId, versionId, callback) {
    settings.logger.info('start npm deployment');

    var buildDirectory = path.join(os.tmpdir(), versionId);
    var params = assign({}, sourceBundle, {
      buildDirectory: buildDirectory,
      appId: appId,
      versionId: versionId,
    }, pick(settings, 'logger', 'npmExecutable'));

    if (isEmpty(params.buildConfig.output)) {
      return callback(new Error('No "output" property specified in the build ' +
        'section of the package.json manifest.'));
    }

    async.series([
      function(cb) {
        common.makeTempDirs(params, function(err) {
          if (err) return cb(err);

          // Override the outputDirectory to the one specified in the build config.
          // Unlike other build engines, this one requires the user to dictate
          // which directory the build output is written to. It is assumed that
          // the build output is a sub-directory of the source directory.
          params.outputDirectory = path.join(params.sourceDirectory, params.buildConfig.output);
          cb();
        });
      },
      function(cb) {
        common.unpackSourceBundle(params, cb);
      },
      function(cb) {
        common.loadPackageJson(params, function(err) {
          if (err) return cb(err);

          params.logger.info('dependencies: %s',
            keys(params.packageJson.dependencies).join(','));
          params.logger.info('devDependencies: %s',
            keys(params.packageJson.devDependencies).join(','));
          cb();
        });
      },
      function(cb) {
        common.runNpmInstall(params, cb);
      },
      function(cb) {
        // List out all the installed modules
        fs.readdir(path.join(params.sourceDirectory, 'node_modules'), function(err, dirs) {
          if (err) return cb(err);
          params.logger.info('Installed modules: %s', dirs.join(','));
          cb();
        });
      },
      function(cb) {
        runNpmBuild(params, cb);
      },
      function(cb) {
        // Copy the package.json to the build output directory
        common.copyPackageJsonToOutput(params, cb);
      },
      function(cb) {
        // Recursively deploy the entire destDirectory
        settings.logger.info('deploying compiled npm site');
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

  function runNpmBuild(params, callback) {
    params.logger.info('PATH=%s', process.env.PATH);

    // Look for the name of the build script
    var buildScript = params.buildConfig.script;
    if (isEmpty(buildScript)) {
      return callback(new Error('Missing "script" property in the build manifest.'));
    }
    var npmScripts = params.packageJson.scripts;
    if (!isObject(npmScripts) || isEmpty(npmScripts[buildScript])) {
      return callback(new Error('Specified script ' + buildScript +
        ' does not exist in the scripts section of package.json.'));
    }

    var spawnArgs = {
      executable: params.npmExecutable,
      logger: params.logger,
      args: ['run-script', buildScript],
      // stdioFilter: function(msg, type) {
      //   // Only show npm stderr output in the log
      //   // return type === 'error';
      //   return true;
      // },
      cwd: params.sourceDirectory, // run the command from the temp directory
      env: assign({}, process.env, {
        PATH: path.join(params.sourceDirectory, 'node_modules', '.bin')
          + ':' + process.env.PATH
      }, params.untrustedRoleEnv)
    };

    params.logger.info('npm run-script ' + buildScript);
    common.spawnProcess(spawnArgs, function(err) {
      if (err) {
        return callback(new Error('npm run-script failure', {code: err.code}));
      }
      callback();
    });
  }
};
