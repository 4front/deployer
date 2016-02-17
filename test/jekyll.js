var async = require('async');
var assert = require('assert');
var shortid = require('shortid');
var fs = require('fs');
var os = require('os');
var path = require('path');
var archiver = require('archiver');
var sinon = require('sinon');
var urljoin = require('url-join');

require('dash-assert');

describe('jekyll', function() {
  var self;
  beforeEach(function() {
    self = this;

    this.settings = {
      logger: {
        info: function() {},
        debug: function() {}
      },
      storage: {
        writeStream: sinon.spy(function(params, callback) {
          callback();
        })
      }
    };

    this.versionId = shortid.generate();
    this.appId = shortid.generate();
  });

  it('builds jekyll-sample', function(done) {
    this.timeout(4000);
    var archivePath = path.join(os.tmpdir(), this.versionId + '.tar.gz');

    var sourceBundle = {
      readStream: function() {
        return fs.createReadStream(archivePath);
      },
      buildConfig: {
        engine: 'jekyll'
      }
    };

    var jekyll = require('../engines/jekyll')(this.settings);

    async.series([
      function(cb) {
        // Create a tarball of the jekyll-sample directory
        var archiveStream = fs.createWriteStream(archivePath);
        var archive = archiver.create('tar', {gzip: true})
          .directory(path.join(__dirname, './fixtures/jekyll-sample'), 'sample-app')
          .finalize();

        archive.pipe(archiveStream).on('finish', cb);
      },
      function(cb) {
        jekyll(sourceBundle, self.appId, self.versionId, function(err) {
          if (err) return cb(err);

          assert.equal(5, self.settings.storage.writeStream.callCount);

          var expectedDeployedFiles = ['index.html', 'about/index.html', 'jekyll/update/2016/02/16/welcome-to-jekyll.html'];

          for (var i = 0; i < 5; i++) {
            console.log(self.settings.storage.writeStream.getCall(i).args[0].path);
          }

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
});
