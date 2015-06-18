var urljoin = require('url-join');

module.exports = function(settings) {
  return function(appId, versionId, filePath, res) {
    var storagePath = urljoin(appId, versionId, filePath);

    settings.storage.getMetadata(storagePath, function(err, metadata) {
      if (!metadata)
        return res.status(404).send("Not Found");

      var readStream = settings.storage.readFileStream(storagePath);

      if (metadata.ContentEncoding)
        res.set('Content-Encoding', metadata.ContentEncoding);

      if (metadata.ContentType)
        res.set('Content-Type', metadata.ContentType);

      if (metadata.CacheControl)
        res.set('Cache-Control', metadata.CacheControl);
      else
        res.set('Cache-Control', 'maxage=' + settings.defaultMaxAge);

      readStream.pipe(res);
    });
  };
};
