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



