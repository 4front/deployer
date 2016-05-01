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

  it('loads from package.json', function() {
    var manifestJson = {
      router: [{
        module: 'webpage',
        options: {setting: 1}
      }]
    };

    var manifestString = JSON.stringify({_virtualApp: manifestJson});

    var appManifest = manifest(manifestString);
    assert.deepEqual(appManifest.router, manifestJson.router);
  });

  it('uses default manifest for missing package.json', function() {
    var json = manifest(null);
    assert.deepEqual(json, manifest.defaultManifest);
  });

  it('throws error for malformed package.json', function() {
    try {
      manifest('not_really_json');
    } catch (err) {
      assert.ok(err);
      assert.equal(err.code, 'malformedPackageJson');
      return;
    }
    assert.fail();
  });

  it('uses default manifest for missing _virtualApp', function() {
    var json = manifest(JSON.stringify({name: 'foo'}));
    assert.deepEqual(json, manifest.defaultManifest);
  });

  it('finds manifest with custom property name', function() {
    var manifestJson = {foo: 1};

    var options = {propertyName: '_custom_'};
    var json = manifest(JSON.stringify({_custom_: manifestJson}), options);
    assert.equal(json.foo, 1);
  });

  it('find manifest with default property when custom property not found', function() {
    var manifestJson = {foo: 1};

    var options = {propertyName: '_custom_'};
    var json = manifest(JSON.stringify({_virtualApp: manifestJson}), options);
    assert.equal(json.foo, 1);
  });
});
