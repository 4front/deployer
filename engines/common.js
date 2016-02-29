var zlib = require('zlib');
var tar = require('tar');
var _ = require('lodash');
var spawn = require('child_process').spawn;

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

  params.logger.debug('spawning process %s', params.executable);
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
    callback(new Error('Error returned from gem install: ' + err.stack));
  });

  process.on('exit', function(code) {
    if (processExited) return;
    processExited = true;
    if (_.isNumber(code) && code !== 0) {
      params.logger.error('gem install failed with code %s', code);
      callback(new Error('Error from gem'));
    } else {
      params.logger.info('gem install complete');
      callback();
    }
  });
};
