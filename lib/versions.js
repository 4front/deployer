var pick = require('lodash.pick');
var defaults = require('lodash.defaults');
var isEmpty = require('lodash.isempty');
var includes = require('lodash.includes');
var sortBy = require('lodash.sortby');
var forEach = require('lodash.foreach');
var some = require('lodash.some');
var async = require('async');
var uid = require('uid-safe');
var debug = require('debug')('4front:deployer:versions');

require('simple-errors');

module.exports = function(settings) {
  var exports = {};

  exports.create = function(params, callback) {
    // Just pick out the valid properties
    var versionData = pick(params, 'versionId', 'name', 'message',
      'manifest', 'commit', 'fileCount', 'hasLog', 'status');

    // if (isObject(versionData.manifest) === false) {
    //   return callback(Error.create('Missing version manifest', {
    //     status: 400,
    //     code: 'missingManifest'
    //   }));
    // }

    defaults(versionData, {
      // Generate a new unique versionId
      versionId: versionData.versionId || uid.sync(10),
      // Initially versions are in-progress. Once all files are deployed successfully, the status
      // is updated to 'complete'.
      status: 'initiated'
    });

    if (isEmpty(versionData.message)) {
      delete versionData.message;
    }

    var tasks = [];

    // If a version name was not sent in the header, auto-generate one
    tasks.push(function(cb) {
      settings.database.nextVersionNum(versionData.appId, function(err, nextNum) {
        if (err) return cb(err);

        versionData.versionNum = nextNum;

        if (isEmpty(versionData.name)) versionData.name = 'v' + nextNum;

        cb();
      });
    });

    var newVersion;
    tasks.push(function(cb) {
      debug('creating version %s in database', versionData.versionId);
      settings.database.createVersion(versionData, function(err, version) {
        if (err) return cb(err);

        newVersion = version;
        debug('finished writing version to database');
        newVersion.username = versionData.username;
        cb();
      });
    });

    async.series(tasks, function(err) {
      if (err) return callback(err);
      callback(null, newVersion);
    });
  };

  exports.delete = function(versionId, context, callback) {
    settings.database.getVersion(context.virtualApp.appId, versionId, function(err, version) {
      // Ensure the appId in the URL matches the appId of the version.
      if (!version) {
        return callback(Error.create('Version ' + versionId + ' does not exist', {
          code: 'versionNotFound'
        }));
      }

      deleteVersion(context.virtualApp.appId, versionId, callback);
    });
  };

  // Delete all the versions for an application
  exports.deleteAll = function(appId, context, callback) {
    // TODO: The current logic in the database to delete all the versions should really be here.
    settings.storage.deleteFiles(appId, callback);
  };

  // Delete the oldest deployments skipping any that have traffic
  // flowing to them.
  exports.deleteOldest = function(context, numberToDelete, callback) {
    debug('delete oldest versions');
    // Collect up all the unique versionIds that have an active traffic rule.
    var versionsWithTraffic = [];
    forEach(context.virtualApp.trafficRules, function(ruleList) {
      ruleList.forEach(function(rule) {
        versionsWithTraffic.push(rule.versionId);
      });
    });

    var versionsToDelete = [];
    async.series([
      function(cb) {
        var opts = {excludeIncomplete: false};
        var db = settings.database;
        db.listVersions(context.virtualApp.appId, opts, function(err, data) {
          if (err) return cb(err);

          // Order the versions by oldest first.
          var versions = sortBy(data, 'created');

          for (var i = 0; i < versions.length; i++) {
            if (!includes(versionsWithTraffic, versions[i].versionId)) {
              versionsToDelete.push(versions[i].versionId);
            }
            if (versionsToDelete.length === numberToDelete) break;
          }

          cb();
        });
      },
      function(cb) {
        async.each(versionsToDelete, function(versionId, done) {
          debug('delete version %s', versionId);
          deleteVersion(context.virtualApp.appId, versionId, done);
        }, cb);
      }
    ], callback);
  };

  // Test if the version can be deployed.
  exports.ensureCanBeDeployed = function(params, callback) {
    // Check that there isn't already a version for this commit and
    // also that there isn't a deployment already underway.
    var db = settings.database;
    db.listVersions(params.appId, {excludeIncomplete: false}, function(err, existingVersions) {
      if (err) return callback(err);

      debug('check if there is already a deployment for this commit');
      if (some(existingVersions, {commit: params.commit})) {
        return callback(Error.create('There is already a deployment for this commit', {
          commit: params.commit,
          code: 'versionCommitExists',
          log: false
        }));
      }

      debug('test if there is another running deployment');
      if (some(existingVersions, {status: 'running'})) {
        return callback(Error.create('There is another deployment running for this app.', {
          code: 'deploymentInProgress',
          log: false
        }));
      }

      callback();
    });
  };

  function deleteVersion(appId, versionId, callback) {
    async.parallel([
      function(cb) {
        settings.database.deleteVersion(appId, versionId, cb);
      },
      function(cb) {
        settings.storage.deleteFiles(appId + '/' + versionId, cb);
      }
    ], callback);
  }

  return exports;
};
