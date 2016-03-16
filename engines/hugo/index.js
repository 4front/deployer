var _ = require('lodash');
var async = require('async');
var path = require('path');
var os = require('os');
var fs = require('fs-extra');
var rimraf = require('rimraf');
var request = require('request');
var zlib = require('zlib');
var tar = require('tar');
var toml = require('toml');
var yaml = require('js-yaml');
var common = require('../common');
var gitHubUrl = require('github-url-to-object');
var bitbucketUrl = require('bitbucket-url-to-object');

var BASEURL_PLACEHOLDER = 'https://__baseurl__';

module.exports = function(settings) {
  var deploy = require('../../lib/deploy')(settings);

  return function(sourceBundle, appId, versionId, callback) {
    settings.logger.info('start hugo deployment');

    var buildDirectory = path.join(os.tmpdir(), versionId);
    var params = _.assign({}, sourceBundle, {
      buildDirectory: buildDirectory,
      appId: appId,
      versionId: versionId,
    }, _.pick(settings, 'logger', 'hugoBinary'));

    async.series([
      function(cb) {
        common.makeTempDirs(params, cb);
      },
      function(cb) {
        common.unpackSourceBundle(params, cb);
      },
      function(cb) {
        installTheme(params, function(err, themeName) {
          if (err) return cb(err);
          params.themeName = themeName;
          cb();
        });
      },
      function(cb) {
        modifyConfigFile(params, cb);
      },
      function(cb) {
        runHugoBuild(params, cb);
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

  function runHugoBuild(params, callback) {
    settings.logger.info('running hugo build');
    var hugoArgs = [
      '--source=source',
      '--destination=../output',
      '--ignoreCache=true'
    ];

    var spawnParams = {
      executable: params.hugoBinary,
      logger: params.logger,
      args: hugoArgs,
      stdioFilter: function(msg) {
        // Filter out the ominous sounding baseurl warning. This is what we want.
        return !/No 'baseurl' set in configuration or as a flag/.test(msg);
      },
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

  function modifyConfigFile(params, callback) {
    var hugoConfig;
    var configFile;
    var configContents;

    // Look for the first config file
    var configFiles = _.map(['config.toml', 'config.yml', 'config.json'], function(filename) {
      return path.join(params.sourceDirectory, filename);
    });

    async.series([
      function(cb) {
        getFirstConfigFile(configFiles, function(err, file) {
          if (err) return cb(err);
          configFile = file;
          cb();
        });
      },
      function(cb) {
        fs.readFile(configFile, function(err, data) {
          if (err) return cb(err);
          configContents = data.toString();
          cb();
        });
      },
      function(cb) {
        try {
          hugoConfig = parseConfigFile(configFile, configContents);
        } catch (parseErr) {
          return cb(new Error('Cannot parse config file ' + configFile));
        }

        // Force the baseurl to be the placeholder value
        hugoConfig.baseurl = BASEURL_PLACEHOLDER;
        if (_.isString(params.themeName)) {
          hugoConfig.theme = params.themeName;
        }
        cb();
      },
      function(cb) {
        // Delete all the existing config files
        settings.logger.debug('delete original config files');
        async.each(configFiles, function(file, next) {
          rimraf(file, next);
        }, cb);
      },
      function(cb) {
        settings.logger.debug('write updated config.json');
        // Save the updated config as config.json
        fs.writeFile(path.join(params.sourceDirectory, 'config.json'),
          JSON.stringify(hugoConfig, null, 2), cb);
      }
    ], callback);
  }

  function getFirstConfigFile(configFiles, callback) {
    async.detectSeries(configFiles, fs.exists, function(file) {
      if (!file) {
        return callback(new Error('No config file found (config.toml, ' +
          'config.yaml, or config.json)'));
      }

      settings.logger.debug('found config file %s', file);
      callback(null, file);
    });
  }

  function parseConfigFile(filePath, contents) {
    var extname = path.extname(filePath);
    var parser;
    if (extname === '.toml') {
      parser = toml.parse;
    } else if (extname === '.yaml') {
      parser = yaml.safeLoad;
    } else {
      parser = JSON.parse;
    }

    return parser(contents);
  }
};
