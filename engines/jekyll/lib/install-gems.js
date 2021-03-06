var async = require('async');
var fs = require('fs-extra');
var path = require('path');
var debug = require('debug')('4front:deployer:jekyll:gems');
var isArray = require('lodash.isarray');
var assign = require('lodash.assign');
var yaml = require('js-yaml');
var common = require('../../common');

module.exports = function(params, callback) {
  var localGemsDirectory = path.join(params.buildDirectory, 'gems');
  var jekyllConfig;

  async.series([
    function(cb) {
      loadJekyllConfig(params, function(err, config) {
        if (err) return cb(err);
        jekyllConfig = config;
        cb();
      });
    },
    function(cb) {
      gemInstallPlugins(params, jekyllConfig, localGemsDirectory, cb);
    }
  ], function(err) {
    callback(err, localGemsDirectory);
  });
};

function gemInstallPlugins(params, jekyllConfig, localGemsDirectory, callback) {
  if (!isArray(jekyllConfig.gems) || jekyllConfig.gems.length === 0) {
    params.logger.debug('no gems array in _config.yml');
    return callback();
  }

  var gemExecutable = path.join(params.rubyPath, 'gem');

  async.each(jekyllConfig.gems, function(gemName, cb) {
    // Replace forward slashes with dashes. Some gems, jekyll-tagging for one,
    // has to be represented in the gems array of _config.yml with a forward
    // slash. Not sure why this is or if it's widespread or specific to jekyll-tagging.
    // https://github.com/pattex/jekyll-tagging/issues/47
    gemName = gemName.replace(/\//g, '-');

    params.logger.info('installing gem %s', gemName);
    // http://guides.rubygems.org/command-reference/#gem-install
    var spawnParams = {
      executable: gemExecutable,
      args: [
        'install', gemName,
        '--install-dir', localGemsDirectory,
        '--no-ri',
        '--no-rdoc',
        '--force',
        '--conservative'],
      logger: params.logger,
      env: assign({}, process.env, {
        GEM_PATH: params.systemGemPath + ':' + localGemsDirectory
      }, params.untrustedRoleEnv)
    };

    common.spawnProcess(spawnParams, function(err) {
      if (err) {
        return cb(Error.create('Error installing gem ' + gemName));
      }
      cb();
    });
  }, callback);
}

function loadJekyllConfig(params, callback) {
  params.logger.info('loading jekyll _config.yml');
  // Look for a _config.yml file
  fs.readFile(path.join(params.sourceDirectory, '_config.yml'), function(err, data) {
    if (err) {
      // If the _config.yml file doesn't exist return an empty object.
      if (err.code === 'ENOENT') {
        params.logger.warn('no _config.yml file found, continuing without it');
        return callback(null, {});
      }
      return callback(err);
    }

    var jekyllConfig;
    var validYaml;
    try {
      jekyllConfig = yaml.safeLoad(data.toString());
      validYaml = true;
    } catch (yamlErr) {
      validYaml = false;
    }

    if (!validYaml) {
      return callback(new Error('Could not parse _config.yml'));
    }

    callback(null, jekyllConfig);
  });
}

// function bundleInstall(params, localGemsDirectory, callback) {
//   // First look for a Gemfile, if one exists run bundle install
//   fs.stat(path.join(params.sourceDirectory, 'Gemfile'), function(err) {
//     if (err) {
//       if (err.code === 'ENOENT') {
//         params.logger.debug('no Gemfile found');
//         return callback(null);
//       }
//       return callback(err);
//     }
//
//     var bundlerParams = {
//       executable: path.join(params.rubyPath, 'bundle'),
//       cwd: params.sourceDirectory,
//       args: [
//         'install',
//         '--path',
//         localGemsDirectory
//       ],
//       logger: params.logger,
//       env: _.extend({}, process.env, params.untrustedRoleEnv)
//     };
//
//     common.spawnProcess(bundlerParams, callback);
//   });
// }
