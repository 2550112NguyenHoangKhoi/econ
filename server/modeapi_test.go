package main

import (
	"bytes"
	"econ/simulation"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func bp(b bool) *bool { return &b }
func ip(i int) *int { return &i }
func fp(f float64) *float64 { return &f }

func TestModeAPI_Get(t *testing.T) {
	engine := simulation.NewEngine()
	engine.SetMode(simulation.ModeSimulation)

	handler := modeHandler(engine, nil)
	req := httptest.NewRequest(http.MethodGet, "/api/mode", nil)
	rec := httptest.NewRecorder()

	handler(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}

	if origin := rec.Header().Get("Access-Control-Allow-Origin"); origin != "*" {
		t.Errorf("expected Access-Control-Allow-Origin: *, got %q", origin)
	}

	var res modeResponse
	if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if !res.OK {
		t.Errorf("expected ok=true, got %v", res.OK)
	}
	if res.Mode != "simulation" {
		t.Errorf("expected mode='simulation', got %q", res.Mode)
	}
	if res.ModeInt != 0 {
		t.Errorf("expected mode_int=0, got %d", res.ModeInt)
	}
	if res.IsReal || res.IsRealCamel {
		t.Errorf("expected is_real=false, got is_real=%v, isReal=%v", res.IsReal, res.IsRealCamel)
	}
	if !strings.Contains(strings.ToLower(res.Description), "simulation") {
		t.Errorf("expected description to mention simulation, got %q", res.Description)
	}
}

func TestModeAPI_PostFormats(t *testing.T) {
	engine := simulation.NewEngine()
	handler := modeHandler(engine, nil)

	cases := []struct {
		name        string
		method      string
		url         string
		body        string
		expectedCode int
		expectedMode string
		expectedReal bool
	}{
		{
			name:         "JSON mode 'real'",
			method:       http.MethodPost,
			url:          "/api/mode",
			body:         `{"mode":"real"}`,
			expectedCode: http.StatusOK,
			expectedMode: "real",
			expectedReal: true,
		},
		{
			name:         "JSON mode '1'",
			method:       http.MethodPost,
			url:          "/api/mode",
			body:         `{"mode":"1"}`,
			expectedCode: http.StatusOK,
			expectedMode: "real",
			expectedReal: true,
		},
		{
			name:         "JSON numeric mode 1",
			method:       http.MethodPost,
			url:          "/api/mode",
			body:         `{"mode":1}`,
			expectedCode: http.StatusOK,
			expectedMode: "real",
			expectedReal: true,
		},
		{
			name:         "JSON mode 'simulation'",
			method:       http.MethodPost,
			url:          "/api/mode",
			body:         `{"mode":"simulation"}`,
			expectedCode: http.StatusOK,
			expectedMode: "simulation",
			expectedReal: false,
		},
		{
			name:         "JSON mode 'sim'",
			method:       http.MethodPost,
			url:          "/api/mode",
			body:         `{"mode":"sim"}`,
			expectedCode: http.StatusOK,
			expectedMode: "simulation",
			expectedReal: false,
		},
		{
			name:         "JSON mode '0'",
			method:       http.MethodPost,
			url:          "/api/mode",
			body:         `{"mode":"0"}`,
			expectedCode: http.StatusOK,
			expectedMode: "simulation",
			expectedReal: false,
		},
		{
			name:         "JSON numeric mode 0",
			method:       http.MethodPost,
			url:          "/api/mode",
			body:         `{"mode":0}`,
			expectedCode: http.StatusOK,
			expectedMode: "simulation",
			expectedReal: false,
		},
		{
			name:         "Query parameter mode=real",
			method:       http.MethodPost,
			url:          "/api/mode?mode=real",
			body:         "",
			expectedCode: http.StatusOK,
			expectedMode: "real",
			expectedReal: true,
		},
		{
			name:         "Query parameter mode=0",
			method:       http.MethodPost,
			url:          "/api/mode?mode=0",
			body:         "",
			expectedCode: http.StatusOK,
			expectedMode: "simulation",
			expectedReal: false,
		},
		{
			name:         "Raw body 'real'",
			method:       http.MethodPost,
			url:          "/api/mode",
			body:         "real",
			expectedCode: http.StatusOK,
			expectedMode: "real",
			expectedReal: true,
		},
		{
			name:         "Invalid mode string",
			method:       http.MethodPost,
			url:          "/api/mode",
			body:         `{"mode":"invalid_test"}`,
			expectedCode: http.StatusBadRequest,
		},
		{
			name:         "Empty body and no query param",
			method:       http.MethodPost,
			url:          "/api/mode",
			body:         "",
			expectedCode: http.StatusBadRequest,
		},
		{
			name:         "Disallowed method PUT",
			method:       http.MethodPut,
			url:          "/api/mode",
			body:         `{"mode":"real"}`,
			expectedCode: http.StatusMethodNotAllowed,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var req *http.Request
			if tc.body != "" {
				req = httptest.NewRequest(tc.method, tc.url, bytes.NewBufferString(tc.body))
				req.Header.Set("Content-Type", "application/json")
			} else {
				req = httptest.NewRequest(tc.method, tc.url, nil)
			}
			rec := httptest.NewRecorder()

			handler(rec, req)

			if rec.Code != tc.expectedCode {
				t.Fatalf("expected status %d, got %d (body: %s)", tc.expectedCode, rec.Code, rec.Body.String())
			}

			if tc.expectedCode == http.StatusOK {
				var res modeResponse
				if err := json.NewDecoder(rec.Body).Decode(&res); err != nil {
					t.Fatalf("failed to decode response JSON: %v", err)
				}
				if res.Mode != tc.expectedMode {
					t.Errorf("expected mode %q, got %q", tc.expectedMode, res.Mode)
				}
				if res.IsReal != tc.expectedReal {
					t.Errorf("expected is_real %v, got %v", tc.expectedReal, res.IsReal)
				}
				if engine.IsRealMode() != tc.expectedReal {
					t.Errorf("expected engine.IsRealMode() == %v, got %v", tc.expectedReal, engine.IsRealMode())
				}
			}
		})
	}
}

