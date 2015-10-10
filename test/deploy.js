var path = require('path');
var uid = require('uid-safe');
var os = require('os');
var sinon = require('sinon');
var assert = require('assert');
var sbuff = require('simple-bufferstream');
var writefile = require('writefile');

require('dash-assert');

describe('deploy', function() {
  var self;

  beforeEach(function() {
    self = this;

    this.settings = {
      storage: {
        writeStream: sinon.spy(function(fileInfo, callback) {
          callback(null);
        })
      },
      logger: {
        info: function() {},
        error: function() {},
        debug: function() {}
      }
    };

    this.appId = uid.sync(10);
    this.versionId = uid.sync(10);
    this.deploy = require('../lib/deploy')(this.settings);
  });

  it('deploy non gizpped file', function(done) {
    var filePath = 'views/' + Date.now() + '.html';
    var fullPath = path.join(os.tmpdir(), filePath);
    var contents = '<html></html>';

    writefile(fullPath, contents, function(err) {
      if (err) return done(err);

      var fileInfo = {
        path: filePath,
        contents: sbuff(contents)
      };

      self.deploy(self.appId, self.versionId, fileInfo, function() {
        assert.isTrue(self.settings.storage.writeStream.calledWith(sinon.match({
          path: self.appId + '/' + self.versionId + '/' + filePath,
          contents: sinon.match({
            readable: true
          })
        })));

        done();
      });
    });
  });

  it('deploy gzipped file', function(done) {
    var filePath = 'js/' + Date.now() + '.js';
    var fullPath = path.join(os.tmpdir(), filePath);
    var contents = 'function(){asdlfkjasdfkalsdjfakldfgjslkdfgjskldfjgklsdjfgklsdjklasjdlk asdkfasldkfhasdfh}';

    writefile(fullPath, contents, function(err) {
      if (err) return done(err);

      var fileInfo = {
        path: filePath,
        contents: sbuff(contents)
      };

      self.deploy(self.appId, self.versionId, fileInfo, function() {
        assert.isTrue(self.settings.storage.writeStream.calledWith(sinon.match({
          path: self.appId + '/' + self.versionId + '/' + filePath,
          contents: sinon.match({
            _buffer: sinon.match.object,
            readable: true
          }),
          gzipEncoded: true
        })));

        // assert.isTrue(self.settings.storage.writeStream.getCall(0).args[0].size < contents.length);

        done();
      });
    });
  });

  it('deploy stream', function(done) {
    var filePath = Date.now() + '.html';
    var contents = '<html><div></div></html>';

    var fileInfo = {
      path: filePath,
      contents: sbuff(contents),
      size: contents.length
    };

    self.deploy(self.appId, self.versionId, fileInfo, function(err) {
      if (err) return done(err);

      assert.isTrue(self.settings.storage.writeStream.calledWith(sinon.match({
        path: self.appId + '/' + self.versionId + '/' + filePath,
        contents: sinon.match({readable: true})
      })));

      done();
    });
  });
});
