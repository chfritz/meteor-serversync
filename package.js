Package.describe({
  name: 'chfritz:serversync',
  version: '0.0.1',
  summary: 'Synchronize collections across multiple meteor servers (belonging to separate apps)',
  git: 'https://github.com/chfritz/meteor-serversync',
  // By default, Meteor will default to using README.md for documentation.
  // To avoid submitting documentation, set this field to null.
  documentation: 'README.md'
});

Package.onUse(function(api) {
  api.versionsFrom('1.3.2.4');
  api.use('ecmascript');
  api.mainModule('serversync.js');
});

Package.onTest(function(api) {
  api.use('ecmascript');
  api.use('tinytest');
  api.use('serversync');
  api.mainModule('serversync-tests.js');
});
