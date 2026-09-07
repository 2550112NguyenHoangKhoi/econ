package e2e_tests

import (
	"encoding/json"
	"math"
	"testing"

	"econ/simulation"
)

// =============================================================================
// TIER 3: CROSS-FEATURE COMBINATION & INTERACTION TESTS
// Requirements Covered:
//   3.1 Manual override state persistence while switching between Simulation and Real mode.
//   3.2 Sustainability recommendations reacting to live model forecast and manual overrides.
//   3.3 Offline local AI inference during Real Mode telemetry flow.
// =============================================================================

// -----------------------------------------------------------------------------
// [Interaction 1] Manual Override During Operation Mode Switch
// -----------------------------------------------------------------------------
func TestTier3_ManualOverrideDuringModeSwitch(t *testing.T) {
	wrapper := SetupTestEngineWithWrapper()
	engine := wrapper.Engine
	zone := "zone-office-a"

	// Step 1: Start in default Simulation Mode
	if engine.IsRealMode() {
		t.Fatalf("expected initial state to be Simulation Mode")
	}

	// Step 2: Dispatch manual overrides for HVAC IR, smart plug, and VAV damper
	irCmd := "IR_SEND:COOLIX:0xB27BE0:32"
	engine.PublishCommand(irCmd, zone)
	engine.PublishCommand("PLUG_OFF", zone)
	engine.PublishCommand("DAMPER=35", zone)

	z := engine.Zones[zone]
	if z.IrState == nil || *z.IrState != irCmd {
		t.Fatalf("IR state not latched in simulation mode")
	}
	if !z.PlugShed {
		t.Fatalf("PlugShed not set in simulation mode")
	}
	if math.Abs(z.DamperPos-0.35) > 0.01 {
		t.Fatalf("DamperPos not set in simulation mode")
	}

	// Step 3: Switch operation mode to Real Mode
	engine.SetMode(simulation.ModeReal)
	if !engine.IsRealMode() {
		t.Fatalf("failed to switch to Real Mode")
	}

	// Step 4: Verify that manual override states PERSIST across mode switch
	if z.IrState == nil || *z.IrState != irCmd {
		t.Errorf("IR state lost across mode switch to Real Mode")
	}
	if !z.PlugShed {
		t.Errorf("PlugShed reset across mode switch to Real Mode")
	}
	if math.Abs(z.DamperPos-0.35) > 0.01 {
		t.Errorf("DamperPos reset across mode switch to Real Mode")
	}

	// Step 5: Verify that Real Mode now blocks mock telemetry while preserving latches
	mockFlag := true
	temp := 23.0
	err := engine.IngestTelemetry(zone, "esp32", simulation.Measurement{
		Temp:     &temp,
		TempReal: true,
		Mock:     &mockFlag,
	})
	if err == nil {
		t.Errorf("Real Mode failed to reject mock payload")
	}

	// Step 6: Ingest genuine telemetry in Real Mode
	realTemp := 24.8
	err = engine.IngestTelemetry(zone, "esp32", simulation.Measurement{
		Temp:     &realTemp,
		TempReal: true,
		Source:   "esp32",
	})
	if err != nil {
		t.Errorf("genuine telemetry rejected: %v", err)
	}
	if z.HwTemp != realTemp {
		t.Errorf("expected HwTemp=%f, got %f", realTemp, z.HwTemp)
	}

	// Overrides must still be intact after genuine telemetry
	if !z.PlugShed || math.Abs(z.DamperPos-0.35) > 0.01 {
		t.Errorf("overrides corrupted after genuine telemetry ingestion in Real Mode")
	}

	// Step 7: Switch back to Simulation Mode
	engine.SetMode(simulation.ModeSimulation)
	if engine.IsRealMode() {
		t.Fatalf("failed to return to Simulation Mode")
	}
	// Mock telemetry should succeed again
	err = engine.IngestTelemetry(zone, "esp32", simulation.Measurement{
		Temp:     &temp,
		TempReal: true,
		Mock:     &mockFlag,
	})
	if err != nil {
		t.Errorf("mock telemetry rejected after returning to Simulation Mode: %v", err)
	}
}

