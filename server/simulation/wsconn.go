package simulation

import (
	"sync"
	"time"

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

// wsWriteTimeout bounds a single frame write.
//
// Without it, WriteMessage blocks for as long as the peer refuses to read: a browser tab
// that was killed, suspended, or simply stopped draining its socket fills the kernel send
// buffer and the write never returns. Because the write happens under this connection's
// mutex, that one dead client then blocks EVERY other writer of the same connection, and
// any caller that fans out across clients stops at the first stalled one — which wedged
// POST /api/building/switch for 30 s with 32 half-dead sockets open, while every other
// endpoint answered in microseconds.
//
// Five seconds is far beyond a healthy client's round trip and still bounds the damage.
// A peer that misses the deadline has a broken connection: the frame is dropped, the
// error is returned, and its reader goroutine tears the client down as it would for any
// other write failure. Dropping a frame to a stalled viewer is always better than
// stalling the engine for everyone else.
const wsWriteTimeout = 5 * time.Second

// WSWrite serialises WriteMessage against all other writers of the same connection.
// Every write to a connection shared between goroutines must go through this.
func WSWrite(conn *websocket.Conn, messageType int, data []byte) error {
	v, _ := wsWriteLocks.LoadOrStore(conn, &sync.Mutex{})
	mu := v.(*sync.Mutex)
	mu.Lock()
	defer mu.Unlock()
	// Deadline set inside the lock: SetWriteDeadline is itself state on the connection,
	// so setting it outside would race with the writer that currently holds the lock.
	_ = conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
	return conn.WriteMessage(messageType, data)
}

// WSForget drops the write lock for a closed connection so the map does not grow
// without bound as clients come and go.
func WSForget(conn *websocket.Conn) {
	wsWriteLocks.Delete(conn)
}
