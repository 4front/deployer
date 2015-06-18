var _ = require('lodash');
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

  var exports = {};

  // Deploy an app source bundle
  exports.bundle = require('./lib/bundle')(settings);

  // Create,update, and delete versions
  exports.version = require('./lib/version')(settings);

  // Serve deployed static assets
  exports.serve = require('./lib/serve')(settings);

  // return {
  //   createVersion: createVersion,
  //   updateVersionStatus: updateVersionStatus,
  //   deployFile: deployFile,
  //   deleteVersion: deleteVersion,
  //   deleteAllVersions: deleteAllVersions,
  //   deployArchive: deployArchive,
  //   serveFile: serveFile
  // };

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
