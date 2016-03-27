var zlib = require('zlib');
var tar = require('tar');
var async = require('async');
var fs = require('fs-extra');
var path = require('path');
var assign = require('lodash.assign');
var isFunction = require('lodash.isfunction');
var isNumber = require('lodash.isnumber');
var pick = require('lodash.pick');
var spawn = require('child_process').spawn;

require('simple-errors');

module.exports.loadPackageJson = loadPackageJson;

module.exports.BASEURL_PLACEHOLDER = 'https://__baseurl__';

// Make the temp build directory and the source and output
// sub-directories.
module.exports.makeTempDirs = function(params, callback) {
  assign(params, {
    sourceDirectory: path.join(params.buildDirectory, 'source'),
    outputDirectory: path.join(params.buildDirectory, 'output'),
    binDirectory: path.join(params.buildDirectory, 'bin')
  });

  params.logger.debug('making temp build directory: %s', params.buildDirectory);
  var dirs = [params.buildDirectory, params.binDirectory,
    params.sourceDirectory, params.outputDirectory];
  async.eachSeries(dirs, function(dir, next) {
    fs.mkdir(dir, next);
  }, callback);
};

// Uncompress the tarball and extract the contents to the temp source directory
module.exports.unpackSourceBundle = function(params, callback) {
  params.logger.debug('unpack bundle to %s', params.sourceDirectory);

  // Unpack the sourceBundle to the source directory.
  params.readStream()
    .pipe(zlib.createGunzip())
    .pipe(tar.Extract({  // eslint-disable-line
      path: params.sourceDirectory,
      strip: 1 // skip past the top-level directory to the good stuff
    }))
    .on('error', function(err) {
      callback(err);
    })
    .on('end', function() {
      callback();
    });
};

module.exports.spawnProcess = spawnProcess;

module.exports.copyPackageJsonToOutput = function(params, callback) {
  // Copy the package.json to the build output directory
  var src = path.join(params.sourceDirectory, 'package.json');
  var dest = path.join(params.outputDirectory, 'package.json');
  fs.copy(src, dest, function(err) {
    // Just eat any error
    callback();
  });
};

function loadPackageJson(params, callback) {
  fs.readFile(path.join(params.sourceDirectory, 'package.json'), function(err, data) {
    if (err) {
      if (err.code === 'ENOENT') {
        return callback(new Error('No package.json file found.'));
      }
      return callback(err);
    }

    try {
      params.packageJson = JSON.parse(data.toString());
    } catch (jsonErr) {
      return callback(new Error('Could not parse package.json'));
    }

    callback();
  });
}

module.exports.runNpmInstall = function(params, moduleName, callback) {
  if (isFunction(moduleName)) {
    callback = moduleName;
    moduleName = null;
  }

  params.logger.info('running npm install' + (moduleName ? ' ' + moduleName : '') +
    ' in ' + params.sourceDirectory);

  var npmArgs = ['install'];
  if (moduleName) npmArgs.push(moduleName);
  npmArgs.push('--progress', 'false');

  var spawnArgs = {
    executable: 'npm',
    logger: params.logger,
    args: npmArgs,
    // stdioFilter: function(msg, type) {
    //   // Only show npm stderr output in the log
    //   return type === 'error';
    // },
    cwd: params.sourceDirectory, // run the command from the temp directory
    env: assign({}, process.env, {
      PATH: params.binDirectory + ':' + process.env.PATH,
      NODE_ENV: 'development'
    }, params.untrustedRoleEnv)
  };

  spawnProcess(spawnArgs, function(err) {
    if (err) {
      return callback(new Error('npm install failure', {code: err.code}));
    }
    callback();
  });
};

function spawnProcess(params, callback) {
  var options = pick(params, 'cwd', 'env');
  options.stdio = 'pipe';

  var executableBaseName = path.basename(params.executable);
  params.logger.debug('spawning process %s', executableBaseName);
  var process = spawn(params.executable, params.args, options);
  var processExited;

  var log = function(func, data) {
    var msg = data.toString();
    if (msg.trim().length === 0) return;
    if (isFunction(params.stdioFilter) && !params.stdioFilter(msg, func)) return;
    params.logger[func](msg);
  };

  process.stdout.on('data', function(data) {
    log('info', data);
  });

  process.stderr.on('data', function(data) {
    log('error', data);
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
    if (isNumber(code) && code !== 0) {
      callback(Error.create('Process ' + executableBaseName + ' failed', {code: code}));
    } else {
      params.logger.info(executableBaseName + ' complete');
      callback();
    }
  });
}
