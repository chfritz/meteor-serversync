/**
    ServerSync Server Code

    TODO:

    - cleanup code: prune history from time to time

*/


import { Meteor } from "meteor/meteor";

const logger = console.log;
// const logger = function(){};

export default class ServerSyncSubscriber {

  constructor() {
    this._history = new Mongo.Collection('_serversync_history');
    this._history._ensureIndex('at');
  }

  /**
      @param foo is the publish function defined by the user as usual,
      but it cannot accept any arguments (they will be ignored);
      everyone is served the same. This could be changed, but then the
      server would need to maintain a separate collection per
      subscriber.
  */
  publish(name, foo) {
    const cursor = foo();

    let initializing = true;
    // observe changes in cursor and store resulting DDP messages in
    // history together with a timestamp of the change
    cursor.observeChanges({
      added(id, fields) {
        if (!initializing) {
          self._history.insert({
            name: name,
            msg: "added",
            id: id,
            fields: fields,
            at: Date.now()
          });
        }
      },
      changed(id, fields) {
        self._history.insert({
          name: name,
          msg: "changed",
          id: id,
          fields: fields,
          at: Date.now()
        });
      },
      removed(id) {
        self._history.insert({
          name: name,
          msg: "removed",
          id: id,
          at: Date.now()
        });
      }
    }); // returns only once initial insertion is done; that's why we
        // have `initializing`
    initializing = false;

    // get first item in history:
    const first = self._history.findOne({}, {sort: {at: 1}});

    /** the actual publish function:

        @param time is the timestamp of the last update the subscriber
        received
    */
    Meteor.publish(name, function(time) {
      const self = this;

      if (time > first.at) {
        // play back the history from the point onwards when subscriber
        // got last update (`time`)
        _.each( self._history.find({ name: name, at: {$gte: time}}).fetch(),
                function(change) {
                  logger("sending change", change);
                  if (change.msg == "added") {
                    self.added(name, change.id, change.fields);
                  } else if (change.msg == "changed") {
                    self.changed(name, change.id, change.fields);
                  } else if (change.msg == "removed") {
                    self.removed(name, change.id);
                  }
                });

        // and then resume with the present:
        cursor.observeChanges({
          added(id, fields) {
            self.added(name, id, fields);
          },
          changed(id, fields) {
            self.changed(name, id, fields);
          },
          removed(id) {
            self.removed(name, id);
          }
        });
        self.ready();

      } else {
        // recorded history doesn't reach back this far, fall back to
        // full sync:
        return cursor;
      }
    });
  }
};
