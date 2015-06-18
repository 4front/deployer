var async = require('async');
var fs = require('graceful-fs');
var path = require('path');
var os = require('os');
var zlib = require('zlib');
var tar = require('tar');
var readdirp = require('readdirp');
var rimraf = require('rimraf');
var debug = require('debug')('4front:deployer:bundle');
var manifest = require('./manifest');

module.exports = function(settings) {
  var versions = require('./versions')(settings);
  var deploy = require('./deploy')(settings);

  return function(sourceBundle, context, callback) {
    console.log("start deploy of bundle for app %s", sourceBundle.appId);
    settings.logger.info("start deploy of bundle for app %s", sourceBundle.appId);

    var extractDir = path.join(os.tmpdir(), Date.now().toString());
    var sourcesDir, versionManifest, deployedVersion, versionError;

    async.series([
      function(cb) {
        // Create a tmp directory
        fs.mkdir(extractDir, cb);
      },
      function(cb) {
        extractBundle(sourceBundle.stream, extractDir, cb);
      },
      function(cb) {
        manifest(extractDir, function(err, json) {
          if (err) return cb(err);
          versionManifest = json;
          cb();
        });
      },
      function(cb) {
        // Create the version
        var versionData = {
          message: sourceBundle.message,
          appId: context.virtualApp.appId,
          manifest: versionManifest
        };

        versions.create(versionData, context, function(err, version) {
          if (err) return cb(err);
          deployedVersion = version;
          cb();
        });
      },
      function(cb) {
        // Check if the files to be deployed are in a nested directory of
        // the extracted tar bundle.
        if (sourceBundle.deployDir) {
          sourcesDir = path.join(extractDir, sourceBundle.deployDir);
          fs.exists(sourcesDir, function(exists) {
            if (!exists)
              versionError = "Sub-directory " + sourceBundle.deployDir + " does not exist in source archive";

            cb();
          });
        }
        else {
          // Otherwise assume the entire contents of the archive should be deployed.
          sourcesDir = extractDir;
          cb();
        }
      },
      function(cb) {
        if (versionError)
          return cb();

        deployFiles(sourcesDir, context.virtualApp.appId, deployedVersion.versionId, function(err) {
          if (err)
            versionError = err;

          cb();
        });
      },
      function(cb) {
        // Update the version status
        if (versionError) {
          deployedVersion.status = 'failed';
          deployedVersion.error = versionError;
        }
        else {
          deployedVersion.status = 'complete';
        }

        versions.updateStatus(deployedVersion, context, {}, cb);
      }
    ], function(err) {
      debug("Cleanup extracted source archive");
      rimraf(extractDir, function(rmErr) {
        if (rmErr) {
          settings.logger.error(Error.create(rmErr.message, {code: "couldNotDeleteSourceArchive"}));
        }

        if (err) return callback(err);

        callback(null, deployedVersion);
      });
    });
  };

  function extractBundle(tarStream, extractDir, callback) {
    var error = false;
    debug("decompressing and extracting tar bundle to %s", extractDir);
    tarStream
      .pipe(zlib.Unzip())
      .pipe(tar.Extract({ path: extractDir, strip: 1 }))
      .on('error', function(err) {
        error = true;
        debug("error unzipping archive: %o", err);
        return callback(err);
      })
      .on('close', function() {
        debug("done unzipping archive");
        if (!error)
          callback();
      });
  }

  function deployFiles(rootDir, appId, versionId, callback) {
    // Gather up all the files starting at the root of the top level directory
    // from the extract. Specifically exclude the package.json.
    var options = {
      root: rootDir,
      entryType: 'files',
      fileFilter: '!package.json'
    };

    readdirp(options, function() {}, function(err, res) {
      if (err) return cb(err);

      debug("found %s files to deploy", res.files.length);

      // Deploy each file
      async.each(res.files, function(fileInfo, cb) {
        deploy(appId, versionId, fileInfo, cb);
      }, callback);
    });
  }
};
