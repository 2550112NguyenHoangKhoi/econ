package main

import (
	"econ/simulation"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestSustainabilityHandler_HTTPMethods verifies HTTP method routing:
// GET -> 200 with full sustainability payload
// OPTIONS -> 204 No Content with CORS headers
// POST/PUT/DELETE -> 405 Method Not Allowed
func TestSustainabilityHandler_HTTPMethods(t *testing.T) {
	engine := &simulation.Engine{
		Zones: map[string]*simulation.ZoneSim{
			"zone-main": {
				Type:      "open-office",
				AreaM2:    150.0,
				Occupancy: 12,
				HwPlugW:   1800.0,
				HwStripW:  600.0,
				HwAcW:     2200.0,
			},
		},
	}
	tracker := newCarbonTracker(engine)
	tracker.SetCumulativeEmissions(25.5)

	handler := sustainabilityHandler(engine, tracker)

	// 1. OPTIONS CORS preflight
	optReq := httptest.NewRequest(http.MethodOptions, "/api/sustainability", nil)
	optRec := httptest.NewRecorder()
	handler(optRec, optReq)
	if optRec.Code != http.StatusNoContent {
		t.Fatalf("expected OPTIONS 204, got %d", optRec.Code)
	}
	if optRec.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Errorf("expected Access-Control-Allow-Origin: *")
	}

	// 2. GET request
	getReq := httptest.NewRequest(http.MethodGet, "/api/sustainability", nil)
	getRec := httptest.NewRecorder()
	handler(getRec, getReq)
	if getRec.Code != http.StatusOK {
		t.Fatalf("expected GET 200, got %d: %s", getRec.Code, getRec.Body.String())
	}
	if getRec.Header().Get("Content-Type") != "application/json" {
		t.Errorf("expected Content-Type application/json, got %s", getRec.Header().Get("Content-Type"))
	}

	var payload SustainabilityPayload
	if err := json.Unmarshal(getRec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("failed to unmarshal JSON: %v", err)
	}

	// Validate CarbonAccounting
	if payload.CarbonAccounting.InstantaneousPowerW != 4600.0 {
		t.Errorf("expected 4600.0W total power, got %f", payload.CarbonAccounting.InstantaneousPowerW)
	}
	if payload.CarbonAccounting.Breakdown.PlugW != 1800.0 ||
		payload.CarbonAccounting.Breakdown.StripW != 600.0 ||
		payload.CarbonAccounting.Breakdown.AcW != 2200.0 {
		t.Errorf("breakdown mismatch: %+v", payload.CarbonAccounting.Breakdown)
	}
	if payload.CarbonAccounting.CumulativeEmissionsKgCO2e != 25.5 {
		t.Errorf("expected cumulative emissions 25.5, got %f", payload.CarbonAccounting.CumulativeEmissionsKgCO2e)
	}

	// Validate SpaceUtilization
	if payload.SpaceUtilization.TotalLiveOccupants != 12 {
		t.Errorf("expected 12 live occupants, got %d", payload.SpaceUtilization.TotalLiveOccupants)
	}

	// 3. Disallowed methods (POST, PUT, DELETE)
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		req := httptest.NewRequest(method, "/api/sustainability", nil)
		rec := httptest.NewRecorder()
		handler(rec, req)
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("expected %s to return 405 Method Not Allowed, got %d", method, rec.Code)
		}
	}
}

// TestSustainability_ZeroOccupancyAndEmptyZones verifies behavior when zones have zero occupants or no load.
func TestSustainability_ZeroOccupancyAndEmptyZones(t *testing.T) {
	engine := &simulation.Engine{
		Zones: map[string]*simulation.ZoneSim{
			"zone-empty": {
				Type:      "cellular-office",
				AreaM2:    30.0,
				Occupancy: 0,
				HwPlugW:   0.0,
				HwStripW:  0.0,
				HwAcW:     0.0,
			},
		},
	}
	tracker := newCarbonTracker(engine)
	tracker.SetCumulativeEmissions(0.0)

	handler := sustainabilityHandler(engine, tracker)

	req := httptest.NewRequest(http.MethodGet, "/api/sustainability", nil)
	rec := httptest.NewRecorder()
	handler(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", rec.Code)
	}

	var payload SustainabilityPayload
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("failed to parse JSON: %v", err)
	}

	if payload.CarbonAccounting.InstantaneousPowerW != 0.0 {
		t.Errorf("expected 0.0 power, got %f", payload.CarbonAccounting.InstantaneousPowerW)
	}
	if payload.SpaceUtilization.TotalLiveOccupants != 0 {
		t.Errorf("expected 0 live occupants, got %d", payload.SpaceUtilization.TotalLiveOccupants)
	}
	if payload.SpaceUtilization.OverallEfficiencyPercent != 0.0 {
		t.Errorf("expected 0%% overall efficiency, got %f", payload.SpaceUtilization.OverallEfficiencyPercent)
	}
	if payload.CarbonCreditRecommendations.OverBudget {
		t.Errorf("expected not over budget when emissions are 0.0")
	}
}

// TestSustainability_OverBudgetOffsetMath tests multiple emission deficit points and ceiling certificate requirements.
func TestSustainability_OverBudgetOffsetMath(t *testing.T) {
	quote := MarketQuote{
		Source:                   "Toucan Protocol BCT (CoinGecko)",
		SpotPricePerMetricTonUSD: 20.0,
		Currency:                 "USD",
		IsLive:                   true,
		FetchedAt:                time.Now().UTC().Format(time.RFC3339),
	}

	// 1. Deficit = 1 kg (0.001 MT) -> whole certificate must be 1 (ceil)
	rec1 := CalculateOffsetRecommendation(51.0, 50.0, quote)
	if !rec1.OverBudget {
		t.Errorf("expected over budget")
	}
	if rec1.DeficitKgCO2e != 1.0 {
		t.Errorf("expected deficit 1.0 kg, got %f", rec1.DeficitKgCO2e)
	}
	if rec1.WholeCertificatesNeeded != 1 {
		t.Errorf("expected 1 whole certificate for 1kg deficit, got %d", rec1.WholeCertificatesNeeded)
	}
	if rec1.EstimatedCostUSD != 0.02 { // 0.001 * 20.0 = 0.02
		t.Errorf("expected 0.02 USD cost, got %f", rec1.EstimatedCostUSD)
	}

	// 2. Deficit = 1500 kg (1.5 MT) -> whole certificates must be 2
	rec2 := CalculateOffsetRecommendation(1550.0, 50.0, quote)
	if rec2.WholeCertificatesNeeded != 2 {
		t.Errorf("expected 2 whole certificates for 1.5 MT, got %d", rec2.WholeCertificatesNeeded)
	}
	if rec2.CreditsNeededMetricTons != 1.5 {
		t.Errorf("expected 1.5 metric tons, got %f", rec2.CreditsNeededMetricTons)
	}
	if rec2.EstimatedCostUSD != 30.0 { // 1.5 * 20.0 = 30.0
		t.Errorf("expected 30.0 USD cost, got %f", rec2.EstimatedCostUSD)
	}
}
