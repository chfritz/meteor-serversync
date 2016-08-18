import { Meteor } from "meteor/meteor";
import { DDP } from "meteor/ddp-client";

const logger = console.log;
// const logger = function(){};

/** the local change set, i.e., things that have changed locally but
    have not yet been synced up, e.g., because we were/are offline */
let ChangeSet = new Mongo.Collection('_serversync_change-set');

/** set of remote changes, stored here for batch application to local
    collection once sync is complete */
let remoteChanges = [];

/** Server code */
export default class ServerSyncClient {

  /** establish the connection and setup onReconnect handler 
      @param options:
      - onConnect: a function to be called upon initial connection
      - onReconnect: a function to be called upon reconnect
      - beforeSyncDirty: a function to be called before syncing
        offline changes
      - afterSyncDirty: a function to be called after syncing
        offline changes

  */
  constructor(URL, options) {
    const self = this;

    this._initialized = false;
    this._connection = DDP.connect(URL);
    // this._connection.call("", function(e, r) {
    //   console.log("fake method call", e, r);
    // });
    this._options = options;
    this._connection.onReconnect = function() {
      logger("reconnected");

      if (!self._initialized) {
        options.onConnect && options.onConnect();

        // always clean the local collection before joining the sync,
        // otherwise we won't get destructive changes the master made
        // while we weren't running
        _.each(self._collections, function(collectionSet, name) {
          logger("clearing collection", name);
          collectionSet.local.direct.remove({});
        });

        self._initialized = true;
      } else {
        options.onReconnect && options.onReconnect();
      }

      // self._connection.call("", function(e, r) {
      //   logger("sync complete");
        
      //   // apply remote changes to local before applying local changes
      //   // to remote (they may overwrite local changes)
      //   self._applyChanges();
        
      //   // apply local change (to remote)
      //   self._syncDirty();
      // });
        
      self._rescheduleSyncDirty();
    }

    // We are impatient: forcing a higher rate of reconnection
    // attempts when unable to reach master
    Meteor.setInterval(function() {
      if (self._connection.status().status == "waiting") {
        self._connection.reconnect();
      }
    }, 10000);


    /** 
        for each sync we have one object of the form
        { 
          remote: .. , 
          local: .., 
          subscription: ..,
          options: .. 
        }
    */
    this._collections = {};

    // whether or not the initial sync is completed
    this._ready = false;
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
      - beforeSyncUp: a function to be called before syncing up
      - beforeSyncDown: a function to be called before syncing down
      - afterSyncUp: a function to be called after syncing up
      - afterSyncDown: a function to be called after syncing down
  */
  sync(collectionName, options = {mode: "write", args: []}) {
    const self = this;

    const query = options.query || {};

    this._connection.reconnect();

    // check(collectionName, String);
    if (_.has(this._collections, collectionName)) {
      logger("already subscribed to", collectionName);
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
        logger("onReady", collectionName);
        self._ready = true;
        options.onReady && options.onReady();
        collectionName && self._syncDirty(collectionName);
      },
      onError: function(e) {
        logger("onError", e);
      },
      onStop: function(e) {
        logger("onStop", e);
      }
    });
    const subscription = 
      this._connection.subscribe.apply(this._connection, args);
    this._collections[collectionName].subscription = subscription;
    this._collections[collectionName].options = options;
    const collectionSet = this._collections[collectionName];

    // ---------------------------------------------------------

    let syncInProgress = false;
    /** put a marker in the DDP pipe by calling a non-existant method.
        This will be put in the queue on the server and tell us when
        the current batch of messages is done (which will be once the
        callback comes back).
    */
    function placeMarker() {
      if (!syncInProgress) {
        self._connection.call("", function(e, r) {
          logger("sync complete");       
          // apply remote changes to local before applying local changes
          // to remote (they may overwrite local changes)
          self._applyChanges();
          syncInProgress = false;

          // we can now also apply local changes to remote, since we
          // know that sync down is done; no need to wait for timeout
          self._syncDirty();
        });
        syncInProgress = true;

        // now that sync down has started we can use the DPP pipe
        // marker to indicate when it is safe to sync up, remove timer
        if (self._syncDirtyTimeout) {
          Meteor.clearTimeout(self._syncDirtyTimeout);
          this._syncDirtyTimeout = null;
        }
      }
    }

