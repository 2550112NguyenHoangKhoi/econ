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
	"sync"
	"testing"
	"time"
)

// TestStatePersistence_WriteAndRead tests setting toggles and verifying atomic persistence to disk.
func TestStatePersistence_WriteAndRead(t *testing.T) {
	tempDir := t.TempDir()
	stateFile := filepath.Join(tempDir, "dashboard-state.json")

	store := NewStateStore(stateFile, nil)
	store.SetBuildingId("test-tower")
	store.Set("autoPilot", false)
	store.Set("operationMode", "real")
	store.Set("activeFloor", float64(4))
	store.Set("showWindSim", false)
	store.Set("viewMode", "3d")

	if err := store.Save(); err != nil {
		t.Fatalf("failed to save state: %v", err)
	}

	// 1. Verify atomic write: file exists and has valid JSON
	data, err := os.ReadFile(stateFile)
	if err != nil {
		t.Fatalf("failed to read persisted state file: %v", err)
	}

	var parsed DashboardState
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("failed to unmarshal state file: %v", err)
	}

	if parsed.BuildingId != "test-tower" {
		t.Errorf("expected buildingId='test-tower', got %q", parsed.BuildingId)
	}
	if parsed.Toggles["autoPilot"] != false {
		t.Errorf("expected autoPilot=false, got %v", parsed.Toggles["autoPilot"])
	}
	if parsed.Toggles["operationMode"] != "real" {
		t.Errorf("expected operationMode='real', got %v", parsed.Toggles["operationMode"])
	}
	if parsed.Toggles["activeFloor"] != float64(4) {
		t.Errorf("expected activeFloor=4, got %v", parsed.Toggles["activeFloor"])
	}
	if parsed.Toggles["showWindSim"] != false {
		t.Errorf("expected showWindSim=false, got %v", parsed.Toggles["showWindSim"])
	}

	// 2. Verify loading into a fresh StateStore instance
	secondStore := NewStateStore(stateFile, nil)
	if secondStore.BuildingId() != "test-tower" {
		t.Errorf("secondStore buildingId mismatch: %q", secondStore.BuildingId())
	}
	if val, ok := secondStore.GetOk("autoPilot"); !ok || val != false {
		t.Errorf("secondStore autoPilot mismatch: %v (found=%v)", val, ok)
	}
	if val, ok := secondStore.GetOk("activeFloor"); !ok || val != float64(4) {
		t.Errorf("secondStore activeFloor mismatch: %v (found=%v)", val, ok)
	}
}

// TestStatePersistence_ColdBootInitialization verifies that an existing state file
// accurately restores engine settings (AutoPilot, OperationMode, Scenario) upon engine cold boot.
func TestStatePersistence_ColdBootInitialization(t *testing.T) {
	tempDir := t.TempDir()
	stateFile := filepath.Join(tempDir, "dashboard-state.json")

	// Pre-populate state file from previous session
	initialData := DashboardState{
		BuildingId: "home",
		UpdatedAt:  time.Now().UTC(),
		Toggles: map[string]interface{}{
			"autoPilot":     false,
			"operationMode": "real",
			"scenario":      "night",
			"activeFloor":   float64(2),
		},
	}
	raw, err := json.MarshalIndent(initialData, "", "  ")
	if err != nil {
		t.Fatalf("failed to marshal initial data: %v", err)
	}
	if err := os.WriteFile(stateFile, raw, 0644); err != nil {
		t.Fatalf("failed to write state file: %v", err)
	}

	// Cold boot simulation: initialize fresh engine with defaults (AutoPilot=true, ModeSimulation)
	engine := simulation.NewEngine()
	engine.SetAutoPilot(true)
	engine.SetMode(simulation.ModeSimulation)

	// Load persistent state store and apply to engine
	store := NewStateStore(stateFile, nil)
	applyPersistentStateToEngine(engine, store)

	// Assert that engine adopted cold-boot state
	if engine.AutoPilot != false {
		t.Errorf("expected engine AutoPilot restored to false, got %v", engine.AutoPilot)
	}
	if !engine.IsRealMode() {
		t.Errorf("expected engine Mode restored to Real, got %v", engine.Mode())
	}
	if engine.Scenario != "night" {
		t.Errorf("expected engine Scenario restored to 'night', got %q", engine.Scenario)
	}
}

