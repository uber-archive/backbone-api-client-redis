# backbone-api-client-redis [![Build status](https://travis-ci.org/uber/backbone-api-client-redis.png?branch=master)](https://travis-ci.org/uber/backbone-api-client-redis)

Mixins that add [Redis][] caching on top of [backbone-api-client][]

This was built to provide an easy way to add caching to [Backbone][] resources. Cache mechanism details can be found in the [Caching documentation](#caching).

[Redis]: http://redis.io/
[backbone-api-client]: https://github.com/uber/backbone-api-client
[Backbone]: http://backbonejs.org/

## Getting Started
Install the module with: `npm install backbone-api-client-redis`

```js
// Create a base model to add caching to
var _ = require('underscore');
var Backbone = require('backbone');
var BackboneApiClient = require('backbone-api-client');
var BackboneApiClientRedis = require('backbone-api-client-redis');
var Github = require('github');
var redis = require('redis');
var _GithubModel = BackboneApiClient.mixinModel(Backbone.Model).extend({
  callApiClient: function (methodKey, options, cb) {
    // Prepare headers with data
    var params = _.clone(options.data) || {};
    if (options.headers) {
      params.headers = options.headers;
    }

    // Find the corresponding resource method and call it
    var method = this.methodMap[methodKey];
    return this.apiClient[this.resourceName][method](params, cb);
  }
});

// Add caching to our GithubModel and crete RepoModel
var GithubModel = BackboneApiClientRedis.mixinModel(_GithubModel);
var RepoModel = GithubModel.extend({
  resourceName: 'repos',
  methodMap: {
    read: 'get'
  },
  cachePrefix: 'repo',
  cacheTtl: 60 * 10 // 10 minutes
});

// Generate an API client for the user
var apiClient = new Github({
  version: '3.0.0'
});
apiClient.authenticate({
  type: 'basic',
  username: process.env.GITHUB_USERNAME,
  password: process.env.GITHUB_PASSWORD
});

// Create a common set of options for Backbone models
// DEV: This should be done on a per-request basis
var backboneOptions = {
  apiClient: apiClient,
  userIdentifier: 1,
  redis: redis.createClient()
};

// Fetch information for a repo with user-specific settings
var repo = new RepoModel(null, backboneOptions);
repo.fetch({
  data: {
    user: 'uber',
    repo: 'backbone-api-client-redis'
  }
}, function (err, repo, options) {
  console.log(repo.attributes);
  // Logs: { id: 19302684, name: 'backbone-api-client-redis', ...}

  // If we fetch again in another request, we will get cached data
  var repo2 = new RepoModel(null, backboneOptions);
  repo2.fetch({
    data: {
      user: 'uber',
      repo: 'backbone-api-client-redis'
    }
  }, function (err, repo2, options2) {
    console.log(repo2.attributes);
    // Logs: { id: 19302684, name: 'backbone-api-client-redis', ...}
  });
});
```

## Documentation
`backbone-api-client-redis` exposes `exports.mixinModel` and `exports.mixinCollection`.

### Caching
We currently cache via a fixed expiration fault-tolerant pass-through cache, [request-redis-cache][]. This means:

[request-redis-cache]: https://github.com/uber/request-redis-cache

1. Look up data in Redis
2. If it isn't found, via the normal `read` logic
3. Save redis for a given TTL in Redis

If Redis has any issues, we will ignore it and talk directly to the backend via the normal `read` logic.

When any alterations occur (e.g. new model, update model, delete model), we will cache bust the relevant model(s) and collection(s) information.

Since we are on the backend, each request could be tied to user specific information. As a result, we require a `userIdentifier` for each model/collection to prevent leakage between users. If you don't care for this, feel free to use a common identifier for all items (e.g. your service's name).

The naming scheme is:

```
{{userIdentifier}}-{{cachePrefix}}-model-{{id}}-{{requestHash}}
{{userIdentifier}}-{{cachePrefix}}-collection-{{requestHash}}
```

- userIdentifier, unique identifier for user where request originated
- cachePrefix, namespace for resources of a given type
- id, id of the model
- requestHash, [object-hash][] of the request parameters

[object-hash]: https://www.npmjs.org/object-hash

### `mixinModel(ModelKlass)`
Extends `ModelKlass`, via `ModelKlass.extend`, and adds caching logic on top of `callApiClient`.

