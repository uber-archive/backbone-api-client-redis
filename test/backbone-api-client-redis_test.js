// Load in dependencies
var _ = require('underscore');
var Backbone = require('backbone');
var BackboneApiClient = require('backbone-api-client');
var expect = require('chai').expect;
var BackboneApiClientRedis = require('../');
var redisUtils = require('./utils/redis');
var FakeGithub = require('./utils/fake-github');
var githubUtils = require('./utils/github');

// Define base for our cache clients
var _GithubModel = BackboneApiClient.mixinModel(Backbone.Model).extend({
  callApiClient: function (methodKey, options, cb) {
    // Prepare headers with data and send request
    var params = _.clone(options.data) || {};
    if (options.headers) {
      params.headers = options.headers;
    }

    // If the method is not create and there is an `id`, add it to params
    var reqParams = params;
    if (methodKey !== 'create' && this.id) {
      reqParams = _.extend({id: this.id}, params);
    }

    // Send our request
    var method = this.methodMap[methodKey];
    var that = this;
    return this.apiClient[this.resourceName][method](reqParams, cb);
  }
});
var _GithubCollection = BackboneApiClient.mixinCollection(Backbone.Collection).extend({
  callApiClient: _GithubModel.prototype.callApiClient
});
var GithubModel = BackboneApiClientRedis.mixinModel(_GithubModel);
var GithubCollection = BackboneApiClientRedis.mixinCollection(_GithubCollection);

// Generate models/collections to interact with
var CommentModel = GithubModel.extend({
  // https://developer.github.com/v3/issues/comments/
  // http://mikedeboer.github.io/node-github/#issues.prototype.createComment
  resourceName: 'issues',
  methodMap: {
    create: 'createComment',
    read: 'getComment',
    update: 'editComment',
    'delete': 'deleteComment'
  },
  cachePrefix: 'comment',
  cacheTtl: 1, // second
  // Trim out undesired `user` data
  parse: function (res) {
    delete res.user;
    return res;
  }
});
var CommentCollection = GithubCollection.extend({
  model: CommentModel,
  resourceName: CommentModel.prototype.resourceName,
  methodMap: {
    read: 'getComments'
  }
});

// Create a helper for resolving backbone options
before(function createBackboneOptions () {
  this.getBackboneOptions = function (userIdentifier) {
    return {
      userIdentifier: userIdentifier,
      apiClient: this.apiClient,
      redis: this.redis
    };
  };
});

// Cache-hit tests
describe('A model', function () {
  FakeGithub.start(before);
  githubUtils.createClient();
  redisUtils.run();

  describe('when fetched', function () {
    function fetchComment() {
      before(function fetchCommentFn (done) {
        var that = this;
        this.comment = new CommentModel({
          id: 41888185
        }, this.getBackboneOptions('fetch-model'));
        this.comment.fetch({
          data: {
            user: 'twolfsontest',
            repo: 'Spoon-Knife'
          }
        }, function saveError (err, model, info) {
          that.err = err;
          done();
        });
      });
    }
    fetchComment();
    after(function cleanupComment () {
      delete this.err;
      delete this.comment;
    });

    it('sends expected data', function () {
      expect(this.err).to.equal(null);
      expect(this.comment.attributes).to.have.property('body');
    });

    describe('when fetched from a downed server', function () {
      FakeGithub.stop(before);
      fetchComment();

      it('sends the cached data', function () {
        expect(this.err).to.equal(null);
        expect(this.comment.attributes).to.have.property('body');
      });

      describe('when the cache expires', function () {
        before(function waitForCacheToExpire (done) {
          setTimeout(done, 1000);
        });
        fetchComment();

        it('cannot complete the request', function () {
          expect(this.err).to.not.equal(null);
        });
      });
    });
  });
});

describe('A collection', function () {
  FakeGithub.start(before);
  githubUtils.createClient();
  redisUtils.run();

  describe('when fetched', function () {
    function fetchComments() {
      before(function fetchCommentsFn (done) {
        var that = this;
        this.comments = new CommentCollection(null, this.getBackboneOptions('fetch-collection'));
        this.comments.fetch({
          data: {
            user: 'twolfsontest',
            repo: 'Spoon-Knife',
            number: 1
          }
        }, function saveError (err, model, info) {
          that.err = err;
          done();
        });
      });
    }
    fetchComments();
    after(function cleanupComments () {
      delete this.err;
      delete this.comments;
    });

    it('sends expected data', function () {
      expect(this.err).to.equal(null);
      expect(this.comments.models[0].attributes).to.have.property('body');
    });

    describe('when fetched from a downed server', function () {
      FakeGithub.stop(before);
      fetchComments();

      it('sends the cached data', function () {
        expect(this.err).to.equal(null);
        expect(this.comments.models[0].attributes).to.have.property('body');
      });

      describe('when the cache expires', function () {
        before(function waitForCacheToExpire (done) {
          setTimeout(done, 1000);
        });
        fetchComments();

        it('cannot complete the request', function () {
          expect(this.err).to.not.equal(null);
        });
      });
    });
  });
});