    // sync down (from remote to local)
    // each remote change resets the timer for syncDirty
    remoteCollection.find(query).observeChanges({
      added(id, fields) {
        if (ChangeSet.findOne(id)) {
          // this remote addition just confirms the local addition
          ChangeSet.remove(id);
        } else {
          if (self._syncDirtyTimeout) {
            self._rescheduleSyncDirty();
            // TODO: replace this by sync-done marker
          }
          var obj = fields;
          obj._id = id;
          placeMarker();
          remoteChanges.push({
            collectionName: collectionName,
            action: "insert",
            _id: id, 
            obj: obj,
            options: options
          });
        }
      },

      changed(id, fields) {
        const change = ChangeSet.findOne(id);
        // if (fields._updated) {
        //   // our marker has come back, this batch of DDP messages is done
        //   logger("sync complete");
        //   syncInProgress = false;
        //   self._applyChanges();
        // } else 
        if (change && change._synced) {
          // remote confirmed the update
          logger("ignoring remote update");
          ChangeSet.remove(id);

        } else {
          if (self._syncDirtyTimeout) {
            self._rescheduleSyncDirty();
          }

          var obj = fields;
          obj._id = id;
          placeMarker();
          remoteChanges.push({
            collectionName: collectionName,
            action: "update",
            _id: id, 
            obj: obj,
            options: options
          });
        }
      },

      removed(id) {
        const change = ChangeSet.findOne(id);
        if (change && change._synced) {
          // remote confirmed removal
          logger("ignoring remote removal");
          ChangeSet.remove(id);
        } else {
          if (self._syncDirtyTimeout) {
            self._rescheduleSyncDirty();
          }

          placeMarker();
          remoteChanges.push({
            collectionName: collectionName,
            action: "remove",
            _id: id,
            options: options
          });
        }
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
          logger("local insertion of ", id);

          let change = {
            collectionName: collectionName
          };
          // only sync back up after initial sync down
          if (self._ready 
              && self._connection.status().connected) {
            
            change._synced = true;
            ChangeSet.upsert(id, change);
            options.beforeSyncUp && options.beforeSyncUp("insert", id, obj);
            remoteCollection.upsert(id, obj);
            options.afterSyncUp && options.afterSyncUp("insert", id, obj);
            logger("added to remote");
          } else {
            // can't sync this right now, add to change set
            logger("insert queued until reconnect", id);
            change.obj = obj;
            change.action = "insert";
            ChangeSet.upsert(id, change);
          }       
        });

      localCollection.after.update( 
        function(userId, doc, fieldNames, modifier, update_options) {
          const id = doc._id;
          logger("local update to ", id, doc, fieldNames, 
                 modifier, update_options);

          // there may already be a prior change in this id
          let change = ChangeSet.findOne(id);
          if (!change) {
            change = {
              collectionName: collectionName
            };
          }

          var obj = _.pick(doc, fieldNames);
          if (self._ready) {
            if (self._connection.status().connected) {
              change._synced = true;
              ChangeSet.upsert(id, change);
              options.beforeSyncUp && options.beforeSyncUp("update", id, obj);
              remoteCollection.upsert(id, {$set: obj});
              options.afterSyncUp && options.afterSyncUp("update", id, obj);
              logger("changed in remote");
            } else {
              logger("update queued until reconnect", id);
              if (!change.obj) {
                change.obj = {};
              }
              _.extend(change.obj, obj);
              change.action = "update"; // may overwrite "insert"
              ChangeSet.upsert(id, change);
            }
          } else {
            // we have not yet connected to master, but we have
            // inserted this document earlier (and potentially
            // already updated it, too), so it's OK to edit
            if (change && change.action ) {
              logger("updated newly inserted item", id);
              _.extend(change.obj, obj);
              change.action = "update"; // may overwrite "insert"
              ChangeSet.upsert(id, change);
            }
          }
        });

      localCollection.after.remove(
        function(userId, doc) {
          const id = doc._id;
          logger("local removal of ", id);

          let change = {
            collectionName: collectionName
          }; // this will overwrite any updates or inserts, but that's OK

          if (self._ready) { 
            if (self._connection.status().connected) {
              change._synced = true;
              ChangeSet.upsert(id, change);
              options.beforeSyncUp && options.beforeSyncUp("remove", id, doc);
              remoteCollection.remove(id);
              options.afterSyncUp && options.afterSyncUp("remove", id, doc);
              logger("removed in remote");
            } else {
              logger("removal queued until reconnect", id);
              change.action = "remove";
              ChangeSet.upsert(id, change);            
            }
          }
        });
    }
  }


  /** Batch apply all remote changes. This is called when sync down is
      complete. Batching is necessary to ensure sync atomicity, i.e.,
      avoid partial syncs. This can be important when changes in two
      documents or collections need to happen simultaneous, e.g., to
      ensure data consistency */
  _applyChanges() {
    logger("starting applyChanges");
    const self = this;

    _.each(remoteChanges, function(change) {
      const localCollection = self._collections[change.collectionName].local;
      const options = change.options;

      options.beforeSyncDown 
        && options.beforeSyncDown(change.action, change._id, change.obj);

      if (change.action == "insert") {
        localCollection.direct.upsert(change._id, change.obj);

      } else if (change.action == "update") {

        // remote changes invalidates local changes:
        const localChange = ChangeSet.findOne(change._id);
        if (localCollection.findOne(change._id)) {
          if (localChange) {
            // we made local changes as well; overwrite the object
            // completely (don't just patch it)
            let obj = remoteCollection.findOne(change._id);
            localCollection.direct.upsert(change._id, obj);
          } else {
            delete change.obj._id;
            localCollection.direct.upsert(change._id, {$set: change.obj});
          }
        } else {
          // document was removed locally (presumably while
          // offline), recreate it completely (not just the change)
          localCollection.direct.insert(remoteCollection.findOne(change._id));
        }

      } else if (change.action == "remove") {
        // remote changes invalidates local changes:
        localCollection.direct.remove(change._id);
      }

      options.afterSyncDown 
        && options.afterSyncDown(change.action, change._id, change.obj);


      logger(change.action, ": remote -> local");
      ChangeSet.remove(change._id);
    });

    remoteChanges = [];
    logger("applyChanges done");
  }


  /** sync any offline changes that were not overwritten by remote up
      to master */
  _syncDirty(collectionName) {

    if (this._syncDirtyTimeout) {
      Meteor.clearTimeout(this._syncDirtyTimeout);
      this._syncDirtyTimeout = null;
    }  

    if (!this._connection.status().connected) {
      console.warn("(serversync) _syncDirty failed;",
                   "lost connection again before we could sync",
                   this._connection.status());
      return;
    }

    const self = this;
    logger("_syncDirty", ChangeSet.find().fetch());
    const numberOfChanges = ChangeSet.find().count(); 
    this._options.beforeSyncDirty 
      && this._options.beforeSyncDirty(numberOfChanges);

    _.each(ChangeSet.find().fetch(), function(changeInfo) {
      const id = changeInfo._id;

      if (changeInfo._synced) {
        // why does this happen?
        ChangeSet.remove(id);
        return;
      }

      ChangeSet.update(id, {$set: { _synced: true }});
      // ^ we need to mark this changeInfo as sync, so we can
      // recognize it when remote confirms it

      if (changeInfo.collectionName == collectionName
          || collectionName == undefined) {

        const remoteCollection =
          self._collections[changeInfo.collectionName].remote;
        const options = 
          self._collections[changeInfo.collectionName].options;

        options.beforeSyncUp 
          && options.beforeSyncUp(changeInfo.action, id, changeInfo.obj);

        if (changeInfo.action == "insert") {
          remoteCollection.upsert(id, changeInfo.obj, function(err, res) {
            logger("insert local -> remote:", id, err, res);
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
              logger("update local -> remote:", id, err, res);
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
            logger("removed local -> remote:", id, err, res);
          });
        }

        options.afterSyncUp 
          && options.afterSyncUp(changeInfo.action, id, changeInfo.obj);
      }
    });

    this._options.afterSyncDirty 
      && this._options.afterSyncDirty(numberOfChanges);
  }


  /** get (local) collection by name */
  getCollection(name) {
    return this._collections[name].local;
  }

};
