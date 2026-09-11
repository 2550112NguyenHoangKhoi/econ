package simulation

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/gorilla/websocket"
)

// TestWSWriteSerialisesConcurrentWriters reproduces the crash that took the engine
// down: "panic: concurrent write to websocket connection". A single connection is
// written by the simulation tick, the per-connection command reader and the state
// hub at once. Routing every writer through WSWrite must make that safe.
//
// Against a bare conn.WriteMessage this panics; the panic happens on the writing
// goroutine, so it takes the whole process with it rather than failing one test.
func TestWSWriteSerialisesConcurrentWriters(t *testing.T) {
	upgrader := websocket.Upgrader{}
	var serverConn *websocket.Conn
	ready := make(chan struct{})

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		serverConn = c
		close(ready)
		for {
			if _, _, err := c.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer srv.Close()

	client, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()
	<-ready
	defer serverConn.Close()

	go func() {
		for {
			if _, _, err := client.ReadMessage(); err != nil {
				return
			}
		}
	}()

	const writers, each = 8, 60
	payload := []byte(strings.Repeat("x", 2048))

	var wg sync.WaitGroup
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < each; j++ {
				if err := WSWrite(serverConn, websocket.BinaryMessage, payload); err != nil {
					return // peer gone; not what this test is asserting
				}
			}
		}()
	}
	wg.Wait()
}

// TestWSForgetReleasesLock verifies the lock registry does not grow without bound
// as clients connect and disconnect.
func TestWSForgetReleasesLock(t *testing.T) {
	conn := &websocket.Conn{}
	wsWriteLocks.LoadOrStore(conn, &sync.Mutex{})
	if _, ok := wsWriteLocks.Load(conn); !ok {
		t.Fatal("expected lock to be registered")
	}
	WSForget(conn)
	if _, ok := wsWriteLocks.Load(conn); ok {
		t.Error("expected lock to be dropped after WSForget")
	}
}
