package main

import (
	"bytes"
	"econ/simulation"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// TestChallenger2_HighConcurrencyRestBurst tests rapid burst of concurrent GET and POST
// requests to /api/state under heavy load (50 concurrent goroutines, 1000 total requests).
func TestChallenger2_HighConcurrencyRestBurst(t *testing.T) {
	tempDir := t.TempDir()
	stateFile := filepath.Join(tempDir, "burst-state.json")
	store := NewStateStore(stateFile, nil)
	engine := simulation.NewEngine()
	handler := stateHandler(engine, store)

	server := httptest.NewServer(handler)
	defer server.Close()

	client := &http.Client{Timeout: 5 * time.Second}
	var wg sync.WaitGroup
	workers := 50
	requestsPerWorker := 20

	var totalSuccess int64
	var totalErrors int64

	startTime := time.Now()

	for i := 0; i < workers; i++ {
		wg.Add(1)
		workerID := i
		go func(wid int) {
			defer wg.Done()
			for reqIdx := 0; reqIdx < requestsPerWorker; reqIdx++ {
				op := (wid + reqIdx) % 4
				switch op {
				case 0: // GET all
					resp, err := client.Get(server.URL + "/api/state")
					if err != nil || resp.StatusCode != http.StatusOK {
						atomic.AddInt64(&totalErrors, 1)
					} else {
						atomic.AddInt64(&totalSuccess, 1)
						resp.Body.Close()
					}
				case 1: // GET key
					resp, err := client.Get(fmt.Sprintf("%s/api/state?key=activeFloor", server.URL))
					if err != nil || resp.StatusCode != http.StatusOK {
						atomic.AddInt64(&totalErrors, 1)
					} else {
						atomic.AddInt64(&totalSuccess, 1)
						resp.Body.Close()
					}
				case 2: // POST toggles batch
					payload := map[string]interface{}{
						"toggles": map[string]interface{}{
							fmt.Sprintf("worker_key_%d", wid): reqIdx,
							"activeFloor":                     reqIdx % 5,
							"autoPilot":                       (reqIdx%2 == 0),
						},
					}
					data, _ := json.Marshal(payload)
					resp, err := client.Post(server.URL+"/api/state", "application/json", bytes.NewReader(data))
					if err != nil || resp.StatusCode != http.StatusOK {
						atomic.AddInt64(&totalErrors, 1)
					} else {
						atomic.AddInt64(&totalSuccess, 1)
						resp.Body.Close()
					}
				case 3: // POST single key
					payload := map[string]interface{}{
						"key":   "viewMode",
						"value": fmt.Sprintf("mode_%d", reqIdx%3),
					}
					data, _ := json.Marshal(payload)
					resp, err := client.Post(server.URL+"/api/state", "application/json", bytes.NewReader(data))
					if err != nil || resp.StatusCode != http.StatusOK {
						atomic.AddInt64(&totalErrors, 1)
					} else {
						atomic.AddInt64(&totalSuccess, 1)
						resp.Body.Close()
					}
				}
			}
		}(workerID)
	}

	wg.Wait()
	duration := time.Since(startTime)
	t.Logf("High concurrency burst completed: %d success, %d errors in %v", totalSuccess, totalErrors, duration)

	if totalErrors > 0 {
		t.Fatalf("Encountered %d errors during high concurrency REST burst", totalErrors)
	}

	// Final verification of disk integrity
	if err := store.Save(); err != nil {
		t.Fatalf("store.Save() failed after burst: %v", err)
	}

	diskData, err := os.ReadFile(stateFile)
	if err != nil {
		t.Fatalf("failed to read persisted state file: %v", err)
	}

	var parsed DashboardState
	if err := json.Unmarshal(diskData, &parsed); err != nil {
		t.Fatalf("disk state file corrupted after REST burst: %v", err)
	}
	if len(parsed.Toggles) == 0 {
		t.Errorf("expected persisted toggles, got 0")
	}
}

// TestChallenger2_SimulatedMultiClientWebSocketTopology_BroadcastLatency tests a 10+
// client topology connected to /ws, asserting real-time broadcast delivery (<50ms)
// to all peer clients when Client 1 mutates state.
func TestChallenger2_SimulatedMultiClientWebSocketTopology_BroadcastLatency(t *testing.T) {
	tempDir := t.TempDir()
	stateFile := filepath.Join(tempDir, "ws-topology-state.json")
	store := NewStateStore(stateFile, nil)
	store.Set("initialKey", "initialVal")
	engine := simulation.NewEngine()

	// Spin up server with handleWebSocket and stateHandler
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		handleWebSocket(w, r, engine, store)
	})
	mux.HandleFunc("/api/state", stateHandler(engine, store))

	server := httptest.NewServer(mux)
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws"

	const numClients = 12 // > 10 concurrent clients
	clients := make([]*websocket.Conn, numClients)

	// Step 1: Connect 12 WebSocket clients and verify initial state_sync frame
	for i := 0; i < numClients; i++ {
		conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
		if err != nil {
			if strings.Contains(err.Error(), "operation not permitted") {
				t.Skipf("skipping websocket network test in restricted sandbox: %v", err)
			}
			t.Fatalf("failed to dial client %d: %v", i, err)
		}
		clients[i] = conn
		defer conn.Close()

		// Read initial frame: must be state_sync
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		msgType, msg, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("client %d failed to receive initial frame: %v", i, err)
		}
		if msgType != websocket.TextMessage {
			t.Fatalf("client %d expected TextMessage for state_sync, got %d", i, msgType)
		}
		var syncFrame struct {
			Type    string                 `json:"type"`
			Toggles map[string]interface{} `json:"toggles"`
		}
		if err := json.Unmarshal(msg, &syncFrame); err != nil || syncFrame.Type != "state_sync" {
			t.Fatalf("client %d invalid state_sync frame: %s", i, string(msg))
		}
	}

	t.Logf("Successfully connected %d WebSocket clients with verified state_sync", numClients)

	// Step 2: Client 0 sends a toggle update via WebSocket set_state
	// Record time and assert all other 11 clients receive state_update within <50ms
	type receivedUpdate struct {
		clientID int
		latency  time.Duration
		key      string
		value    interface{}
		err      error
	}

	resultsChan := make(chan receivedUpdate, numClients)
	targetFloor := float64(4)

	// Start listener goroutines on clients 1 through 11
	var listenWg sync.WaitGroup
	var startSignal sync.WaitGroup
	startSignal.Add(1)

	for i := 1; i < numClients; i++ {
		listenWg.Add(1)
		cid := i
		go func(cIndex int, c *websocket.Conn) {
			defer listenWg.Done()
			_ = c.SetReadDeadline(time.Now().Add(500 * time.Millisecond))

			// Wait until sender triggers
			startSignal.Wait()

			t0 := time.Now()
			for {
				msgType, msg, err := c.ReadMessage()
				if err != nil {
					resultsChan <- receivedUpdate{clientID: cIndex, err: err}
					return
				}
				if msgType == websocket.TextMessage {
					var frame struct {
						Type  string      `json:"type"`
						Key   string      `json:"key"`
						Value interface{} `json:"value"`
					}
					if err := json.Unmarshal(msg, &frame); err == nil && frame.Type == "state_update" && frame.Key == "activeFloor" {
						resultsChan <- receivedUpdate{
							clientID: cIndex,
							latency:  time.Since(t0),
							key:      frame.Key,
							value:    frame.Value,
						}
						return
					}
				}
			}
		}(cid, clients[i])
	}

	// Small pause to ensure listener goroutines are ready
	time.Sleep(20 * time.Millisecond)

	// Send mutation from Client 0
	actionMsg := map[string]interface{}{
		"action": "set_state",
		"key":    "activeFloor",
		"value":  targetFloor,
	}
	actionBytes, _ := json.Marshal(actionMsg)

	// Release listeners and send immediately
	startSignal.Done()
	sendTime := time.Now()
	if err := clients[0].WriteMessage(websocket.TextMessage, actionBytes); err != nil {
		t.Fatalf("client 0 failed to send set_state: %v", err)
	}

	// Collect results from all 11 peer clients
	listenWg.Wait()
	close(resultsChan)

	var maxLatency time.Duration
	var minLatency = 24 * time.Hour
	receivedCount := 0

	for res := range resultsChan {
		if res.err != nil {
			t.Errorf("peer client %d read error: %v", res.clientID, res.err)
			continue
		}
		receivedCount++
		if res.key != "activeFloor" || res.value != targetFloor {
			t.Errorf("client %d got unexpected key/value: %s=%v", res.clientID, res.key, res.value)
		}
		if res.latency > maxLatency {
			maxLatency = res.latency
		}
		if res.latency < minLatency {
			minLatency = res.latency
		}
		// Strict SLA: < 50ms
		if res.latency >= 50*time.Millisecond {
			t.Errorf("client %d latency exceeded 50ms threshold: %v", res.clientID, res.latency)
		}
	}

	t.Logf("Peer broadcast reception: %d/%d clients received update. Min latency: %v, Max latency: %v (elapsed from send: %v)",
		receivedCount, numClients-1, minLatency, maxLatency, time.Since(sendTime))

	if receivedCount != numClients-1 {
		t.Fatalf("Expected %d peer clients to receive state_update, but only %d received it", numClients-1, receivedCount)
	}

	// Step 3: Echo prevention check on Client 0 (sender)
	// Client 0 must NOT receive its own state_update
	_ = clients[0].SetReadDeadline(time.Now().Add(50 * time.Millisecond))
	for {
		msgType, msg, err := clients[0].ReadMessage()
		if err != nil {
			// Timeout as expected
			break
		}
		if msgType == websocket.TextMessage {
			var frame struct {
				Type string `json:"type"`
				Key  string `json:"key"`
			}
			if json.Unmarshal(msg, &frame) == nil && frame.Type == "state_update" && frame.Key == "activeFloor" {
				t.Errorf("Client 0 received unexpected echo of its own set_state action!")
			}
		}
	}

	// Verify store state updated
	if val, ok := store.GetOk("activeFloor"); !ok || val != targetFloor {
		t.Errorf("store activeFloor not updated, got %v (found=%v)", val, ok)
	}
}

