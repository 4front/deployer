var os = require('os');
var fs = require('fs-extra');
var path = require('path');
var uid = require('uid-safe');
var assert = require('assert');
var winston = require('winston');

require('dash-assert');

describe('build', function() {
  var self;

  beforeEach(function() {
    self = this;

    this.versionId = uid.sync(10);
    this.appId = uid.sync(10);
    this.userId = uid.sync(10);

    this.buildLog = new winston.Logger({
      transports: [
        new winston.transports.Console({level: 'debug'})
      ]
    });

    this.sourceDirectory = path.join(os.tmpdir(), this.versionId);
    this.buildParams = {
      virtualApp: {
        appId: this.appId
      },
      sourceDirectory: this.sourceDirectory,
      buildLog: this.buildLog
    };

    fs.ensureDirSync(this.buildParams.sourceDirectory);
    this.copyEngine = require('../engines/copy')({});
  });

  it('virtualApp does not have a deployDirectory', function(done) {
    this.copyEngine(this.buildParams, function(err, outputDirectory) {
      if (err) return done(err);
      assert.equal(self.buildParams.sourceDirectory, outputDirectory);
      done();
    });
  });

  it('virtualApp with a deploy directory', function(done) {
    this.buildParams.virtualApp.deployDirectory = 'dist';
    var distDirectory = path.join(this.buildParams.sourceDirectory, 'dist');
    fs.outputFileSync(distDirectory + '/index.html', '<html>');
    this.copyEngine(this.buildParams, function(err, outputDirectory) {
      if (err) return done(err);
      assert.equal(outputDirectory, distDirectory);
      done();
    });
  });

  it('virtualApp deployDirectory does not exist', function(done) {
    this.buildParams.virtualApp.deployDirectory = 'missing';
    this.copyEngine(this.buildParams, function(err) {
      assert.equal(err.code, 'invalidDeployDirectory');
      done();
    });
  });

  it('virtualApp deployDirectory is not a directory', function(done) {
    this.buildParams.virtualApp.deployDirectory = 'file-not-directory';
    fs.writeFileSync(path.join(this.sourceDirectory, 'file-not-directory'), '');
    this.copyEngine(this.buildParams, function(err) {
      assert.equal(err.code, 'invalidDeployDirectory');
      done();
    });
  });

  it('deletes blacklisted extension files', function(done) {
    var phpFile = path.join(this.sourceDirectory, 'test.php');
    var aspFile = path.join(this.sourceDirectory, 'test.asp');

    fs.writeFileSync(phpFile, 'php');
    fs.writeFileSync(aspFile, 'asp');

    this.copyEngine(this.buildParams, function(err) {
      if (err) return done(err);

      assert.isFalse(fs.existsSync(phpFile));
      assert.isFalse(fs.existsSync(aspFile));
      done();
    });
  });
});
