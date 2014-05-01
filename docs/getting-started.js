// Create a base model to add caching to
var _ = require('underscore');
var Backbone = require('backbone');
var BackboneApiClient = require('backbone-api-client');
var BackboneApiClientRedis = require('../');
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
