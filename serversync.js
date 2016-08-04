import { Meteor } from "meteor/meteor";
import { DDP } from "meteor/ddp-client";


/** TODO:
    
    - make changeset persistent, so we don't lose the changes if we
      need to stop the app before being able to reconnect?

 */
let changeSet = new Mongo.Collection('_serversync_change-set');


/** Server code */
export default class ServerSyncClient {

  /** establish the connection and setup onReconnect handler */
  constructor(URL, onConnected) {
    const self = this;

    this._initialized = false;
    this._connection = DDP.connect(URL);
    this._connection.onReconnect = function() {
      console.log("reconnected");

      if (!self._initialized) {
        onConnected && onConnected();

        // always clean the local collection before joining the sync,
        // otherwise we won't get destructive changes the master made
        // while we weren't running
        _.each(self._collections, function(collectionSet, name) {
          console.log("clearing collection", name);
          collectionSet.local.direct.remove({});
        });

        self._initialized = true;
      } 

      self._rescheduleSyncDirty();
    }

    // We are impatient: forcing a higher rate of reconnection
    // attempts when unable to reach master
    Meteor.setInterval(function() {
      if (self._connection.status().status == "waiting") {
        self._connection.reconnect();
      }
    }, 10000);


    // objects of the form { remote: .. , local: .., subscription: ..,
    // options: .. }
    this._collections = {};

    // whether or not the initial sync is completed
    this._ready = false;

    // -- sync logging: this is needed in order to break the cycle.
    // ids that have just been updated, i.e., do not sync
    // this._changeSets = { remote: {}, local: {} };
  }

  /** schedule a syncDirty for some time from now, if it is already
      scheduled, reschedule. Each remote reschedules this. This way we
      won't syncDirty while changes are still coming in. TODO: This is
      a bit of a #hack. It would be better to have a signal when the
      sync from server is all caught up.
  */
  _rescheduleSyncDirty() {
    const self = this;
    if (this._syncDirtyTimeout) {
      Meteor.clearTimeout(this._syncDirtyTimeout);
    }
    this._syncDirtyTimeout = Meteor.setTimeout(function() {
      self._syncDirty();
    }, 2000);
  }

  /** Subscribe to the given remote collection, creating a synced
      local copy of the result set for the given query.
      @param collectionName: name of publication to sync with
      @param options: an object containing:
      - mode: "write" (default), or "read"
      - args: subscription arguments (as given to Meteor.subscribe(.., args))
      - onReady: a callback function for when the subscription becomes
        ready (initial sync is complete)
  */
  sync(collectionName, options = {mode: "write", args: []}) {
    const self = this;

    const query = options.query || {};

    this._connection.reconnect();

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
    if (options.collection) {
      localCollection = options.collection;
    } else {
      localCollection = new Mongo.Collection(collectionName);
    }
    this._collections[collectionName].local = localCollection;

    // add subscription arguments
    let args = options.args || [];
    args.unshift(collectionName);
    args.push({
      onReady: function() {
        console.log("onReady", collectionName);
        self._ready = true;
        if (options.onReady) {
          options.onReady();
        }

        collectionName && self._syncDirty(collectionName);
      },
      onError: function(e) {
        console.log("onError", e);
      },
      onStop: function(e) {
        console.log("onStop", e);
      }
    });
    const subscription = 
      this._connection.subscribe.apply(this._connection, args);
    this._collections[collectionName].subscription = subscription;
    const collectionSet = this._collections[collectionName];

    // ---------------------------------------------------------

    // sync down (from remote to local)
    // each remote change resets the timer for syncDirty
    remoteCollection.find(query).observeChanges({
      added(id, fields) {
        if (changeSet.findOne(id)) {
          // this remote addition just confirms the local addition
        } else {
          if (self._syncDirtyTimeout) {
            self._rescheduleSyncDirty();
          }
          var obj = fields;
          obj._id = id;
          localCollection.direct.upsert(id, obj);
          console.log("added by remote");
        }
        changeSet.remove(id);
      },

      changed(id, fields) {
        const change = changeSet.findOne(id);
        if (change && change._synced) {
          // remote confirmed the update
          console.log("ignoring remote update");
        } else {
          if (self._syncDirtyTimeout) {
            self._rescheduleSyncDirty();
          }

          var obj = fields;
          obj._id = id;
          // remote changes invalidates local changes:
          if (localCollection.findOne(id)) {
            if (change) {
              // we made local changes as well; overwrite the object
              // completely (don't just patch it)
              localCollection.direct.upsert(
                id, remoteCollection.findOne(id));
            } else {
              localCollection.direct.upsert(id, {$set: obj});
            }
          } else {
            // document was removed locally (presumably while
            // offline), recreate it completely (not just the change)
            localCollection.direct.insert(remoteCollection.findOne(id));
          }
          console.log("changed by remote");
        }
        changeSet.remove(id);
      },

      removed(id) {
        const change = changeSet.findOne(id);
        if (change && change._synced) {
          // remote confirmed removal
          console.log("ignoring remote removal");
        } else {
          if (self._syncDirtyTimeout) {
            self._rescheduleSyncDirty();
          }

          // remote changes invalidates local changes:
          console.log("removed by remote");
          localCollection.direct.remove(id);
        }
        changeSet.remove(id);
      }
    });


    // ---------------------------------------------------------

    // sync up (from local to remote)
    if (options.mode != "read") {

      // Local changes are noted using hooks. Note that this means
      // that direct changes to the DB, e.g., via mongorestore, will
      // not be synced.
      localCollection.after.insert( 
        function(userId, obj) {
          const id = obj._id;
          console.log("local insertion of ", id);

          let change = {
            collectionName: collectionName
          };
          // only sync back up after initial sync down
          if (self._ready 
              && self._connection.status().connected) {
            
            change._synced = true;
            changeSet.upsert(id, change);
            remoteCollection.upsert(id, obj);
            console.log("added to remote");
          } else {
            // can't sync this right now, add to change set
            console.log("insert queued until reconnect", id);
            change.obj = obj;
            change.action = "insert";
            changeSet.upsert(id, change);
          }       
        });

      localCollection.after.update( 
        function(userId, doc, fieldNames, modifier, options) {
          const id = doc._id;
          console.log("local update to ", id, doc, fieldNames, 
                      modifier, options);

          // there may already be a prior change in this id
          let change = changeSet.findOne(id);
          if (!change) {
            change = {
              collectionName: collectionName
            };
          }

          var obj = _.pick(doc, fieldNames);
          if (self._ready) {
            if (self._connection.status().connected) {
              change._synced = true;
              changeSet.upsert(id, change);
              remoteCollection.upsert(id, {$set: obj});
              console.log("changed in remote");
            } else {
              console.log("update queued until reconnect", id);
              if (!change.obj) {
                change.obj = {};
              }
              _.extend(change.obj, obj);
              change.action = "update"; // may overwrite "insert"
              changeSet.upsert(id, change);
            }
          } else {
            // we have not yet connected to master, but we have
            // inserted this document earlier (and potentially
            // already updated it, too), so it's OK to edit
            if (change && change.action ) {
              console.log("updated newly inserted item", id);
              _.extend(change.obj, obj);
              change.action = "update"; // may overwrite "insert"
              changeSet.upsert(id, change);
            }
          }
        });

      localCollection.after.remove(
        function(userId, doc) {
          const id = doc._id;
          console.log("local removal of ", id);

          let change = {
            collectionName: collectionName
          }; // this will overwrite any updates or inserts, but that's OK

          if (self._ready) { 
            if (self._connection.status().connected) {
              change._synced = true;
              changeSet.upsert(id, change);            
              remoteCollection.remove(id);
              console.log("removed in remote");
            } else {
              console.log("removal queued until reconnect", id);
              change.action = "remove";
              changeSet.upsert(id, change);            
            }
          }          
        });
    }
  }


