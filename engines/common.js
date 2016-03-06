var zlib = require('zlib');
var tar = require('tar');
var fs = require('fs');
var path = require('path');
var _ = require('lodash');
var spawn = require('child_process').spawn;

require('simple-errors');

module.exports.loadPackageJson = loadPackageJson;

module.exports.unpackSourceBundle = function(readStream, dest, callback) {
  // Unpack the sourceBundle to the source directory.
  readStream()
    .pipe(zlib.createGunzip())
    .pipe(tar.Extract({  // eslint-disable-line
      path: dest,
      strip: 1 // skip past the top-level directory to the good stuff
    }))
    .on('error', function(err) {
      callback(err);
    })
    .on('end', function() {
      callback();
    });
};

module.exports.spawnProcess = function(params, callback) {
  var options = _.pick(params, 'cwd', 'env');
  options.stdio = 'pipe';

  var executableBaseName = path.basename(params.executable);
  params.logger.debug('spawning process %s', executableBaseName);
  var process = spawn(params.executable, params.args, options);
  var processExited;
  process.stdout.on('data', function(data) {
    params.logger.info(data.toString());
  });

  process.stderr.on('data', function(data) {
    params.logger.warn(data.toString());
  });

  process.on('error', function(err) {
    params.logger.error(err.stack);
    if (processExited) return;
    processExited = true;
    callback(new Error('Error returned from ' + executableBaseName + ': ' + err.message));
  });

  process.on('exit', function(code) {
    if (processExited) return;
    processExited = true;
    if (_.isNumber(code) && code !== 0) {
      callback(Error.create('Process ' + executableBaseName + ' failed', {code: code}));
    } else {
      params.logger.info(executableBaseName + ' complete');
      callback();
    }
  });
};

// module.exports.loadExtraBuildOptions = function(params, callback) {
//   loadPackageJson(params, function(err, packageJson) {
//     if (err) return callback(err);
//
//     var manifest = packageJson[params.packageJsonManifestKey];
//     if (!_.isObject(manifest) || !_.isObject(manifest.build)) return callback();
//
//     callback(null, _.omit(manifest.build, 'engine'));
//   });
// };

function loadPackageJson(params, callback) {
  fs.readFile(path.join(params.sourceDirectory, 'package.json'), function(err, data) {
    if (err) {
      if (err.code === 'ENOENT') {
        return callback(new Error('No package.json file found.'));
      }
      return callback(err);
    }

    var json;
    try {
      json = JSON.parse(data.toString());
    } catch (jsonErr) {
      return callback(new Error('Could not parse package.json'));
    }

    callback(null, json);
  });
}