// TestChallenger2_PayloadFuzzingAndMalformedInputs exhaustively tests invalid,
// malformed, oversized, and edge-case payloads to POST /api/state and /ws.
func TestChallenger2_PayloadFuzzingAndMalformedInputs(t *testing.T) {
	tempDir := t.TempDir()
	stateFile := filepath.Join(tempDir, "fuzz-state.json")
	store := NewStateStore(stateFile, nil)
	engine := simulation.NewEngine()

	handler := stateHandler(engine, store)
	server := httptest.NewServer(handler)
	defer server.Close()

	client := &http.Client{Timeout: 2 * time.Second}

	// Test 1: REST POST Fuzzing
	malformedRESTCases := []struct {
		name         string
		payload      []byte
		expectedCode int
	}{
		{
			name:         "Empty body",
			payload:      []byte(""),
			expectedCode: http.StatusBadRequest,
		},
		{
			name:         "Whitespace only",
			payload:      []byte("   \t\n   "),
			expectedCode: http.StatusBadRequest,
		},
		{
			name:         "Unclosed JSON brace",
			payload:      []byte(`{"toggles": {"activeFloor": 2`),
			expectedCode: http.StatusBadRequest,
		},
		{
			name:         "Unquoted keys and values",
			payload:      []byte(`{toggles: {key: val}}`),
			expectedCode: http.StatusBadRequest,
		},
		{
			name:         "Non-JSON arbitrary string",
			payload:      []byte(`THIS_IS_NOT_JSON_AT_ALL`),
			expectedCode: http.StatusBadRequest,
		},
		{
			name:         "Empty JSON object",
			payload:      []byte(`{}`),
			expectedCode: http.StatusBadRequest,
		},
		{
			name:         "JSON Array root",
			payload:      []byte(`[1, 2, 3, "foo"]`),
			expectedCode: http.StatusBadRequest,
		},
		{
			name:         "JSON Number root",
			payload:      []byte(`9999999`),
			expectedCode: http.StatusBadRequest,
		},
		{
			name:         "JSON Boolean root",
			payload:      []byte(`true`),
			expectedCode: http.StatusBadRequest,
		},
		{
			name:         "JSON null root",
			payload:      []byte(`null`),
			expectedCode: http.StatusBadRequest,
		},
		{
			name:         "Oversized payload exceeding 1MB",
			payload:      bytes.Repeat([]byte("x"), 1024*1024+500),
			expectedCode: http.StatusBadRequest,
		},
		{
			name:         "Null bytes inside JSON",
			payload:      []byte("{\"toggles\": {\"key\x00\": \"val\x00\"}}"),
			expectedCode: http.StatusBadRequest,
		},
	}

	for _, tc := range malformedRESTCases {
		t.Run("REST_"+tc.name, func(t *testing.T) {
			resp, err := client.Post(server.URL+"/api/state", "application/json", bytes.NewReader(tc.payload))
			if err != nil {
				t.Fatalf("POST request failed: %v", err)
			}
			defer resp.Body.Close()

			if resp.StatusCode != tc.expectedCode {
				t.Errorf("expected HTTP status %d, got %d", tc.expectedCode, resp.StatusCode)
			}
		})
	}

	// Test 2: WebSocket Malformed Frames
	wsMux := http.NewServeMux()
	wsMux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		handleWebSocket(w, r, engine, store)
	})
	wsServer := httptest.NewServer(wsMux)
	defer wsServer.Close()

	wsURL := "ws" + strings.TrimPrefix(wsServer.URL, "http") + "/ws"
	wsConn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		if strings.Contains(err.Error(), "operation not permitted") {
			t.Skipf("skipping websocket network test in restricted sandbox: %v", err)
		}
		t.Fatalf("failed to dial websocket: %v", err)
	}
	defer wsConn.Close()

	// Read initial state_sync
	_, _, _ = wsConn.ReadMessage()

	malformedWSFrames := [][]byte{
		[]byte(`{ corrupted json syntax `),
		[]byte(`"just a string"`),
		[]byte(`12345`),
		[]byte(`{"action": "unknown_action_without_handler"}`),
		[]byte(`{"action": "set_state"}`),                                          // missing key and toggles
		[]byte(`{"action": "set_state", "key": 12345, "value": "invalid_key_num"}`), // invalid type
		[]byte(`{"action": "autopilot", "value": "not_a_bool"}`),                     // invalid autopilot type
		[]byte(`{"action": "switch_model", "model": "non_existent_model_file_404"}`),
		[]byte(""),
	}

	for idx, frame := range malformedWSFrames {
		if err := wsConn.WriteMessage(websocket.TextMessage, frame); err != nil {
			t.Fatalf("failed to write malformed frame %d: %v", idx, err)
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Also send binary frame
	if err := wsConn.WriteMessage(websocket.BinaryMessage, []byte{0xDE, 0xAD, 0xBE, 0xEF}); err != nil {
		t.Fatalf("failed to write binary frame: %v", err)
	}
	time.Sleep(20 * time.Millisecond)

	// Assert server is still alive and responsive to valid command
	validMsg := map[string]interface{}{
		"action": "set_state",
		"key":    "fuzzPassed",
		"value":  true,
	}
	validBytes, _ := json.Marshal(validMsg)
	if err := wsConn.WriteMessage(websocket.TextMessage, validBytes); err != nil {
		t.Fatalf("server dropped connection or died after fuzzing: %v", err)
	}

	time.Sleep(20 * time.Millisecond)
	if val, ok := store.GetOk("fuzzPassed"); !ok || val != true {
		t.Errorf("store did not process valid state after fuzzing: %v", val)
	}
}

// TestChallenger2_DirectMapFallbackBug documents whether POST /api/state with a direct map
// e.g. {"autoPilot": false} succeeds (200 OK) or fails (400 Bad Request) due to struct unmarshaling.
func TestChallenger2_DirectMapFallbackBug(t *testing.T) {
	tempDir := t.TempDir()
	stateFile := filepath.Join(tempDir, "direct-map-state.json")
	store := NewStateStore(stateFile, nil)
	engine := simulation.NewEngine()

	handler := stateHandler(engine, store)
	server := httptest.NewServer(handler)
	defer server.Close()

	client := &http.Client{Timeout: 2 * time.Second}

	// Payload with direct toggle keys without "toggles" wrapper
	directPayload := []byte(`{"autoPilot": false, "activeFloor": 3}`)
	resp, err := client.Post(server.URL+"/api/state", "application/json", bytes.NewReader(directPayload))
	if err != nil {
		t.Fatalf("POST request failed: %v", err)
	}
	defer resp.Body.Close()

	t.Logf("Direct map POST response status code: %d", resp.StatusCode)
	if resp.StatusCode == http.StatusBadRequest {
		t.Logf("[FINDING] Direct toggle map POST rejected with HTTP 400 Bad Request because struct unmarshaling skips fallback")
	}
}
