var async = require('async');
var os = require('os');
var path = require('path');
var fs = require('fs-extra');
var tar = require('tar');
var zlib = require('zlib');
var isEmpty = require('lodash.isempty');
var assign = require('lodash.assign');
var defaults = require('lodash.defaults');
var manifest = require('./manifest');
var debug = require('debug')('4front:deployer:build');

var buildEngines = {
  copy: require('../engines/copy'),
  // jekyll: require('../engines/jekyll'),
  // hugo: require('../engines/hugo'),
  // wintersmith: require('../engines/wintersmith'),
  // npm: require('../engines/npm')
};

module.exports = function(settings) {
  var versions = require('./versions')(settings);

  return function(params, callback) {
    var tempDir = os.tmpdir();
    var tempTarballFile = path.join(tempDir, params.sourceTarball);
    var outputDirectory;

    defaults(params, {
      virtualEnv: 'production'
    });

    params.sourceDirectory = path.join(tempDir, params.versionId + '_source');

    var startTime = Date.now();

    async.series([
      function(cb) {
        params.buildLog.info('ensure version can be deployed');
        versions.ensureCanBeDeployed(params, cb);
      },
      function(cb) {
        prepareFileSystem(params, tempTarballFile, cb);
      },
      function(cb) {
        downloadExtractTarball(params, tempTarballFile, cb);
      },
      function(cb) {
        loadVersion(params, function(err, version) {
          // We might have both a version and an error.
          if (version) params.version = version;
          cb(err, version);
        });
      },
      function(cb) {
        var engineName = params.version.manifest.build.engine;

        // For copy builds there is no actual build step, just
        // deploy the original source code.
        if (engineName === 'copy') {
          params.buildLog.info('using the copy build engine');
          outputDirectory = params.sourceDirectory;
          return cb();
        }

        params.buildLog.debug('get buildEngine %s', engineName);
        var buildEngine = buildEngines[engineName];
        if (!buildEngine) {
          return cb(Error.create('Invalid build engine ' + engineName), {
            code: 'invalidBuildEngine'
          });
        }

        buildEngine(params, function(err, output) {
          if (err) return cb(err);
          outputDirectory = output;
          cb();
        });
      },
      function(cb) {
        deployOutput(params, outputDirectory, cb);
      },
      function(cb) {
        cleanupFilesystem(params, tempTarballFile, outputDirectory, cb);
      }
    ], function(err) {
      // Update the status of the version.
      var duration = Date.now() - startTime;
      if (err) {
        buildFailed(params, err, duration, callback);
      } else {
        buildSuccess(params, duration, callback);
      }
    });
  };

  function buildFailed(params, buildError, duration, callback) {
    if (params.version) {
      params.buildLog.error('Version failed with error: %s', buildError.message);
      var updateData = assign({}, params.version, {
        appId: params.appId,
        versionId: params.version.versionId,
        status: 'failed',
        error: buildError.message,
        duration: duration
      });
      settings.database.updateVersion(updateData, callback);
    } else {
      // If we don't have the version object, then we can't update the status to failed.
      // So just log to the system log.
      return callback(Error.create('Error building version', {}, buildError));
    }
  }

  function buildSuccess(params, duration, callback) {
    var db = settings.database;

    async.waterfall([
      function(cb) {
        params.buildLog.info('update version status to complete');
        // Update the version
        var updateData = assign({}, params.version, {
          status: 'complete',
          duration: duration
        });

        db.updateVersion(updateData, cb);
      },
      function(version, cb) {
        params.buildLog.info('update app traffic rules to point to new version');
        // Update the application traffic rules so that all traffic
        // now points to the new version for the virtualEnv
        var trafficRules = [{versionId: params.versionId, rule: '*'}];

        db.updateTrafficRules(params.appId, params.virtualEnv, trafficRules, function(err) {
          if (err) {
            return cb(Error.create('Error updating traffic rules', {}, err));
          }

          return cb(null, version);
        });
      }
    ], callback);
  }

  function loadVersion(params, callback) {
    var appManifest;
    var version;
    var manifestErr;

    async.series([
      function(cb) {
        loadAppManifest(params, function(err, _manifest) {
          if (err) {
            manifestErr = err;
            appManifest = {};
          } else {
            appManifest = _manifest;
          }

          cb();
        });
      },
      function(cb) {
        debug('look for existing version %s in database', params.versionId);
        settings.database.getVersion(params.appId, params.versionId, function(err, _version) {
          if (err) return cb(err);
          version = _version;
          cb();
        });
      },
      function(cb) {
        var versionData = {
          versionId: params.versionId,
          appId: params.appId,
          userId: params.userId,
          status: 'running',
          manifest: appManifest,
          startedAt: Date.now()
        };

        if (!version) {
          params.buildLog.debug('create new version');
          versions.create(versionData, function(err, _version) {
            if (err) return cb(err);
            version = _version;
            cb();
          });
        } else {
          params.buildLog.debug('update the version status to running');
          settings.database.updateVersion(versionData, function(err, _version) {
            if (err) return cb(err);
            version = _version;
            cb();
          });
        }
      }
    ], function(err) {
      if (err) return callback(err);

      if (manifestErr) {
        return callback(manifestErr, version);
      }
      debug('version loaded');
      callback(null, version);
    });
  }

  // Download the tarball from S3 using the awscli
  function downloadExtractTarball(params, tempTarballFile, callback) {
    var storageKey = params.appId + '/' + params.sourceTarball;
    params.buildLog.info('downloading and extracting %s from S3', storageKey);
    async.series([
      function(cb) {
        settings.storage.copyToLocal({
          bucket: settings.storageStagingBucket,
          key: storageKey,
          localPath: tempTarballFile
        }, cb);
      },
      function(cb) {
        fs.createReadStream(tempTarballFile)
          .pipe(zlib.createGunzip())
          .pipe(tar.Extract({  // eslint-disable-line
            path: params.sourceDirectory,
            strip: 1 // skip past the top-level directory to the good stuff
          }))
          .on('error', function(err) {
            cb(err);
          })
          .on('end', function() {
            cb();
          });
      }
    ], callback);
  }

  // Use the awscli to bulk write the build output directory to S3
  function deployOutput(params, outputDirectory, callback) {
    params.buildLog.info('copy build output to deployment bucket');
    settings.storage.copyToStorage({
      bucket: settings.storageDeploymentBucket,
      key: params.appId + '/' + params.versionId,
      recursive: true,
      localPath: outputDirectory
    }, function(err) {
      callback(err);
    });
  }

  function prepareFileSystem(params, tempTarballFile, callback) {
    debug('prepare file system for build');
    async.series([
      function(cb) {
        fs.remove(params.sourceDirectory, cb);
      },
      function(cb) {
        fs.remove(tempTarballFile, cb);
      },
      function(cb) {
        fs.mkdir(params.sourceDirectory, cb);
      }
    ], callback);
  }

  function cleanupFilesystem(params, tempTarballFile, outputDirectory, callback) {
    params.buildLog.debug('Cleanup files and directories');
    async.each([params.sourceDirectory, tempTarballFile, outputDirectory], function(_path, cb) {
      if (isEmpty(_path)) return cb();
      fs.remove(_path, cb);
    }, callback);
  }

  // Load the app manifest from package.json file
  function loadAppManifest(params, callback) {
    debug('load the app manifest from package.json');
    fs.readFile(path.join(params.sourceDirectory, 'package.json'), function(err, data) {
      if (err) {
        // If there is no package.json, use a default manifest
        if (err.code === 'ENOENT') {
          debug('no package.json file found, use default manifest');
          return callback(null, manifest.defaultManifest);
        }
        return callback(err);
      }

      var appManifest;
      try {
        appManifest = manifest(data.toString(), {propertyName: settings.packageJsonManifestKey});
      } catch (manifestErr) {
        debug('Error loading the manifest from package.json');
        return callback(manifestErr);
      }

      callback(null, appManifest);
    });
  }
};
