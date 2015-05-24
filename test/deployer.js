var assert = require('assert');
var async = require('async');
var rimraf = require('rimraf');
var fs = require('fs');
var os = require('os');
var path = require('path');
var _ = require('lodash');
var sinon = require('sinon');
var shortid = require('shortid');
var sbuff = require('simple-bufferstream');
var archiver = require('archiver');
var deployer = require('..');

require('dash-assert');

describe('deployer', function() {
  var self;

  beforeEach(function() {
    self = this;
    this.settings = {};
    this.nextVersionNum = 2;

    this.settings.database = {
      createVersion: sinon.spy(function(data, callback) {
        callback(null, _.extend(data, {complete: false}));
      }),
      nextVersionNum: sinon.spy(function(appId, callback) {
        callback(null, self.nextVersionNum);
      }),
      updateVersion: sinon.spy(function(versionData, callback) {
        callback(null, versionData);
      }),
      updateTrafficRules: sinon.spy(function(appId, environment, trafficRules, callback) {
        callback(null);
      }),
      getVersion: sinon.spy(function(appId, versionId, callback) {
        callback(null, {versionId: versionId});
      }),
      deleteVersion: sinon.spy(function(appId, versionId, callback) {
        callback(null, null);
      })
    };

    this.settings.storage = {
      writeFile: sinon.spy(function(fileInfo, callback) {
        callback(null);
      }),
      deleteFiles: sinon.spy(function(prefix, callback) {
        callback();
      })
    };

    this.settings.virtualAppRegistry = this.virtualAppRegistry = {
      flushApp: sinon.spy(function(app) {
      })
    };

    this.context = {
      virtualApp: {
        appId: shortid.generate(),
        url: 'http://app.apphost.com',
        trafficControlEnabled: false
      },
      organization: {
        orgId: shortid.generate(),
        environments: ['production']
      },
      user: {
        userId: shortid.generate()
      }
    };

    this.deployer = deployer(this.settings);
  });

  describe("createVersion", function() {
    it('succeeds', function(done) {
      var versionData = {
        name: 'name',
        username: 'username',
        manifest: {router: []}
      };

      this.deployer.createVersion(versionData, this.context, function(err, version) {
        if (err) return done(err);

        assert.isTrue(self.settings.database.nextVersionNum.calledWith
          (self.context.virtualApp.appId));

        assert.isTrue(self.settings.database.createVersion.calledWith(sinon.match({
          versionId: sinon.match.string,
          appId: self.context.virtualApp.appId,
          userId: self.context.user.userId,
          name: versionData.name,
          manifest: versionData.manifest
        })));

        assert.isMatch(version, {
          name: versionData.name,
          appId: self.context.virtualApp.appId,
          status: 'initiated'
        });

        done();
      });
    });

    it('auto-generate version name', function(done) {
      var versionData = {
        username: 'username',
        manifest: {}
      };

      this.deployer.createVersion(versionData, this.context, function(err, version) {
        if (err) return done(err);

        assert.isTrue(self.settings.database.createVersion.calledWith(sinon.match({
          versionId: sinon.match.string,
          appId: self.context.virtualApp.appId,
          name: 'v' + self.nextVersionNum,
          manifest: versionData.manifest
        })));

        assert.equal(version.name, 'v' + self.nextVersionNum);

        done();
      });
    });

    it('missing manifest raises error', function(done) {
      this.deployer.createVersion({}, this.context, function(err, version) {
        assert.equal(err.code, 'missingManifest');
        done();
      });
    });
  });

  describe('updateVersionStatus', function() {
    it('force all traffic to new version', function(done) {
      var options = {forceAllTrafficToNewVersion: true};

      var versionData = {
        versionId: shortid.generate(),
        status: 'complete'
      };

      this.deployer.updateVersionStatus(versionData, this.context, options, function(err, version) {
        assert.isTrue(self.settings.database.updateVersion.called);

        assert.isTrue(self.settings.database.updateVersion.calledWith(sinon.match({
          appId: self.context.virtualApp.appId,
          versionId: versionData.versionId,
          status: 'complete'
        })));

        assert.isTrue(self.settings.database.updateTrafficRules.calledWith(
          self.context.virtualApp.appId,
          'production',
          [{versionId: versionData.versionId, rule: "*"}]
        ));

        assert.ok(self.virtualAppRegistry.flushApp.calledWith(self.context.virtualApp));
        assert.equal(version.previewUrl, 'http://app.apphost.com');

        done();
      });
    });

    it('do not direct any traffic to it', function(done) {
      self.context.virtualApp.trafficControlEnabled = true;
      var options = {forceAllTrafficToNewVersion: false};
      var versionData = {
        versionId: shortid.generate(),
        status: 'complete'
      };

      this.deployer.updateVersionStatus(versionData, this.context, options, function(err, version) {
        assert.isTrue(self.settings.database.updateVersion.calledWith(sinon.match({
          appId: self.context.virtualApp.appId,
          versionId: versionData.versionId,
          status: 'complete'
        })));

        assert.isFalse(self.settings.database.updateTrafficRules.called);
        assert.isFalse(self.virtualAppRegistry.flushApp.called);
        assert.equal(version.previewUrl, 'http://app.apphost.com?_version=' + versionData.versionId);

        done();
      });
    });

    it('version status updated to failed', function(done) {
      var versionData = {
        versionId: shortid.generate(),
        status: 'failed',
        error: 'Version failed to deploy'
      };

      var options = {forceAllTrafficToNewVersion: false};

      this.deployer.updateVersionStatus(versionData, this.context, options, function(err, version) {
        assert.isTrue(self.settings.database.updateVersion.calledWith(sinon.match({
          appId: self.context.virtualApp.appId,
          versionId: versionData.versionId,
          status: 'failed',
          error: versionData.error
        })));

        assert.isFalse(self.settings.database.updateTrafficRules.called);
        done();
      });
    });

    it('traffic rules not updated if no environments exist', function(done) {
      this.context.organization.environments = [];

      var versionData = {
        versionId: shortid.generate(),
        status: 'complete'
      };

      this.deployer.updateVersionStatus(shortid.generate(), this.context, null, function(err, version) {
        assert.isFalse(self.settings.database.updateTrafficRules.called);
        done();
      });
    });
  });

  it('deployFile', function(done) {
    var versionId = shortid.generate();

    var contents = "<html></html>";
    var file = {
      path: 'views/hello.html',
      contents: sbuff(contents),
      size: contents.length
    };

    this.deployer.deployFile(file, versionId, this.context, function(err) {
      assert.isTrue(self.settings.storage.writeFile.calledWith(sinon.match({
        path: self.context.virtualApp.appId + '/' + versionId + '/views/hello.html',
        size: contents.length
      })));

      done();
    });
  });

  it('delete version', function(done) {
    var versionId = shortid.generate();

    this.deployer.deleteVersion(versionId, this.context, function(err) {
      assert.isTrue(self.settings.database.getVersion.calledWith(self.context.virtualApp.appId, versionId));
      assert.isTrue(self.settings.database.deleteVersion.calledWith(self.context.virtualApp.appId, versionId));
      assert.isTrue(self.settings.storage.deleteFiles.calledWith(self.context.virtualApp.appId + '/' + versionId));

      done();
    });
  });

  it('deletes all versions', function(done) {
    this.deployer.deleteAllVersions(this.context.virtualApp.appId, this.context, function(err) {
      assert.isTrue(self.settings.storage.deleteFiles.calledWith(self.context.virtualApp.appId));

      done();
    });
  });

  describe('deployArchive', function() {
    beforeEach(function() {
      self = this;
      this.versionId = shortid.generate();
      this.sampleArchivePath = path.join(os.tmpdir(), 'sample-app.tar.gz');
      this.sampleArchive = fs.createWriteStream(this.sampleArchivePath);

      this.sampleFiles = ['index.html', 'js/app.js', 'css/app.css'];
    });

    afterEach(function(cb) {
      rimraf(this.sampleArchivePath, cb);
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
          var archiveStream = fs.createReadStream(self.sampleArchivePath);
          self.deployer.deployArchive(archiveStream, self.versionId, '/', self.context, function(err) {
            if (err) return cb(err);

            assert.equal(self.settings.storage.writeFile.callCount, 3);

            assert.every(self.sampleFiles, function(file) {
              return self.settings.storage.writeFile.calledWith(sinon.match({
                path: self.context.virtualApp.appId + '/' + self.versionId + '/' + file,
                gzipEncoded: file != 'index.html'
              }));
            });

            cb();
          });
        }
      ], done);
    });

    it('deployArchive using sub-folder', function(done) {
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
          var archiveStream = fs.createReadStream(self.sampleArchivePath);
          self.deployer.deployArchive(archiveStream, self.versionId, '/dist', self.context, function(err) {
            if (err) return cb(err);

            assert.equal(self.settings.storage.writeFile.callCount, 3);

            assert.every(self.sampleFiles, function(file) {
              return self.settings.storage.writeFile.calledWith(sinon.match({
                path: self.context.virtualApp.appId + '/' + self.versionId + '/' + file,
                gzipEncoded: file != 'index.html'
              }));
            });

            cb();
          });
        }
      ], done);
    });

    it('deployArchive from missing sub-folder', function(done) {
      async.series([
        function(cb) {
          var archive = archiver.create('tar', {gzip: true})
            .directory(path.join(__dirname, './fixtures/sample-app'), 'sample-app')
            .finalize();

          archive.pipe(self.sampleArchive).on('close', cb);
        },
        function(cb) {
          var archiveStream = fs.createReadStream(self.sampleArchivePath);
          self.deployer.deployArchive(archiveStream, self.versionId, '/dist', self.context, function(err) {
            assert.ok(/Subdirectory \/dist does not exist/.test(err.message));
            cb();
          });
        }
      ], done);
    });
  });

  describe('serveFile', function() {
    beforeEach(function() {
      self = this;

      this.fileStream = {
        pipe: sinon.spy(function(){})
      };

      this.settings.storage.readFileStream = sinon.spy(function(storagePage){
        return self.fileStream;
      });

      this.httpResponse = {
        set: sinon.spy(function(key, value){}),
        pipe: sinon.spy(function(){}),
        status: sinon.spy(function(statusCode){
          return self.httpResponse;
        }),
        send: sinon.spy(function(content){})
      };

      this.versionId = shortid.generate();
    });

    it('serves file', function(done) {
      this.settings.storage.getMetadata = sinon.spy(function(storagePath, callback) {
        callback(null, {
          ContentType: 'application/javascript',
          CacheControl: 'maxage=1000'
        });
      });

      this.deployer.serveFile(self.context.virtualApp.appId, this.versionId, "/js/main.js", this.httpResponse);

      assert.ok(self.settings.storage.getMetadata.calledWith(
        self.context.virtualApp.appId + '/' +
        this.versionId + '/js/main.js'));

      assert.ok(this.httpResponse.set.calledWith('Content-Type', 'application/javascript'));
      assert.ok(this.httpResponse.set.calledWith('Cache-Control', 'maxage=1000'));
      assert.ok(this.fileStream.pipe.calledWith(this.httpResponse));

      done();
    });

    it('throws 404 for missing file', function(done) {
      this.settings.storage.getMetadata = sinon.spy(function(storagePath, callback) {
        callback(null, null);
      });

      this.deployer.serveFile(self.context.virtualApp.appId, this.versionId, "/js/main.js", this.httpResponse);
      assert.ok(this.httpResponse.status.calledWith(404));
      assert.ok(this.httpResponse.send.calledWith("Not Found"));
      assert.isFalse(this.settings.storage.readFileStream.called);
      done();
    });
  });
});
