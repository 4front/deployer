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
      virtualAppRegistry: {
        flushApp: sinon.spy(function() {})
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
      userId: this.userId,
      message: this.message,
      manifest: this.manifest
    };

    this.versions.create(versionData, function(err, version) {
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

  it('delete version', function(done) {
    var versionId = uid.sync(10);

    this.versions.delete(this.appId, versionId, function(err) {
      if (err) return done(err);
      assert.isTrue(self.settings.database.getVersion.calledWith(
        self.appId, versionId));
      assert.isTrue(self.settings.database.deleteVersion.calledWith(
        self.appId, versionId));
      assert.isTrue(self.settings.storage.deleteFiles.calledWith(
        self.appId + '/' + versionId));

      done();
    });
  });

  it('deletes all versions', function(done) {
    this.versions.deleteAll(this.appId, function(err) {
      if (err) return done(err);
      assert.isTrue(self.settings.storage.deleteFiles.calledWith(self.appId));

      done();
    });
  });

  it('cleans up old versions', function(done) {
    var trafficRules = {
      production: [{versionId: 'a'}],
      staging: [{versionId: 'c'}, {versionId: 'd'}]
    };

    var versions = [
      {created: 1, versionId: 'a', appId: self.appId},
      {created: 2, versionId: 'b', appId: self.appId},
      {created: 3, versionId: 'c', appId: self.appId},
      {created: 4, versionId: 'd', appId: self.appId},
      {created: 5, versionId: 'e', appId: self.appId}
    ];

    this.settings.database.listVersions = sinon.spy(function(_appId, options, callback) {
      callback(null, versions);
    });

    this.versions.deleteOldest(this.appId, trafficRules, 2, function(err) {
      if (err) return done(err);

      assert.isTrue(self.settings.database.listVersions.calledWith(
        self.appId, {excludeIncomplete: false}));
      assert.equal(2, self.settings.database.deleteVersion.callCount);
      assert.isTrue(self.settings.database.deleteVersion.calledWith(self.appId, 'e'));
      assert.isTrue(self.settings.database.deleteVersion.calledWith(self.appId, 'b'));

      done();
    });
  });
});
