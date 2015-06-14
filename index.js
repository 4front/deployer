var _ = require('lodash');
var async = require('async');
var urljoin = require('url-join');
var shortid = require('shortid');
var tar = require('tar');
var os = require('os');

// Use graceful-fs to handle EMFILE errors from opening too many files at once.
var fs = require('graceful-fs');
var readdirp = require('readdirp');
var path = require('path');
var zlib = require('zlib');
var debug = require('debug')('4front:deployer');

require('simple-errors');

var compressExtensions = ['.css', '.js', '.json', '.txt', '.svg'];

module.exports = function(settings) {
  if (!settings.database)
    throw new Error("Missing database option");

  if (!settings.storage)
    throw new Error("Missing storage option");

  _.defaults(settings, {
    defaultMaxAge: 30 * 60 * 30
  });

  return {
    createVersion: createVersion,
    updateVersionStatus: updateVersionStatus,
    deployFile: deployFile,
    deleteVersion: deleteVersion,
    deleteAllVersions: deleteAllVersions,
    deployArchive: deployArchive,
    serveFile: serveFile
  };

  function createVersion(versionData, context, callback) {
    // Just pick out the valid properties
    versionData = _.pick(versionData, 'name', 'message', 'manifest');

    if (_.isObject(versionData.manifest) === false) {
      return callback(Error.create("Missing version manifest", {status: 400, code: "missingManifest"}));
    }

    _.extend(versionData, {
      // Generate a new unique versionId
      versionId: shortid.generate(),
      appId: context.virtualApp.appId,
      userId: context.user.userId,
      // Initially versions are in-progress. Once all files are deployed successfully, the status
      // is updated to 'complete'.
      status: 'initiated'
    });

    if (_.isEmpty(versionData.message))
      delete versionData.message;

    var tasks = [];

    // If a version name was not sent in the header, auto-generate one
    tasks.push(function(cb) {
      settings.database.nextVersionNum(versionData.appId, function(err, nextNum) {
        if (err) return cb(err);

        versionData.versionNum = nextNum;

        if (_.isEmpty(versionData.name))
          versionData.name = 'v' + nextNum;

        cb();
      });
    });

    var newVersion;
    tasks.push(function(cb) {
      debug("creating version %s in database", versionData.versionId);
      settings.database.createVersion(versionData, function(err, version) {
        if (err) return cb(err);

        newVersion = version;
        debug("finished writing version to database");
        newVersion.username = versionData.username;
        cb();
      });
    });

    async.series(tasks, function(err) {
      if (err) return callback(err);
      callback(null, newVersion);
    });
  }

  function updateVersionStatus(versionData, context, options, callback) {
    if (_.contains(['complete', 'failed'], versionData.status) === false)
      return callback(new Error("Updated version status must be 'complete' or 'failed'"));

    versionData.appId = context.virtualApp.appId;
    settings.database.updateVersion(versionData, function(err, version) {
      if (err) return callback(err);

      // If the status of the version is not complete, then exit now.
      if (version.status !== 'complete')
        return callback(null, version);

      // If traffic control is not enabled on this app, then new deployments
      // automatically take all the traffic.
      if (context.virtualApp.trafficControlEnabled !== true)
        options.forceAllTrafficToNewVersion = true;

      // If new version doesnt take all traffic, then it is just a draft deploy
      // which can be previewed via a special link.
      if (options.forceAllTrafficToNewVersion !== true) {
        //TODO: Need to incorporate the environment name into the preview URL.
        version.previewUrl = context.virtualApp.url + '?_version=' + version.versionId;
        return callback(null, version);
      }

      // Get the name of the first environment in the pipeline. If the app has
      // overridden the organization settings use them, otherwise use the org
      // defaults.
      var environments = context.organization ?
        context.organization.environments : context.virtualApp.environments;

      // Deployments are done to the first environment in the pipeline. Promotion to subsequent
      // environments entails updating the traffic rules for those envs.
      // If there are no environment, default to production.
      var environment;
      if (!environments || _.isEmpty(environments))
        environment = 'production';
      else
        environment = environments[0];

      debug("forcing all %s traffic to new version %s", environment, version.versionId);
      version.previewUrl = context.virtualApp.url;

      var trafficRules = [{versionId: version.versionId, rule: "*"}];
      settings.database.updateTrafficRules(context.virtualApp.appId, environment, trafficRules, function(err) {
        if (err) return callback(err);

        settings.virtualAppRegistry.flushApp(context.virtualApp);
        return callback(null, version);
      });
    });
  }

  function deployFile(file, versionId, context, callback) {
    debug('deploying file %s', file.path);

    // Prepend the appId/versionId to the filePath
    file.path = urljoin(context.virtualApp.appId, versionId, file.path);

    if (!file.maxAge)
      file.maxAge = settings.defaultMaxAge;

    settings.storage.writeFile(file, function(err) {
      if (err) {
        debug("error writing file %s: %o", file.path, err);
        return callback(err);
      }

      debug("done deploying file %s", file.path);
      callback();
    });
  }

  // Download the archive url (.gz.tar format) and deploy all the files therein as a new version
  function deployArchive(archiveStream, versionId, nestedDir, context, callback) {
    var extractDir = path.join(os.tmpdir(), versionId);
    var sourcesDir;

    async.series([
      function(cb) {
        // Create a tmp directory
        fs.mkdir(extractDir, cb);
      },
      function(cb) {
        var error = false;
        debug("unzipping archive to %s", extractDir);
        archiveStream
          .pipe(zlib.Unzip())
          .pipe(tar.Extract({ path: extractDir, strip: 1 }))
          .on('error', function(err) {
            error = true;
            debug("error unzipping archive: %o", err);
            return cb(err);
          })
          .on('close', function() {
            debug("done unzipping archive");
            if (!error)
              cb();
          });
      },
      function(cb) {
        // If the deployment specifies a nested subdirectory for the contents, ensure it exists.
        if (nestedDir) {
          sourcesDir = path.join(extractDir, nestedDir);
          fs.exists(sourcesDir, function(exists) {
            if (!exists)
              return cb(new Error("Subdirectory " + nestedDir + " does not exist in source archive"));
            else
              cb();
          });
        }
        else {
          sourcesDir = extractDir;
          cb();
        }
      },
      function(cb) {
        // Gather up all the files starting at the root of the top level directory
        // from the extract.
        readdirp({ root: sourcesDir, entryType: 'files' }, function() {}, function(err, res) {
          if (err) return cb(err);

          debug("found %s files to deploy", res.files.length);

          async.each(res.files, function(fileInfo, cb1) {
            getDeployPayload(fileInfo, function(err, deployData) {
              if (err) return cb1(err);

              deployFile(deployData, versionId, context, cb1);
            });
          }, function(err) {
            if (err) return cb(err);
            debug("done deploying files");
            cb();
          });
        });
      }
    ], callback);
  }

  function getDeployPayload(fileInfo, callback) {
    var compress = _.contains(compressExtensions, path.extname(fileInfo.path));
    if (compress) {
      debug('compressing file %s', fileInfo.path);

      // If the file is to be compressed, write the .gz file to disk alongside
      // the original and upload it. Trying to pipe the gzipped output directly
      // to the deploy command hangs.
      var compressError;
      fs.createReadStream(fileInfo.fullPath)
        .pipe(zlib.createGzip())
        .pipe(fs.createWriteStream(fileInfo.fullPath + '.gz'))
        .on('error', function(err) {
          compressError = true;
          return callback(Error.create("Error compressing file " + fileInfo.path, {}, err));
        })
        .on('finish', function() {
          if (compressError) return;

          debug('done writing gzip file %s', fileInfo.fullPath + '.gz');

          // Need to stat the new .gz file to get the updated size.
          fs.stat(fileInfo.fullPath + '.gz', function(err, stats) {
            if (err) return callback(err);

            return callback(null, {
              contents: fs.createReadStream(fileInfo.fullPath + '.gz'),
              size: stats.size,
              // Keep the original file name
              path: fileInfo.path.replace(/\\/g, '/'),
              gzipEncoded: true
            });
          });
        });
    }
    else {
      callback(null, {
        contents: fs.createReadStream(fileInfo.fullPath),
        size: fileInfo.stat.size,
        path: fileInfo.path.replace(/\\/g, '/'),
        gzipEncoded: false
      });
    }
  }

  function deleteVersion(versionId, context, callback) {
    settings.database.getVersion(context.virtualApp.appId, versionId, function(err, version) {
      // Ensure the appId in the URL matches the appId of the version.
      if (!version)
        return next(Error.create("Version " + versionId + " does not exist", {code: "versionNotFound"}));

      async.parallel([
        function(cb) {
          settings.database.deleteVersion(context.virtualApp.appId, versionId, cb);
        },
        function(cb) {
          settings.storage.deleteFiles(context.virtualApp.appId + '/' + versionId, cb);
        }
      ], callback);
    });
  }

  // Delete all the versions for an application
  function deleteAllVersions(appId, context, callback) {
    // TODO: The current logic in the database to delete all the versions should really be here.
    settings.storage.deleteFiles(appId, callback);
  }

  // Serve the specified file asset to the http response
  function serveFile(appId, versionId, filePath, res) {
    var storagePath = urljoin(appId, versionId, filePath);

    settings.storage.getMetadata(storagePath, function(err, metadata) {
      if (!metadata)
        return res.status(404).send("Not Found");

      var readStream = settings.storage.readFileStream(storagePath);

      if (metadata.ContentEncoding)
        res.set('Content-Encoding', metadata.ContentEncoding);

      if (metadata.ContentType)
        res.set('Content-Type', metadata.ContentType);

      if (metadata.CacheControl)
        res.set('Cache-Control', metadata.CacheControl);
      else
        res.set('Cache-Control', 'maxage=' + settings.defaultMaxAge);

      readStream.pipe(res);
    });
  }

  // Split the collection into equal size groups
  // function splitIntoGroups(coll, size) {
  //   if (coll.length < size)
  //     return [coll];
  //
  //   var numGroups = Math.ceiling(coll.length / size);
  //
  //   var groups = [];
  //   for (var i=0; i<numGroups; i++) {
  //     groups.push(_.slice(coll, i * size, size));
  //   }
  //   return groups;
  // }
};