// TestStatePersistence_RESTEndpoints tests GET /api/state and POST /api/state handlers.
func TestStatePersistence_RESTEndpoints(t *testing.T) {
	tempDir := t.TempDir()
	stateFile := filepath.Join(tempDir, "dashboard-state.json")

	store := NewStateStore(stateFile, nil)
	engine := simulation.NewEngine()
	handler := stateHandler(engine, store)

	// 1. Initial GET /api/state returns default state
	getReq := httptest.NewRequest(http.MethodGet, "/api/state", nil)
	getRec := httptest.NewRecorder()
	handler(getRec, getReq)

	if getRec.Code != http.StatusOK {
		t.Fatalf("GET /api/state status %d", getRec.Code)
	}
	var getResp stateResponse
	if err := json.Unmarshal(getRec.Body.Bytes(), &getResp); err != nil {
		t.Fatalf("failed to parse GET response: %v", err)
	}
	if !getResp.OK {
		t.Errorf("expected ok=true")
	}

	// 2. POST /api/state with multiple toggles
	postPayload := map[string]interface{}{
		"toggles": map[string]interface{}{
			"autoPilot":     false,
			"operationMode": "real",
			"activeFloor":   3,
			"viewMode":      "physical",
		},
	}
	postBytes, _ := json.Marshal(postPayload)
	postReq := httptest.NewRequest(http.MethodPost, "/api/state", bytes.NewReader(postBytes))
	postReq.Header.Set("Content-Type", "application/json")
	postRec := httptest.NewRecorder()
	handler(postRec, postReq)

	if postRec.Code != http.StatusOK {
		t.Fatalf("POST /api/state status %d: %s", postRec.Code, postRec.Body.String())
	}

	// Assert engine was mutated by POST
	if engine.AutoPilot != false {
		t.Errorf("expected engine AutoPilot=false after POST, got %v", engine.AutoPilot)
	}
	if !engine.IsRealMode() {
		t.Errorf("expected engine Mode=Real after POST, got %v", engine.Mode())
	}

	// 3. GET /api/state with ?key=activeFloor
	queryReq := httptest.NewRequest(http.MethodGet, "/api/state?key=activeFloor", nil)
	queryRec := httptest.NewRecorder()
	handler(queryRec, queryReq)

	if queryRec.Code != http.StatusOK {
		t.Fatalf("GET /api/state?key=activeFloor status %d", queryRec.Code)
	}
	var queryResp stateResponse
	if err := json.Unmarshal(queryRec.Body.Bytes(), &queryResp); err != nil {
		t.Fatalf("failed to parse query response: %v", err)
	}
	if queryResp.Key != "activeFloor" || queryResp.Value != float64(3) {
		t.Errorf("expected key='activeFloor' value=3, got key=%q value=%v", queryResp.Key, queryResp.Value)
	}

	// 4. POST /api/state with single key/value
	singleKeyPayload := map[string]interface{}{
		"key":   "showWindSim",
		"value": false,
	}
	singleBytes, _ := json.Marshal(singleKeyPayload)
	singleReq := httptest.NewRequest(http.MethodPost, "/api/state", bytes.NewReader(singleBytes))
	singleRec := httptest.NewRecorder()
	handler(singleRec, singleReq)

	if singleRec.Code != http.StatusOK {
		t.Fatalf("POST single key status %d: %s", singleRec.Code, singleRec.Body.String())
	}
	if store.Get("showWindSim") != false {
		t.Errorf("expected showWindSim=false in store, got %v", store.Get("showWindSim"))
	}

	// 5. Method not allowed
	putReq := httptest.NewRequest(http.MethodPut, "/api/state", nil)
	putRec := httptest.NewRecorder()
	handler(putRec, putReq)
	if putRec.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected status 405 for PUT, got %d", putRec.Code)
	}
}