It is expected that you have set up the core functionality of `callApiClient` for your API use case before using `mixinModel`. This is because we rely on `options` to be stable to guarantee a hash that is unique to the request (e.g. if a data parameter changes, it will be a different cache key).

- ModelKlass `ApiClientModel`, class extended upon [backbone-api-client][]

Returns:

- ChildModel `BackboneModel`, `Model` class extended from `ModelKlass`

#### `ChildModel#cachePrefix`
Namespace for resources of this type. Used in cache keys.

**You must define this on the class prototype.**

- cachePrefix `String|Function`, prefix for keys
    - Functions should return a `String`

#### `ChildModel#cacheTtl`
Amount of time to save resources in cache for.

**You must define this on the class prototype.**

- cacheTtl `Number|Function`, time in seconds to cache item for
    - Functions should return a `Number`

#### `ChildModel#initialize(attrs, options)`
We overwrite `initialize` the requisites for a few more new properties.

- attrs `Object|null`, attributes to set up on the model
- options `Object`, container for model options
    - userIdentifier `Mixed`, unique identifier for user to prevent item bleeding between users
    - redis `Redis`, instance of [`redis`][] client
    - requestCache `RequestRedisCache`, optional instance of [`request-redis-cache`][request-redis-cache]
        - If this is not provided, one will be instantiated

[`redis`]: https://github.com/mranney/node_redis

#### `ChildModel#callApiClient(method, options, callback)`
We overwrite `callApiClient` with some pre/post logic for cache handling.

If this is a `read` request, we will attempt to read from cache and fallback to the server.

Otherwise, we will delete the relevant cache items (any associated collections of the same type and relevant models). Then, we will perform the action. Currently, we do not cache this response as if it were `read` data due to the `requestHash` logic. See [#1][] for discussion.

[#1]: https://github.com/uber/backbone-api-client-redis/issues/1

#### `ChildModel#clearCache(method, options, callback)`
In order to delete cache without taking a `callApiClient` action, we provide the `clearCache` method. Under the hood, `callApiClient` leverages this for non-`read` actions.

This will clear associated collections and relevant models from Redis.

- method `String`, method to clear cache on behalf of (as if it were coming from `callApiClient`)
    - Possible values are: `create`, `update`, `delete`
    - We optimize on behalf of this parameter (e.g. `create` will not search/delete model items since they don't exist)
- options `Object`, options that would be received by `callApiClient`
- callback `Function`, error-first, `(err)`, callback to handle any errors that arose during cache removal

### `mixinCollection(CollectionKlass)`
Similar setup as [`mixinModel`][]; extends `CollectionKlass` and adds caching logic.

This should be done after `callApiClient` is locked in since request parameters are taken into consideration during cache interaction.

[`mixinModel`]: #mixinmodelmodelklass

- CollectionKlass `ApiClientCollection`, class extended upon [backbone-api-client][]

Returns:

- ChildCollection `BackboneCollection`, `Collection` class extended from `ModelKlass`

#### `cachePrefix`, `cacheTtl`, `initialize`, `callApiClient`, `clearCache`
These methods are all the same as [`mixinModel`][] except for two things. Instead of requiring `cachePrefix`/`cacheTtl`, these are resolved by default via `ChildCollection.Model`.

For example:

```js
var RepoModel = GithubModel.extend({
  cachePrefix: 'repo',
  cacheTtl: 10 * 60 // 1 hour
});
var RepoCollection = GithubModel.extend({
  Model: RepoModel
  // Automatically resolve {cachePrefix: 'repo', cacheTtl: 10 * 60}
});
```

#### `_prepareModel(attrs, options)`
We override `_prepareModel` as this is the way Backbone instantiated new models when fetched/created.

https://github.com/jashkenas/backbone/blob/1.1.2/backbone.js#L909-L919

It invokes the `Model` constructor so we add `userIdentifier`, `redis`, and `requestCache` to that list. This allows for using `CacheModels` as `collection.Model` without consequence.

- attrs `Object|null`, attributes to set on the new model
- object `Object|null`, options to pass to new model constructor

## Contributing
In lieu of a formal styleguide, take care to maintain the existing coding style. Add unit tests for any new or changed functionality. Lint via [grunt](https://github.com/gruntjs/grunt) and test via `npm test`.

## License
Copyright (c) 2014 Uber Technologies, Inc.

Licensed under the MIT license.