// Cache bust tests
describe('A cached model and collection', function () {
  githubUtils.createClient();
  redisUtils.run();

  function fetchComment(userIdentifier) {
    before(function fetchCommentFn (done) {
      var that = this;
      this.comment = new CommentModel({
        id: 41895833
      }, this.getBackboneOptions(userIdentifier));
      this.comment.fetch({
        data: {
          user: 'twolfsontest',
          repo: 'Spoon-Knife'
        }
      }, function handleError (err, res, info) {
        that.err = err;
        done();
      });
    });
  }
  function fetchComments(userIdentifier) {
    before(function fetchCommentsFn (done) {
      var that = this;
      this.comments = new CommentCollection(null, this.getBackboneOptions(userIdentifier));
      this.comments.fetch({
        data: {
          user: 'twolfsontest',
          repo: 'Spoon-Knife',
          number: 2
        }
      }, function handleError (err, res, info) {
        that.err = err;
        done();
      });
    });
  }
  function fetchCommentInfo(userIdentifier) {
    fetchComment(userIdentifier);
    before(function verifySuccess () {
      expect(this.err).to.equal(null);
    });
    fetchComments(userIdentifier);
    before(function verifySuccess () {
      expect(this.err).to.equal(null);
    });
  }
  after(function cleanup () {
    delete this.err;
    delete this.comment;
    delete this.comments;
  });

  // DEV: This covers the delete case as well
  describe('when a model is updated', function () {
    FakeGithub.start(before);
    // Update comment to known state
    before(function updateCommentKnownState (done) {
      this.apiClient.issues.editComment({
        id: 41895833,
        user: 'twolfsontest',
        repo: 'Spoon-Knife',
        body: 'Oh hai'
      }, done);
    });
    // Fetch the data
    fetchCommentInfo('fetch-model-update');
    // Make an update (and bust the cache)
    before(function updateCommentNewState (done) {
      this.comment = new CommentModel({
        id: 41895833
      }, this.getBackboneOptions('fetch-model-update'));
      this.comment.save(null, {
        data: {
          user: 'twolfsontest',
          repo: 'Spoon-Knife',
          body: 'Hello world'
        }
      }, done);
    });

    it('updates the model', function () {
      expect(this.comment.attributes).to.have.property('body', 'Hello world');
    });

    describe('fetching from a downed server', function () {
      FakeGithub.stop(before);

      describe('the model', function () {
        fetchComment('fetch-model-update');

        it('cannot cannot be retrieved (since the cache has been invalidated)', function () {
          expect(this.err).to.not.equal(null);
        });
      });

      describe('the collection', function () {
        fetchComments('fetch-model-update');

        it('cannot cannot be retrieved (since the cache has been invalidated)', function () {
          expect(this.err).to.not.equal(null);
        });
      });
    });
  });

  describe('when a model is created', function () {
    FakeGithub.start(before);
    // Fetch the data
    fetchCommentInfo('fetch-model-create');
    // Make an create (and bust the cache)
    before(function createComment (done) {
      this.comment = new CommentModel(null, this.getBackboneOptions('fetch-model-create'));
      this.comment.save(null, {
        data: {
          user: 'twolfsontest',
          repo: 'Spoon-Knife',
          number: 3,
          body: 'Hello world'
        }
      }, done);
    });

    it('creates the item', function () {
      expect(this.comment.attributes).to.have.property('body', 'Hello world');
    });

    describe('and we fetch the collection from a downed server', function () {
      FakeGithub.stop(before);
      fetchComments('fetch-model-create');

      it('cannot complete the request (since the cache has been invalidated)', function () {
        expect(this.err).to.not.equal(null);
      });
    });
  });
});

// Cache isolation
describe('A cached model', function () {
  FakeGithub.start(before);
  githubUtils.createClient();
  redisUtils.run();

  function fetchComment(userIdentifier, attrs, data) {
    before(function fetchCommentFn (done) {
      var that = this;
      this.comment = new CommentModel(attrs || {
        id: 41888185
      }, this.getBackboneOptions(userIdentifier));
      this.comment.fetch({
        data: data || {
          user: 'twolfsontest',
          repo: 'Spoon-Knife'
        }
      }, function handleError (err, res, info) {
        that.err = err;
        done();
      });
    });
  }
  fetchComment('cache-isolation');
  before(function verifySuccessfulFetch () {
    expect(this.err).to.equal(null);
  });

  describe('and another model with a different id', function () {
    before(function verifyDifferentBody () {
      expect(this.comment.attributes).to.have.property('body', 'Comment!');
    });
    fetchComment('cache-isolation', {id: 41898856});

    it('receives other model info', function () {
      expect(this.err).to.equal(null);
      expect(this.comment.attributes).to.have.property('body', 'Another comment!');
    });
  });

  describe('when fetched from a down server', function () {
    FakeGithub.stop(before);

    describe('with different data (querystring alters response)', function () {
      fetchComment('cache-isolation', null, {
        data: {
          user: 'twolfsontest',
          repo: 'Spoon-Knife-Foooooork'
        }
      });

      it('does not receive cached data', function () {
        expect(this.err).to.not.equal(null);
      });
    });

    describe('with different user identifier (keep requests specific to users)', function () {
      fetchComment('cache-isolation-wat');

      it('does not receive cached data', function () {
        expect(this.err).to.not.equal(null);
      });
    });
  });
});

