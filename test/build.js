var async = require('async');
var assign = require('lodash.assign');
var fs = require('fs');
var path = require('path');
var uid = require('uid-safe');
var rimraf = require('rimraf');
var archiver = require('archiver');
var os = require('os');
var sinon = require('sinon');
var assert = require('assert');
var winston = require('winston');

require('dash-assert');

describe('build', function() {
  var self;

  beforeEach(function() {
    self = this;

    this.versionId = uid.sync(10);
    this.appId = uid.sync(10);
    this.userId = uid.sync(10);

    this.virtualApp = {
      appId: this.appId
    };

    this.storage = {
      copyToLocal: sinon.spy(function(params, cb) {
        var archive = archiver.create('tar', {gzip: true})
          .directory(path.join(__dirname, './fixtures/basic-sample'), 'basic-sample')
          .finalize();

        var localTarball = fs.createWriteStream(params.localPath);
        archive.pipe(localTarball);
        localTarball.on('close', cb);
      }),
      copyToStorage: sinon.spy(function(params, cb) {
        cb();
      })
    };

    this.database = {
      getApplication: sinon.spy(function(appId, cb) {
        cb(null, self.virtualApp);
      }),
      getVersion: sinon.spy(function(appId, versionId, cb) {
        cb(null, {
          versionId: versionId,
          appId: appId
        });
      }),
      updateVersion: sinon.spy(function(versionData, cb) {
        cb(null, versionData);
      }),
      listVersions: sinon.spy(function(appId, options, cb) {
        cb(null, []);
      })
    };

    this.settings = {
      database: this.database,
      storage: this.storage,
      storageStagingBucket: 'staging-bucket',
      storageDeploymentBucket: 'deployment-bucket'
    };

    this.buildLog = new winston.Logger({
      transports: [
        new winston.transports.Console({level: 'info'})
      ]
    });
  });

  it('builds', function(done) {
    var build = require('../lib/build')(this.settings);
    var buildParams = {
      versionId: this.versionId,
      appId: this.appId,
      userId: this.userId,
      sourceTarball: '1234.tar.gz',
      buildLog: this.buildLog
    };

    build(buildParams, function(err, version) {
      if (err) return done(err);

      assert.isTrue(self.settings.database);
      assert.ok(version);
      done();
    });
  });
});
