var assert = require('assert');
var _ = require('lodash');
var sinon = require('sinon');
var shortid = require('shortid');
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
      deleteVersion: sinon.spy(function(appId, callback) {
        callback(null);
      }),
      nextVersionNum: sinon.spy(function(appId, callback) {
        callback(null, self.nextVersionNum);
      }),
      updateVersion: sinon.spy(function(versionData, callback) {
        callback(null, versionData);
      }),
      updateTrafficRules: sinon.spy(function(appId, environment, trafficRules, callback) {
        callback(null);
      })
    };

    this.settings.virtualAppRegistry = this.virtualAppRegistry = {
      flushApp: sinon.spy(function(app) {
      })
    };

    this.settings.storage = {
      // writeVersionFile: sinon.spy(function(appId, callback) {
      //   callback();
      // })
    };

    this.context = {
      virtualApp: {
        appId: shortid.generate()
      },
      organization: {
        orgId: shortid.generate()
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

  it('markVersionComplete', function(done) {
    this.deployer.markVersionComplete(versionId, context, options, function(err, version) {
      done();
    });
  });
});
