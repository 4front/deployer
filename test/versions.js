var assert = require('assert');
var assign = require('lodash.assign');
var sinon = require('sinon');
var uid = require('uid-safe');

require('dash-assert');

describe('version', function() {
  var self;

  beforeEach(function() {
    self = this;
    this.settings = {};

    this.settings = {
      virtualHost: '4fronthost.com',
      database: {
        createVersion: sinon.spy(function(data, callback) {
          callback(null, assign(data, {complete: false}));
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
        info: function() {},
        warn: function() {},
        debug: function() {}
      },
      storage: {
        deleteFiles: sinon.spy(function(prefix, callback) {
          callback();
        })
      }
    };

    this.userId = uid.sync(10);
    this.appId = uid.sync(10);
    this.nextVersionNum = 1;

    this.context = {
      user: {
        userId: this.userId
      },
      virtualApp: {
        appId: this.appId,
        url: 'http://app.apphost.com',
        name: uid.sync(5)
      },
      organization: {
        orgId: uid.sync(10),
        environments: ['production']
      }
    };

    this.message = 'new version';

    this.manifest = {
      router: [
        {
          module: 'webpage'
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
      var virtualEnv = 'feature4';

      var versionData = {
        versionId: uid.sync(10),
        status: 'complete',
        virtualEnv: virtualEnv,
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
          virtualEnv,
          [{versionId: versionData.versionId, rule: '*'}]
        ));

        assert.equal(version.previewUrl,
          'http://' + self.context.virtualApp.name + '--' + virtualEnv + '.' + self.settings.virtualHost);

        done();
      });
    });

    it('do not direct any traffic to it', function(done) {
      self.context.virtualApp.trafficControlEnabled = true;
      var options = {forceAllTrafficToNewVersion: false};
      var versionData = {
        versionId: uid.sync(10),
        status: 'complete'
      };

      this.versions.updateStatus(versionData, this.context, options, function(err, version) {
        assert.isTrue(self.settings.database.updateVersion.calledWith(sinon.match({
          appId: self.context.virtualApp.appId,
          versionId: versionData.versionId,
          status: 'complete'
        })));

        assert.isFalse(self.settings.database.updateTrafficRules.called);
        assert.equal(version.previewUrl, self.context.virtualApp.url +
          '?_version=' + versionData.versionId);

        done();
      });
    });

    it('version status updated to failed', function(done) {
      var versionData = {
        versionId: uid.sync(10),
        status: 'failed',
        error: 'Version failed to deploy'
      };

      var options = {forceAllTrafficToNewVersion: false};

      this.versions.updateStatus(versionData, this.context, options, function(err) {
        if (err) return done(err);

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

      this.versions.updateStatus(uid.sync(10), this.context, null, function(err) {
        if (err) return done(err);
        assert.isFalse(self.settings.database.updateTrafficRules.called);
        done();
      });
    });
  });

  it('delete version', function(done) {
    var versionId = uid.sync(10);

    this.versions.delete(versionId, this.context, function(err) {
      if (err) return done(err);
      assert.isTrue(self.settings.database.getVersion.calledWith(
        self.context.virtualApp.appId, versionId));
      assert.isTrue(self.settings.database.deleteVersion.calledWith(
        self.context.virtualApp.appId, versionId));
      assert.isTrue(self.settings.storage.deleteFiles.calledWith(
        self.context.virtualApp.appId + '/' + versionId));

      done();
    });
  });

  it('deletes all versions', function(done) {
    this.versions.deleteAll(this.appId, this.context, function(err) {
      if (err) return done(err);
      assert.isTrue(self.settings.storage.deleteFiles.calledWith(self.appId));

      done();
    });
  });

  it('cleans up old versions', function(done) {
    this.context.virtualApp.trafficRules = {
      production: [{versionId: 'a'}],
      staging: [{versionId: 'c'}, {versionId: 'd'}]
    };

    var appId = this.context.virtualApp.appId;

    var versions = [
      {created: 1, versionId: 'a', appId: appId},
      {created: 2, versionId: 'b', appId: appId},
      {created: 3, versionId: 'c', appId: appId},
      {created: 4, versionId: 'd', appId: appId},
      {created: 5, versionId: 'e', appId: appId}
    ];

    this.settings.database.listVersions = sinon.spy(function(_appId, options, callback) {
      callback(null, versions);
    });

    this.versions.deleteOldest(self.context, 2, function(err) {
      if (err) return done(err);

      assert.isTrue(self.settings.database.listVersions.calledWith(
        appId, {excludeIncomplete: false}));
      assert.equal(2, self.settings.database.deleteVersion.callCount);
      assert.isTrue(self.settings.database.deleteVersion.calledWith(appId, 'e'));
      assert.isTrue(self.settings.database.deleteVersion.calledWith(appId, 'b'));

      done();
    });
  });
});
