var _ = require('lodash');
var async = require('async');
var fs = require('fs');
var path = require('path');
var shortid = require('shortid');
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

    this.versionId = shortid.generate();
    this.appId = shortid.generate();

    this.context = {
      user: { userId: shortid.generate() },
      virtualApp: {appId: this.appId},
      organization: {orgId: shortid.generate()}
    };

    this.bundle = {
      appId: this.appId,
      stream: self.sampleArchive,
      message: 'commit message'
    };

    _.extend(this.mockVersions, {
      create: sinon.spy(function(versionData, context, callback) {
        callback(null, _.extend(versionData, { versionId: self.versionId }));
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
        info: function(){},
        error: function(){}
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
        self.bundle.readStream = fs.createReadStream(self.sampleArchivePath);

        self.deployBundle(self.bundle, self.context, function(err, deployedVersion) {
          if (err) return cb(err);

          self.mockVersions.create.calledWith(sinon.match({
            messge: self.message,
            appId: self.appId,
            manifest: sinon.match.object
          }), self.context);

          assert.equal(self.mockDeploy.callCount, self.sampleFiles.length);

          self.sampleFiles.forEach(function(sampleFile) {
            assert.isTrue(self.mockDeploy.calledWith(self.appId, self.versionId, sinon.match({
              path: sampleFile
            })));
          });

          // The package.json should not get deployed
          assert.isFalse(self.mockDeploy.calledWith(self.appId, self.versionId, 'package.json'));

          self.mockVersions.updateStatus.calledWith(sinon.match({
            versionId: self.versionId,
            status: 'complete'
          }), self.context);

          cb();
        });
      }
    ], done);
  });

  it('deployArchive using sub-folder', function(done) {
    this.bundle.deployDir = '/dist';

    async.series([
      function(cb) {
        // Create the temp sample app archive. This time nest the files in an
        // additional "dist" directory.
        var archive = archiver.create('tar', {gzip: true})
          .directory(path.join(__dirname, './fixtures/sample-app'), 'sample-app/dist')
          .finalize();

        archive.pipe(self.sampleArchive);
        self.sampleArchive.on('close', function() {
          cb();
        });
      },
      function(cb) {
        self.bundle.readStream = fs.createReadStream(self.sampleArchivePath);

        self.deployBundle(self.bundle, self.context, function(err, deployedVersion) {
          if (err) return cb(err);

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

  it('deployArchive from missing sub-folder', function(done) {
    this.bundle.deployDir = '/dist';

    async.series([
      function(cb) {
        var archive = archiver.create('tar', {gzip: true})
          .directory(path.join(__dirname, './fixtures/sample-app'), 'sample-app')
          .finalize();

        archive.pipe(self.sampleArchive).on('close', cb);
      },
      function(cb) {
        self.bundle.readStream = fs.createReadStream(self.sampleArchivePath);
        self.deployBundle(self.bundle, self.context, function(err, deployedVersion) {
          assert.ok(self.mockVersions.updateStatus.calledWith(sinon.match({
            versionId: self.versionId,
            status: 'failed',
            error: sinon.match(/Sub-directory \/dist does not exist/)
          })));

          assert.equal(deployedVersion.status, 'failed');
          cb();
        });
      }
    ], done);
  });
});
