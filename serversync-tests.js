import { Tinytest } from "meteor/tinytest";

import { Mongo } from 'meteor/mongo';
import ServerSyncClient from "meteor/chfritz:serversync";

Items = new Mongo.Collection('items');

// this test assumes another meteor app is running at port 3100 which
// has an Items collection.
Tinytest.add('meteor-serversync - example', function (test) {

  a = new ServerSyncClient("http://localhost:3100");
  // a = new ServerSyncClient("http://localhost:3000", "online-write");
  // a = new ServerSyncClient("http://localhost:3000", "write");

  a.sync('items', {
    mode: "read",
    collection: Items,
    onReady: function() {
      var coll = a.getCollection('items');
      console.log("ready", coll.find().count());


      var remote = a._collections['items'].remote;
      var countBefore = remote.find().count();
      console.log("countBefore", countBefore);

      a._connection.disconnect();
      coll.insert({name: "testitem"});
      a._connection.reconnect();

      var countAfter = remote.find().count();
      test.equal(countAfter, countBefore + 1);
    }
  });
});
