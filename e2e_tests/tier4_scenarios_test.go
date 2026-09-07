package e2e_tests

import (
	"encoding/json"
	"math"
	"testing"
	"time"

	"econ/simulation"
)

// =============================================================================
// TIER 4: REAL-WORLD APPLICATION SCENARIOS
// Scenario: Full Building Operations "Day-in-the-Life" Lifecycle
// Lifecycle Steps:
//   Phase 1: Cold start initialization in Simulation Mode & hardware inspection
//   Phase 2: Hardware Inspector manual actuation (IR blaster, lighting, setpoints)
//   Phase 3: Transition to Real Mode & strict mock rejection under live telemetry
//   Phase 4: Local AI peak load forecasting (LSTM regressor & TimesFM foundation)
//   Phase 5: Automated & manual peak demand mitigation (plug shed & damper modulation)
//   Phase 6: End-of-day Sustainability carbon accounting & offset certification quote
// =============================================================================

func TestTier4_FullBuildingOperationsDayInLife(t *testing.T) {
	wrapper := SetupTestEngineWithWrapper()
	engine := wrapper.Engine

	// -------------------------------------------------------------------------
	// Phase 1: Cold-Start Initialization in Simulation Mode
	// -------------------------------------------------------------------------
	t.Log("--- Phase 1: Cold-Start Initialization in Simulation Mode ---")
	if engine.IsRealMode() {
		t.Fatalf("expected initial state to be Simulation Mode")
	}

	// Verify all 3 primary building zones are present and initialized
	expectedZones := []string{"zone-office-a", "zone-boardroom", "zone-server-room"}
	for _, zid := range expectedZones {
		z, exists := engine.Zones[zid]
		if !exists {
			t.Fatalf("zone %s missing from digital twin", zid)
		}
		if !z.Live {
			t.Errorf("zone %s not marked live", zid)
		}
	}

	// Ingest synthetic morning baseline telemetry in simulation mode
	simTemp := 22.0
	isSim := true
	err := engine.IngestTelemetry("zone-office-a", "esp32-office-01", simulation.Measurement{
		Temp:      &simTemp,
		TempReal:  true,
		Simulated: &isSim,
		Source:    "sim",
	})
	if err != nil {
		t.Fatalf("simulation mode rejected synthetic morning telemetry: %v", err)
	}

	// -------------------------------------------------------------------------
	// Phase 2: Hardware Inspector Manual Actuation
	// -------------------------------------------------------------------------
	t.Log("--- Phase 2: Hardware Inspector Manual Actuation ---")
	wrapper.ClearCommands()

	// Operator commands office HVAC via IR blaster, illuminates lighting relay, sets setpoint
	irCode := "IR_SEND:COOLIX:0xB27BE0:32"
	compoundCmd := "LIGHTS_ON;SETPOINT=22.5;" + irCode
	engine.PublishCommand(compoundCmd, "zone-office-a")

	lastCmd, ok := wrapper.LastCommand()
	if !ok {
		t.Fatalf("expected manual command to be published to MQTT")
	}
	if lastCmd.Topic != "econ/commands/esp32-office-01" {
		t.Errorf("expected topic 'econ/commands/esp32-office-01', got %q", lastCmd.Topic)
	}
	if lastCmd.Payload != compoundCmd {
		t.Errorf("expected payload %q, got %q", compoundCmd, lastCmd.Payload)
	}

	zOffice := engine.Zones["zone-office-a"]
	if !zOffice.LightsOn {
		t.Errorf("LightsOn not updated")
	}
	if zOffice.Setpoint != 22.5 {
		t.Errorf("Setpoint not updated to 22.5, got %f", zOffice.Setpoint)
	}
	if zOffice.IrState == nil || *zOffice.IrState != irCode {
		t.Errorf("IrState not updated to %q, got %v", irCode, zOffice.IrState)
	}

	// -------------------------------------------------------------------------
	// Phase 3: Transition to Real Operation Mode
	// -------------------------------------------------------------------------
	t.Log("--- Phase 3: Transition to Real Operation Mode ---")
	engine.SetMode(simulation.ModeReal)
	if !engine.IsRealMode() {
		t.Fatalf("failed to switch engine to Real Mode")
	}

	// 3.1 Verify concurrent mock injection is strictly blocked
	isMock := true
	err = engine.IngestTelemetry("zone-office-a", "esp32", simulation.Measurement{
		Temp:     &simTemp,
		TempReal: true,
		Mock:     &isMock,
	})
	if err == nil {
		t.Fatalf("security violation: mock telemetry was accepted in Real Mode")
	}

	// 3.2 Ingest genuine physical sensor telemetry across all zones
	now := time.Now()
	_ = now
	stripOffice := 1850.0 // ACS712 measuring office power strip
	cbOffice := 3400.0    // SCT-013 clamp measuring zone circuit breaker
	tempOffice := 23.1

	err = engine.IngestTelemetry("zone-office-a", "esp32-office-01", simulation.Measurement{
		Temp:            &tempOffice,
		TempReal:        true,
		StripW:          &stripOffice,
		CircuitBreakerW: &cbOffice,
		Source:          "esp32",
	})
	if err != nil {
		t.Fatalf("genuine telemetry was rejected in Real Mode: %v", err)
	}

	if zOffice.HwStripW != stripOffice {
		t.Errorf("expected HwStripW=%f, got %f", stripOffice, zOffice.HwStripW)
	}
	if zOffice.HwCircuitBreakerW != cbOffice {
		t.Errorf("expected HwCircuitBreakerW=%f, got %f", cbOffice, zOffice.HwCircuitBreakerW)
	}
	if zOffice.HwPlugW != cbOffice {
		t.Errorf("expected HwPlugW mapped from CB=%f, got %f", cbOffice, zOffice.HwPlugW)
	}

	// -------------------------------------------------------------------------
	// Phase 4: Local AI Live Inference (Peak Forecast)
	// -------------------------------------------------------------------------
	t.Log("--- Phase 4: Local AI Live Inference ---")
	// Assemble 12-timestep sequence of real physical conditions
	sequence := make([][]float64, 12)
	for i := 0; i < 12; i++ {
		sequence[i] = []float64{23.0 + float64(i)*0.1, 400.0 + float64(i)*10.0}
	}
	aiInput := map[string]interface{}{
		"sensor_sequence":  sequence,
		"outdoor_temp":     35.5,
		"outdoor_humidity": 68.0,
	}
	rawInput, _ := json.Marshal(aiInput)
	outBytes, err := ExecutePythonInference("lstm", string(rawInput))
	if err != nil {
		t.Fatalf("live AI model inference failed: %v", err)
	}

	var aiResult struct {
		Status            string  `json:"status"`
		Engine            string  `json:"engine"`
		PredictedPeakLoad float64 `json:"predicted_peak_load"`
	}
	if err := json.Unmarshal(outBytes, &aiResult); err != nil {
		t.Fatalf("failed to decode AI result: %v", err)
	}
	if aiResult.Status != "ok" {
		t.Errorf("expected status 'ok', got %q", aiResult.Status)
	}
	t.Logf("Local AI Model Predicted Peak Cooling Load: %.3f MW", aiResult.PredictedPeakLoad)

	// -------------------------------------------------------------------------
	// Phase 5: Peak Demand Mitigation (Plug Shed & VAV Modulation)
	// -------------------------------------------------------------------------
	t.Log("--- Phase 5: Peak Demand Mitigation ---")
	// Predicted peak demands active curtailment: shed switchable socket loads and modulate damper
	engine.PublishCommand("PLUG_OFF", "zone-office-a")
	engine.PublishCommand("DAMPER=20", "zone-office-a")

	if !zOffice.PlugShed {
		t.Errorf("expected PlugShed=true after mitigation command")
	}
	if math.Abs(zOffice.DamperPos-0.20) > 0.01 {
		t.Errorf("expected DamperPos=0.20 after mitigation, got %f", zOffice.DamperPos)
	}

	vav := engine.Vavs["vav-office-a"]
	if vav != nil && math.Abs(vav.DamperPos-0.20) > 0.01 {
		t.Errorf("expected VAV DamperPos=0.20, got %f", vav.DamperPos)
	}

	// -------------------------------------------------------------------------
	// Phase 6: Sustainability Carbon Accounting & Offset Certification
	// -------------------------------------------------------------------------
	t.Log("--- Phase 6: Sustainability Accounting & Offset Certification ---")
	// Operating load across 24 hours:
	// 8 hours morning peak (5,000 W) + 8 hours mitigated afternoon (3,500 W) + 8 hours night (1,500 W)
	morningKwh := (5000.0 / 1000.0) * 8.0
	afternoonKwh := (3500.0 / 1000.0) * 8.0
	nightKwh := (1500.0 / 1000.0) * 8.0
	totalDayKwh := morningKwh + afternoonKwh + nightKwh // 40 + 28 + 12 = 80 kWh

	gridFactor := 0.6766 // Vietnam grid emission factor (kgCO2e/kWh)
	totalDayEmissionsKg := totalDayKwh * gridFactor     // 80 * 0.6766 = 54.128 kgCO2e

	if math.Abs(totalDayEmissionsKg-54.128) > 1e-4 {
		t.Errorf("expected 54.128 kgCO2e total daily emissions, got %f", totalDayEmissionsKg)
	}

	targetBudgetKg := 50.0
	pricePerTonUSD := 12.50

	deficitKg, certsNeeded, totalOffsetCost := CalculateExpectedCarbonCreditOffset(
		targetBudgetKg, totalDayEmissionsKg, pricePerTonUSD,
	)

	// Deficit: 54.128 - 50.0 = 4.128 kgCO2e
	if math.Abs(deficitKg-4.128) > 1e-4 {
		t.Errorf("expected deficit=4.128 kgCO2e, got %f", deficitKg)
	}
	// 4.128 kg deficit requires 1 whole certificate (1 metric ton = 1,000 kgCO2e ceiling)
	if certsNeeded != 1 {
		t.Errorf("expected 1 whole certificate needed, got %d", certsNeeded)
	}
	// Cost: 1 * $12.50 = $12.50
	if math.Abs(totalOffsetCost-12.50) > 1e-4 {
		t.Errorf("expected total offset cost=$12.50, got %f", totalOffsetCost)
	}

	t.Logf("End-of-Day Sustainability Audit: Total Scope 2 Emissions: %.2f kgCO2e (Budget: %.1f kgCO2e)",
		totalDayEmissionsKg, targetBudgetKg)
	t.Logf("Carbon Credit Offset Quote: Deficit: %.3f kgCO2e -> %d Certificate(s) Needed ($%.2f USD)",
		deficitKg, certsNeeded, totalOffsetCost)
}
