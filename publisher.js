/**
    ServerSync Server Code

    TODO:

    - cleanup code: prune history from time to time

    - maybe replace "at" time stamp with patch counter to account for
      same-time items (whose application order cannot be guaranteed on
      the client)
*/


import { Meteor } from "meteor/meteor";

const HASH_DELAY = 10000; // insert hashes HASH_DELAY seconds after
                          // last patch insert

const logger = console.log;
// const logger = function(){};

export default class ServerSyncPublisher {

  /** Maybe: add a name so that several independen sets of collections
   * can be synced */
  constructor() {
    const self = this;

    this._patches = new Mongo.Collection('serversync_patches');
    this._patches._ensureIndex('at');
    // this._subscribers = new Mongo.Collection('serversync_subscribers');

    this._collections = [];

    // create a debounced function for inserting commit hashes exactly
    // once N seconds after the last insertion
    const addCommit = _.debounce(function(userId, obj) {
      const md5 = self.getHash();     
      this._patches.direct.insert({
        type: "commit",
        hash: md5,
        at: Date.now()
      });
    }, HASH_DELAY);

    this._patches.after.insert(addCommit);
  }

  /**
      @param foo is the publish function defined by the user as usual,
      but it cannot accept any arguments (they will be ignored);
      everyone is served the same. This could be changed, but then the
      server would need to maintain a separate collection per
      subscriber.
  */
  publish(collectionName, foo) {
    const self = this;
    const cursor = foo();
    this._collections.push({
      collectionName: collectionName,
      cursor: foo
    });

    let initializing = true;
    // observe changes in cursor and store resulting patches together
    // with a timestamp of the change
    cursor.observeChanges({
      added(id, fields) {
        if (!initializing) {
          self._patches.insert({
            collectionName: collectionName,
            type: "added",
            id: id,
            fields: fields,
            at: Date.now()
          });
        }
      },
      changed(id, fields) {
        self._patches.insert({
          collectionName: collectionName,
          type: "changed",
          id: id,
          fields: fields,
          at: Date.now()
        });
      },
      removed(id) {
        self._patches.insert({
          collectionName: collectionName,
          type: "removed",
          id: id,
          at: Date.now()
        });
      }
    }); // returns only once initial insertion is done; that's why we
        // have `initializing`
    initializing = false;

    // get first item in patches:
    // const first = self._patches.findOne({}, {sort: {at: 1}});

    /** the actual publish function:

        @param since: the timestamp of the last checksum the
        subscriber received and applied locally
    */
    Meteor.publish("_serversync_patches", function(since) {
      return self._patches.find({at: {$gt: since}});
    });
  }

  /** compute joint md5 of all collections in the sync */
  _getHash() {
    const self = this;
    const wholeJSON = 
      _.reduce(
        _.map(self._collections, function(collection) {
          return JSON.stringify(collection.cursor().fetch());
        }), function(memo, collectionJSON) {
          return memo + collectionJSON;
        }, "");
    return CryptoJS.MD5(wholeJSON);
  }
};
