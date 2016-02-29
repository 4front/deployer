var installGems = require('../../engines/jekyll/lib/install-gems');
var _ = require('lodash');
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

    self.gemParams = _.extend({},
      require('../../local-ruby-config'), {
        buildDirectory: this.buildDirectory,
        sourceDirectory: this.sourceDirectory,
        logger: {
          info: sinon.spy(logger, 'info'),
          debug: sinon.spy(logger, 'debug'),
          warn: sinon.spy(logger, 'warn')
        }
      });

    fs.mkdirSync(this.buildDirectory);
    fs.mkdirSync(this.sourceDirectory);
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