  /** sync dirty things up to master, but only if not changed remotely */
  _syncDirty(collectionName) {
    if (this._syncDirtyTimeout) {
      Meteor.clearTimeout(this._syncDirtyTimeout);
      this._syncDirtyTimeout = null;
    }  

    if (!this._connection.status().connected) {
      console.warn("syncDirty failed;",
                   "lost connection again before we could sync",
                   this._connection.status());
      return;
    }

    const self = this;

    // wait for heartbeat:
    // console.log("connection", self._connection);
    // const heartbeat = this._connection._heartbeat;
    // if (!heartbeat) {
    //   Meteor.setTimeout(function() {
    //     // console.log("delayed connection", self._connection);
    //     console.log("waiting for master heartbeat", heartbeat);
    //     self._syncDirty(collectionName);
    //   }, 2000);
    // }

    console.log("_syncDirty", changeSet.find().fetch());
    // console.log("_syncDirty");

    _.each(changeSet.find().fetch(), function(changeInfo) {
      const id = changeInfo._id;

      if (changeInfo._synced) {
        // why does this happen?
        changeSet.remove(id);
        return;
      }

      changeSet.update(id, {$set: { _synced: true }});
      // ^ we need to mark this changeInfo as sync, so we can
      // recognize it when remote confirms it

      // console.log("_syncDirty one", changeInfo, collectionName);
      if (changeInfo.collectionName == collectionName
          || collectionName == undefined) {

        const remoteCollection =
          self._collections[changeInfo.collectionName].remote;

        if (changeInfo.action == "insert") {
          remoteCollection.upsert(id, changeInfo.obj, function(err, res) {
            console.log("insert local -> remote:", id, err, res);
            const localCollection =
              self._collections[changeInfo.collectionName].local;
            if (!localCollection.findOne(id)) {
              // this item was removed locally, due to initial clean
              // up; re-add it
              localCollection.upsert(id, changeInfo.obj);
            }
          });

        } else if (changeInfo.action == "update") {
          remoteCollection.upsert(
            id, {$set: changeInfo.obj}, function(err, res) {
              console.log("update local -> remote:", id, err, res);
              const localCollection =
                self._collections[changeInfo.collectionName].local;
              if (!localCollection.findOne(id)) {
                // this item was removed locally, due to initial clean
                // up; re-add it
                localCollection.upsert(id, remoteCollection.findOne(id));
              }
            });
          
        } else if (changeInfo.action == "remove") {
          remoteCollection.remove(id, function(err, res) {
            console.log("removed local -> remote:", id, err, res);
          });
        }
      }
    });


  }


  /** get (local) collection by name */
  getCollection(name) {
    return this._collections[name].local;
  }

};
