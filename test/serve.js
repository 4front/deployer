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
});
