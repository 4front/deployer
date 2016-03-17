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

winston.level = 'debug';
require('dash-assert');

describe('integration-wintersmith', function() {
  var self;
  beforeEach(function() {
    self = this;

    this.settings = _.extend({}, {
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
      }
    };

    this.wintersmith = require('../engines/wintersmith')(this.settings);
  });

  it('builds wintersmith-sample', function(done) {
    this.timeout(60000);

    async.series([
      function(cb) {
        // Create a tarball of the hugo-sample directory
        var archiveStream = fs.createWriteStream(self.archivePath);
        var archive = archiver.create('tar', {gzip: true})
          .directory(path.join(__dirname, './fixtures/wintersmith-sample'), 'sample-app')
          .finalize();

        archive.pipe(archiveStream).on('finish', cb);
      },
      function(cb) {
        self.wintersmith(self.sourceBundle, self.appId, self.versionId, function(err) {
          if (err) return cb(err);

          var expectedDeployedFiles = [
            'index.html',
            'articles/bamboo-cutter/index.html',
            'css/main.css'];

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
