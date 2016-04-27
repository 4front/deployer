var async = require('async');
var os = require('os');
var path = require('path');
var fs = require('fs-extra');
var tar = require('tar');
var zlib = require('zlib');
var isEmpty = require('lodash.isempty');
var manifest = require('./manifest');
var debug = require('debug')('4front:deployer:build');

var buildEngines = {
  basic: require('../engines/basic'),
  jekyll: require('../engines/jekyll'),
  hugo: require('../engines/hugo'),
  wintersmith: require('../engines/wintersmith'),
  npm: require('../engines/npm')
};

module.exports = function(settings) {
  var versions = require('./versions')(settings);

  return function(params, callback) {
    var tempDir = os.tmpdir();
    var tempTarballFile = path.join(tempDir, params.sourceTarball);
    var outputDirectory;

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
        ensureVersion(params, function(err, version) {
          if (err) return cb(err);
          params.version = version;
          cb();
        });
      },
      function(cb) {
        loadAppManifest(params, function(err, appManifest) {
          if (err) return cb(err);
          params.appManifest = appManifest;
          cb();
        });
      },
      function(cb) {
        var engineName = params.appManifest.build.engine;

        // For basic builds there is no actual build step, just
        // deploy the original source code.
        if (engineName === 'basic') {
          params.buildLog.info('using the basic build engine');
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
        cleanupFilesystem(params, cb);
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
      params.buildLog.error('Update version status to failed');
      var updateData = {
        versionId: params.version.versionId,
        status: 'failed',
        error: buildError.message,
        duration: duration
      };
      settings.database.updateVersion(updateData, callback);
    } else {
      // If we don't have the version object, then we can't update the status to failed.
      // So just log to the system log.
      return callback(Error.create('Error building version', {}, buildError));
    }
  }

  function buildSuccess(params, duration, callback) {
    async.waterfall([
      function(cb) {
        params.buildLog.info('update version status to complete');
        // Update the version
        var updateData = {
          versionId: params.versionId,
          status: 'complete',
          duration: duration
        };

        settings.database.version.update(updateData, cb);
      },
      function(version, cb) {
        params.buildLog.info('update app traffic rules to point to new version');
        // Update the application traffic rules so that all traffic
        // now points to the new version for the virtualEnv
        var trafficRules = [{versionId: params.versionId, rule: '*'}];

        var update = settings.database.updateTrafficRules;
        update(params.appId, params.virtualEnv, trafficRules, function(err) {
          if (err) {
            return cb(Error.create('Error updating traffic rules', {}, err));
          }

          return cb(null, version);
        });
      }
    ], callback);
  }

  function ensureVersion(params, callback) {
    async.waterfall([
      function(cb) {
        settings.database.getVersion(params.appId, params.versionId, cb);
      },
      function(version, cb) {
        if (!version) {
          params.buildLog.debug('create new version');
          versions.create({appId: params.appId, status: 'running'}, cb);
        } else {
          params.buildLog.debug('update the version status to running');
          settings.database.updateVersion({
            versionId: params.versionId,
            appId: params.appId,
            status: 'running',
            startedAt: Date.now()
          }, cb);
        }
      }
    ], callback);
  }

  // Download the tarball from S3 using the awscli
  function downloadExtractTarball(params, tempTarballFile, callback) {
    params.buildLog.info('downloading and extracting source tarball from S3');
    async.series([
      function(cb) {
        settings.storage.copyToLocal({
          bucket: settings.s3StagingBucket,
          key: params.appId + '/' + params.sourceTarball,
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
          return callback(null, manifest.defaultManifest);
        }
        return callback(err);
      }

      var appManifest;
      try {
        appManifest = manifest(data.toString(), {propertyName: settings.packageJsonManifestKey});
      } catch (manifestErr) {
        return callback(manifestErr);
      }

      callback(null, appManifest);
    });
  }
};
