// Load our dependencies
var assert = require('assert');
var _ = require('underscore');
var async = require('async');
var objectHash = require('object-hash');
var RequestRedisCache = require('request-redis-cache');

// Helper to get common Model/Collection pieces
exports.getMixinBase = function (ParentKlass) {
  // Verify ParentKlass was extended from `backbone-api-client`
  assert(ParentKlass.prototype.callApiClient, '`ParentKlass` provided to `BackboneApiClientRedis` expected to have method `prototype.callApiClient` (gained via `BackboneApiClient.mixinModel`, not the Redis one) but it was not found');

  // Return our common Model/Collection base
  return {
    initialize: function (attrs, options) {
      // Run the normal initialize method
      var retVal = ParentKlass.prototype.initialize.call(this, attrs, options);

      // DEV: Resolve prototypal information (easier to fix)
      // Grab the cache prefix from the model (so we can cache bust all the things)
      var _cachePrefix = _.result(this, 'cachePrefix');
      assert(_cachePrefix, '`BackboneApiClientRedis` expected `this.cachePrefix` to be defined but it was not found. If this is a collection, you probably forgot to use your CacheModel as the Model.');

      // Resolve cache TTL from options or `this`
      var _cacheTtl = this._cacheTtl = _.result(this, 'cacheTtl');
      assert(_cacheTtl, '`BackboneApiClientRedis` expected `this.cacheTtl` to be defined but it was not found. If this is a collection, you probably forgot to use your CacheModel as the Model.');

      // DEV: Resolve server/request information (harder to fix)
      // Define the user identifier based off of `apiClient`
      var userIdentifier = this.userIdentifier = options.userIdentifier;
      assert(userIdentifier, '`BackboneApiClientRedis` requires `options.userIdentifier` to be defined (so we can namespace a user\'s cache to them)');

      // Define a request cache
      this.redis = options.redis;
      assert(this.redis, '`BackboneApiClientRedis` expected `options.redis` to be defined but it was not found');
      this.requestCache = options.requestCache || new RequestRedisCache({redis: this.redis});

      // Pre-compute cache key base (e.g. `backbone-api-client:abcdef-trip-*`)
      // DEV: I have chosen not to include semver since it would cache bust on patch increments which is a poor experience
      // TODO: Never ever introduce a breaking change on the data we store without adjusting the key in a significant way
      this._cacheBase = 'backbone-api-client:' + userIdentifier + '-' + _cachePrefix;

      // Return the retVal
      return retVal;
    },

    /**
     * We store `models` under `{{userId}}-{{cachePrefix}}-model-{{id}}-{{requestHash}}`
     * and `collections` under `{{userId}}-{{cachePrefix}}-collection-{{requestHash}}`
     * Example key: `abcdef-trip-model-1-def123`
     * This allows for:
     *   - Not reusing cache from previous set of attrs (e.g. previous deploy)
     *     - Get trip 1234 {hello=world} -> `userId-trip-model-1234-aabbcc`
     *     - Get trip 1234 {hello=world&goodbye=moon} -> `userId-trip-model-1234-ddeeff`
     * When we cache bust, we use a set to track what hashes were used. We avoid using `KEYS` for twemproxy support
     * http://redis.io/commands#set
     */
    // DEV: _getCacheKey must be define on Model/Collection basis
    _getModelKey: function (key) {
      return this._cacheBase + '-model-' + this.id + '-' + key;
    },
    _getModelHashKey: function () {
      return this._cacheBase + '-hashes-model-' + this.id;
    },
    _getCollectionKey: function (key) {
      return this._cacheBase + '-collection-' + key;
    },
    _getCollectionHashKey: function () {
      return this._cacheBase + '-hashes-collection-' + this.id;
    },

    // Define method to clear out cache
    clearCache: function (method, options, callback) {
      var that = this;

      function deleteKeys(keys, cb) {
        // If there are no keys, continue
        if (keys.length === 0) {
          return process.nextTick(cb);
        }

        // Otherwise, delete them
        that.redis.del(keys, cb);
      }

      async.parallel([
        function deleteModels (cb) {
          // If we are in a create, skip this step (no models to cache bust)
          if (method === 'create') {
            return process.nextTick(cb);
          }

          // Otherwise, fetch the hash info
          that.redis.smembers(that._getModelHashKey(), function deleteModelsByKey (err, keys) {
            // If there was an error, callback with it
            if (err) {
              return cb(err);
            }

            // Map the keys to their counterparts, delete them, and callback
            var redisKeys = keys.map(that._getModelKey, that);
            deleteKeys(redisKeys, cb);
          });
        },
        function deleteCollections (cb) {
          that.redis.smembers(that._getCollectionHashKey(), function deleteCollectionsByKey (err, keys) {
            if (err) {
              return cb(err);
            }
            var redisKeys = keys.map(that._getCollectionKey, that);
            deleteKeys(redisKeys, cb);
          });
        }
      ], callback);
    },

    // Wrap callApiClient with some magic
    callApiClient: function (method, options, callback) {
      // If this is a `read` request, attempt to load from cache
      var that = this;
      if (method === 'read') {
        var optionsHash = objectHash(options);
        var cacheKey = this._getCacheKey(optionsHash);
        this.requestCache.get({
          cacheKey: cacheKey,
          cacheTtl: this._cacheTtl,
          requestOptions: options,
          uncachedGet: function forwardUncachedFetch (options, cb) {
            return ParentKlass.prototype.callApiClient.call(that, method, options, cb);
          }
        }, callback);
      // Otherwise, delete the cache and take action
      // DEV: Technically, collections never run this but the `read` portion is definitely reused
      } else {
        this.clearCache(method, options, function handleDeleteError (err) {
          // If there was an error, callback (we cannot allow to serve invalid cached data)
          if (err) {
            return callback(err);
          }

          // Otherwise, call the normal method
          return ParentKlass.prototype.callApiClient.call(that, method, options, callback);
        });
      }
    }
  };
};

// Define Redis mixin for models
exports.mixinModel = function (ModelKlass) {
  // Define Model-specific items on top of `getMixinBase` and extend `ModelKlass`
  var MixinBase = exports.getMixinBase(ModelKlass);
  return ModelKlass.extend(_.extend(MixinBase, {
    _getCacheKey: MixinBase._getModelKey
  }));
};

// Define Redis mixin for collections
exports.mixinCollection = function (CollectionKlass) {
  // Define Model-specific items on top of `getMixinBase` and extend `CollectionKlass`
  var MixinBase = exports.getMixinBase(CollectionKlass);
  return CollectionKlass.extend(_.extend(MixinBase, {
    // DEV: We could assert that `Model` is a `CacheModel` in `initialize` but sometimes we want to not need to create a new model for everything
    _getCacheKey: MixinBase._getCollectionKey,

    // For convenience, inherit cache info from Model
    cachePrefix: function () {
      if (this.model && typeof this.model.prototype.cachePrefix !== 'function') {
        return this.model.prototype.cachePrefix;
      }
    },
    cacheTtl: function () {
      if (this.model && typeof this.model.prototype.cacheTtl !== 'function') {
        return this.model.prototype.cacheTtl;
      }
    },

    // Override _prepareModel to pass through cache options to new Model's
    // https://github.com/jashkenas/backbone/blob/1.1.2/backbone.js#L909-L919
    _prepareModel: function (attrs, _options) {
      var options = _.extend({
        userIdentifier: this.userIdentifier,
        redis: this.redis,
        requestCache: this.requestCache
      }, _options);
      return CollectionKlass.prototype._prepareModel.call(this, attrs, options);
    }
  }));
};
