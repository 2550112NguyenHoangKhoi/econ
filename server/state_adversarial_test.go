package main

import (
	"bytes"
	"crypto/rand"
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
)

// TestStatePersistence_Adversarial_ExtremeConcurrency stresses a single StateStore
// with 60 concurrent goroutines executing Set, SetAll, GetAll, GetOk, Save, and engine sync.
func TestStatePersistence_Adversarial_ExtremeConcurrency(t *testing.T) {
	tempDir := t.TempDir()
	stateFile := filepath.Join(tempDir, "high-concurrency-state.json")
	store := NewStateStore(stateFile, nil)
	engine := simulation.NewEngine()

	goroutines := 60
	_ = goroutines
	opsPerGoroutine := 80

	var wg sync.WaitGroup

	// Error counters
	var saveErrors int64

	// Category 1: Single Set callers (15 goroutines)
	for i := 0; i < 15; i++ {
		wg.Add(1)
		gid := i
		go func() {
			defer wg.Done()
			for j := 0; j < opsPerGoroutine; j++ {
				key := fmt.Sprintf("key_%d_%d", gid%5, j%10)
				var val interface{}
				switch j % 5 {
				case 0:
					val = j
				case 1:
					val = fmt.Sprintf("val_%d", j)
				case 2:
					val = (j%2 == 0)
				case 3:
					val = float64(j) * 1.5
				case 4:
					val = map[string]interface{}{"sub": j, "nested": true}
				}
				store.Set(key, val)
			}
		}()
	}

	// Category 2: Batch SetAll callers (15 goroutines)
	for i := 0; i < 15; i++ {
		wg.Add(1)
		gid := i
		go func() {
			defer wg.Done()
			for j := 0; j < opsPerGoroutine; j++ {
				batch := map[string]interface{}{
					fmt.Sprintf("batch_%d_a", gid): j,
					fmt.Sprintf("batch_%d_b", gid): fmt.Sprintf("str_%d", j),
					"autoPilot":                   (j%2 == 0),
					"activeFloor":                 float64(j % 10),
				}
				store.SetAll(batch)
			}
		}()
	}

	// Category 3: Readers hammering GetAll and GetOk (15 goroutines)
	for i := 0; i < 15; i++ {
		wg.Add(1)
		gid := i
		go func() {
			defer wg.Done()
			for j := 0; j < opsPerGoroutine; j++ {
				all := store.GetAll()
				if all == nil {
					t.Errorf("GetAll() returned nil")
				}
				// Verify iteration safety over copied map
				for k, v := range all {
					_ = k
					_ = v
				}
				key := fmt.Sprintf("key_%d_%d", gid%5, j%10)
				_, _ = store.GetOk(key)
				_ = store.BuildingId()
				_ = store.UpdatedAt()
			}
		}()
	}

	// Category 4: Savers calling Save() concurrently while mutations happen (15 goroutines)
	for i := 0; i < 15; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < opsPerGoroutine/2; j++ {
				if err := store.Save(); err != nil {
					atomic.AddInt64(&saveErrors, 1)
				}
				// Apply persistent state to engine concurrently
				applyPersistentStateToEngine(engine, store)
			}
		}()
	}

	wg.Wait()

	if errCount := atomic.LoadInt64(&saveErrors); errCount > 0 {
		t.Fatalf("encountered %d save errors during concurrent hammering", errCount)
	}

	// Final Save to ensure disk consistency
	if err := store.Save(); err != nil {
		t.Fatalf("final Save failed: %v", err)
	}

	// Read and parse file directly from disk to ensure JSON wasn't corrupted
	diskBytes, err := os.ReadFile(stateFile)
	if err != nil {
		t.Fatalf("failed to read persisted state file: %v", err)
	}

	var parsed DashboardState
	if err := json.Unmarshal(diskBytes, &parsed); err != nil {
		t.Fatalf("JSON corrupted on disk after high concurrency stress: %v\nContent: %s", err, string(diskBytes))
	}

	if parsed.Toggles == nil || len(parsed.Toggles) == 0 {
		t.Errorf("expected non-empty toggles in parsed disk state, got %d", len(parsed.Toggles))
	}
}

