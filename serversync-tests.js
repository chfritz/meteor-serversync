// Import Tinytest from the tinytest Meteor package.
import { Tinytest } from "meteor/tinytest";

// Import and rename a variable exported by meteor-serversync.js.
import { name as packageName } from "meteor/chfritz:serversync";

// Write your tests here!
// Here is an example.
Tinytest.add('meteor-serversync - example', function (test) {
  test.equal(packageName, "meteor-serversync");
});
