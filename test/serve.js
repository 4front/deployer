var assert = require('assert');
var sinon = require('sinon');
var uid = require('uid-safe');
var sbuff = require('simple-bufferstream');
var through = require('through2');

require('dash-assert');

describe('version', function() {
  var self;

  beforeEach(function() {
    self = this;
    this.settings = {};

    this.settings = {
      storage: {
        readFileStream: sinon.spy(function() {
          return sbuff(self.contents);
        }),
        getMetadata: sinon.spy(function(storagePath, callback) {
          callback(null, self.metadata);
        })
      },
      defaultMaxAge: 1000
    };

    this.metadata = {};
    this.serve = require('../lib/serve')(this.settings);

    this.appId = uid.sync(10);
    this.versionId = uid.sync(10);

    this.output = '';

    this.res = through(function(chunk, enc, cb) {
      self.output += chunk.toString();
      this.push(chunk);
      cb();
    });

    this.res.set = sinon.spy(function() {});

    this.res.status = function(statusCode) {
      self.res.statusCode = statusCode;
      return self.res;
    };

    this.res.send = sinon.spy(function(contents) {
      sbuff(contents).pipe(self.res);
    });
  });

  it('serves file', function(done) {
    var filePath = 'pages/home.html';

    this.metadata = {
      ContentType: 'text/html'
    };

    this.contents = '<html></html>';

    this.res.on('finish', function() {
      assert.equal(self.output, self.contents);

      assert.isTrue(self.settings.storage.getMetadata.calledWith(
        self.appId + '/' + self.versionId + '/pages/home.html'));

      assert.isTrue(self.res.set.calledWith(
        'Cache-Control', 'maxage=' + self.settings.defaultMaxAge));

      done();
    });

    this.serve(this.appId, this.versionId, filePath, this.res);
  });

  it('serve gzipped file', function(done) {
    var filePath = 'js/app.js';

    this.metadata = {
      ContentType: 'application/javascript',
      ContentEncoding: 'gzip'
    };

    this.res.on('finish', function() {
      assert.isTrue(self.res.set.calledWith('Content-Encoding', 'gzip'));

      done();
    });

    this.contents = 'made_up_gzip_content';
    this.serve(this.appId, this.versionId, filePath, this.res);
  });

  it('serves with custom Cache-Control', function(done) {
    var filePath = 'pages/home.html';

    this.metadata = {
      ContentType: 'text/html',
      CacheControl: 'private'
    };

    this.contents = '<html></html>';

    this.res.on('finish', function() {
      assert.isTrue(self.res.set.calledWith(
        'Cache-Control', 'private'));

      done();
    });

    this.serve(this.appId, this.versionId, filePath, this.res);
  });

  describe('not found', function() {
    beforeEach(function() {
      this.filePath = 'pages/missing.html';

      // Return null metadata indicating the file is not found.
      this.settings.storage.getMetadata = function(storagePath, callback) {
        callback(null, null);
      };
    });

    it('sets res status to 404 for missing file', function(done) {
      this.serve(this.appId, this.versionId, this.filePath, this.res);
      this.res.on('finish', function() {
        assert.equal(self.output, 'Not Found');
        assert.equal(self.res.statusCode, 404);

        assert.isFalse(self.settings.storage.readFileStream.called);

        done();
      });
    });

    it('invokes next callback with 404 error', function(done) {
      this.serve(this.appId, this.versionId, this.filePath, this.res, function(err) {
        assert.equal(err.status, 404);
        assert.isFalse(self.settings.storage.readFileStream.called);
        done();
      });
    });
  });
});