// TestStatePersistence_Adversarial_MultiInstanceDiskContention verifies that
// multiple independent StateStore instances hammering Save() and load() against the same
// underlying file do not tear or corrupt the JSON file.
func TestStatePersistence_Adversarial_MultiInstanceDiskContention(t *testing.T) {
	tempDir := t.TempDir()
	sharedFile := filepath.Join(tempDir, "shared-state.json")

	// Initialize file with clean initial state
	initStore := NewStateStore(sharedFile, nil)
	initStore.Set("init", true)
	if err := initStore.Save(); err != nil {
		t.Fatalf("initial save failed: %v", err)
	}

	instanceCount := 12
	opsPerInstance := 40
	var wg sync.WaitGroup

	for inst := 0; inst < instanceCount; inst++ {
		wg.Add(1)
		instID := inst
		go func() {
			defer wg.Done()
			// Each goroutine has its own StateStore instance pointing to shared file
			localStore := NewStateStore(sharedFile, nil)
			for j := 0; j < opsPerInstance; j++ {
				localStore.Set(fmt.Sprintf("inst_%d", instID), j)
				localStore.Set("activeFloor", float64(j%5))
				_ = localStore.Save()

				// Periodically simulate cold boot reload from disk
				if j%10 == 0 {
					reloader := NewStateStore(sharedFile, nil)
					if reloader.BuildingId() != "home" {
						t.Errorf("expected buildingId='home', got %q", reloader.BuildingId())
					}
				}
			}
		}()
	}

	wg.Wait()

	// Assert final file is 100% valid, uncorrupted JSON
	data, err := os.ReadFile(sharedFile)
	if err != nil {
		t.Fatalf("failed to read shared state file: %v", err)
	}

	var finalState DashboardState
	if err := json.Unmarshal(data, &finalState); err != nil {
		t.Fatalf("shared state file was corrupted by multi-instance contention: %v\nData: %s", err, string(data))
	}
}

// TestStatePersistence_Adversarial_CorruptAndPartialJSONRecovery exhaustively validates
// that invalid, truncated, zero-byte, bit-flipped, or wrong-type files never panic and recover cleanly.
func TestStatePersistence_Adversarial_CorruptAndPartialJSONRecovery(t *testing.T) {
	testCases := []struct {
		name        string
		fileContent []byte
	}{
		{
			name:        "Empty zero-byte file",
			fileContent: []byte(""),
		},
		{
			name:        "Truncated JSON mid-key",
			fileContent: []byte(`{"buildingId": "home", "togg`),
		},
		{
			name:        "Truncated JSON mid-value",
			fileContent: []byte(`{"buildingId": "home", "toggles": {"activeFloor": 3`),
		},
		{
			name:        "Unclosed JSON braces",
			fileContent: []byte(`{"buildingId": "home", "toggles": {"autoPilot": false}`),
		},
		{
			name:        "JSON Array instead of Object",
			fileContent: []byte(`[1, 2, 3, "unexpected", {"key": "val"}]`),
		},
		{
			name:        "JSON String scalar",
			fileContent: []byte(`"just a raw string"`),
		},
		{
			name:        "JSON Number scalar",
			fileContent: []byte(`123456789`),
		},
		{
			name:        "JSON Boolean scalar",
			fileContent: []byte(`true`),
		},
		{
			name:        "JSON null scalar",
			fileContent: []byte(`null`),
		},
		{
			name:        "Valid JSON with null toggles field",
			fileContent: []byte(`{"buildingId": "home", "updatedAt": "2026-09-08T00:00:00Z", "toggles": null}`),
		},
		{
			name:        "Valid JSON with wrong types (number buildingId, string toggles)",
			fileContent: []byte(`{"buildingId": 99999, "toggles": "this should be a map"}`),
		},
		{
			name:        "Null bytes in JSON string",
			fileContent: []byte("{\x00\"buildingId\":\x00 \"home\"\x00}"),
		},
		{
			name:        "Completely random binary garbage (1024 bytes)",
			fileContent: func() []byte {
				buf := make([]byte, 1024)
				_, _ = rand.Read(buf)
				return buf
			}(),
		},
		{
			name:        "High-bit UTF-8 corrupted bytes",
			fileContent: []byte{0xFF, 0xFE, 0xFD, 0x80, 0x81, 0x82, '{', '}'},
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			tempDir := t.TempDir()
			statePath := filepath.Join(tempDir, "corrupt-test.json")

			if err := os.WriteFile(statePath, tc.fileContent, 0644); err != nil {
				t.Fatalf("failed to prepare test file: %v", err)
			}

			// Must not panic on initialization
			var store *StateStore
			panicked := false
			func() {
				defer func() {
					if r := recover(); r != nil {
						panicked = true
						t.Errorf("NewStateStore panicked on %s: %v", tc.name, r)
					}
				}()
				store = NewStateStore(statePath, nil)
			}()

			if panicked || store == nil {
				t.Fatalf("store initialization failed for %s", tc.name)
			}

			// Defaults should be safe
			if store.BuildingId() == "" {
				t.Errorf("buildingId should fallback to default, got empty")
			}
			toggles := store.GetAll()
			if toggles == nil {
				t.Errorf("store.GetAll() must return non-nil map")
			}

			// Store must be fully functional for new writes
			store.Set("recovered", true)
			store.Set("activeFloor", 1)
			if err := store.Save(); err != nil {
				t.Errorf("failed to save after recovery from %s: %v", tc.name, err)
			}

			// Read back to verify file has been overwritten with valid JSON
			data, err := os.ReadFile(statePath)
			if err != nil {
				t.Fatalf("failed to read recovered file: %v", err)
			}
			var verified DashboardState
			if err := json.Unmarshal(data, &verified); err != nil {
				t.Fatalf("recovered file contains invalid JSON: %v", err)
			}
			if verified.Toggles["recovered"] != true {
				t.Errorf("expected recovered=true in saved file, got %v", verified.Toggles["recovered"])
			}
		})
	}
}

