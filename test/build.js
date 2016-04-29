var os = require('os');
var fs = require('fs');
var path = require('path');
var uid = require('uid-safe');
var archiver = require('archiver');
var sinon = require('sinon');
var assert = require('assert');
var winston = require('winston');
var manifest = require('../lib/manifest');

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

    // this.sourceDirectory = path.join(__dirname, './fixtures/basic-sample');

    this.storage = {
      copyToLocal: sinon.spy(function(params, cb) {
        if (!self.sourceTarball) {
          self.sourceTarball = archiver.create('tar', {gzip: true})
            .directory(path.join(__dirname, './fixtures/basic-sample'), 'test-website')
            .finalize();
        }

        var localTarball = fs.createWriteStream(params.localPath);
        self.sourceTarball.pipe(localTarball);
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
      }),
      updateTrafficRules: sinon.spy(function(appId, virtualEnv, trafficRules, cb) {
        cb();
      })
    };

    this.settings = {
      database: this.database,
      storage: this.storage,
      storageStagingBucket: 'staging-bucket',
      storageDeploymentBucket: 'deployment-bucket',
      packageJsonManifestKey: '__manifest'
    };

    this.buildLog = new winston.Logger({
      transports: [
        new winston.transports.Console({level: 'info'})
      ]
    });

    this.buildParams = {
      versionId: this.versionId,
      appId: this.appId,
      userId: this.userId,
      sourceTarball: uid.sync(10) + '.tar.gz',
      buildLog: this.buildLog
    };
  });

  it('builds and version exists in database', function(done) {
    var build = require('../lib/build')(this.settings);
    build(this.buildParams, function(err, version) {
      if (err) return done(err);

      assert.isTrue(self.storage.copyToLocal.calledWith({
        bucket: self.settings.s3StagingBucket,
        key: self.appId + '/' + self.buildParams.sourceTarball,
        localPath: path.join(os.tmpdir(), self.buildParams.sourceTarball)
      }));

      assert.isTrue(self.database.listVersions.calledWith(self.appId));
      assert.isTrue(self.database.getVersion.calledWith(self.appId, self.versionId));

      assert.isTrue(self.storage.copyToStorage.calledWith({
        bucket: self.settings.storageDeploymentBucket,
        key: self.appId + '/' + self.versionId,
        recursive: true,
        localPath: self.buildParams.sourceDirectory
      }));

      assert.isTrue(self.database.updateVersion.calledWith({
        versionId: self.versionId,
        appId: self.appId,
        status: 'running',
        manifest: manifest.defaultManifest,
        startedAt: sinon.match.number
      }));

      assert.ok(version);
      assert.equal(version.status, 'complete');
      assert.isNumber(version.duration);
      assert.deepEqual(version.manifest, manifest.defaultManifest);
      done();
    });
  });

  it('uses custom manifest', function(done) {
    var packageJson = {};
    packageJson[this.settings.packageJsonManifestKey] = {
      router: [],
      build: {
        engine: 'basic'
      }
    };

    this.sourceTarball = archiver.create('tar', {gzip: true})
      .append(new Buffer(JSON.stringify(packageJson)), {name: 'basic-sample/package.json'})
      .directory(path.join(__dirname, './fixtures/basic-sample'), 'basic-sample')
      .finalize();

    var build = require('../lib/build')(this.settings);

    build(this.buildParams, function(err, version) {
      if (err) return done(err);

      assert.equal(version.status, 'complete');
      assert.deepEqual(version.manifest, packageJson[self.settings.packageJsonManifestKey]);
      done();
    });
  });

  it('fails with invalid build engine', function(done) {
    var packageJson = {};
    packageJson[this.settings.packageJsonManifestKey] = {
      router: [],
      build: {
        engine: 'bad-engine'
      }
    };

    this.sourceTarball = archiver.create('tar', {gzip: true})
      .append(new Buffer(JSON.stringify(packageJson)), {name: 'basic-sample/package.json'})
      .directory(path.join(__dirname, './fixtures/basic-sample'), 'basic-sample')
      .finalize();

    var build = require('../lib/build')(this.settings);

    build(this.buildParams, function(err, version) {
      if (err) return done(err);

      assert.equal(version.status, 'failed');
      assert.equal(version.error, 'Invalid build engine bad-engine');
      done();
    });
  });

  it('sets invalid package.json error on version', function(done) {
    // Put an invalid package.json in the tarball
    this.sourceTarball = archiver.create('tar', {gzip: true})
      .append(new Buffer('invalid_json'), {name: 'basic-sample/package.json'})
      .directory(path.join(__dirname, './fixtures/basic-sample'), 'basic-sample')
      .finalize();

    var build = require('../lib/build')(this.settings);

    build(this.buildParams, function(err, version) {
      if (err) return done(err);

      assert.equal(2, self.database.updateVersion.callCount);
      assert.equal('failed', version.status);
      assert.equal('Cannot parse package.json', version.error);

      done();
    });
  });
});
