var _ = require('lodash');
var async = require('async');
var uid = require('uid-safe');
var debug = require('debug')('4front:deployer:version');

require('simple-errors');

module.exports = function(settings) {
  var exports = {};

  exports.create = function(versionData, context, callback) {
    // Just pick out the valid properties
    versionData = _.pick(versionData, 'versionId', 'name', 'message', 'manifest', 'commit', 'fileCount', 'hasLog');

    if (_.isObject(versionData.manifest) === false) {
      return callback(Error.create('Missing version manifest', {
        status: 400,
        code: 'missingManifest'
      }));
    }

    _.extend(versionData, {
      // Generate a new unique versionId
      versionId: versionData.versionId || uid.sync(10),
      appId: context.virtualApp.appId,
      userId: context.user.userId,
      // Initially versions are in-progress. Once all files are deployed successfully, the status
      // is updated to 'complete'.
      status: 'initiated'
    });

    if (_.isEmpty(versionData.message)) {
      delete versionData.message;
    }

    var tasks = [];

    // If a version name was not sent in the header, auto-generate one
    tasks.push(function(cb) {
      settings.database.nextVersionNum(versionData.appId, function(err, nextNum) {
        if (err) return cb(err);

        versionData.versionNum = nextNum;

        if (_.isEmpty(versionData.name)) versionData.name = 'v' + nextNum;

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

  exports.updateStatus = function(versionData, context, options, callback) {
    var virtualEnv = versionData.virtualEnv || 'production';
    versionData = _.pick(versionData, 'status', 'versionId', 'error', 'manifest', 'duration', 'fileCount');

    versionData.appId = context.virtualApp.appId;

    settings.logger.debug('updating version status to %s', versionData.status);

    settings.database.updateVersion(versionData, function(err, version) {
      if (err) {
        return callback(Error.create('Error updating version', {}, err));
      }

      // If the status of the version is not complete, then exit now.
      if (version.status !== 'complete') return callback(null, version);

      var appUrl;
      if (virtualEnv !== 'production') {
        appUrl = (settings.sslEnabled === true ? 'https' : 'http') + '://' + context.virtualApp.name
          + '--' + virtualEnv + '.' + settings.virtualHost;
      } else {
        appUrl = context.virtualApp.url;
      }

      // If traffic control is not enabled on this app, then new deployments
      // automatically take all the traffic.
      if (context.virtualApp.trafficControlEnabled !== true) {
        options.forceAllTrafficToNewVersion = true; // eslint-disable-line
      } else {
        // If new version doesn't take all traffic, then it is just a draft deploy
        // which can be previewed via a special link.
        // TODO: Need to incorporate the environment name into the preview URL.
        version.previewUrl = appUrl + '?_version=' + version.versionId;
        return callback(null, version);
      }


      // Get the name of the first environment in the pipeline. If the app has
      // overridden the organization settings use them, otherwise use the org
      // defaults.
      // var environments = context.organization ?
      //   context.organization.environments : context.virtualApp.environments;

      // Deployments are done to the first environment in the pipeline. Promotion to subsequent
      // environments entails updating the traffic rules for those envs.
      // If there are no environment, default to production.
      // var environment;
      // if (!environments || _.isEmpty(environments)) {
      //   environment = 'production';
      // } else {
      //   environment = environments[0];
      // }

      debug('forcing all %s traffic to new version %s', virtualEnv, version.versionId);
      version.previewUrl = appUrl;

      var trafficRules = [{versionId: version.versionId, rule: '*'}];
      settings.logger.debug('updating traffic rules for app %s and environment',
        context.virtualApp.appId, virtualEnv);

      settings.database.updateTrafficRules(versionData.appId, virtualEnv, trafficRules, function(innerErr) {
        if (err) {
          return callback(Error.create('Error updating traffic rules', {}, innerErr));
        }

        if (settings.virtualAppRegistry) {
          settings.virtualAppRegistry.flushApp(context.virtualApp);
        }

        return callback(null, version);
      });
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
    _.each(context.virtualApp.trafficRules, function(ruleList) {
      ruleList.forEach(function(rule) {
        versionsWithTraffic.push(rule.versionId);
      });
    });

    var versionsToDelete = [];
    async.series([
      function(cb) {
        settings.database.listVersions(context.virtualApp.appId, {excludeIncomplete: false}, function(err, data) {
          if (err) return cb(err);

          // Order the versions by oldest first.
          var versions = _.sortBy(data, 'created');

          for (var i = 0; i < versions.length; i++) {
            if (!_.includes(versionsWithTraffic, versions[i].versionId)) {
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