// TestStatePersistence_ConcurrentAccess validates thread-safety under heavy concurrent reads and writes.
func TestStatePersistence_ConcurrentAccess(t *testing.T) {
	tempDir := t.TempDir()
	stateFile := filepath.Join(tempDir, "dashboard-state.json")
	store := NewStateStore(stateFile, nil)

	var wg sync.WaitGroup
	workers := 40
	iterations := 100

	// Concurrent writers
	for i := 0; i < workers; i++ {
		wg.Add(1)
		workerID := i
		go func() {
			defer wg.Done()
			for j := 0; j < iterations; j++ {
				key := fmt.Sprintf("toggle_%d", workerID%5)
				store.Set(key, j)
				if j%20 == 0 {
					_ = store.Save()
				}
			}
		}()
	}

	// Concurrent readers
	for i := 0; i < workers; i++ {
		wg.Add(1)
		workerID := i
		go func() {
			defer wg.Done()
			for j := 0; j < iterations; j++ {
				key := fmt.Sprintf("toggle_%d", workerID%5)
				_ = store.Get(key)
				_ = store.GetAll()
			}
		}()
	}

	wg.Wait()

	// Final save
	if err := store.Save(); err != nil {
		t.Fatalf("final save failed: %v", err)
	}

	// Assert file exists and contains valid JSON after concurrent execution
	data, err := os.ReadFile(stateFile)
	if err != nil {
		t.Fatalf("failed to read state file: %v", err)
	}
	var parsed DashboardState
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("corrupted JSON after concurrent writes: %v", err)
	}
}

// mockWsSender implements wsSender for unit testing broadcast frames.
type mockWsSender struct {
	mu       sync.Mutex
	messages [][]byte
}

func (m *mockWsSender) WriteMessage(messageType int, data []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	copied := make([]byte, len(data))
	copy(copied, data)
	m.messages = append(m.messages, copied)
	return nil
}

func (m *mockWsSender) messageCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.messages)
}

// TestStatePersistence_WebSocketBroadcast verifies that state updates are broadcasted to registered clients.
func TestStatePersistence_WebSocketBroadcast(t *testing.T) {
	client1 := &mockWsSender{}
	client2 := &mockWsSender{}

	RegisterStateWsClient(client1)
	RegisterStateWsClient(client2)
	defer UnregisterStateWsClient(client1)
	defer UnregisterStateWsClient(client2)

	// Broadcast single update
	BroadcastStateUpdate("autoPilot", false, nil)

	if client1.messageCount() != 1 {
		t.Errorf("expected 1 message for client1, got %d", client1.messageCount())
	}
	if client2.messageCount() != 1 {
		t.Errorf("expected 1 message for client2, got %d", client2.messageCount())
	}

	// Parse received frame
	var frame struct {
		Type  string      `json:"type"`
		Key   string      `json:"key"`
		Value interface{} `json:"value"`
	}
	if err := json.Unmarshal(client1.messages[0], &frame); err != nil {
		t.Fatalf("failed to unmarshal broadcast frame: %v", err)
	}
	if frame.Type != "state_update" || frame.Key != "autoPilot" || frame.Value != false {
		t.Errorf("unexpected frame content: %+v", frame)
	}

	// Broadcast with exclusion (sender excluded)
	BroadcastStateUpdate("activeFloor", float64(2), client1)
	if client1.messageCount() != 1 {
		t.Errorf("client1 should have been excluded, messageCount=%d", client1.messageCount())
	}
	if client2.messageCount() != 2 {
		t.Errorf("client2 should have received message, messageCount=%d", client2.messageCount())
	}
}

// TestStatePersistence_CorruptFileRecovery verifies that unreadable state files gracefully fall back.
func TestStatePersistence_CorruptFileRecovery(t *testing.T) {
	tempDir := t.TempDir()
	stateFile := filepath.Join(tempDir, "corrupted-state.json")

	// Write garbage data
	_ = os.WriteFile(stateFile, []byte("{ this is not valid json --- !!!"), 0644)

	// Should not panic, should initialize with clean defaults
	store := NewStateStore(stateFile, nil)
	if store.BuildingId() != "home" {
		t.Errorf("expected default buildingId='home', got %q", store.BuildingId())
	}
	if len(store.GetAll()) != 0 {
		t.Errorf("expected 0 toggles, got %d", len(store.GetAll()))
	}
}
