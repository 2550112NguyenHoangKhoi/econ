package main

import (
	"econ/simulation"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// End-to-end cover for the actuation-capability gate: that the engine's REAL mode reaches
// the recommendation pass at all, and that simulation mode is left exactly as it was.
//
// The unit cover for the rule itself lives in simulation/capability_test.go. What is
// checked here is the wiring — mode → capability snapshot → report — through the same
// public entry point the dashboard polls.

// vacantAcRecs returns just the AC recommendations for a zone.
func vacantAcRecs(rep simulation.RecommendationReport, zone string) []simulation.Recommendation {
	var out []simulation.Recommendation
	for _, r := range rep.Recommendations {
		if r.Zone == zone && strings.HasPrefix(r.Id, "vacant_ac:") {
			out = append(out, r)
		}
	}
	return out
}

// makeVacant puts the zone in the state that used to produce "Room Vacant but AC may be
// ON": nobody in it, PIR clear, and no report of the air conditioner either way.
func makeVacant(t *testing.T, e *simulation.Engine, zoneID string) {
	t.Helper()
	occZero := 0
	pirFalse := false
	if err := e.IngestTelemetry(zoneID, zoneID, simulation.Measurement{
		Occupancy: &occZero,
		PirState:  &pirFalse,
	}); err != nil {
		t.Fatalf("ingest: %v", err)
	}
}

// TestRealMode_NoAcHardware_NoAcRecommendation is the regression this whole change exists
// for. A vacant room whose air conditioner nothing has ever reported on must not produce
// "turn off the AC" in real mode: there is no measurement behind the claim.
func TestRealMode_NoAcHardware_NoAcRecommendation(t *testing.T) {
	engine, _ := setupTestEngineWithZone("zone-office-a")
	engine.SetMode(simulation.ModeReal)
	makeVacant(t, engine, "zone-office-a")

	rep := engine.Recommendations(8)
	if got := vacantAcRecs(rep, "zone-office-a"); len(got) != 0 {
		t.Fatalf("real mode must not recommend switching off an AC it has never observed, got %+v", got)
	}
	if !rep.Model.RealMode {
		t.Error("the report must say the capability gate was applied, so a short list can be read correctly")
	}
}

// TestSimulationMode_KeepsAcRecommendation: the gate is real-mode only. In simulation the
// twin models the air conditioner it is talking about, so the advice still stands and the
// existing demo behaviour is unchanged.
func TestSimulationMode_KeepsAcRecommendation(t *testing.T) {
	engine, _ := setupTestEngineWithZone("zone-office-a")
	engine.SetMode(simulation.ModeSimulation)
	makeVacant(t, engine, "zone-office-a")

	rep := engine.Recommendations(8)
	if got := vacantAcRecs(rep, "zone-office-a"); len(got) == 0 {
		t.Fatalf("simulation mode must be unaffected by the hardware gate, got %+v", rep.Recommendations)
	}
	if rep.Model.RealMode {
		t.Error("simulation mode must not claim the gate was applied")
	}
}

// TestRealMode_MeteredAcInVacantRoom_IsRecommended: once a clamp actually measures the
// compressor drawing in an empty room, the recommendation is grounded and comes back —
// with its action, because the node has confirmed its IR control reaches the machine.
func TestRealMode_MeteredAcInVacantRoom_IsRecommended(t *testing.T) {
	engine, _ := setupTestEngineWithZone("zone-office-a")
	engine.SetMode(simulation.ModeReal)

	occZero := 0
	pirFalse := false
	acReal := true
	// Expressed against the library's own threshold, not a literal, so recalibrating the
	// coefficient cannot silently invalidate this test.
	acW := simulation.Phys().AcRunningThresholdW * 4
	if err := engine.IngestTelemetry("zone-office-a", "zone-office-a", simulation.Measurement{
		Occupancy: &occZero,
		PirState:  &pirFalse,
		AcReal:    &acReal,
		AcW:       &acW,
		Source:    "esp32",
		TempReal:  true,
	}); err != nil {
		t.Fatalf("ingest: %v", err)
	}
	// Ingesting telemetry is itself the proof the node is alive; the engine marks it
	// online on arrival, exactly as it does for a real node on the broker.

	rep := engine.Recommendations(8)
	got := vacantAcRecs(rep, "zone-office-a")
	if len(got) == 0 {
		t.Fatalf("a measured compressor running in an empty room is exactly what should be reported, got %+v", rep.Recommendations)
	}
	if got[0].Action != "turn_off_ac" {
		t.Fatalf("a confirmed IR path must keep its remediation, got %q", got[0].Action)
	}
	if rep.Hardware.AcMetered != 1 {
		t.Errorf("expected the AC clamp to be counted in the hardware reach, got %+v", rep.Hardware)
	}
	if rep.Hardware.AcControlled != 1 {
		t.Errorf("expected the confirmed AC control to be counted, got %+v", rep.Hardware)
	}
}

// TestRealMode_HardwareReachIsReported: the panel needs to distinguish "nothing is wrong"
// from "nothing is wired", and that is only possible if the payload counts what the twin
// can actually reach.
func TestRealMode_HardwareReachIsReported(t *testing.T) {
	engine, _ := setupTestEngineWithZone("zone-office-a")
	engine.SetMode(simulation.ModeReal)
	makeVacant(t, engine, "zone-office-a")

	rep := engine.Recommendations(8)
	if rep.Hardware.Zones != 1 {
		t.Fatalf("expected 1 modelled zone, got %+v", rep.Hardware)
	}
	if rep.Hardware.AcControlled != 0 || rep.Hardware.AcMetered != 0 {
		t.Errorf("no AC hardware was reported, so none may be counted: %+v", rep.Hardware)
	}
	if rep.Hardware.AcUnknown != 1 {
		t.Errorf("a bound node that never reported its AC control must count as unknown, not as absent: %+v", rep.Hardware)
	}

	// And the same facts must survive the JSON boundary the dashboard reads them over.
	rr := httptest.NewRecorder()
	recommendationsHandler(engine)(rr, httptest.NewRequest(http.MethodGet, "/api/recommendations", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("GET /api/recommendations: %d", rr.Code)
	}
	var wire struct {
		Model struct {
			RealMode bool `json:"realMode"`
		} `json:"model"`
		Hardware simulation.HardwareReach `json:"hardware"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &wire); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !wire.Model.RealMode {
		t.Error("realMode must reach the dashboard")
	}
	if wire.Hardware.Zones != 1 || wire.Hardware.AcUnknown != 1 {
		t.Errorf("hardware reach must reach the dashboard intact, got %+v", wire.Hardware)
	}
}
