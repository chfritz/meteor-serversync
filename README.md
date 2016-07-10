# ServerSync

This package provides server-to-server syncing of collections. It is
modeled along the lines of what clients do, too, i.e., collections are
locally cached, in case the remote server gets disconnected.

# How it Works

This uses DDP.connect to connect to a remote server and subscribe to
collections on it, but also caches that collection in the local
mongodb. It gracefully handles periods of being disconnected, incl.
syncing local changes back to the remote if they happened while
disconnected, but not if at the same time the document was changed
remotely. This means that the collection is "owned" by the remote
server and any changes made there trump any local changes.

*Note*: make sure to remove the `autopublish` package on the server.
ServerSync only works properly with explicit publications. With
autopublish, the entire collection is resynced on each reconnect which
is undesirable and will overwrite any and all local changes, even when
conflict free with what has (or hasn't) changed on the server.

The package supports multiple modes, specified in the second argument
to the sync function:

- `read`: means that the client never writes to the server. Changes to
  the local copy of the collection will be ignored by the server and
  may be overwritten by the server at any time. In this mode only it
  is possible to provide an existing local collection (in the
  'collection' option) into which all remote documents will be added.
  This is particularly useful well wanting to merge remote collections
  from multiple remote hosts into one (for instance for creating a
  dashboard with data from several application servers).

- `write` (default): In this mode a client can insert new documents
  into the shared collection at any time, and even if these insertions
  happen while disconnected, the new items will get synced to the
  server on reconnect. Updates and removals can also be done while
  offline, but if the server makes changes while offline, these
  changes will overwrite any local changes on reconnect.


## Example

```js
Meteor.startup(() => {
  // connect to master:
  a = new ServerSyncClient("http://localhost:3000");
  a.sync('items', {  // sync the "items" collection from the master
    onReady: function() {
      var coll = a.getCollection('items');
      // do something with this collection (e.g., publish it locally)
      console.log("ready", coll.find().count());
    },
    args: [Date.now()] // arguments to pass to publication function on server
  });
});
```

See https://github.com/chfritz/serversync-example for a full example.
