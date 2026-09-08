package main

import (
	"bytes"
	"econ/simulation"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestForensicAuditM2_EngineLatching verifies cold-boot engine property latching across edge types.
func TestForensicAuditM2_EngineLatching(t *testing.T) {
	tempDir := t.TempDir()
	stateFile := filepath.Join(tempDir, "dashboard-state.json")

	// 1. Test autoPilot latching with various representations
	testCasesAutoPilot := []struct {
		val      interface{}
		expected bool
	}{
		{true, true},
		{false, false},
		{"true", true},
		{"TRUE", true},
		{"1", true},
		{"false", false},
		{"FALSE", false},
		{"0", false},
		{float64(1), true},
		{float64(0), false},
	}

	for _, tc := range testCasesAutoPilot {
		store := NewStateStore(stateFile, nil)
		store.Set("autoPilot", tc.val)
		engine := simulation.NewEngine()
		engine.SetAutoPilot(!tc.expected) // invert initial

		applyPersistentStateToEngine(engine, store)
		if engine.AutoPilot != tc.expected {
			t.Errorf("AutoPilot latch failed for input %v (%T): expected %v, got %v",
				tc.val, tc.val, tc.expected, engine.AutoPilot)
		}
	}

	// 2. Test operationMode latching
	testCasesMode := []struct {
		val      interface{}
		expected simulation.OperationMode
	}{
		{"real", simulation.ModeReal},
		{"REAL", simulation.ModeReal},
		{"1", simulation.ModeReal},
		{"simulation", simulation.ModeSimulation},
		{"sim", simulation.ModeSimulation},
		{"0", simulation.ModeSimulation},
		{float64(1), simulation.ModeReal},
		{float64(0), simulation.ModeSimulation},
	}

	for _, tc := range testCasesMode {
		store := NewStateStore(stateFile, nil)
		store.Set("operationMode", tc.val)
		engine := simulation.NewEngine()
		// invert initial
		if tc.expected == simulation.ModeReal {
			engine.SetMode(simulation.ModeSimulation)
		} else {
			engine.SetMode(simulation.ModeReal)
		}

		applyPersistentStateToEngine(engine, store)
		if engine.Mode() != tc.expected {
			t.Errorf("OperationMode latch failed for input %v (%T): expected %v, got %v",
				tc.val, tc.val, tc.expected, engine.Mode())
		}
	}

	// 3. Test scenario latching
	store := NewStateStore(stateFile, nil)
	store.Set("scenario", "morning_rush")
	engine := simulation.NewEngine()
	engine.Scenario = "nominal"
	applyPersistentStateToEngine(engine, store)
	if engine.Scenario != "morning_rush" {
		t.Errorf("Scenario latch failed: expected 'morning_rush', got %q", engine.Scenario)
	}

	// 4. Test nil safety
	applyPersistentStateToEngine(nil, store)
	applyPersistentStateToEngine(engine, nil)
}

// TestForensicAuditM2_AtomicDiskPersistence verifies atomic file persistence, directory creation, and non-corrupt reads.
func TestForensicAuditM2_AtomicDiskPersistence(t *testing.T) {
	tempDir := t.TempDir()
	nestedPath := filepath.Join(tempDir, "nested", "sub", "dir", "state.json")

	store := NewStateStore(nestedPath, nil)
	store.Set("level", 5)
	store.Set("name", "audit-check")

	// Must create parent directories automatically and write cleanly
	if err := store.Save(); err != nil {
		t.Fatalf("Save failed on nested path: %v", err)
	}

	// Verify file exists
	if _, err := os.Stat(nestedPath); err != nil {
		t.Fatalf("Nested state file does not exist: %v", err)
	}

	// Verify no stray .tmp files left over
	dirEntries, err := os.ReadDir(filepath.Dir(nestedPath))
	if err != nil {
		t.Fatalf("Failed to read dir: %v", err)
	}
	if len(dirEntries) != 1 || dirEntries[0].Name() != "state.json" {
		t.Errorf("Unexpected files in directory: %v", dirEntries)
	}

	// Reload from new instance
	freshStore := NewStateStore(nestedPath, nil)
	if val := freshStore.Get("level"); val != float64(5) {
		t.Errorf("expected level=5, got %v", val)
	}
	if val := freshStore.Get("name"); val != "audit-check" {
		t.Errorf("expected name='audit-check', got %v", val)
	}
}

// TestForensicAuditM2_CorruptedAndTruncatedFiles verifies resilience to bad disk data.
func TestForensicAuditM2_CorruptedAndTruncatedFiles(t *testing.T) {
	tempDir := t.TempDir()

	testFiles := []struct {
		name    string
		content []byte
	}{
		{"empty.json", []byte("")},
		{"whitespace.json", []byte("   \n\t  ")},
		{"truncated.json", []byte(`{"buildingId": "home", "toggles": {"a": 1, `)},
		{"binary.json", []byte{0x00, 0xFF, 0xFE, 0x12, 0x44}},
	}

	for _, tf := range testFiles {
		p := filepath.Join(tempDir, tf.name)
		if err := os.WriteFile(p, tf.content, 0644); err != nil {
			t.Fatalf("Failed to create test file %s: %v", tf.name, err)
		}

		store := NewStateStore(p, nil)
		if store.BuildingId() != "home" {
			t.Errorf("[%s] Expected default buildingId 'home', got %q", tf.name, store.BuildingId())
		}
		if len(store.GetAll()) != 0 {
			t.Errorf("[%s] Expected 0 toggles, got %d", tf.name, len(store.GetAll()))
		}

		// Verify that Save() heals the corrupted file with valid JSON
		store.Set("repaired", true)
		if err := store.Save(); err != nil {
			t.Errorf("[%s] Save failed on corrupted file: %v", tf.name, err)
		}

		data, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("[%s] Failed to read healed file: %v", tf.name, err)
		}
		var parsed DashboardState
		if err := json.Unmarshal(data, &parsed); err != nil {
			t.Errorf("[%s] Healed file is still invalid JSON: %v", tf.name, err)
		}
		if parsed.Toggles["repaired"] != true {
			t.Errorf("[%s] Healed file missing repaired key: %v", tf.name, parsed.Toggles)
		}
	}
}

