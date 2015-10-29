var urljoin = require('url-join');
var _ = require('lodash');

require('simple-errors');

module.exports = function(settings) {
  return function(appId, versionId, filePath, res, next) {
    var storagePath = urljoin(appId, versionId, filePath);

    settings.storage.getMetadata(storagePath, function(err, metadata) {
      if (!metadata) {
        if (_.isFunction(next)) {
          return next(Error.http(404, 'File ' + storagePath + ' not found'));
        }

        return res.status(404).send('Not Found');
      }

      var readStream = settings.storage.readFileStream(storagePath);

      if (metadata.ContentEncoding) {
        res.set('Content-Encoding', metadata.ContentEncoding);
      }

      if (metadata.ContentType) {
        res.set('Content-Type', metadata.ContentType);
      }

      if (metadata.CacheControl) {
        res.set('Cache-Control', metadata.CacheControl);
      } else {
        res.set('Cache-Control', 'maxage=' + settings.defaultMaxAge);
      }

      readStream.pipe(res);
    });
  };
};
