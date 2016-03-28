var async = require('async');
var assert = require('assert');
var shortid = require('shortid');
var fs = require('fs');
var os = require('os');
var assign = require('lodash.assign');
var path = require('path');
var archiver = require('archiver');
var sinon = require('sinon');
var urljoin = require('url-join');
var winston = require('winston');

winston.level = 'debug';
require('dash-assert');

describe('integration-npm', function() {
  var self;
  beforeEach(function() {
    self = this;

    this.settings = assign({}, {
      logger: winston,
      npmExecutable: '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
      npmCacheDirectory: path.join(__dirname, './fixtures/npm-cache'),
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
        engine: 'npm',
        script: 'build',
        output: 'public'
      }
    };

    this.npmBuild = require('../engines/npm')(this.settings);
  });

  it('builds npm react redux app', function(done) {
    this.timeout(200000);

    async.series([
      function(cb) {
        // Create a tarball of the npm-react-sample directory
        var archiveStream = fs.createWriteStream(self.archivePath);
        var archive = archiver.create('tar', {gzip: true})
          .directory(path.join(__dirname, './fixtures/react-redux-starter'), 'sample-app')
          .finalize();

        archive.pipe(archiveStream).on('finish', cb);
      },
      function(cb) {
        self.npmBuild(self.sourceBundle, self.appId, self.versionId, function(err) {
          if (err) return cb(err);

          var expectedDeployedFiles = [
            'index.html',
          ];

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

  it('builds npm angular yeoman app', function(done) {
    this.timeout(200000);

    this.sourceBundle.buildConfig.output = 'dist';

    async.series([
      function(cb) {
        // Create a tarball of the npm-react-sample directory
        var archiveStream = fs.createWriteStream(self.archivePath);
        var archive = archiver.create('tar', {gzip: true})
          .directory(path.join(__dirname, './fixtures/npm-yeoman-angular'), 'sample-app')
          .finalize();

        archive.pipe(archiveStream).on('finish', cb);
      },
      function(cb) {
        self.npmBuild(self.sourceBundle, self.appId, self.versionId, function(err) {
          if (err) return cb(err);

          var expectedDeployedFiles = [
            'index.html',
          ];

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
