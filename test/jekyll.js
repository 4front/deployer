var async = require('async');
var assert = require('assert');
var shortid = require('shortid');
var fs = require('fs');
var os = require('os');
var _ = require('lodash');
var path = require('path');
var archiver = require('archiver');
var sinon = require('sinon');
var urljoin = require('url-join');
var winston = require('winston');

require('dash-assert');

describe('jekyll', function() {
  var self;
  beforeEach(function() {
    self = this;

    this.settings = _.extend({}, require('../local-ruby-config'), {
      logger: winston,
      storage: {
        writeStream: sinon.spy(function(params, callback) {
          callback();
        })
      }
    });

    this.versionId = shortid.generate();
    this.appId = shortid.generate();

    this.archivePath = path.join(os.tmpdir(), this.versionId + '.tar.gz');

    this.sourceBundle = {
      readStream: function() {
        return fs.createReadStream(self.archivePath);
      },
      buildConfig: {
        engine: 'jekyll'
      }
    };

    this.jekyll = require('../engines/jekyll')(this.settings);
  });

  it('builds jekyll-sample', function(done) {
    this.timeout(30000);

    async.series([
      function(cb) {
        // Create a tarball of the jekyll-sample directory
        var archiveStream = fs.createWriteStream(self.archivePath);
        var archive = archiver.create('tar', {gzip: true})
          .directory(path.join(__dirname, './fixtures/jekyll-sample'), 'sample-app')
          .finalize();

        archive.pipe(archiveStream).on('finish', cb);
      },
      function(cb) {
        self.jekyll(self.sourceBundle, self.appId, self.versionId, function(err) {
          if (err) return cb(err);

          assert.equal(5, self.settings.storage.writeStream.callCount);

          var expectedDeployedFiles = ['index.html', 'about/index.html',
            'jekyll/update/2016/02/16/welcome-to-jekyll.html'];

          // make assertions about what files were deployed.
          expectedDeployedFiles.forEach(function(filePath) {
            assert.isTrue(self.settings.storage.writeStream.calledWith(sinon.match({
              path: urljoin(self.appId, self.versionId, filePath)
            })));
          });

          cb();
        });
      }
    ], done);
  });

  it('handles missing _config.yml', function(done) {
    this.timeout(5000);
    async.series([
      function(cb) {
        // Create a tarball of the jekyll-sample directory
        var archiveStream = fs.createWriteStream(self.archivePath);
        var archive = archiver.create('tar', {gzip: true})
          .glob('jekyll-sample/**/*.*', {
            ignore: '**/_config.yml',
            cwd: path.join(__dirname, './fixtures')
          })
          .finalize();

        archive.pipe(archiveStream).on('finish', cb);
      },
      function(cb) {
        self.jekyll(self.sourceBundle, self.appId, self.versionId, cb);
      }
    ], done);
  });

  // it('handles invalid gem', function(done) {
  //
  // });
});
