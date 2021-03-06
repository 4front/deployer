#4front-deployer

[![Build Status][travis-image]][travis-url]
[![Test Coverage][coveralls-image]][coveralls-url]

![http://www.4front.io](https://s3-us-west-2.amazonaws.com/4front-media/4front-logo.png)

Deployment module for the [4front](http://4front.io) front-end web app platform. Relies upon a database provider like [4front-dynamodb](https://github.com/4front/dynamodb) and a storage provider like [4front-s3-storage](https://github.com/4front/s3-storage).

## Running Tests
~~~
npm test
~~~

### Running jekyll Tests

First run this command to create a gems directory in the tests directory.

`gem install jekyll --no-ri --no-rdoc --install-dir ./test/gems`

## Notes

## License
Licensed under the Apache License, Version 2.0. See (http://www.apache.org/licenses/LICENSE-2.0).

[travis-image]: https://travis-ci.org/4front/deployer.svg
[travis-url]: https://travis-ci.org/4front/deployer
[coveralls-image]: https://coveralls.io/repos/4front/deployer/badge.svg?branch=master
[coveralls-url]: https://coveralls.io/r/4front/deployer?branch=master
