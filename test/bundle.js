var async = require('async');
var assign = require('lodash.assign');
var fs = require('fs');
var path = require('path');
var uid = require('uid-safe');
var rimraf = require('rimraf');
var archiver = require('archiver');
var mockery = require('mockery');
var os = require('os');
var sinon = require('sinon');
var assert = require('assert');
var urljoin = require('url-join');

require('dash-assert');

describe('bundle', function() {
  var self;

  before(function() {
    self = this;

    this.mockVersions = {};

    mockery.enable({warnOnUnregistered: false});
    mockery.registerMock('./versions', function() {
      return self.mockVersions;
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
      user: {userId: uid.sync(10)},
      virtualApp: {appId: this.appId},
      organization: {orgId: uid.sync(10)}
    };

    this.bundle = {
      appId: this.appId,
      message: 'commit message'
    };

    assign(this.mockVersions, {
      create: sinon.spy(function(versionData, context, callback) {
        callback(null, assign(versionData, {
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
        }),
        writeStream: sinon.spy(function(params, callback) {
          callback();
        })
      },
      database: {
        getVersion: sinon.spy(function(appId, versionId, cb) {
          cb(null, {
            versionId: versionId,
            appId: appId
          });
        }),
        listVersions: sinon.spy(function(appId, options, cb) {
          cb(null, []);
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

        self.deployBundle(self.bundle, self.context, function(err) {
          if (err) return cb(err);

          self.mockVersions.create.calledWith(sinon.match({
            messge: self.message,
            appId: self.appId,
            manifest: {}
          }), self.context);

          assert.equal(self.settings.storage.writeStream.callCount, self.sampleFiles.length + 1);

          self.sampleFiles.forEach(function(sampleFile) {
            assert.isTrue(self.settings.storage.writeStream.calledWith(sinon.match({
              path: urljoin(self.appId, self.versionId, sampleFile)
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
          .append(new Buffer('string'), {name: 'sample-app/ignore.html'})
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
        };

        self.deployBundle(self.bundle, self.context, function(err) {
          if (err) return cb(err);

          assert.isFalse(self.settings.storage.writeStream.calledWith(sinon.match(function(arg) {
            return arg.path.indexOf('ignore.html') !== -1;
          })));

          self.sampleFiles.forEach(function(sampleFile) {
            assert.isTrue(self.settings.storage.writeStream.calledWith(sinon.match({
              path: urljoin(self.appId, self.versionId, sampleFile)
            })));
          });

          cb();
        });
      }
    ], done);
  });

  it('deploy archive in deeper nested subfolder', function(done) {
    this.bundle.deployDirectory = '/FE/public';

    async.series([
      function(cb) {
        // Create the temp sample app archive. This time nest the files in an
        // additional "dist" directory.
        var archive = archiver.create('tar', {gzip: true})
          .append(new Buffer('string'), {name: 'sample-app/BE/ignore.html'})
          .directory(path.join(__dirname, './fixtures/sample-app'), 'sample-app/FE/public')
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

        self.deployBundle(self.bundle, self.context, function(err) {
          if (err) return cb(err);

          assert.isFalse(self.settings.storage.writeStream.calledWith(sinon.match(function(arg) {
            return arg.path.indexOf('ignore.html') !== -1;
          })));

          self.sampleFiles.forEach(function(sampleFile) {
            assert.isTrue(self.settings.storage.writeStream.calledWith(sinon.match({
              path: urljoin(self.appId, self.versionId, sampleFile)
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
        };

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

  it('invokes onManifest function', function(done) {
    this.context.onManifest = sinon.spy(function(organization, virtualApp, manifest) {
      manifest.modified = true;
    });

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

        self.deployBundle(self.bundle, self.context, function(err) {
          if (err) return cb(err);

          assert.isTrue(self.context.onManifest.calledWith(self.context.organization,
            self.context.virtualApp, sinon.match({router: sinon.match.array})));
          assert.isTrue(self.mockVersions.updateStatus.getCall(0).args[0].manifest.modified);
          cb();
        });
      }
    ], done);
  });

  it('skips blacklisted extensions', function(done) {
    async.series([
      function(cb) {
        // Create the temp sample app archive. This time nest the files in an
        // additional "dist" directory.
        var archive = archiver.create('tar', {gzip: true})
          .append(new Buffer('string'), {name: 'hello.php'})
          .append(new Buffer('string'), {name: 'index.html'})
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

        self.deployBundle(self.bundle, self.context, function(err) {
          if (err) return cb(err);

          assert.isFalse(self.settings.storage.writeStream.calledWith(sinon.match(function(arg) {
            return arg.path.indexOf('hello.php') !== -1;
          })));

          assert.isTrue(self.settings.storage.writeStream.calledWith(sinon.match({
            path: urljoin(self.appId, self.versionId, 'index.html')
          })));

          cb();
        });
      }
    ], done);
  });

  it('deployment times out', function(done) {
    assign(self.bundle, {
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
          .append('<html/>', {name: 'root/index.html'})
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

          cb();
        });
      }
    ], done);
  });

  it('raises error if another build with same commit exists', function(done) {
    var commit = uid.sync(10);
    this.settings.database.listVersions = function(appId, opts, cb) {
      cb(null, [{versionId: uid.sync(10), commit: commit}]);
    };

    this.bundle.commit = commit;

    this.deployBundle(this.bundle, this.context, function(err) {
      assert.isObject(err);
      assert.equal(err.code, 'versionCommitExists');
      done();
    });
  });

  it('raises error if another version with initiated status', function(done) {
    this.settings.database.listVersions = function(appId, opts, cb) {
      cb(null, [{versionId: uid.sync(10), status: 'initiated'}]);
    };

    this.deployBundle(this.bundle, this.context, function(err) {
      assert.isObject(err);
      assert.equal(err.code, 'deploymentInProgress');
      done();
    });
  });
});
