import { Tinytest } from "meteor/tinytest";

import { Mongo } from 'meteor/mongo';
import ServerSyncClient from "meteor/chfritz:serversync";

MyItems = new Mongo.Collection('myitems');

// this test assumes another meteor app is running at port 3100 which
// has an Items collection.

Tinytest.addAsync(
  'offline insertions are added on reconnect in online-write mode', 
  function(test, onComplete) {
    a = new ServerSyncClient("http://localhost:3100", function() {
      a.sync('items', {
        mode: "online-write",
        onReady: function() {
          var coll = a.getCollection('items');
          console.log("wanna be ready", coll.find({}, {reactive: false}).count());

          var remote = a._collections['items'].remote;
          var countBefore = remote.find({}, {reactive: false}).count();

          console.log("disconnect");
          a._connection.disconnect();
          coll.insert({name: "testitem"});
          console.log("reconnect");
          a._connection.reconnect();

          var countAfter = remote.find({}, {reactive: false}).count();
          console.log("before", countBefore, "after", countAfter);
          test.equal(countAfter, countBefore + 1);
          onComplete();
        }
      });
    });

  });


Tinytest.addAsync(
  'offline insertions are overwritten on reconnect in read mode', 
  function(test, onComplete) {
    a = new ServerSyncClient("http://localhost:3100", function() {
      a.sync('items', {
        mode: "read",
        collection: MyItems,
        onReady: function() {
          var coll = a.getCollection('items');
          var remote = a._collections['items'].remote;
          var countBefore = remote.find({}, {reactive: false}).count();

          a._connection.disconnect();
          coll.insert({name: "testitem"});
          a._connection.reconnect();

          var countAfter = remote.find({}, {reactive: false}).count();
          test.equal(countAfter, countBefore);
          onComplete();
        }
      });
    });

  });