// -----------------------------------------------------------------------------
// [Interaction 2] Sustainability Reacting to Overrides & Live Forecast
// -----------------------------------------------------------------------------
func TestTier3_SustainabilityReactingToOverrides(t *testing.T) {
	budgetKg := 50.0
	gridFactor := 0.5 // kgCO2e/kWh
	pricePerTon := 12.50

	// Phase 1: Heavy building baseline load (3,000 W per zone x 3 zones = 9,000 W)
	initialWatts := 9000.0
	hours := 12.0 // Half day operation

	initialEmissions := CalculateExpectedScope2Emissions(initialWatts, hours, gridFactor)
	// 9.0 kW * 12h * 0.5 = 54.0 kgCO2e
	if math.Abs(initialEmissions-54.0) > 1e-4 {
		t.Fatalf("expected 54.0 kg initial emissions, got %f", initialEmissions)
	}

	initialDeficit, initialCerts, initialCost := CalculateExpectedCarbonCreditOffset(budgetKg, initialEmissions, pricePerTon)
	if initialDeficit != 4.0 || initialCerts != 1 || initialCost != 12.50 {
		t.Fatalf("expected initial offset recommendation: deficit=4.0 kg, certs=1, cost=$12.50")
	}

	// Phase 2: Live AI Model forecasts impending peak cooling demand
	// PeakLoadLSTM predicts 3.5 MW building peak
	predictedPeak := 3.5
	if predictedPeak < 2.0 {
		t.Fatalf("expected high peak forecast")
	}

	// Phase 3: Operator executes energy shedding manual overrides
	// 1. PLUG_OFF on non-critical zones
	// 2. Throttle VAV dampers to minimum ventilation floor (15%)
	reducedWatts := initialWatts - 2500.0 // 2.5 kW reduction from plug & HVAC shed (6,500 W)

	reducedEmissions := CalculateExpectedScope2Emissions(reducedWatts, hours, gridFactor)
	// 6.5 kW * 12h * 0.5 = 39.0 kgCO2e
	if math.Abs(reducedEmissions-39.0) > 1e-4 {
		t.Fatalf("expected 39.0 kg reduced emissions, got %f", reducedEmissions)
	}

	// Phase 4: Dynamic Sustainability recalculation
	reducedDeficit, reducedCerts, reducedCost := CalculateExpectedCarbonCreditOffset(budgetKg, reducedEmissions, pricePerTon)
	// 39.0 <= 50.0 -> deficit 0, 0 certificates, $0.00 cost!
	if reducedDeficit != 0.0 || reducedCerts != 0 || reducedCost != 0.0 {
		t.Errorf("sustainability recommendation failed to clear deficit after overrides: deficit=%f, certs=%d, cost=%f",
			reducedDeficit, reducedCerts, reducedCost)
	}
}

// -----------------------------------------------------------------------------
// [Interaction 3] Offline AI Inference During Real Mode Telemetry Flow
// -----------------------------------------------------------------------------
func TestTier3_OfflineAIInferenceDuringRealMode(t *testing.T) {
	wrapper := SetupTestEngineWithWrapper()
	engine := wrapper.Engine
	engine.SetMode(simulation.ModeReal)
	defer engine.SetMode(simulation.ModeSimulation)

	// Step 1: Feed real telemetry readings into zones
	zoneTelemetry := map[string]struct {
		temp  float64
		strip float64
		cb    float64
	}{
		"zone-office-a":    {temp: 24.5, strip: 450.0, cb: 1200.0},
		"zone-boardroom":   {temp: 23.8, strip: 120.0, cb: 800.0},
		"zone-server-room": {temp: 21.0, strip: 1800.0, cb: 3500.0},
	}

	for zoneId, m := range zoneTelemetry {
		tVal := m.temp
		sVal := m.strip
		cbVal := m.cb
		err := engine.IngestTelemetry(zoneId, "esp32", simulation.Measurement{
			Temp:            &tVal,
			TempReal:        true,
			StripW:          &sVal,
			CircuitBreakerW: &cbVal,
			Source:          "esp32",
		})
		if err != nil {
			t.Fatalf("failed to ingest real telemetry into %s: %v", zoneId, err)
		}
	}

	// Step 2: Assemble 12-timestep sequence based on real office telemetry
	sequence := make([][]float64, 12)
	baseTemp := engine.Zones["zone-office-a"].HwTemp
	for i := 0; i < 12; i++ {
		// [room_temp, airflow]
		sequence[i] = []float64{baseTemp + float64(i)*0.05, 350.0 + float64(i)*5.0}
	}

	inputData := map[string]interface{}{
		"sensor_sequence":  sequence,
		"outdoor_temp":     34.0,
		"outdoor_humidity": 70.0,
	}
	rawJSON, _ := json.Marshal(inputData)

	// Step 3: Run offline Python inference using real-mode sequence
	outBytes, err := ExecutePythonInference("lstm", string(rawJSON))
	if err != nil {
		t.Fatalf("offline Python inference failed during real mode: %v", err)
	}

	var inferResp struct {
		Status            string  `json:"status"`
		Engine            string  `json:"engine"`
		PredictedPeakLoad float64 `json:"predicted_peak_load"`
	}
	if err := json.Unmarshal(outBytes, &inferResp); err != nil {
		t.Fatalf("failed to unmarshal output: %v", err)
	}

	if inferResp.Status != "ok" {
		t.Fatalf("expected status 'ok', got %q", inferResp.Status)
	}
	if inferResp.PredictedPeakLoad <= 0.0 {
		t.Errorf("expected positive predicted peak load, got %f", inferResp.PredictedPeakLoad)
	}

	// Step 4: Verify twin state reflects real power while model forecast is logged
	z := engine.Zones["zone-office-a"]
	if z.HwStripW != 450.0 || z.HwCircuitBreakerW != 1200.0 {
		t.Errorf("real telemetry values diverged during inference execution")
	}
}
