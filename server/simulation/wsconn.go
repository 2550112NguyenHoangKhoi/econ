package simulation

import (
	"sync"

	"github.com/gorilla/websocket"
)

// gorilla/websocket permits only one concurrent writer per connection and panics
// ("concurrent write to websocket connection") rather than emit a corrupt frame.
// A single connection here is written by at least three independent goroutines:
// the simulation tick's telemetry broadcast, the per-connection reader answering
// commands, and the state hub fanning out toggle updates. None of them can know
// about the others, so the serialisation has to live with the connection itself.
//
// The mutex is keyed off the connection rather than wrapping it so that every
// existing *websocket.Conn call site can be converted in place, without threading
// a new type through the engine, the HTTP handlers and the state hub.
var wsWriteLocks sync.Map // *websocket.Conn -> *sync.Mutex

// WSWrite serialises WriteMessage against all other writers of the same connection.
// Every write to a connection shared between goroutines must go through this.
func WSWrite(conn *websocket.Conn, messageType int, data []byte) error {
	v, _ := wsWriteLocks.LoadOrStore(conn, &sync.Mutex{})
	mu := v.(*sync.Mutex)
	mu.Lock()
	defer mu.Unlock()
	return conn.WriteMessage(messageType, data)
}

// WSForget drops the write lock for a closed connection so the map does not grow
// without bound as clients come and go.
func WSForget(conn *websocket.Conn) {
	wsWriteLocks.Delete(conn)
}
