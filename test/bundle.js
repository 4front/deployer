var _ = require('lodash');
var async = require('async');
var fs = require('fs');
var path = require('path');
var uid = require('uid-safe');
var rimraf = require('rimraf');
var archiver = require('archiver');
var mockery = require('mockery');
var os = require('os');
var sinon = require('sinon');
var assert = require('assert');

require('dash-assert');

describe('bundle', function() {
  var self;

  before(function() {
    self = this;

    this.mockVersions = {};
    this.mockDeploy = {};

    mockery.enable({warnOnUnregistered: false});
    mockery.registerMock('./versions', function(settings) {
      return self.mockVersions;
    });

    mockery.registerMock('./deploy', function(settings) {
      return self.mockDeploy;
    });
  });

  after(function() {
    mockery.deregisterAll();
    mockery.disable();
  });

  beforeEach(function() {
    self = this;
    this.sampleArchivePath = path.join(os.tmpdir(), 'sample-app.tar.gz');
    this.sampleArchive = fs.createWriteStream(this.sampleArchivePath);

    this.sampleFiles = ['index.html', 'js/app.js', 'css/app.css'];

    this.versionId = uid.sync(10);
    this.appId = uid.sync(10);

    this.manifest = {
      router: [{
        module: 'test-plugin',
        options: {
          foo: 1
        }
      }]
    };

    this.packageJson = {
      name: 'app-name',
      _virtualApp: this.manifest
    };

    this.context = {
      user: { userId: uid.sync(10) },
      virtualApp: {appId: this.appId},
      organization: {orgId: uid.sync(10)}
    };

    this.bundle = {
      appId: this.appId,
      message: 'commit message'
    };

    _.extend(this.mockVersions, {
      create: sinon.spy(function(versionData, context, callback) {
        callback(null, _.extend(versionData, {
          versionId: self.versionId,
          status: 'initiated'
        }));
      }),
      updateStatus: sinon.spy(function(versionData, context, options, callback) {
        callback(null, versionData);
      })
    });

    this.mockDeploy = sinon.spy(function(appId, versionId, filePath, callback) {
      callback(null);
    });

    this.settings = {
      logger: {
        info: function() {},
        error: function() {},
        debug: function() {},
        warn: function() {}
      },
      storage: {
        readFile: sinon.spy(function(key, callback) {
          callback(null, self.packageJson);
        })
      },
      database: {
        getVersion: sinon.spy(function(appId, versionId, cb) {
          cb(null, {
            versionId: versionId,
            appId: appId
          });
        })
      }
    };

    this.deployBundle = require('../lib/bundle')(this.settings);
  });

  afterEach(function(done) {
    rimraf(this.sampleArchivePath, done);
  });

  it('deployArchive from root', function(done) {
    async.series([
      function(cb) {
        // Create the temp sample app archive
        var archive = archiver.create('tar', {gzip: true})
          .directory(path.join(__dirname, './fixtures/sample-app'), 'sample-app')
          .finalize();

        archive.pipe(self.sampleArchive);

        self.sampleArchive.on('close', function() {
          cb();
        });
      },
      function(cb) {
        self.bundle.readStream = function() {
          return fs.createReadStream(self.sampleArchivePath);
        };

        self.deployBundle(self.bundle, self.context, function(err, deployedVersion) {
          if (err) return cb(err);

          self.mockVersions.create.calledWith(sinon.match({
            messge: self.message,
            appId: self.appId,
            manifest: {}
          }), self.context);

          assert.equal(self.mockDeploy.callCount, self.sampleFiles.length + 1);

          self.sampleFiles.forEach(function(sampleFile) {
            assert.isTrue(self.mockDeploy.calledWith(self.appId, self.versionId, sinon.match({
              path: sampleFile
            })));
          });

          self.settings.storage.readFile.calledWith(
            self.appId + '/' + self.versionId + '/package.json');

          self.mockVersions.updateStatus.calledWith(sinon.match({
            versionId: self.versionId,
            status: 'complete',
            manifest: self.manifest
          }), self.context);

          cb();
        });
      }
    ], done);
  });

  it('deployArchive using sub-folder', function(done) {
    this.bundle.deployDirectory = '/dist';

    async.series([
      function(cb) {
        // Create the temp sample app archive. This time nest the files in an
        // additional "dist" directory.
        var archive = archiver.create('tar', {gzip: true})
          .append(new Buffer('string'), { name: 'sample-app/ignore.html' })
          .directory(path.join(__dirname, './fixtures/sample-app'), 'sample-app/dist')
          .finalize();

        archive.pipe(self.sampleArchive);
        self.sampleArchive.on('close', function() {
          cb();
        });
      },
      function(cb) {
        self.bundle.readStream = function() {
          return fs.createReadStream(self.sampleArchivePath);
        }

        self.deployBundle(self.bundle, self.context, function(err, deployedVersion) {
          if (err) return cb(err);

          assert.isFalse(self.mockDeploy.calledWith(self.appId, self.versionId, sinon.match({
            path: 'ignore.html'
          })));

          self.sampleFiles.forEach(function(sampleFile) {
            assert.isTrue(self.mockDeploy.calledWith(self.appId, self.versionId, sinon.match({
              path: sampleFile
            })));
          });

          cb();
        });
      }
    ], done);
  });

  it('deploy empty archive', function(done) {
    async.series([
      function(cb) {
        var archive = archiver.create('tar', {gzip: true}).finalize();
        archive.pipe(self.sampleArchive).on('close', cb);
      },
      function(cb) {
        self.bundle.readStream = function() {
          return fs.createReadStream(self.sampleArchivePath);
        }

        self.deployBundle(self.bundle, self.context, function(err, deployedVersion) {
          assert.ok(self.mockVersions.updateStatus.calledWith(sinon.match({
            appId: self.appId,
            versionId: self.versionId,
            status: 'failed',
            error: 'No files found to deploy'
          })));

          assert.equal(deployedVersion.status, 'failed');
          cb();
        });
      }
    ], done);
  });

  // it('continues deployment of existing version', function(done) {
  //   self.bundle.versionId = self.versionId;
  //
  //   this.settings.database.getVersion = sinon.spy(function(appId, versionId, cb) {
  //     cb(null, {
  //       versionId: versionId,
  //       appId: appId,
  //       deploymentParts: [{
  //         partNumber: 1,
  //         lastFile: 'scripts/main.js'
  //       }]
  //     })
  //   });
  //
  //   async.series([
  //     function(cb) {
  //       self.bundle.partNumber = 2;
  //       self.bundle.lastDeployAttempt = 'scripts/main.js';
  //
  //       var tarball = archiver.create('tar', {gzip: true})
  //         .append('<html/>', { name: 'root/index.html' })
  //         .append('function(){}', {name: 'root/scripts/main.js'})
  //         .append('body{}', {name: 'root/styles/main.css'})
  //         .finalize();
  //
  //       tarball.pipe(self.sampleArchive);
  //       self.sampleArchive.on('close', function() {
  //         cb();
  //       });
  //     },
  //     function(cb) {
  //       self.bundle.readStream = function() {
  //         return fs.createReadStream(self.sampleArchivePath);
  //       };
  //
  //       self.deployBundle(self.bundle, self.context, function(err, deployedVersion) {
  //         if (err) return cb(err);
  //
  //         assert.isTrue(self.settings.database.getVersion.calledWith(self.appId, self.versionId));
  //         assert.equal(2, self.mockDeploy.callCount);
  //
  //         assert.isTrue(self.mockDeploy.calledWith(self.appId, self.versionId, sinon.match({
  //           path: 'scripts/main.js'
  //         })));
  //
  //         assert.isTrue(self.mockDeploy.calledWith(self.appId, self.versionId, sinon.match({
  //           path: 'styles/main.css'
  //         })));
  //
  //         // index.html should not have been deployed because it's already in storage
  //         assert.isFalse(self.mockDeploy.calledWith(self.appId, self.versionId, sinon.match({
  //           path: 'index.html'
  //         })));
  //
  //         assert.isTrue(self.mockVersions.updateStatus.called);
  //
  //         assert.ok(self.mockVersions.updateStatus.calledWith(sinon.match({
  //           appId: self.appId,
  //           versionId: self.versionId,
  //           status: 'complete'
  //         })));
  //
  //         cb();
  //       });
  //     }
  //   ], done);
  // });

  it('deployment times out', function(done) {
    _.extend(self.bundle, {
      shouldStop: function(entry) {
        return entry.path === 'styles/main.css';
      },
      readStream: function() {
        return fs.createReadStream(self.sampleArchivePath);
      }
    });

    async.series([
      function(cb) {
        var tarball = archiver.create('tar', {gzip: true})
          .append('<html/>', { name: 'root/index.html' })
          .append('function(){}', {name: 'root/scripts/main.js'})
          .append('body{}', {name: 'root/styles/main.css'})
          .finalize();

        tarball.pipe(self.sampleArchive);
        self.sampleArchive.on('close', function() {
          cb();
        });
      },
      function(cb) {
        self.deployBundle(self.bundle, self.context, function(err, deployedVersion) {
          if (err) return cb(err);

          assert.equal(deployedVersion.status, 'timedOut');
          assert.isTrue(deployedVersion.fileCount < 3);

          // assert.equal(2, deployedVersion.fileCount);
          // assert.equal(2, self.mockDeploy.callCount);
          //
          // assert.isTrue(self.mockDeploy.calledWith(self.appId, self.versionId, sinon.match({
          //   path: 'index.html'
          // })));
          //
          // assert.isTrue(self.mockDeploy.calledWith(self.appId, self.versionId, sinon.match({
          //   path: 'scripts/main.js'
          // })));
          //
          // assert.isFalse(self.mockDeploy.calledWith(self.appId, self.versionId, sinon.match({
          //   path: 'styles/main.css'
          // })));
          //
          // assert.equal(deployedVersion.fileCount, 2);

          cb();
        });
      }
    ], done);
  });
});
