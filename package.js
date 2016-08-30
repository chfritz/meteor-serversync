Package.describe({
  name: 'chfritz:serversync',
  version: '0.4.9',
  summary: 'Synchronize collections across multiple meteor servers (belonging to separate apps)',
  git: 'https://github.com/chfritz/meteor-serversync',
  documentation: 'README.md'
});

Package.onUse(function(api) {
  api.versionsFrom('1.3.2.4');
  api.use('ecmascript');
  api.use('underscore');
  api.use('mongo');
  api.use('matb33:collection-hooks@0.8.1');
  api.use('jparker:crypto-md5@0.1.1');
  api.mainModule('main.js');
});

Package.onTest(function(api) {
  api.use('ecmascript');
  api.use('tinytest');
  api.use('chfritz:serversync');
  api.mainModule('serversync-tests.js');
});
