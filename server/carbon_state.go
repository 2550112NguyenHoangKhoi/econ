package main

import (
	"econ/simulation"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"
)

// Persistence and the HTTP surface for sustainability accounting.
//
// Cumulative emissions and equipment runtime are the two quantities in carbon.go that must
// survive a restart -- they are integrals, and restarting the engine must not reset the
// building's year to zero. State is keyed by building id so switching fixtures does not
// mix one building's ledger into another's.

// Persistence functions

func loadSustainabilityState(tracker *CarbonTracker, currentBuildingId string) {
	data, err := os.ReadFile(sustainabilityStatePath)
	if err != nil {
		return
	}
	var s sustainabilityState
	if err := json.Unmarshal(data, &s); err != nil {
		log.Printf("[carbon] state unreadable, starting fresh: %v", err)
		return
	}
	if s.BuildingId != "" && currentBuildingId != "" && s.BuildingId != currentBuildingId {
		log.Printf("[carbon] state belongs to %q but loaded building is %q; discarding cumulative emissions", s.BuildingId, currentBuildingId)
		return
	}
	tracker.mu.Lock()
	tracker.cumulativeEmissionsKgCO2e = s.CumulativeEmissionsKg
	if s.EquipmentRuntimeHours != nil {
		tracker.equipmentRuntimeHours = s.EquipmentRuntimeHours
	}
	tracker.mu.Unlock()
	log.Printf("[carbon] restored state: cumulative=%.2f kgCO2e, %d equipment runtime trackers",
		s.CumulativeEmissionsKg, len(s.EquipmentRuntimeHours))
}

func saveSustainabilityState(tracker *CarbonTracker, buildingId string) {
	tracker.mu.Lock()
	s := sustainabilityState{
		BuildingId:            buildingId,
		CumulativeEmissionsKg: tracker.cumulativeEmissionsKgCO2e,
		EquipmentRuntimeHours: tracker.equipmentRuntimeHours,
	}
	tracker.mu.Unlock()

	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return
	}
	if err := os.WriteFile(sustainabilityStatePath, data, 0644); err != nil {
		log.Printf("[carbon] save state failed: %v", err)
	}
}

func carbonPersistLoop(tracker *CarbonTracker, engine *simulation.Engine) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		buildingId := ""
		if engine != nil {
			buildingId = engine.BuildingId()
		}
		// Maintain background time progression even without client polling.
		tracker.Snapshot(engine, time.Now())
		saveSustainabilityState(tracker, buildingId)
	}
}

// sustainabilityHandler handles GET /api/sustainability and OPTIONS CORS preflight.
func sustainabilityHandler(engine *simulation.Engine, tracker *CarbonTracker) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if corsPreflight(w, r) {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		payload := tracker.Snapshot(engine, time.Now())
		if err := json.NewEncoder(w).Encode(payload); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}
	}
}
