# ServerSync

This package provides server-to-server syncing of collections. It is
modeled along the lines of what clients do, too, i.e., collections are
locally cached, in case the remote server gets disconnected.

This uses DDP.connect to connect to a remote server and subscribe to
collections on it, but also caches that collection in the local
mongodb. It gracefully handles periods of being disconnected, incl.
syncing local changes back to the remote if they happened while
disconnected, but not if at the same time the document was changed
remotely. This means that the collection is "owned" by the remote
server and any changes made there trump any local changes.

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

- `online-write` (default): In this mode a client can insert new
  documents into the shared collection at any time, and even if these
  insertions happen while disconnected, the new items will get synced
  to the server on reconnect. However, updates and removals can only
  be made while connected. Otherwise they will be ignored by the
  server and may get overwritten (see read-only mode). An error is
  thrown.

- `write` (not yet implemented): In this mode the client can make
  arbitrary changes while offline which will be synced intelligently
  on reconnect. This however requires the server to have
  ServerSyncServer to decorate the documents with time stamps,
  required to determine changes since last sync.
