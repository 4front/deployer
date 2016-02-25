var path = require('path');
var uid = require('uid-safe');
var os = require('os');
var fs = require('fs');
var async = require('async');
var sinon = require('sinon');
var assert = require('assert');
var isStream = require('is-stream');
var sbuff = require('simple-bufferstream');
var writefile = require('writefile');
var shortid = require('shortid');
var debug = require('debug')('4front:deployer:test');

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

  it('gzips compressible files when gzipStaticAssets is true', function(done) {
    this.settings.gzipStaticAssets = true;
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
          contents: sinon.match(function(obj) {
            return isStream(obj);
          }),
          gzipEncoded: true
        })));

        done();
      });
    });
  });

  it('deploy html stream', function(done) {
    var filePath = shortid.generate() + '.html';
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
        contents: sinon.match(function(obj) {
          return isStream(obj);
        }),
        gzipEncoded: false
      })));

      done();
    });
  });

  it('deploy directory', function(done) {
    // Create some test files in a directory.
    var rootDir = path.join(os.tmpdir(), shortid.generate());
    var dirs = ['css', 'js'];
    var files = ['index.html', 'css/styles.css', 'js/main.js'];

    var seriesTasks = [];
    seriesTasks.push(function(cb) {
      fs.mkdir(rootDir, cb);
    });
    dirs.forEach(function(dirPath) {
      seriesTasks.push(function(cb) {
        fs.mkdir(path.join(rootDir, dirPath), cb);
      });
    });

    files.forEach(function(filePath) {
      seriesTasks.push(function(cb) {
        writefile(path.join(rootDir, filePath), 'contents', cb);
      });
    });

    seriesTasks.push(function(cb) {
      debug('deploy directory');
      self.deploy(self.appId, self.versionId, {type: 'Directory', path: rootDir}, function(err) {
        if (err) return cb(err);

        assert.equal(files.length, self.settings.storage.writeStream.callCount);

        files.forEach(function(filePath) {
          assert.isTrue(self.settings.storage.writeStream.calledWith(sinon.match({
            path: self.appId + '/' + self.versionId + '/' + filePath
          })));
        });

        cb();
      });
    });

    async.series(seriesTasks, done);
  });

  it('handles error deploying an individual file', function(done) {
    this.settings.storage.writeStream = sinon.spy(function(fileInfo, callback) {
      if (path.basename(fileInfo.path) === 'app.js') {
        return callback(new Error('failed to deploy js/app.js'));
      }
      callback(null);
    });

    var dir = path.join(__dirname, './fixtures/sample-app');
    self.deploy(self.appId, self.versionId, {type: 'Directory', path: dir}, function(err) {
      assert.ok(err);
      assert.equal(err.message, 'failed to deploy js/app.js');
      done();
    });
  });
});
