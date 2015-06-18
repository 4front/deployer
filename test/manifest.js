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
        module: "webpage",
        options: {setting: 1}
      }]
    };

    fs.writeFileSync(path.join(this.appDir, 'package.json'),
      JSON.stringify({ "_virtualApp": manifestJson}));

    manifest(this.appDir, function(err, json) {
      assert.deepEqual(json, manifestJson);
      done();
    });
  });

  it('uses default manifest for missing package.json', function(done) {
    manifest(this.appDir, function(err, json) {
      assert.deepEqual(json, manifest.defaultManifest);
      done();
    });
  });

  it('uses default manifest for malformed package.json', function(done) {
    fs.writeFileSync(path.join(this.appDir, 'package.json'), 'not_really_json');

    manifest(this.appDir, function(err, json) {
      assert.deepEqual(json, manifest.defaultManifest);
      done();
    });
  });

  it('uses default manifest for missing _virtualApp', function(done) {
    fs.writeFileSync(path.join(this.appDir, 'package.json'), "{'name': 'foo'}");

    manifest(this.appDir, function(err, json) {
      assert.deepEqual(json, manifest.defaultManifest);
      done();
    });
  });
});