func TestModeAPI_CORSPreflight(t *testing.T) {
	engine := simulation.NewEngine()
	handler := modeHandler(engine, nil)

	req := httptest.NewRequest(http.MethodOptions, "/api/mode", nil)
	rec := httptest.NewRecorder()

	handler(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204 No Content for preflight, got %d", rec.Code)
	}
	if rec.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Errorf("expected CORS origin header to be *")
	}
	if !strings.Contains(rec.Header().Get("Access-Control-Allow-Methods"), "POST") {
		t.Errorf("expected CORS methods to allow POST")
	}
}

func TestModeAPI_NilEngine(t *testing.T) {
	handler := modeHandler(nil, nil)
	req := httptest.NewRequest(http.MethodGet, "/api/mode", nil)
	rec := httptest.NewRecorder()

	handler(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 InternalServerError for nil engine, got %d", rec.Code)
	}
}

func TestModeAPI_SegregationIntegration(t *testing.T) {
	engine := simulation.NewEngine()
	handler := modeHandler(engine, nil)

	// Ensure there is at least one zone for ingestion
	zoneId := "zone-office-a"
	z := engine.Zones[zoneId]
	if z == nil {
		// Fallback to first available zone
		for k, v := range engine.Zones {
			zoneId = k
			z = v
			break
		}
	}
	if z == nil {
		t.Fatal("no zones loaded in test engine")
	}

	// 1. In Simulation mode: mock payloads accepted
	setSimReq := httptest.NewRequest(http.MethodPost, "/api/mode", bytes.NewBufferString(`{"mode":"simulation"}`))
	setSimReq.Header.Set("Content-Type", "application/json")
	recSim := httptest.NewRecorder()
	handler(recSim, setSimReq)
	if recSim.Code != http.StatusOK {
		t.Fatalf("failed to set simulation mode: %d", recSim.Code)
	}

	mockPayload := simulation.Measurement{
		Mock:      bp(true),
		Source:    "mock",
		Occupancy: ip(7),
	}
	if err := engine.IngestTelemetry(zoneId, "sim_node", mockPayload); err != nil {
		t.Fatalf("mock payload rejected in simulation mode: %v", err)
	}
	if z.Occupancy != 7 {
		t.Errorf("expected occupancy 7 in simulation mode, got %d", z.Occupancy)
	}

	// 2. Switch to Real mode via POST /api/mode
	setRealReq := httptest.NewRequest(http.MethodPost, "/api/mode", bytes.NewBufferString(`{"mode":"real"}`))
	setRealReq.Header.Set("Content-Type", "application/json")
	recReal := httptest.NewRecorder()
	handler(recReal, setRealReq)
	if recReal.Code != http.StatusOK {
		t.Fatalf("failed to switch to real mode: %d", recReal.Code)
	}

	var realRes modeResponse
	if err := json.NewDecoder(recReal.Body).Decode(&realRes); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if !realRes.IsReal || realRes.Mode != "real" {
		t.Fatalf("expected is_real=true and mode='real', got %+v", realRes)
	}
	if !engine.IsRealMode() {
		t.Fatal("expected engine.IsRealMode() to be true")
	}

	// 3. In Real mode: mock payload MUST be strictly rejected
	mockPayload2 := simulation.Measurement{
		Mock:      bp(true),
		Source:    "mock",
		Occupancy: ip(12),
	}
	err := engine.IngestTelemetry(zoneId, "sim_node", mockPayload2)
	if err == nil {
		t.Fatal("expected mock payload to be strictly rejected in Real Mode, but got nil error")
	}
	// Zone occupancy remains unchanged at 7
	if z.Occupancy != 7 {
		t.Errorf("expected occupancy to remain 7 after rejected mock payload, got %d", z.Occupancy)
	}

	// Also test synthetic source rejected in Real Mode
	synthPayload := simulation.Measurement{
		Source:    "synthetic",
		Occupancy: ip(20),
	}
	if err := engine.IngestTelemetry(zoneId, "node_synth", synthPayload); err == nil {
		t.Fatal("expected synthetic source to be rejected in Real Mode")
	}

	// 4. In Real mode: genuine physical telemetry with stripW maps to plugs
	stripWatts := 345.2
	stripPayload := simulation.Measurement{
		StripW:   fp(stripWatts),
		Source:   "esp32",
		TempReal: true,
	}
	if err := engine.IngestTelemetry(zoneId, "esp32_node", stripPayload); err != nil {
		t.Fatalf("genuine stripW payload rejected in Real Mode: %v", err)
	}
	if z.HwStripW != stripWatts {
		t.Errorf("expected z.HwStripW == %v, got %v", stripWatts, z.HwStripW)
	}

	// 5. In Real mode: genuine physical telemetry with CircuitBreakerW maps to plugW
	cbWatts := 1820.5
	cbPayload := simulation.Measurement{
		CircuitBreakerW: fp(cbWatts),
		Source:          "esp32",
		TempReal:        true,
	}
	if err := engine.IngestTelemetry(zoneId, "esp32_subboard", cbPayload); err != nil {
		t.Fatalf("genuine CB payload rejected in Real Mode: %v", err)
	}
	if z.HwPlugW != cbWatts {
		t.Errorf("expected z.HwPlugW to map to CB watts %v, got %v", cbWatts, z.HwPlugW)
	}
	if z.HwCircuitBreakerW != cbWatts {
		t.Errorf("expected z.HwCircuitBreakerW == %v, got %v", cbWatts, z.HwCircuitBreakerW)
	}

	// 6. Switch back to Simulation mode via POST /api/mode {"mode":"sim"}
	setSimReq2 := httptest.NewRequest(http.MethodPost, "/api/mode", bytes.NewBufferString(`{"mode":"sim"}`))
	setSimReq2.Header.Set("Content-Type", "application/json")
	recSim2 := httptest.NewRecorder()
	handler(recSim2, setSimReq2)
	if recSim2.Code != http.StatusOK {
		t.Fatalf("failed to switch back to simulation mode: %d", recSim2.Code)
	}
	if engine.IsRealMode() {
		t.Fatal("expected engine to be in Simulation mode")
	}

	// In Simulation mode, mock payload succeeds again
	if err := engine.IngestTelemetry(zoneId, "sim_node", mockPayload); err != nil {
		t.Fatalf("mock payload rejected after switching back to Simulation Mode: %v", err)
	}
}
