/** 
    ServerSync Server Code


    TODO:
    
    - cleanup code: prune history from time to time


*/


import { Meteor } from "meteor/meteor";

const logger = console.log;
// const logger = function(){};

export default class ServerSyncServer {

  constructor() {
    this._history = new Mongo.Collection('_serversync_history');
    this._history._ensureIndex('at');
    this._subscribers = new Mongo.Collection('_serversync_subscribers');
  }

  /** 
      @param foo is the publish function defined by the user as usual
  */
  publish(name, foo) {
    /** the actual publish function: 
       
        @param id is a uniq but persistent id for the client
    */
    Meteor.publish(name, function(id) {
      const self = this;

      const cursor = foo.apply(arguments);
      
      // observe changes in cursor and store resulting DDP messages in
      // history together with a timestamp of the change
      let initializing = true;
      const handle = cursor.observeChanges({
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
      });
      initializing = false;


      // make sure we have a subscriber object
      let subscriber = self._subscribers.findOne(id);
      if (!subscriber) {
        subscriber = {_id: id, time: 0};
        self._subscribers.insert(subscriber);
      }
      
      // play back the history from the point onwards when subscriber
      // got last update
      _.each( self._history.find({ name: name, at: {$gte: subscriber.time}}).fetch(),
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
      self.ready();
     
      self.onStop(function () {
        handle.stop();
      });
    });
  }

}
