var _ = require('lodash');
var async = require('async');
var uid = require('uid-safe');
var debug = require('debug')('4front:deployer:version');

require('simple-errors');

var VERSION_ATTRIBUTES = ['status', 'versionId', 'error', 'manifest', 'commit', 'fileCount'];

module.exports = function(settings) {
  var exports = {};

  exports.create = function(versionData, context, callback) {
    // Just pick out the valid properties
    versionData = _.pick(versionData, VERSION_ATTRIBUTES);

    if (_.isObject(versionData.manifest) === false) {
      return callback(Error.create('Missing version manifest', {
        status: 400,
        code: 'missingManifest'
      }));
    }

    _.extend(versionData, {
      // Generate a new unique versionId
      versionId: uid.sync(10),
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
    versionData = _.pick(versionData, VERSION_ATTRIBUTES);

    versionData.appId = context.virtualApp.appId;

    settings.logger.debug('updating version status to %s', versionData.status);

    settings.database.updateVersion(versionData, function(err, version) {
      if (err) {
        return callback(Error.create('Error updating version', {}, err));
      }

      // If the status of the version is not complete, then exit now.
      if (version.status !== 'complete') return callback(null, version);

      // If traffic control is not enabled on this app, then new deployments
      // automatically take all the traffic.
      if (context.virtualApp.trafficControlEnabled !== true) {
        /* eslint-disable */
        options.forceAllTrafficToNewVersion = true;
        /* eslint-enable */
      } else {
        // If new version doesnt take all traffic, then it is just a draft deploy
        // which can be previewed via a special link.
        // TODO: Need to incorporate the environment name into the preview URL.
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
      if (!environments || _.isEmpty(environments)) {
        environment = 'production';
      } else {
        environment = environments[0];
      }

      debug('forcing all %s traffic to new version %s', environment, version.versionId);
      version.previewUrl = context.virtualApp.url;

      var trafficRules = [{versionId: version.versionId, rule: '*'}];
      settings.logger.debug('updating traffic rules for app %s and environment',
        context.virtualApp.appId, environment);

      settings.database.updateTrafficRules(versionData.appId, environment, trafficRules, function(innerErr) {
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

      async.parallel([
        function(cb) {
          settings.database.deleteVersion(context.virtualApp.appId, versionId, cb);
        },
        function(cb) {
          settings.storage.deleteFiles(context.virtualApp.appId + '/' + versionId, cb);
        }
      ], callback);
    });
  };

  // Delete all the versions for an application
  exports.deleteAll = function(appId, context, callback) {
    // TODO: The current logic in the database to delete all the versions should really be here.
    settings.storage.deleteFiles(appId, callback);
  };

  return exports;
};
