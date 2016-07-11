import { Meteor } from "meteor/meteor";
import { DDP } from "meteor/ddp-client";


/** TODO:
    
    - make changeset persistent, so we don't lose the changes if we
      need to stop the app before being able to reconnect?

 */


/** Server code */
export default class ServerSyncClient {

  /** establish the connection and setup onReconnect handler */
  constructor(URL, onConnected) {
    const self = this;

    this._initialized = false;
    this._connection = DDP.connect(URL);
    this._connection.onReconnect = function() {
      console.log("reconnected");

      if (!this._initialized) {
        onConnected && onConnected();
        this._initialized = true;
      } else {
        // Note: on reconnect, Meteor will perform a complete refresh of
        // the remote collections, i.e., it will remove all items and
        // re-add them. This also means that DDP.connect + subscribe are
        // only useful for fairly small collections (in terms of bytes).
        self._rescheduleSyncDirty();
      }
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
    if (options.mode == "read"
        && options.collection) {

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
    const subscription = this._connection.subscribe.apply(this._connection, args);
    this._collections[collectionName].subscription = subscription;

    // ---------------------------------------------------------

    // sync down (from remote to local)
    // each remote change resets the timer for syncDirty
    remoteCollection.find(query).observeChanges({
      added(id, fields) {
        if (self._changeSets.local[id]) {
          // this remote addition just confirms the local addition
        } else {
          if (self._syncDirtyTimeout) {
            self._rescheduleSyncDirty();
          }
          var obj = fields;
          obj._id = id;
          self._changeSets.remote[id] = true;
          localCollection.upsert(id, obj);
          console.log("added by remote");
        }
        delete self._changeSets.local[id];
      },

      changed(id, fields) {
        if (self._changeSets.local[id]
            && self._changeSets.local[id]._synced) {
          // remote confirmed the update
          console.log("ignoring remote update");
        } else {
          if (self._syncDirtyTimeout) {
            self._rescheduleSyncDirty();
          }

          var obj = fields;
          obj._id = id;
          self._changeSets.remote[id] = true;
          // remote changes invalidates local changes:
          if (localCollection.findOne(id)) {
            localCollection.upsert(id, {$set: obj});
          } else {
            // document was removed locally (presumably while
            // offline), recreate it
            localCollection.insert(remoteCollection.findOne(id));
          }
          console.log("changed by remote");
        }
        delete self._changeSets.local[id];
      },

      removed(id) {
        if (self._changeSets.local[id]
            && self._changeSets.local[id]._synced) {
          // remote confirmed removal
          console.log("ignoring remote removal");
        } else {
          if (self._syncDirtyTimeout) {
            self._rescheduleSyncDirty();
          }

          self._changeSets.remote[id] = true;
          // remote changes invalidates local changes:
          console.log("removed by remote");
          localCollection.remove(id);
        }
        delete self._changeSets.local[id];
      }
    });


    // ---------------------------------------------------------

    // sync up (from local to remote)
    if (options.mode != "read") {
      localCollection.find().observeChanges({

        added(id, fields) {
          if (!self._changeSets.remote[id]) {
            // this addition was not initiated by remote; sync up remote
            self._changeSets.local[id] = {
              collectionName: collectionName
            };
            var obj = fields;
            obj._id = id;

            // only sync back up after initial sync down
            if (self._ready) { 
              if (self._connection.status().connected) {
                self._changeSets.local[id]._synced = true;
                remoteCollection.upsert(id, obj);
                console.log("added to remote");
              } else {
                // can't sync this right now, add to change set
                console.log("insert queued until reconnect", id);
                self._changeSets.local[id].obj = obj;
                self._changeSets.local[id].action = "insert";
              }
            }
          } else {
            // acknowledged, clear flag for next update
            delete self._changeSets.remote[id];
          }
        },

        changed(id, fields) {
          if (!self._changeSets.remote[id]) {
            // this change was not initiated by remote; sync up remote
            if (!self._changeSets.local[id]) {
              self._changeSets.local[id] = {
                collectionName: collectionName
              };
            }

            var obj = fields;
            if (self._ready) { 
              if (self._connection.status().connected) {
                // obj._updated = Date.now();
                // delete obj._dirty;
                self._changeSets.local[id]._synced = true;
                remoteCollection.upsert(id, {$set: obj});
                console.log("changed in remote");
              } else {
                // localCollection.update(id, {$set: {"_dirty": true}});
                // console.warn("cannot reach server, not updating;",
                // "local change will be lost on reconnect");
                console.log("update queued until reconnect", id);
                if (!self._changeSets.local[id].obj) {
                  self._changeSets.local[id].obj = {};
                }
                _.extend(self._changeSets.local[id].obj, obj);
                self._changeSets.local[id].action = "update"; // may overwrite "insert"
              }
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
            self._changeSets.local[id] = {
              collectionName: collectionName
            }; // this will overwrite any updates or inserts, but that's OK

            if (self._ready) { 
              if (self._connection.status().connected) {
                self._changeSets.local[id]._synced = true;
                remoteCollection.remove(id);
                console.log("removed in remote");
              } else {
                // queue up for remote deletion
                // self._locallyDeleted.push({
                //   collectionName: collectionName,
                //   id: id
                // });
                // console.warn("cannot reach server, not removing;",
                // "local change will be lost on reconnect");
                console.log("removal queued until reconnect", id);
                self._changeSets.local[id].action = "remove";
              }
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

    console.log("_syncDirty", self._changeSets.local);
    // console.log("_syncDirty");

    _.each(self._changeSets.local, function(changeInfo, id) {

      if (changeInfo._synced) {
        // why does this happen?
        return;
      }

      changeInfo._synced = true;
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
          });
        } else if (changeInfo.action == "update") {
          remoteCollection.upsert(id, {$set: changeInfo.obj}, function(err, res) {
            console.log("update local -> remote:", id, err, res);
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
