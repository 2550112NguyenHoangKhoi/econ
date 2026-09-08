package main

import (
	"database/sql"
	"econ/simulation"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const defaultDashboardStatePath = "./data/dashboard-state.json"

// DashboardState represents the serialized schema for dashboard toggles and preferences.
type DashboardState struct {
	BuildingId string                 `json:"buildingId"`
	UpdatedAt  time.Time              `json:"updatedAt"`
	Toggles    map[string]interface{} `json:"toggles"`
}

// StateStore provides a thread-safe dual-layer storage engine:
// 1. PostgreSQL table `dashboard_state` when db != nil
// 2. Atomic local JSON file storage (`./data/dashboard-state.json`) as durable fallback
type StateStore struct {
	mu       sync.RWMutex
	filePath string
	db       *sql.DB
	state    DashboardState
}

// NewStateStore initializes a StateStore and restores state from PostgreSQL or the local JSON file.
func NewStateStore(filePath string, db *sql.DB) *StateStore {
	if filePath == "" {
		filePath = defaultDashboardStatePath
	}
	s := &StateStore{
		filePath: filePath,
		db:       db,
		state: DashboardState{
			BuildingId: "home",
			UpdatedAt:  time.Now().UTC(),
			Toggles:    make(map[string]interface{}),
		},
	}
	s.load()
	return s
}

// load reads persistent state from PostgreSQL if db is reachable, or falls back to reading the local JSON file.
func (s *StateStore) load() {
	s.mu.Lock()
	defer s.mu.Unlock()

	loadedFromDB := false
	if s.db != nil {
		rows, err := s.db.Query(`SELECT key, value FROM dashboard_state`)
		if err == nil {
			defer rows.Close()
			count := 0
			for rows.Next() {
				var k string
				var rawVal []byte
				if err := rows.Scan(&k, &rawVal); err == nil {
					var val interface{}
					if json.Unmarshal(rawVal, &val) == nil {
						s.state.Toggles[k] = val
						count++
					}
				}
			}
			if count > 0 {
				loadedFromDB = true
				s.state.UpdatedAt = time.Now().UTC()
				log.Printf("[state] Loaded %d toggle keys from PostgreSQL database", count)
			}
		} else {
			log.Printf("[state] PostgreSQL query failed (%v), falling back to file", err)
		}
	}

	// If DB not used, or DB had 0 rows, check JSON file
	if !loadedFromDB {
		data, err := os.ReadFile(s.filePath)
		if err != nil {
			log.Printf("[state] No persistent state file at %s, starting with defaults", s.filePath)
			return
		}
		var loaded DashboardState
		if err := json.Unmarshal(data, &loaded); err != nil {
			log.Printf("[state] Unreadable state file at %s: %v", s.filePath, err)
			return
		}
		if loaded.BuildingId != "" {
			s.state.BuildingId = loaded.BuildingId
		}
		if !loaded.UpdatedAt.IsZero() {
			s.state.UpdatedAt = loaded.UpdatedAt
		}
		if loaded.Toggles != nil {
			for k, v := range loaded.Toggles {
				s.state.Toggles[k] = v
			}
		}
		log.Printf("[state] Restored %d persistent toggles from %s", len(s.state.Toggles), s.filePath)
	}
}

// Get retrieves a toggle value by key in a thread-safe manner, returning nil if not found.
func (s *StateStore) Get(key string) interface{} {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.state.Toggles == nil {
		return nil
	}
	return s.state.Toggles[key]
}

// GetOk retrieves a toggle value by key along with a boolean indicating presence.
func (s *StateStore) GetOk(key string) (interface{}, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.state.Toggles == nil {
		return nil, false
	}
	val, ok := s.state.Toggles[key]
	return val, ok
}

// GetAll returns a deep-safe copy of all stored toggles.
func (s *StateStore) GetAll() map[string]interface{} {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]interface{}, len(s.state.Toggles))
	for k, v := range s.state.Toggles {
		out[k] = v
	}
	return out
}

