var _ = require('lodash');
var async = require('async');
var urljoin = require('url-join');
var shortid = require('shortid');
var debug = require('debug')('4front:deployer');

require('simple-errors');

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
    markVersionComplete: markVersionComplete,
    deployFile: deployFile
  };

  function createVersion(versionData, context, callback) {
    _.extend(versionData, {
      // Generate a new unique versionId
      versionId: shortid.generate(),
      appId: context.virtualApp.appId,
      // Versions are not marked as complete initially. A second api call to /complete is required
      // to flip the complete flag to true after all the files are successfully deployed.
      complete: false
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

  function markVersionComplete(versionId, context, options, callback) {
    // Get the name of the first environment in the pipeline. If the app has
    // overridden the organization settings use them, otherwise use the org
    // defaults.
    var environments = context.organization ?
      context.organization.environments : virtualApp.environments;

    if (_.isEmpty(environments))
      return callback(Error.create("No environments configured", {code: "noEnvironmentsExist"}));

    // Deployments are done to the first environment in the pipeline. Promotion to subsequent
    // environments entails updating the traffic rules for those envs.
    var environment = environments[0];

    // If traffic control is not enabled on this app, then new deployments
    // automatically take all the traffic.
    if (context.virtualApp.trafficControlEnabled !== true)
      options.forceAllTrafficToNewVersion = true;

    settings.database.updateVersion({
      appId: context.virtualApp.appId,
      versionId: versionId,
      complete: true
    }, function(err, version) {
      if (err) return next(err);

      // If new version doesnt take all traffic, then it is just a draft deploy
      // which can be previewed via a special link.
      if (options.forceAllTrafficToNewVersion !== true) {
        //TODO: Need to incorporate the environment name into the preview URL.
        version.previewUrl = context.virtualApp.url + '?_version=' + version.versionId;
        return callback(null, version);
      }

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

    settings.storage.writeFile(file, callback);
  }
};