// TestStatePersistence_Adversarial_ColdBootExtremeToggles verifies that extreme,
// invalid, or boundary toggle values do not cause engine panics, memory corruption,
// or state corruption during cold-boot restoration.
func TestStatePersistence_Adversarial_ColdBootExtremeToggles(t *testing.T) {
	tempDir := t.TempDir()
	stateFile := filepath.Join(tempDir, "extreme-toggles.json")

	// Craft extreme inputs
	extremeData := DashboardState{
		BuildingId: "home",
		UpdatedAt:  time.Now().UTC(),
		Toggles: map[string]interface{}{
			// autoPilot variations
			"autoPilot_str_true":   "TRUE",
			"autoPilot_str_false":  "FALSE",
			"autoPilot_str_1":      "1",
			"autoPilot_str_0":      "0",
			"autoPilot_str_junk":   "not_a_bool",
			"autoPilot_num_pos":    float64(100),
			"autoPilot_num_zero":   float64(0),
			"autoPilot_num_neg":    float64(-1),
			"autoPilot_nil":        nil,
			"autoPilot_slice":      []interface{}{true, false},
			"autoPilot_map":        map[string]interface{}{"nested": true},

			// operationMode variations
			"mode_str_real":        "REAL",
			"mode_str_sim":         "SIM",
			"mode_str_spaces":      "  mode_real  ",
			"mode_str_invalid":     "interstellar_mode",
			"mode_num_1":           float64(1),
			"mode_num_0":           float64(0),
			"mode_num_invalid":     float64(42),
			"mode_bool_true":       true,
			"mode_bool_false":      false,
			"mode_nil":             nil,

			// scenario variations
			"scenario_empty":       "",
			"scenario_spaces":      "   \t\n  ",
			"scenario_sql_inject":  "'; DROP TABLE dashboard_state; --",
			"scenario_xss":         "<script>alert('pwned')</script>",
			"scenario_emojis":      "🔥❄️⚡️🚀",
			"scenario_long":        strings.Repeat("A", 10000),

			// buildingModel variations
			"buildingModel_path":   "../../../../etc/shadow",
			"buildingModel_empty":  "",
			"buildingModel_alias1": "house",
			"buildingModel_alias2": "tower",
			"buildingModel_alias3": "multi-level",
			"buildingModel_alias4": "DOMESTIC-HOME",
			"buildingModel_junk":   "non_existent_model_xyz",

			// activeFloor variations
			"activeFloor_neg":      float64(-999),
			"activeFloor_huge":     float64(1e12),
			"activeFloor_decimal":  3.1415926535,
			"activeFloor_string":   "B2-Basement",
			"activeFloor_nil":      nil,

			// Deeply nested maps
			"deep_nesting": map[string]interface{}{
				"level1": map[string]interface{}{
					"level2": map[string]interface{}{
						"level3": map[string]interface{}{
							"value": "deep_payload",
						},
					},
				},
			},

			// Large strings and special unicode
			"special_unicode":      "Hà Nội 🏢 Thành phố Hồ Chí Minh 🏛️",
		},
	}

	raw, err := json.MarshalIndent(extremeData, "", "  ")
	if err != nil {
		t.Fatalf("failed to marshal extreme test data: %v", err)
	}
	if err := os.WriteFile(stateFile, raw, 0644); err != nil {
		t.Fatalf("failed to write extreme state file: %v", err)
	}

	// 1. Cold boot store load
	store := NewStateStore(stateFile, nil)
	if len(store.GetAll()) < len(extremeData.Toggles) {
		t.Errorf("expected at least %d toggles, got %d", len(extremeData.Toggles), len(store.GetAll()))
	}

	// 2. Cold boot engine hook application
	engine := simulation.NewEngine()

	// Test autoPilot permutations
	testAutopilotKeys := []string{
		"autoPilot_str_true", "autoPilot_str_false", "autoPilot_str_1", "autoPilot_str_0",
		"autoPilot_str_junk", "autoPilot_num_pos", "autoPilot_num_zero", "autoPilot_num_neg",
		"autoPilot_nil", "autoPilot_slice", "autoPilot_map",
	}
	for _, k := range testAutopilotKeys {
		subStore := NewStateStore(stateFile, nil)
		subStore.Set("autoPilot", store.Get(k))
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("applyPersistentStateToEngine panicked on autoPilot=%v (%s): %v", store.Get(k), k, r)
				}
			}()
			applyPersistentStateToEngine(engine, subStore)
		}()
	}

	// Test operationMode permutations
	testModeKeys := []string{
		"mode_str_real", "mode_str_sim", "mode_str_spaces", "mode_str_invalid",
		"mode_num_1", "mode_num_0", "mode_num_invalid", "mode_bool_true", "mode_bool_false", "mode_nil",
	}
	for _, k := range testModeKeys {
		subStore := NewStateStore(stateFile, nil)
		subStore.Set("operationMode", store.Get(k))
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("applyPersistentStateToEngine panicked on operationMode=%v (%s): %v", store.Get(k), k, r)
				}
			}()
			applyPersistentStateToEngine(engine, subStore)
		}()
	}

	// Test scenario permutations
	testScenarioKeys := []string{
		"scenario_empty", "scenario_spaces", "scenario_sql_inject", "scenario_xss", "scenario_emojis", "scenario_long",
	}
	for _, k := range testScenarioKeys {
		subStore := NewStateStore(stateFile, nil)
		subStore.Set("scenario", store.Get(k))
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("applyPersistentStateToEngine panicked on scenario=%v (%s): %v", store.Get(k), k, r)
				}
			}()
			applyPersistentStateToEngine(engine, subStore)
		}()
	}

	// Test buildingModel permutations
	testModelKeys := []string{
		"buildingModel_path", "buildingModel_empty", "buildingModel_alias1",
		"buildingModel_alias2", "buildingModel_alias3", "buildingModel_alias4", "buildingModel_junk",
	}
	for _, k := range testModelKeys {
		subStore := NewStateStore(stateFile, nil)
		subStore.Set("buildingModel", store.Get(k))
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("applyPersistentStateToEngine panicked on buildingModel=%v (%s): %v", store.Get(k), k, r)
				}
			}()
			applyPersistentStateToEngine(engine, subStore)
		}()
	}
}