// TestForensicAuditM2_RESTValidationEdgeCases tests security & edge inputs on /api/state.
func TestForensicAuditM2_RESTValidationEdgeCases(t *testing.T) {
	tempDir := t.TempDir()
	stateFile := filepath.Join(tempDir, "state.json")
	store := NewStateStore(stateFile, nil)
	engine := simulation.NewEngine()
	handler := stateHandler(engine, store)

	// 1. Nil store returns 500
	nilHandler := stateHandler(engine, nil)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/state", nil)
	nilHandler(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("Expected 500 for nil store, got %d", rec.Code)
	}

	// 2. Disallowed HTTP methods return 405
	disallowedMethods := []string{http.MethodPut, http.MethodDelete, http.MethodPatch}
	for _, m := range disallowedMethods {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(m, "/api/state", nil)
		handler(rec, req)
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("Expected 405 for %s, got %d", m, rec.Code)
		}
	}

	// 3. POST with empty JSON body returns 400
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/state", bytes.NewReader([]byte("{}")))
	handler(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("Expected 400 for empty POST body {}, got %d", rec.Code)
	}

	// 4. POST with invalid JSON syntax returns 400
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/state", bytes.NewReader([]byte("{invalid-json")))
	handler(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("Expected 400 for malformed JSON, got %d", rec.Code)
	}

	// 5. GET with unknown key returns null value cleanly without error
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/state?key=nonExistentKeyXYZ", nil)
	handler(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("Expected 200 for missing key query, got %d", rec.Code)
	}
	var resp stateResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("Failed to parse JSON response: %v", err)
	}
	if resp.Key != "nonExistentKeyXYZ" || resp.Value != nil {
		t.Errorf("Expected key='nonExistentKeyXYZ' and value=nil, got key=%q, val=%v", resp.Key, resp.Value)
	}

	// 6. OPTIONS preflight CORS returns 204 or 200
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodOptions, "/api/state", nil)
	handler(rec, req)
	if rec.Code != http.StatusNoContent && rec.Code != http.StatusOK {
		t.Errorf("Expected 204 or 200 for OPTIONS preflight, got %d", rec.Code)
	}
}

// failingWsSender simulates a broken connection that fails to write.
type failingWsSender struct{}

func (f *failingWsSender) WriteMessage(messageType int, data []byte) error {
	return errors.New("broken pipe")
}

// TestForensicAuditM2_WebSocketBroadcastResilience verifies hub stability under failure and high concurrency.
func TestForensicAuditM2_WebSocketBroadcastResilience(t *testing.T) {
	// Register nil client (should not panic)
	RegisterStateWsClient(nil)
	UnregisterStateWsClient(nil)

	// Register a failing client alongside working client
	failClient := &failingWsSender{}
	workClient := &mockWsSender{}

	RegisterStateWsClient(failClient)
	RegisterStateWsClient(workClient)
	defer UnregisterStateWsClient(failClient)
	defer UnregisterStateWsClient(workClient)

	// Broadcast should not panic when failClient fails
	BroadcastStateUpdate("activeFloor", 3, nil)
	if workClient.messageCount() != 1 {
		t.Errorf("workClient expected 1 message, got %d", workClient.messageCount())
	}

	// Concurrent register, unregister, and broadcast stress
	var wg sync.WaitGroup
	var broadcastCount int32

	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c := &mockWsSender{}
			RegisterStateWsClient(c)
			time.Sleep(2 * time.Millisecond)
			UnregisterStateWsClient(c)
		}()
	}

	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 10; j++ {
				BroadcastStateUpdate("stress_test", j, nil)
				atomic.AddInt32(&broadcastCount, 1)
			}
		}()
	}

	wg.Wait()
}
