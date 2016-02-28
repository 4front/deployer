var installGems = require('../../engines/jekyll/lib/install-gems');
var fs = require('fs');
var sinon = require('sinon');
var path = require('path');
var os = require('os');
var assert = require('assert');
var winston = require('winston');

require('dash-assert');

describe('jekyll/install-gems', function() {
  var self;
  var logger;

  beforeEach(function() {
    self = this;
    this.buildDirectory = path.join(os.tmpdir(), Date.now().toString());
    this.sourceDirectory = path.join(this.buildDirectory, 'source');

    logger = new winston.Logger({transports: [new (winston.transports.Console)()]});

    self.gemParams = {
      buildDirectory: this.buildDirectory,
      sourceDirectory: this.sourceDirectory,
      systemGemPath: path.join(__dirname, '../gems'),
      rubyVersion: '2.2.0',
      rubyPath: '/usr/local/rvm/rubies/ruby-2.2.0/bin',
      logger: {
        info: sinon.spy(logger, 'info'),
        debug: sinon.spy(logger, 'debug'),
        warn: sinon.spy(logger, 'warn')
      }
    };

    fs.mkdirSync(this.buildDirectory);
    fs.mkdirSync(this.sourceDirectory);
  });

  it('installs gems using bundler', function(done) {
    this.timeout(20000);

    logger.info('write Gemfile');
    fs.writeFileSync(path.join(this.sourceDirectory, 'Gemfile'), [
      'source "https://rubygems.org"',
      'gem "jekyll", ">=3.1.2"',
      'gem "jekyll-paginate"'
    ].join('\n'));

    installGems(self.gemParams, function(err) {
      if (err) return done(err);

      assert.isTrue(fs.existsSync(path.join(self.buildDirectory, 'gems/ruby/2.2.0/gems/jekyll-3.1.2')));
      assert.isTrue(logger.info.calledWith(sinon.match(/Using jekyll 3\.1\.2/)));
      assert.isTrue(logger.info.calledWith(sinon.match(/Using liquid 3\.0\.6/)));
      assert.isTrue(logger.info.calledWith(sinon.match(/Installing jekyll-paginate 1\.1\.0/)));

      done();
    });
  });

  it('installs plugin gems from _config.yml', function(done) {
    this.timeout(20000);

    logger.info('write _config.yml');
    fs.writeFileSync(path.join(this.sourceDirectory, '_config.yml'), 'gems: [jekyll-paginate]');
    installGems(self.gemParams, function(err) {
      if (err) return done(err);

      assert.isTrue(fs.existsSync(path.join(self.buildDirectory, 'gems/ruby/2.2.0/gems/jekyll-3.1.2')));
      assert.isTrue(logger.info.calledWith('installing gem %s', 'jekyll-paginate'));

      done();
    });
  });
});