// TestStatePersistence_Adversarial_RESTHandlerStress hammers the HTTP endpoint
// /api/state with 50 concurrent goroutines sending valid, invalid, oversized, and edge-case requests.
func TestStatePersistence_Adversarial_RESTHandlerStress(t *testing.T) {
	tempDir := t.TempDir()
	stateFile := filepath.Join(tempDir, "rest-stress-state.json")
	store := NewStateStore(stateFile, nil)
	engine := simulation.NewEngine()
	handler := stateHandler(engine, store)

	goroutines := 50
	opsPerGoroutine := 20
	var wg sync.WaitGroup

	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		gid := i
		go func() {
			defer wg.Done()
			for j := 0; j < opsPerGoroutine; j++ {
				var req *http.Request
				rec := httptest.NewRecorder()

				switch (gid + j) % 7 {
				case 0: // Normal GET
					req = httptest.NewRequest(http.MethodGet, "/api/state", nil)
					handler(rec, req)
					if rec.Code != http.StatusOK {
						t.Errorf("GET /api/state returned code %d", rec.Code)
					}

				case 1: // GET with specific key
					req = httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/state?key=toggle_%d", gid%3), nil)
					handler(rec, req)
					if rec.Code != http.StatusOK {
						t.Errorf("GET /api/state?key returned code %d", rec.Code)
					}

				case 2: // Standard POST with toggles wrapper
					body, _ := json.Marshal(map[string]interface{}{
						"toggles": map[string]interface{}{
							fmt.Sprintf("toggle_%d", gid%3): j,
							"autoPilot":                     (j%2 == 0),
						},
					})
					req = httptest.NewRequest(http.MethodPost, "/api/state", bytes.NewReader(body))
					req.Header.Set("Content-Type", "application/json")
					handler(rec, req)
					if rec.Code != http.StatusOK {
						t.Errorf("POST with toggles returned code %d: %s", rec.Code, rec.Body.String())
					}

				case 3: // Single key/value POST
					body, _ := json.Marshal(map[string]interface{}{
						"key":   fmt.Sprintf("toggle_single_%d", gid%3),
						"value": j,
					})
					req = httptest.NewRequest(http.MethodPost, "/api/state", bytes.NewReader(body))
					req.Header.Set("Content-Type", "application/json")
					handler(rec, req)
					if rec.Code != http.StatusOK {
						t.Errorf("POST single key/value returned code %d: %s", rec.Code, rec.Body.String())
					}

				case 4: // Invalid JSON payload
					req = httptest.NewRequest(http.MethodPost, "/api/state", strings.NewReader(`{ invalid json syntax `))
					req.Header.Set("Content-Type", "application/json")
					handler(rec, req)
					if rec.Code != http.StatusBadRequest {
						t.Errorf("POST invalid JSON expected 400, got %d", rec.Code)
					}

				case 5: // Empty POST body
					req = httptest.NewRequest(http.MethodPost, "/api/state", strings.NewReader(`{}`))
					req.Header.Set("Content-Type", "application/json")
					handler(rec, req)
					if rec.Code != http.StatusBadRequest {
						t.Errorf("POST empty body expected 400, got %d", rec.Code)
					}

				case 6: // Disallowed HTTP Method
					req = httptest.NewRequest(http.MethodDelete, "/api/state", nil)
					handler(rec, req)
					if rec.Code != http.StatusMethodNotAllowed {
						t.Errorf("DELETE expected 405, got %d", rec.Code)
					}
				}
			}
		}()
	}

	wg.Wait()

	// Verify oversized payload rejection (> 1 MB limit)
	oversizedBody := make([]byte, 1024*1024*2) // 2 MB
	for i := range oversizedBody {
		oversizedBody[i] = 'a'
	}
	oversizedReq := httptest.NewRequest(http.MethodPost, "/api/state", bytes.NewReader(oversizedBody))
	oversizedRec := httptest.NewRecorder()
	handler(oversizedRec, oversizedReq)
	if oversizedRec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 Bad Request for >1MB body, got %d", oversizedRec.Code)
	}
}

