
// Variables exported by this module can be imported by other packages and
// applications. See meteor-serversync-tests.js for an example of importing.
// export const name = 'chfritz:serversync';

/** Server code */
class ServerSync {
  
  constructor(URL) {
    this._connection = DDP.connect(URL);
    this._connection.onReconnect = function() {
      console.log("reconnected");
    }
    this.collections = {};
  }

  /** Subscribe to the given remote collection, creating a synced
   * local copy of the result set for the given query */
  sync(collectionName, query = {}, options = {}) {

    // this._connection.reconnect();
    if (this._connection.status().connected) {
      console.log("not connected", this._connection.status());
      return false;
    }

    // check(collectionName, String);
    if (_.has(this.collections, collectionName)) {
      console.log("already subscribed to", collectionName);
      return;
    }

    // remote collection
    const collection =
      new Mongo.Collection(collectionName, this._connection);
    this.collections[collectionName] = collection;
    // local collection
    const localCollection = new Mongo.Collection(collectionName);
    this.collections[collectionName] = localCollection;

    this._connection.subscribe(collectionName, function() {
      if (options.onReady) {
        options.onReady();
      }
    });

    // sync down (from remote to local)
    collection.find(query).observeChanges({

      added(id, fields) {
        var obj = fields;
        obj._id = id;
        // obj._updated = Date.now();
        localCollection.upsert(id, obj);
        console.log("added");
      },

      changed(id, fields) {
        // The document identified by id has changed. fields contains
        // the changed fields with their new values. If a field was
        // removed from the document then it will be present in fields
        // with a value of undefined.
        var obj = fields;
        // obj._updated = Date.now();
        localCollection.update(id, obj);
      },

      removed(id) {
        // The document identified by id was removed from the result
        // set.
        localCollection.remove(id);
      }
    });


    // sync up (from local to remote)
    localCollection.find().observeChanges({

      added(id, fields) {
        // #HERE: check that we are connected, if not queue it up
        // somehow

        var obj = fields;
        obj._id = id;
        // obj._updated = Date.now();
        collection.upsert(id, obj);
        console.log("added locally");
      },
      
      changed(id, fields) {
        // #HERE: check that we are connected, if not queue it up
        // somehow and only apply if document hasn't changed in
        // between (on remote)

        var obj = fields;
        // obj._updated = Date.now();
        collection.update(id, obj);
      },

      removed(id) {
        // #HERE: check that we are connected, if not queue it up
        // somehow and only apply if document hasn't changed in
        // between (on remote)

        collection.remove(id);
      }
    });

  }
  
  /** get (local) collection by name */
  getCollection(name) {
    return this.collections[name];
  }

};

export default ServerSync;
