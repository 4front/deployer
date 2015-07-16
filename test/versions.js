var assert = require('assert');
var _ = require('lodash');
var sinon = require('sinon');
var shortid = require('shortid');

require('dash-assert');

describe('version', function() {
  var self;

  beforeEach(function() {
    self = this;
    this.settings = {};

    this.settings = {
      database: {
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
      },
      logger: {
        info: function(){}
      },
      virtualAppRegistry: {
        flushApp: sinon.spy(function(app) {})
      },
      storage: {
        deleteFiles: sinon.spy(function(prefix, callback) {
          callback();
        })
      }
    };

    this.userId = shortid.generate();
    this.appId = shortid.generate();
    this.nextVersionNum = 1;

    this.context = {
      user: {
        userId: this.userId
      },
      virtualApp: {
        appId: this.appId,
        url: 'http://app.apphost.com'
      },
      organization: {
        orgId: shortid.generate(),
        environments: ['production']
      }
    };

    this.message = "new version";

    this.manifest = {
      router: [
        {
          module: "webpage"
        }
      ]
    };

    this.versions = require('../lib/versions')(this.settings);
  });

  it('creates version', function(done) {
    var versionData = {
      appId: this.appId,
      message: this.message,
      manifest: this.manifest
    };

    this.versions.create(versionData, this.context, function(err, version) {
      if (err) return done(err);

      assert.isTrue(self.settings.database.nextVersionNum.calledWith(self.appId));

      assert.isTrue(self.settings.database.createVersion.calledWith(sinon.match({
        versionId: sinon.match.string,
        appId: self.appId,
        userId: self.userId,
        name: 'v' + self.nextVersionNum,
        manifest: self.manifest
      })));

      assert.isMatch(version, {
        name: 'v' + self.nextVersionNum,
        appId: self.appId,
        status: 'initiated'
      });

      done();
    });
  });

  describe('updateVersionStatus', function() {
    it('force all traffic to new version', function(done) {
      var options = {forceAllTrafficToNewVersion: true};

      var versionData = {
        versionId: shortid.generate(),
        status: 'complete',
        manifest: {
          router: [
            {
              module: 'webpage'
            }
          ]
        }
      };

      this.versions.updateStatus(versionData, this.context, {}, function(err, version) {
        assert.isTrue(self.settings.database.updateVersion.called);

        assert.isTrue(self.settings.database.updateVersion.calledWith(sinon.match({
          appId: self.appId,
          versionId: versionData.versionId,
          status: 'complete',
          manifest: versionData.manifest
        })));

        assert.isTrue(self.settings.database.updateTrafficRules.calledWith(
          self.context.virtualApp.appId,
          'production',
          [{versionId: versionData.versionId, rule: "*"}]
        ));

        assert.ok(self.settings.virtualAppRegistry.flushApp.calledWith(self.context.virtualApp));
        assert.equal(version.previewUrl, self.context.virtualApp.url);

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

      this.versions.updateStatus(versionData, this.context, options, function(err, version) {
        assert.isTrue(self.settings.database.updateVersion.calledWith(sinon.match({
          appId: self.context.virtualApp.appId,
          versionId: versionData.versionId,
          status: 'complete'
        })));

        assert.isFalse(self.settings.database.updateTrafficRules.called);
        assert.isFalse(self.settings.virtualAppRegistry.flushApp.called);
        assert.equal(version.previewUrl, self.context.virtualApp.url + '?_version=' + versionData.versionId);

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

      this.versions.updateStatus(versionData, this.context, options, function(err, version) {
        assert.isTrue(self.settings.database.updateVersion.calledWith(sinon.match({
          appId: self.appId,
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

      this.versions.updateStatus(shortid.generate(), this.context, null, function(err, version) {
        assert.isFalse(self.settings.database.updateTrafficRules.called);
        done();
      });
    });
  });

  it('delete version', function(done) {
    var versionId = shortid.generate();

    this.versions.delete(versionId, this.context, function(err) {
      assert.isTrue(self.settings.database.getVersion.calledWith(self.context.virtualApp.appId, versionId));
      assert.isTrue(self.settings.database.deleteVersion.calledWith(self.context.virtualApp.appId, versionId));
      assert.isTrue(self.settings.storage.deleteFiles.calledWith(self.context.virtualApp.appId + '/' + versionId));

      done();
    });
  });

  it('deletes all versions', function(done) {
    this.versions.deleteAll(this.appId, this.context, function(err) {
      assert.isTrue(self.settings.storage.deleteFiles.calledWith(self.appId));

      done();
    });
  });
});