// errorProneWsSender simulates a WebSocket client that occasionally fails writes (broken pipe).
type errorProneWsSender struct {
	mu           sync.Mutex
	failRate     int // fail every N writes
	writeCount   int
	successCount int
}

func (e *errorProneWsSender) WriteMessage(messageType int, data []byte) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.writeCount++
	if e.failRate > 0 && e.writeCount%e.failRate == 0 {
		return fmt.Errorf("simulated broken pipe / write failure")
	}
	e.successCount++
	return nil
}

// TestStatePersistence_Adversarial_WebSocketHubStress tests concurrent client registration,
// deregistration, and broadcasts including broken clients to verify zero deadlocks or panics.
func TestStatePersistence_Adversarial_WebSocketHubStress(t *testing.T) {
	goroutines := 40
	var wg sync.WaitGroup

	// Register 20 error-prone clients
	clients := make([]*errorProneWsSender, 20)
	for i := range clients {
		clients[i] = &errorProneWsSender{failRate: (i % 3) + 1}
		RegisterStateWsClient(clients[i])
	}

	// Concurrently broadcast and dynamically register/unregister clients
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		gid := i
		go func() {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				if gid%4 == 0 {
					// Dynamic register / unregister
					tempClient := &errorProneWsSender{failRate: 1}
					RegisterStateWsClient(tempClient)
					BroadcastStateUpdate("tempKey", j, nil)
					UnregisterStateWsClient(tempClient)
				} else if gid%4 == 1 {
					// Single update broadcast with exclusion
					exclude := clients[j%len(clients)]
					BroadcastStateUpdate(fmt.Sprintf("key_%d", j), j, exclude)
				} else {
					// Batch update broadcast
					batch := map[string]interface{}{
						"autoPilot":   (j%2 == 0),
						"activeFloor": j % 5,
					}
					BroadcastStateBatch(batch, nil)
				}
			}
		}()
	}

	wg.Wait()

	// Clean up all clients
	for _, c := range clients {
		UnregisterStateWsClient(c)
	}
}
