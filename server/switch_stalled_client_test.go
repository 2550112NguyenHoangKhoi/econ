package main

import (
	"bytes"
	"econ/simulation"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

// TestBuildingSwitch_NotBlockedByStalledWebsocketClient reproduces a regression that made
// POST /api/building/switch hang for 30 s.
//
// The handler persists the new model and tells the other dashboards about it. That
// broadcast writes to every registered websocket connection, and a websocket write blocks
// for as long as the peer refuses to read. A browser tab that was killed — or 32 of them,
// which is what a morning of testing leaves behind — fills its socket buffer and never
// drains it, so the fan-out stopped on the first dead client and the HTTP reply never
// came, while every other endpoint answered in microseconds.
//
// The test stands up a real TCP peer that completes the connection and then reads
// NOTHING, registers it with the state hub, and asserts the switch still answers
// promptly.
func TestBuildingSwitch_NotBlockedByStalledWebsocketClient(t *testing.T) {
	engine := simulation.NewEngine()
	store := NewStateStore(filepath.Join(t.TempDir(), "dashboard-state.json"), nil)
	handler := buildingSwitchHandler(engine, store)

	// A peer that accepts bytes into its buffer and never reads them.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	accepted := make(chan net.Conn, 1)
	go func() {
		c, err := ln.Accept()
		if err == nil {
			accepted <- c // deliberately never Read from
		}
	}()

	client, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()
	select {
	case c := <-accepted:
		defer c.Close()
	case <-time.After(2 * time.Second):
		t.Fatal("peer never accepted")
	}

	// stalledSender stands in for a websocket whose peer has stopped reading: every write
	// blocks until the test is over. This is what a half-dead browser tab does to the
	// real connection, without needing a full websocket handshake.
	done := make(chan struct{})
	defer close(done)
	stalled := &stalledSender{block: done}
	RegisterStateWsClient(stalled)
	defer UnregisterStateWsClient(stalled)

	req := httptest.NewRequest(http.MethodPost, "/api/building/switch",
		bytes.NewBufferString(`{"model":"domestic-home"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	finished := make(chan int, 1)
	go func() {
		handler.ServeHTTP(rec, req)
		finished <- rec.Code
	}()

	select {
	case code := <-finished:
		if code != http.StatusOK {
			t.Fatalf("switch returned %d, want 200; body: %s", code, rec.Body.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("POST /api/building/switch did not return within 5s with one stalled " +
			"websocket client registered: the broadcast is blocking the request handler")
	}
}

// stalledSender never returns from WriteMessage until the test releases it.
type stalledSender struct{ block chan struct{} }

func (s *stalledSender) WriteMessage(messageType int, data []byte) error {
	<-s.block
	return nil
}
