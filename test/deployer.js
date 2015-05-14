var assert = require('assert');
var _ = require('lodash');
var sinon = require('sinon');
var shortid = require('shortid');
var sbuff = require('simple-bufferstream');
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

  it('createVersion', function(done) {
    var versionData = {
      name: 'name',
      username: 'username'
    };

    this.deployer.createVersion(versionData, this.context, function(err, version) {
      if (err) return done(err);

      assert.isTrue(self.settings.database.nextVersionNum.calledWith
        (self.context.virtualApp.appId));

      assert.isTrue(self.settings.database.createVersion.calledWith(sinon.match({
        versionId: sinon.match.string,
        appId: self.context.virtualApp.appId,
        userId: self.context.user.userId,
        username: 'username',
        name: versionData.name
      })));

      assert.isMatch(version, {
        name: versionData.name,
        appId: self.context.virtualApp.appId
      });

      done();
    });
  });

  it('createVersion and generate name', function(done) {
    var versionData = {
      username: 'username'
    };

    this.deployer.createVersion(versionData, this.context, function(err, version) {
      if (err) return done(err);

      assert.isTrue(self.settings.database.createVersion.calledWith(sinon.match({
        versionId: sinon.match.string,
        appId: self.context.virtualApp.appId,
        username: 'username',
        name: 'v' + self.nextVersionNum
      })));

      assert.equal(version.name, 'v' + self.nextVersionNum);

      done();
    });
  });

  describe('markVersionComplete', function() {
    it('force all traffic to new version', function(done) {
      var options = {forceAllTrafficToNewVersion: true};
      var versionId = shortid.generate();

      this.deployer.markVersionComplete(versionId, this.context, options, function(err, version) {
        assert.isTrue(self.settings.database.updateVersion.called);

        assert.isTrue(self.settings.database.updateVersion.calledWith(sinon.match({
          appId: self.context.virtualApp.appId,
          versionId: versionId,
          complete: true
        })));

        assert.isTrue(self.settings.database.updateTrafficRules.calledWith(
          self.context.virtualApp.appId,
          'production',
          [{versionId: versionId, rule: "*"}]
        ));

        assert.ok(self.virtualAppRegistry.flushApp.calledWith(self.context.virtualApp));
        assert.equal(version.previewUrl, 'http://app.apphost.com');

        done();
      });
    });

    it('do not direct any traffic to it', function(done) {
      self.context.virtualApp.trafficControlEnabled = true;
      var options = {forceAllTrafficToNewVersion: false};
      var versionId = shortid.generate();

      this.deployer.markVersionComplete(versionId, this.context, options, function(err, version) {
        assert.isTrue(self.settings.database.updateVersion.calledWith(sinon.match({
          appId: self.context.virtualApp.appId,
          versionId: versionId,
          complete: true
        })));

        assert.isFalse(self.settings.database.updateTrafficRules.called);
        assert.isFalse(self.virtualAppRegistry.flushApp.called);
        assert.equal(version.previewUrl, 'http://app.apphost.com?_version=' + versionId);

        done();
      });
    });

    it('no environments exist', function(done) {
      this.context.organization.environments = [];
      this.deployer.markVersionComplete(shortid.generate(), this.context, null, function(err, version) {
        assert.equal(err.code, 'noEnvironmentsExist');
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
});
