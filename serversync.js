
// Variables exported by this module can be imported by other packages and
// applications. See meteor-serversync-tests.js for an example of importing.
// export const name = 'chfritz:serversync';

/** Server code */
export default class ServerSyncClient {

  /** establish the connection and setup onReconnect handler */
  constructor(URL) {
    const self = this;

    this._connection = DDP.connect(URL);
    this._connection.onReconnect = function() {
      // #HERE: can we update the query of the existing subscriptions
      // to avoid getting a complete re-sync of the entire collection?
      // And/Or implement a remote counter part after all?
      // (ServerSyncServer)
      // there: timestamp all docs with updated time

      console.log("reconnected");
      // Note: on reconnect, Meteor will perform a complete refresh of
      // the remote collections, i.e., it will remove all items and
      // re-add them. This also means that DDP.connect + subscribe are
      // only useful for fairly small collections (in terms of bytes).
      self._syncDirty();
    }

    // objects of the form { remote: .. , local: .., subscription: ..,
    // options: .. }
    this._collections = {};

    // whether or not the initial sync is completed
    this._ready = false;

    // -- sync logging: this is needed in order to break the cycle.
    // ids that have just been updated, i.e., do not sync
    this._changeSets = { remote: {}, local: {} };   
  }



  /** Subscribe to the given remote collection, creating a synced
   * local copy of the result set for the given query */
  sync(collectionName, options = {mode: "online-write"}) {
    const self = this;

    const query = options.query || {};

    this._connection.reconnect();
    if (this._connection.status().connected) {
      console.log("not connected", this._connection.status());
      return false;
    }

    // check(collectionName, String);
    if (_.has(this._collections, collectionName)) {
      console.log("already subscribed to", collectionName);
      return;
    }

    this._collections[collectionName] = {
      options: options
    };

    // remote collection
    const remoteCollection =
      new Mongo.Collection(collectionName, this._connection);
    this._collections[collectionName].remote = remoteCollection;
    // local collection
    let localCollection = null;
    if (options.mode == "read" 
        && options.collection) {

      localCollection = options.collection;
    } else {
      localCollection = new Mongo.Collection(collectionName);
    }
    this._collections[collectionName].local = localCollection;

    const subscription = this._connection.subscribe(collectionName);
    this._collections[collectionName].subcription = subscription;
    
    console.log("ready?", subscription.ready());

    // ---------------------------------------------------------

    // sync down (from remote to local)
    remoteCollection.find(query).observeChanges({

      added(id, fields) {
        if (!self._changeSets.local[id]) {
          var obj = fields;
          obj._id = id;    
          self._changeSets.remote[id] = true;
          localCollection.upsert(id, obj);
          console.log("added by remote");
        } else {
          delete self._changeSets.local[id];
        }
      },

      changed(id, fields) {
        if (!self._changeSets.local[id]) {
          var obj = fields;
          self._changeSets.remote[id] = true;
          localCollection.update(id, obj);
          console.log("changed by remote");
        } else {
          delete self._changeSets.local[id];
        }
      },

      removed(id) {
        if (!self._changeSets.local[id]) {
          self._changeSets.remote[id] = true;
          localCollection.remove(id);
          console.log("removed by remote");
        } else {
          delete self._changeSets.local[id];
        }
      }
    });

    // console.log("ready?", subscription.ready()); 
    // ^not implemented for server-to-server?
    this._ready = true;
    if (options.onReady) {
      options.onReady();
    }

    // ---------------------------------------------------------

    // sync up (from local to remote)
    if (options.mode != "read") {
      localCollection.find().observeChanges({

        added(id, fields) {
          if (!self._changeSets.remote[id]) {
            // this addition was not initiated by remote; sync up remote
            self._changeSets.local[id] = true;
            var obj = fields;
            obj._id = id;

            // only take action if this wasn't just added from remote,
            // indicated by an explicit _dirty = false field;
            if (self._ready && self._connection.status().connected) {
              remoteCollection.upsert(id, obj);
              console.log("added to remote");
            } else {
              // can't sync this right now, add to change set
              self._changeSets.local[id] = { 
                collectionName: collectionName,
                obj: obj
              };
            }
          } else {
            // acknowledged, clear flag for next update
            delete self._changeSets.remote[id];
          }
        },
        
        changed(id, fields) {
          if (!self._changeSets.remote[id]) {
            // this change was not initiated by remote; sync up remote
            self._changeSets.local[id] = true;

            if (self._ready && self._connection.status().connected) {
              var obj = fields;
              // obj._updated = Date.now();
              delete obj._dirty;
              remoteCollection.update(id, obj);
              console.log("changed in remote");
            } else {
              // localCollection.update(id, {$set: {"_dirty": true}});
              console.warn("cannot reach server, not updating;",
                           "local change will be lost on reconnect");
            }
          } else {
            // else either self was just changed remotely, or it was
            // marked dirty by offline insert locally; don't do anything

            // acknowledged, clear flag for next update
            delete self._changeSets.remote[id];
          }
        },

        removed(id) {
          if (!self._changeSets.remote[id]) {
            // this removal was not initiated by remote; sync up remote
            self._changeSets.local[id] = true;

            if (self._ready && self._connection.status().connected) {
              remoteCollection.remove(id);
              console.log("removed in remote");
            } else {
              // queue up for remote deletion
              // self._locallyDeleted.push({
              //   collectionName: collectionName,
              //   id: id
              // });
              console.warn("cannot reach server, not removing;",
                           "local change will be lost on reconnect");
            }
          } else {
            // acknowledged, clear flag for next update
            delete self._changeSets.remote[id];
          }
        }
      });
    }

  }


  /** sync dirty things, but only if not changed remotely */
  _syncDirty() {
    const self = this;
    console.log("_syncDirty");
    
    // locally inserted or changed
    // _.each(this.localCollections, function(localCollection, name) {

    //   var remoteCollection = self.remoteCollections[name];
    //   // TODO: throw error if no remoteCollection (should not happen)

    //   localCollection.find({_dirty: true}, {reactive: false}).forEach(
    //     function(dirtyDocument) {
    //       console.log("upserting remotely:", dirtyDocument);
    //       // update in remote collection         
    //       remoteCollection.upsert(dirtyDocument._id, dirtyDocument);         
    //       // now mark as _dirty: false
    //       localCollection.update(id, {$set: {"_dirty": false}});         
    //     });
    // });

    // locally deleted
    // _.each(this._locallyDeleted, function(deleteInfo) {      
    //   console.log(deleteInfo);

    //   const localCollection = 
    //     self.localCollections[deleteInfo.collectionName];
    //   const remoteCollection = 
    //     self.remoteCollections[deleteInfo.collectionName];

    //   if (deleteInfo.id
    //       && !localCollection.find(deleteInfo.id)
    //      ) {
    //     console.log("removing remotely:", deleteInfo);
    //     // remoteCollection.remove(deleteInfo.id);
    //   } else {
    //     console.log(deleteInfo.collectionName, "document", 
    //                 deleteInfo.id, 
    //                 "has been changed remotely, not deleting");
    //   }
    // });
    // this._locallyDeleted = [];

    _.each(self._changeSets.local, function(changeInfo) {
      const remoteCollection = 
        self._collections[changeInfo.collectionName].remote;
      remoteCollection.insert(changeInfo.obj);
      console.log("added remotely:", changeInfo.obj);
    });


  }

  
  /** get (local) collection by name */
  getCollection(name) {
    return this._collections[name].local;
  }

};

