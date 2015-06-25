var fs = require('fs');
var path = require('path');
var _ = require('lodash');
var stream = require('stream');
var debug = require('debug')('aerobatic:bitbucket:manifest');
var through = require('through2');

var DEFAULT_MANIFEST = {
  router: [
    {
      module: "webpage"
    }
  ]
};

module.exports = function(file, callback) {
  var isStream = (file instanceof stream.Stream);

  if (isStream)
    loadFromStream(file, done);
  else
    loadFromFile(file, done);

  function done(err, data) {
    if (err)
      return callback(err);

    if (_.isEmpty(data))
      return callback(null, DEFAULT_MANIFEST);

    var packageJson;
    try {
      packageJson = JSON.parse(data);
    }
    catch(err) {
      return callback(null, DEFAULT_MANIFEST);
    }

    if (_.isObject(packageJson._virtualApp) === false)
      return callback(null, DEFAULT_MANIFEST);

    return callback(null, packageJson._virtualApp)
  }

  function loadFromFile(dir, callback) {
    fs.readFile(path.join(dir, 'package.json'), function(err, data) {
      if (err) {
        if (err.code === 'ENOENT')
          return callback(null);
        else
          return callback(err);
      }

      callback(null, data);
    });
  }

  function loadFromStream(stream, callback) {
    debug("loading package json from stream");
    var buffer = '';
    stream.pipe(through(function(chunk, enc, cb) {
      buffer += chunk.toString();
      cb();
    }, function() {
      callback(null, buffer);
    }));

    // .on('error', function(err) {
    //   debugger;
    //   return callback(err);
    // })
    // .on('end', function() {
    //   debugger;
    //   debug("done buffering package json stream");
    //   callback(null, buffer);
    // });
  }
};

module.exports.defaultManifest = DEFAULT_MANIFEST;
