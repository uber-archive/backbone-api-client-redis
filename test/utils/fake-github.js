// Create an eight-track proxy in front of GitHub
var assert = require('assert');
var http = require('http');
var eightTrack = require('eight-track');

// Methods to setup/teardown fake GitHub server
exports.start = function (fn) {
  fn(function startServer () {
    assert(!this.server, 'FakeGithub expected `this.server` to not be defined but it was. This is probably due to not terminating another server. Please do that.');
    this.server = http.createServer(eightTrack({
      url: 'https://api.github.com',
      fixtureDir: __dirname + '/../fixtures/github'
    }));
    this.server.listen(1337);
  });
};
exports.stop = function (fn) {
  fn(function stopServer (done) {
    this.server.close(done);
    delete this.server;
  });
};

// Helper to setup and teardown all at once
exports.run = function () {
  exports.start(before);
  exports.stop(after);
};
