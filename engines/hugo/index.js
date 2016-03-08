var _ = require('lodash');
var async = require('async');
var path = require('path');
var os = require('os');
var fs = require('fs-extra');
var rimraf = require('rimraf');
var request = require('request');
var zlib = require('zlib');
var tar = require('tar');
var common = require('../common');
var gitHubUrl = require('github-url-to-object');
var bitbucketUrl = require('bitbucket-url-to-object');

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
        settings.logger.debug('unpack bundle to %s', params.sourceDirectory);
        common.unpackSourceBundle(params.readStream, params.sourceDirectory, cb);
      },
      function(cb) {
        installTheme(params, function(err, themeName) {
          if (err) return cb(err);
          params.themeName = themeName;
          cb();
        });
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
    var hugoArgs = [
      '--source=source',
      '--destination=../output',
      '--baseURL=\"\"', // force baseURL to empty string
      '--ignoreCache=true'
    ];

    if (params.themeName) {
      hugoArgs.push('--theme=' + params.themeName);
    }

    var spawnParams = {
      executable: params.hugoBinary,
      logger: params.logger,
      args: hugoArgs,
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
    if (!_.isString(params.buildConfig.themeRepo)) {
      params.logger.debug('no themeRepo in buildConfig');
      return callback();
    }

    var themeUrlObject = gitHubUrl(params.buildConfig.themeRepo);
    var themeDownloadUrl;

    if (themeUrlObject) {
      // The tarball_url redirects which messes up piping the response. Instead
      // build it ourselves.
      themeDownloadUrl = 'https://github.com/' + themeUrlObject.user + '/' +
        themeUrlObject.repo + '/archive/' + themeUrlObject.branch + '.tar.gz';
    }
    if (!themeUrlObject) {
      themeUrlObject = bitbucketUrl(params.buildConfig.themeUrl);
      // https://bitbucket.org/dvonlehman/hugo-demo/get/master.tar.gz
      themeDownloadUrl = themeUrlObject.tarball_url;
    }

    if (!themeUrlObject) {
      return callback(new Error('The themeRepo must be either a GitHub or Bitbucket url.'));
    }

    var themeName = themeUrlObject.repo;
    var themeDirectory = path.join(params.sourceDirectory, 'themes', themeName);

    async.series([
      function(cb) {
        // Blow away any existing theme directory
        rimraf(path.join(params.sourceDirectory, 'themes'), cb);
      },
      function(cb) {
        // Ensure the themes directory exists
        params.logger.debug('ensure themes directory exists');
        fs.mkdirs(themeDirectory, cb);
      },
      function(cb) {
        // If there is a themeUrl, git clone it to the themes directory
        params.logger.info('downloading theme %s', themeDownloadUrl);

        // Download and unpack the theme.
        request.get(themeDownloadUrl)
          .pipe(zlib.createGunzip())
          .pipe(tar.Extract({  // eslint-disable-line
            path: themeDirectory,
            strip: 1 // skip past the root directory to the hard-coded theme name
          }))
          .on('error', function(err) {
            cb(err);
          })
          .on('end', function() {
            cb();
          });
      }
    ], function(err) {
      callback(err, themeName);
    });
  }
};
