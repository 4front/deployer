var assert = require('assert');
var fs = require('fs');
var path = require('path');
var rimraf = require('rimraf');
var os = require('os');
var manifest = require('../lib/manifest');

describe('manifest', function() {
  beforeEach(function(done) {
    this.appDir = path.join(os.tmpdir(), Date.now().toString());
    fs.mkdir(this.appDir, done);
  });

  afterEach(function(done) {
    rimraf(this.appDir, done);
  });

  it('loads from package.json', function(done) {
    var manifestJson = {
      router: [{
        module: 'webpage',
        options: {setting: 1}
      }]
    };

    var manifestString = JSON.stringify({_virtualApp: manifestJson});

    manifest(manifestString, function(err, json) {
      assert.deepEqual(json, manifestJson);
      done();
    });
  });

  it('uses default manifest for missing package.json', function(done) {
    manifest(null, function(err, json) {
      assert.deepEqual(json, manifest.defaultManifest);
      done();
    });
  });

  it('throws error for malformed package.json', function(done) {
    manifest('not_really_json', function(err) {
      assert.ok(err);
      assert.equal(err.code, 'malformedPackageJson');
      done();
    });
  });

  it('uses default manifest for missing _virtualApp', function(done) {
    manifest(JSON.stringify({name: 'foo'}), function(err, json) {
      assert.deepEqual(json, manifest.defaultManifest);
      done();
    });
  });

  it('finds manifest with custom property name', function(done) {
    var manifestJson = {foo: 1};

    var options = {propertyName: '_custom_'};
    manifest(JSON.stringify({_custom_: manifestJson}), options, function(err, json) {
      assert.deepEqual(json, manifestJson);
      done();
    });
  });

  it('find manifest with default property when custom property not found', function(done) {
    var manifestJson = {foo: 1};

    var options = {propertyName: '_custom_'};
    manifest(JSON.stringify({_virtualApp: manifestJson}), options, function(err, json) {
      assert.deepEqual(json, manifestJson);
      done();
    });
  });
});
