import { Meteor } from "meteor/meteor";
import { DDP } from "meteor/ddp-client";

// const logger = console.log;
const logger = function(){};

let ChangeSet = new Mongo.Collection('_serversync_change-set');


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

    // sync down (from remote to local)
    // each remote change resets the timer for syncDirty
    remoteCollection.find(query).observeChanges({
      added(id, fields) {
        if (ChangeSet.findOne(id)) {
          // this remote addition just confirms the local addition
        } else {
          if (self._syncDirtyTimeout) {
            self._rescheduleSyncDirty();
          }
          var obj = fields;
          obj._id = id;
          options.beforeSyncDown && options.beforeSyncDown("insert", id, obj);
          localCollection.direct.upsert(id, obj);
          options.afterSyncDown && options.afterSyncDown("insert", id, obj);
          logger("added by remote");
        }
        ChangeSet.remove(id);
      },

      changed(id, fields) {
        const change = ChangeSet.findOne(id);
        if (change && change._synced) {
          // remote confirmed the update
          logger("ignoring remote update");
        } else {
          if (self._syncDirtyTimeout) {
            self._rescheduleSyncDirty();
          }

          var obj = fields;
          obj._id = id;
          options.beforeSyncDown && options.beforeSyncDown("update", id, obj);
          // remote changes invalidates local changes:
          if (localCollection.findOne(id)) {
            if (change) {
              // we made local changes as well; overwrite the object
              // completely (don't just patch it)
              let obj = remoteCollection.findOne(id);
              localCollection.direct.upsert(id, obj);
            } else {
              delete obj._id;
              localCollection.direct.upsert(id, {$set: obj});
            }
          } else {
            // document was removed locally (presumably while
            // offline), recreate it completely (not just the change)
            localCollection.direct.insert(remoteCollection.findOne(id));
          }
          options.afterSyncDown && options.afterSyncDown("update", id, obj);
          logger("changed by remote");
        }
        ChangeSet.remove(id);
      },

      removed(id) {
        const change = ChangeSet.findOne(id);
        if (change && change._synced) {
          // remote confirmed removal
          logger("ignoring remote removal");
        } else {
          if (self._syncDirtyTimeout) {
            self._rescheduleSyncDirty();
          }

          // remote changes invalidates local changes:
          logger("removed by remote");
          options.beforeSyncDown && options.beforeSyncDown("remove", id);
          localCollection.direct.remove(id);
          options.afterSyncDown && options.afterSyncDown("remove", id);
        }
        ChangeSet.remove(id);
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