// Set sets a toggle value by key and updates the timestamp.
func (s *StateStore) Set(key string, val interface{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state.Toggles == nil {
		s.state.Toggles = make(map[string]interface{})
	}
	s.state.Toggles[key] = val
	s.state.UpdatedAt = time.Now().UTC()
}

// SetAll updates multiple toggle values atomically and updates the timestamp.
func (s *StateStore) SetAll(toggles map[string]interface{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state.Toggles == nil {
		s.state.Toggles = make(map[string]interface{})
	}
	for k, v := range toggles {
		s.state.Toggles[k] = v
	}
	s.state.UpdatedAt = time.Now().UTC()
}

// BuildingId returns the building identifier associated with this state.
func (s *StateStore) BuildingId() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.state.BuildingId == "" {
		return "home"
	}
	return s.state.BuildingId
}

// SetBuildingId sets the building identifier.
func (s *StateStore) SetBuildingId(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state.BuildingId = id
	s.state.UpdatedAt = time.Now().UTC()
}

// UpdatedAt returns the timestamp of the last state modification.
func (s *StateStore) UpdatedAt() time.Time {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.state.UpdatedAt
}

// Save persists the current state to PostgreSQL (if db != nil) and atomically to disk via a temp file.
func (s *StateStore) Save() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state.UpdatedAt = time.Now().UTC()

	// 1. Persist to PostgreSQL if connected
	if s.db != nil {
		tx, err := s.db.Begin()
		if err == nil {
			stmt, err := tx.Prepare(`
				INSERT INTO dashboard_state (key, value, updated_at, updated_by)
				VALUES ($1, $2, $3, $4)
				ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = $3, updated_by = $4
			`)
			if err == nil {
				for k, v := range s.state.Toggles {
					raw, marshalErr := json.Marshal(v)
					if marshalErr == nil {
						_, _ = stmt.Exec(k, raw, s.state.UpdatedAt, "system")
					}
				}
				stmt.Close()
			}
			_ = tx.Commit()
		}
	}

	// 2. Atomic write to local JSON file
	data, err := json.MarshalIndent(s.state, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal dashboard state: %w", err)
	}

	dir := filepath.Dir(s.filePath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create directory %s: %w", dir, err)
	}

	tmpFile := fmt.Sprintf("%s.tmp.%d", s.filePath, time.Now().UnixNano())
	if err := os.WriteFile(tmpFile, data, 0644); err != nil {
		return fmt.Errorf("failed to write temporary state file %s: %w", tmpFile, err)
	}

	if err := os.Rename(tmpFile, s.filePath); err != nil {
		_ = os.Remove(tmpFile)
		return fmt.Errorf("failed to atomically rename state file: %w", err)
	}

	return nil
}

// applyPersistentStateToEngine configures the running simulation engine to match the restored state store.
func applyPersistentStateToEngine(engine *simulation.Engine, store *StateStore) {
	if engine == nil || store == nil {
		return
	}

	// 1. AutoPilot
	if val, ok := store.GetOk("autoPilot"); ok {
		switch v := val.(type) {
		case bool:
			engine.SetAutoPilot(v)
		case string:
			lower := strings.ToLower(strings.TrimSpace(v))
			if lower == "true" || lower == "1" {
				engine.SetAutoPilot(true)
			} else if lower == "false" || lower == "0" {
				engine.SetAutoPilot(false)
			}
		case float64:
			engine.SetAutoPilot(v != 0)
		}
	}

	// 2. OperationMode (Simulation vs Real Mode)
	var modeVal interface{}
	if val, ok := store.GetOk("operationMode"); ok {
		modeVal = val
	} else if val, ok := store.GetOk("mode"); ok {
		modeVal = val
	}
	if modeVal != nil {
		if parsed, err := parseOperationMode(modeVal); err == nil {
			engine.SetMode(parsed)
		}
	}

	// 3. Scenario
	if val, ok := store.GetOk("scenario"); ok {
		if s, ok := val.(string); ok && strings.TrimSpace(s) != "" {
			engine.SetScenario(s)
		}
	}

	// 4. Building Model
	if val, ok := store.GetOk("buildingModel"); ok {
		if bldg, ok := val.(string); ok && bldg != "" && bldg != engine.BuildingId() {
			targetFile := simulation.ModelFileFor(bldg)
			if targetFile != "" {
				if data, err := os.ReadFile(simulation.DataPath(targetFile)); err == nil {
					_ = engine.ReloadBuilding(data)
				}
			}
		}
	}
}
