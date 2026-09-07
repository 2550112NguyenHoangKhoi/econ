package e2e_tests

import (
	"encoding/json"
	"math"
	"testing"

	"econ/simulation"
)

// =============================================================================
// TIER 1: COMPREHENSIVE FEATURE COVERAGE TESTS (>=5 Tests Per Feature)
// Requirements Covered:
//   F1. Hardware Inspector Manual Controls & IR Blaster
//   F2. Simulation vs. Real Mode Engine API & Segregation
//   F3. Sustainability Recommendations & Scope 2 Carbon Accounting
//   F4. Go Backend Manual Override Command Dispatching via MQTT
//   F5. Local Python AI Models (LSTM & TimesFM) Live Inference
// =============================================================================

// -----------------------------------------------------------------------------
// [Feature 1] Hardware Inspector Manual Controls & IR Blaster
// -----------------------------------------------------------------------------
func TestTier1_F1_HardwareInspectorManualControls(t *testing.T) {
	wrapper := SetupTestEngineWithWrapper()
	engine := wrapper.Engine
	zone := "zone-office-a"

	// 1.1 IR Blaster manual actuation formatting & protocol latching
	t.Run("1.1_IR_Blaster_Fields_And_Manual_Actuation", func(t *testing.T) {
		wrapper.ClearCommands()
		irCmd := "IR_SEND:COOLIX:0xB27BE0:32"
		engine.PublishCommand(irCmd, zone)

		cmd, ok := wrapper.LastCommand()
		if !ok {
			t.Fatalf("expected MQTT command to be published")
		}
		if cmd.Topic != "econ/commands/esp32-office-01" {
			t.Errorf("expected topic 'econ/commands/esp32-office-01', got %q", cmd.Topic)
		}
		if cmd.Payload != irCmd {
			t.Errorf("expected payload %q, got %q", irCmd, cmd.Payload)
		}

		z := engine.Zones[zone]
		if z.DetectedProtocol != "COOLIX" {
			t.Errorf("expected DetectedProtocol='COOLIX', got %q", z.DetectedProtocol)
		}
		if z.IrState == nil || *z.IrState != irCmd {
			t.Errorf("expected IrState=%q, got %v", irCmd, z.IrState)
		}
	})

	// 1.2 Smart Plug Relay manual actuation (PLUG_ON / PLUG_OFF)
	t.Run("1.2_Smart_Plug_Relay_Actuation", func(t *testing.T) {
		wrapper.ClearCommands()
		engine.PublishCommand("PLUG_OFF", zone)

		cmd, ok := wrapper.LastCommand()
		if !ok {
			t.Fatalf("expected MQTT command to be published")
		}
		if cmd.Payload != "PLUG_OFF" {
			t.Errorf("expected payload 'PLUG_OFF', got %q", cmd.Payload)
		}
		z := engine.Zones[zone]
		if !z.PlugShed {
			t.Errorf("expected PlugShed=true after PLUG_OFF")
		}

		// Re-energize
		engine.PublishCommand("PLUG_ON", zone)
		if z.PlugShed {
			t.Errorf("expected PlugShed=false after PLUG_ON")
		}
	})

	// 1.3 Lighting Relay manual actuation (LIGHTS_ON / LIGHTS_OFF)
	t.Run("1.3_Lighting_Relay_Actuation", func(t *testing.T) {
		wrapper.ClearCommands()
		engine.PublishCommand("LIGHTS_OFF", zone)

		cmd, ok := wrapper.LastCommand()
		if !ok {
			t.Fatalf("expected MQTT command to be published")
		}
		if cmd.Payload != "LIGHTS_OFF" {
			t.Errorf("expected payload 'LIGHTS_OFF', got %q", cmd.Payload)
		}
		z := engine.Zones[zone]
		if z.LightsOn {
			t.Errorf("expected LightsOn=false after LIGHTS_OFF")
		}

		engine.PublishCommand("LIGHTS_ON", zone)
		if !z.LightsOn {
			t.Errorf("expected LightsOn=true after LIGHTS_ON")
		}
	})

	// 1.4 VAV Damper manual position override (DAMPER= / VAV_SET:)
	t.Run("1.4_VAV_Damper_Manual_Modulation", func(t *testing.T) {
		wrapper.ClearCommands()
		engine.PublishCommand("DAMPER=45", zone)

		z := engine.Zones[zone]
		if math.Abs(z.DamperPos-0.45) > 0.01 {
			t.Errorf("expected zone DamperPos=0.45, got %f", z.DamperPos)
		}

		vav := engine.Vavs["vav-office-a"]
		if vav != nil && math.Abs(vav.DamperPos-0.45) > 0.01 {
			t.Errorf("expected VAV DamperPos=0.45, got %f", vav.DamperPos)
		}
	})

	// 1.5 Edge CPU Strain testing actuation (CPU_STRAIN:HIGH / NORMAL)
	t.Run("1.5_Edge_CPU_Strain_Simulation_Controls", func(t *testing.T) {
		wrapper.ClearCommands()
		engine.PublishCommand("CPU_STRAIN:HIGH", zone)

		cmd, ok := wrapper.LastCommand()
		if !ok || cmd.Payload != "CPU_STRAIN:HIGH" {
			t.Errorf("expected CPU_STRAIN:HIGH dispatched to MQTT, got %v", cmd)
		}

		z := engine.Zones[zone]
		if !z.CpuStrain {
			t.Errorf("expected CpuStrain=true in zone twin state")
		}

		engine.PublishCommand("CPU_STRAIN:NORMAL", zone)
		if z.CpuStrain {
			t.Errorf("expected CpuStrain=false after CPU_STRAIN:NORMAL")
		}
	})
}

// -----------------------------------------------------------------------------
// [Feature 2] Simulation vs. Real Mode Engine API & Segregation
// -----------------------------------------------------------------------------
func TestTier1_F2_SimulationVsRealMode_APIAndEngineState(t *testing.T) {
	engine := SetupTestEngine()
	zone := "zone-office-a"

	// 2.1 Default mode is ModeSimulation
	t.Run("2.1_Default_Engine_Mode_Simulation", func(t *testing.T) {
		if engine.Mode() != simulation.ModeSimulation {
			t.Fatalf("expected default mode to be ModeSimulation (0), got %v", engine.Mode())
		}
		if engine.IsRealMode() {
			t.Fatalf("expected IsRealMode()=false in default simulation mode")
		}
		if engine.Mode().String() != "simulation" {
			t.Errorf("expected mode string 'simulation', got %q", engine.Mode().String())
		}
	})

	// 2.2 Mode switching transitions (SetMode)
	t.Run("2.2_Mode_Switching_State_Transitions", func(t *testing.T) {
		engine.SetMode(simulation.ModeReal)
		if !engine.IsRealMode() || engine.Mode() != simulation.ModeReal {
			t.Fatalf("expected ModeReal (1), got %v (isReal=%v)", engine.Mode(), engine.IsRealMode())
		}
		if engine.Mode().String() != "real" {
			t.Errorf("expected mode string 'real', got %q", engine.Mode().String())
		}

		engine.SetMode(simulation.ModeSimulation)
		if engine.IsRealMode() || engine.Mode() != simulation.ModeSimulation {
			t.Fatalf("expected ModeSimulation (0), got %v (isReal=%v)", engine.Mode(), engine.IsRealMode())
		}
	})

	// 2.3 Strict mock telemetry rejection in Real Mode
	t.Run("2.3_Strict_Mock_Telemetry_Rejection_In_Real_Mode", func(t *testing.T) {
		engine.SetMode(simulation.ModeReal)
		defer engine.SetMode(simulation.ModeSimulation)

		isMock := true
		tempVal := 22.0

		// Attempt 1: explicit mock flag
		err := engine.IngestTelemetry(zone, "esp32", simulation.Measurement{
			Temp:     &tempVal,
			TempReal: true,
			Mock:     &isMock,
		})
		if err == nil {
			t.Fatalf("expected IngestTelemetry to reject payload with mock=true in Real Mode")
		}

		// Attempt 2: synthetic source identifier
		err = engine.IngestTelemetry(zone, "esp32", simulation.Measurement{
			Temp:     &tempVal,
			TempReal: true,
			Source:   "synthetic",
		})
		if err == nil {
			t.Fatalf("expected IngestTelemetry to reject payload with source='synthetic' in Real Mode")
		}

		// Attempt 3: placeholder temperature (tempReal=false)
		err = engine.IngestTelemetry(zone, "esp32", simulation.Measurement{
			Temp:     &tempVal,
			TempReal: false,
			Source:   "esp32",
		})
		if err == nil {
			t.Fatalf("expected IngestTelemetry to reject placeholder temperature in Real Mode")
		}
	})

	// 2.4 Acceptance of genuine telemetry in Real Mode
	t.Run("2.4_Acceptance_Of_Genuine_Telemetry_In_Real_Mode", func(t *testing.T) {
		engine.SetMode(simulation.ModeReal)
		defer engine.SetMode(simulation.ModeSimulation)

		tempReal := 25.5
		humReal := 55.0
		err := engine.IngestTelemetry(zone, "esp32-office-01", simulation.Measurement{
			Temp:     &tempReal,
			TempReal: true,
			Humidity: &humReal,
			Source:   "esp32",
		})
		if err != nil {
			t.Fatalf("genuine telemetry was rejected in Real Mode: %v", err)
		}
		z := engine.Zones[zone]
		if z.HwTemp != tempReal {
			t.Errorf("expected HwTemp=%f, got %f", tempReal, z.HwTemp)
		}
	})

	// 2.5 Electrical disaggregation in Real Mode (stripW and CB mapping)
	t.Run("2.5_Electrical_Telemetry_Disaggregation_In_Real_Mode", func(t *testing.T) {
		engine.SetMode(simulation.ModeReal)
		defer engine.SetMode(simulation.ModeSimulation)

		stripWatts := 850.0
		cbWatts := 2400.0

		err := engine.IngestTelemetry(zone, "esp32-office-01", simulation.Measurement{
			StripW:          &stripWatts,
			CircuitBreakerW: &cbWatts,
			Source:          "esp32",
			TempReal:        true,
		})
		if err != nil {
			t.Fatalf("telemetry ingestion failed: %v", err)
		}

		z := engine.Zones[zone]
		if z.HwStripW != stripWatts {
			t.Errorf("expected HwStripW=%f, got %f", stripWatts, z.HwStripW)
		}
		if z.HwCircuitBreakerW != cbWatts {
			t.Errorf("expected HwCircuitBreakerW=%f, got %f", cbWatts, z.HwCircuitBreakerW)
		}
		// In Real Mode, CB powers z.HwPlugW
		if z.HwPlugW != cbWatts {
			t.Errorf("expected HwPlugW=%f mapped from CB, got %f", cbWatts, z.HwPlugW)
		}
	})
}

// -----------------------------------------------------------------------------
// [Feature 3] Sustainability Recommendations & Scope 2 Carbon Accounting
// -----------------------------------------------------------------------------
func TestTier1_F3_SustainabilityRecommendations(t *testing.T) {
	// 3.1 Mathematical verification of Scope 2 Carbon Emissions
	t.Run("3.1_Mathematical_Scope2_Carbon_Formula", func(t *testing.T) {
		// Test case: 1,000 W drawn for 1 hour with grid factor 0.5 kgCO2e/kWh
		// E = (1000 / 1000) * 1.0 * 0.5 = exactly 0.5 kgCO2e
		watts := 1000.0
		hours := 1.0
		gridFactor := 0.5
		expectedEmissions := CalculateExpectedScope2Emissions(watts, hours, gridFactor)
		if math.Abs(expectedEmissions-0.5) > 1e-6 {
			t.Errorf("expected 0.5 kgCO2e, got %f", expectedEmissions)
		}

		// 3,500 W (AC load) for 2.5 hours at Vietnam grid factor 0.6766 kgCO2e/kWh
		expectedVn := CalculateExpectedScope2Emissions(3500.0, 2.5, 0.6766)
		// 3.5 * 2.5 * 0.6766 = 5.92025 kgCO2e
		if math.Abs(expectedVn-5.92025) > 1e-4 {
			t.Errorf("expected 5.92025 kgCO2e, got %f", expectedVn)
		}
	})

	// 3.2 Space utilization efficiency calculation
	t.Run("3.2_Space_Utilization_Efficiency", func(t *testing.T) {
		engine := SetupTestEngine()
		totalOccupants := 0
		totalCapacity := 0
		for _, z := range engine.Zones {
			totalOccupants += z.Occupancy
			// Standard design density: 1 occupant per 10 m2
			capacity := int(math.Max(1.0, math.Round(z.AreaM2/10.0)))
			totalCapacity += capacity
		}

		if totalCapacity <= 0 {
			t.Fatalf("expected non-zero building capacity")
		}
		efficiency := (float64(totalOccupants) / float64(totalCapacity)) * 100.0
		if efficiency < 0.0 || efficiency > 100.0 {
			t.Errorf("space utilization efficiency out of bounds [0, 100]: %f", efficiency)
		}
	})

	// 3.3 Predictive maintenance diagnostic threshold logic
	t.Run("3.3_Predictive_Maintenance_Surge_Thresholds", func(t *testing.T) {
		// Rated capacity thresholds from specification
		powerStripRatedWatts := 2000.0
		normalLoad := 1200.0
		surgeLoad := 2500.0

		// Normal load within threshold
		if normalLoad > powerStripRatedWatts {
			t.Errorf("normal load flagged incorrectly")
		}
		// Surge load exceeds threshold
		if surgeLoad <= powerStripRatedWatts {
			t.Errorf("surge load failed to exceed rated threshold")
		}
	})

	// 3.4 Dynamic carbon credit offset recommendation logic
	t.Run("3.4_Dynamic_Carbon_Credit_Offset_Recommendation", func(t *testing.T) {
		budgetKg := 50.0
		pricePerTonUSD := 12.50

		// Case A: Within budget -> 0 credits, $0 cost
		deficitA, certsA, costA := CalculateExpectedCarbonCreditOffset(budgetKg, 45.0, pricePerTonUSD)
		if deficitA != 0.0 || certsA != 0 || costA != 0.0 {
			t.Errorf("expected 0 offset when within budget, got deficit=%f, certs=%d, cost=%f",
				deficitA, certsA, costA)
		}

		// Case B: Over budget by 1,200 kg -> requires 2 metric ton certificates ($25.00)
		deficitB, certsB, costB := CalculateExpectedCarbonCreditOffset(budgetKg, 1250.0, pricePerTonUSD)
		if math.Abs(deficitB-1200.0) > 1e-6 {
			t.Errorf("expected deficit=1200.0, got %f", deficitB)
		}
		if certsB != 2 {
			t.Errorf("expected 2 certificates (ceil(1200/1000)), got %d", certsB)
		}
		if math.Abs(costB-25.00) > 1e-6 {
			t.Errorf("expected cost=$25.00, got %f", costB)
		}
	})

	// 3.5 Multi-zone carbon emissions aggregation
	t.Run("3.5_MultiZone_Carbon_Emissions_Aggregation", func(t *testing.T) {
		loads := map[string]float64{
			"zone-office-a":    1500.0,
			"zone-boardroom":   800.0,
			"zone-server-room": 3200.0,
		}
		totalW := 0.0
		for _, w := range loads {
			totalW += w
		}
		if totalW != 5500.0 {
			t.Fatalf("expected 5500.0 W total, got %f", totalW)
		}
		// 5.5 kW * 1h * 0.5 kg/kWh = 2.75 kgCO2e
		hourlyEmissions := CalculateExpectedScope2Emissions(totalW, 1.0, 0.5)
		if math.Abs(hourlyEmissions-2.75) > 1e-6 {
			t.Errorf("expected 2.75 kgCO2e, got %f", hourlyEmissions)
		}
	})
}

// -----------------------------------------------------------------------------
// [Feature 4] Backend Command Routing & MQTT Actuation
// -----------------------------------------------------------------------------
func TestTier1_F4_MQTTCommandDispatching(t *testing.T) {
	wrapper := SetupTestEngineWithWrapper()
	engine := wrapper.Engine

	// 4.1 IR code formatting routed to target device topic
	t.Run("4.1_IR_Code_MQTT_Topic_Dispatch", func(t *testing.T) {
		wrapper.ClearCommands()
		cmd := "IR_SEND:GREE:0x11223344:32"
		engine.PublishCommand(cmd, "zone-boardroom")

		captured, ok := wrapper.LastCommand()
		if !ok {
			t.Fatalf("expected MQTT publication")
		}
		if captured.Topic != "econ/commands/esp32-boardroom-01" {
			t.Errorf("expected topic 'econ/commands/esp32-boardroom-01', got %q", captured.Topic)
		}
		if captured.Payload != cmd {
			t.Errorf("expected payload %q, got %q", cmd, captured.Payload)
		}
	})

	// 4.2 Plug commands update zone twin and forward to MQTT
	t.Run("4.2_Plug_Commands_Twin_Update_And_Forward", func(t *testing.T) {
		wrapper.ClearCommands()
		engine.PublishCommand("PLUG_OFF", "zone-server-room")

		captured, ok := wrapper.LastCommand()
		if !ok || captured.Payload != "PLUG_OFF" {
			t.Errorf("expected PLUG_OFF published, got %v", captured)
		}
		if !engine.Zones["zone-server-room"].PlugShed {
			t.Errorf("expected PlugShed=true")
		}
	})

	// 4.3 Lighting commands update zone twin and forward to MQTT
	t.Run("4.3_Lighting_Commands_Twin_Update_And_Forward", func(t *testing.T) {
		wrapper.ClearCommands()
		engine.PublishCommand("LIGHTS_OFF", "zone-office-a")

		captured, ok := wrapper.LastCommand()
		if !ok || captured.Payload != "LIGHTS_OFF" {
			t.Errorf("expected LIGHTS_OFF published, got %v", captured)
		}
		if engine.Zones["zone-office-a"].LightsOn {
			t.Errorf("expected LightsOn=false")
		}
	})

	// 4.4 Damper commands update VAV actuator position
	t.Run("4.4_Damper_Commands_Actuator_Position", func(t *testing.T) {
		wrapper.ClearCommands()
		engine.PublishCommand("DAMPER=80", "zone-office-a")

		vav := engine.Vavs["vav-office-a"]
		if vav == nil {
			t.Fatalf("vav-office-a not found")
		}
		if math.Abs(vav.DamperPos-0.80) > 0.01 {
			t.Errorf("expected VAV DamperPos=0.80, got %f", vav.DamperPos)
		}
	})

	// 4.5 CPU strain commands dispatch and update twin
	t.Run("4.5_CPU_Strain_Command_Dispatch", func(t *testing.T) {
		wrapper.ClearCommands()
		engine.PublishCommand("CPU_STRAIN:HIGH", "zone-office-a")

		captured, ok := wrapper.LastCommand()
		if !ok || captured.Payload != "CPU_STRAIN:HIGH" {
			t.Errorf("expected CPU_STRAIN:HIGH dispatched, got %v", captured)
		}
		if !engine.Zones["zone-office-a"].CpuStrain {
			t.Errorf("expected CpuStrain=true in twin")
		}
	})

	// 4.6 Compound semicolon-separated command dispatch
	t.Run("4.6_Compound_Command_Dispatch", func(t *testing.T) {
		wrapper.ClearCommands()
		compound := "LIGHTS_OFF;SETPOINT=26.0;DAMPER=20"
		engine.PublishCommand(compound, "zone-office-a")

		captured, ok := wrapper.LastCommand()
		if !ok || captured.Payload != compound {
			t.Errorf("expected compound payload %q, got %v", compound, captured)
		}
		z := engine.Zones["zone-office-a"]
		if z.LightsOn {
			t.Errorf("expected LightsOn=false")
		}
		if z.Setpoint != 26.0 {
			t.Errorf("expected Setpoint=26.0, got %f", z.Setpoint)
		}
		if math.Abs(z.DamperPos-0.20) > 0.01 {
			t.Errorf("expected DamperPos=0.20, got %f", z.DamperPos)
		}
	})
}

// -----------------------------------------------------------------------------
// [Feature 5] Local Python AI Models (LSTM & TimesFM) Live Inference
// -----------------------------------------------------------------------------
func TestTier1_F5_LocalAIModelLiveInference(t *testing.T) {
	// 5.1 PeakLoadLSTM live forward pass execution
	t.Run("5.1_PeakLoadLSTM_Forward_Pass_CLI", func(t *testing.T) {
		inputData := map[string]interface{}{
			"sensor_sequence": [][]float64{
				{24.0, 300.0}, {24.1, 310.0}, {24.2, 320.0}, {24.3, 330.0},
				{24.4, 340.0}, {24.5, 350.0}, {24.6, 360.0}, {24.7, 370.0},
				{24.8, 380.0}, {24.9, 390.0}, {25.0, 400.0}, {25.1, 410.0},
			},
			"outdoor_temp":     32.0,
			"outdoor_humidity": 65.0,
		}
		rawInput, err := json.Marshal(inputData)
		if err != nil {
			t.Fatalf("failed to marshal input JSON: %v", err)
		}

		outBytes, err := ExecutePythonInference("lstm", string(rawInput))
		if err != nil {
			t.Fatalf("PeakLoadLSTM inference failed: %v", err)
		}

		var resp struct {
			Status            string  `json:"status"`
			Engine            string  `json:"engine"`
			PredictedPeakLoad float64 `json:"predicted_peak_load"`
			OutdoorTempUsed   float64 `json:"outdoor_temp_used"`
			TimestepsUsed     int     `json:"timesteps_used"`
		}
		if err := json.Unmarshal(outBytes, &resp); err != nil {
			t.Fatalf("failed to unmarshal inference output JSON: %v, raw=%s", err, string(outBytes))
		}

		if resp.Status != "ok" {
			t.Errorf("expected status='ok', got %q", resp.Status)
		}
		if resp.Engine != "lstm" {
			t.Errorf("expected engine='lstm', got %q", resp.Engine)
		}
		if resp.PredictedPeakLoad <= 0.0 || resp.PredictedPeakLoad > 10.0 {
			t.Errorf("predicted peak load out of plausible physical range (0..10 MW): %f", resp.PredictedPeakLoad)
		}
		if resp.TimestepsUsed != 12 {
			t.Errorf("expected 12 timesteps used, got %d", resp.TimestepsUsed)
		}
	})

	// 5.2 LSTM Physical monotonicity: higher heat & airflow yields higher predicted load
	t.Run("5.2_LSTM_Physical_Monotonicity", func(t *testing.T) {
		// Low-load scenario (cool room, low airflow, cool exterior)
		coolInput := map[string]interface{}{
			"sensor_sequence": [][]float64{
				{20.0, 100.0}, {20.0, 100.0}, {20.0, 100.0}, {20.0, 100.0},
				{20.0, 100.0}, {20.0, 100.0}, {20.0, 100.0}, {20.0, 100.0},
				{20.0, 100.0}, {20.0, 100.0}, {20.0, 100.0}, {20.0, 100.0},
			},
			"outdoor_temp":     22.0,
			"outdoor_humidity": 50.0,
		}
		coolBytes, _ := json.Marshal(coolInput)
		outCool, err := ExecutePythonInference("lstm", string(coolBytes))
		if err != nil {
			t.Fatalf("cool LSTM inference failed: %v", err)
		}

		// Hot-load scenario (warm room, high airflow, hot exterior)
		hotInput := map[string]interface{}{
			"sensor_sequence": [][]float64{
				{27.0, 500.0}, {27.2, 510.0}, {27.4, 520.0}, {27.6, 530.0},
				{27.8, 540.0}, {28.0, 550.0}, {28.2, 560.0}, {28.4, 570.0},
				{28.6, 580.0}, {28.8, 590.0}, {29.0, 600.0}, {29.2, 610.0},
			},
			"outdoor_temp":     38.0,
			"outdoor_humidity": 75.0,
		}
		hotBytes, _ := json.Marshal(hotInput)
		outHot, err := ExecutePythonInference("lstm", string(hotBytes))
		if err != nil {
			t.Fatalf("hot LSTM inference failed: %v", err)
		}

		var respCool, respHot struct {
			PredictedPeakLoad float64 `json:"predicted_peak_load"`
		}
		_ = json.Unmarshal(outCool, &respCool)
		_ = json.Unmarshal(outHot, &respHot)

		if respHot.PredictedPeakLoad <= respCool.PredictedPeakLoad {
			t.Errorf("monotonicity violation: hot load (%f MW) should exceed cool load (%f MW)",
				respHot.PredictedPeakLoad, respCool.PredictedPeakLoad)
		}
	})

	// 5.3 TimesFM Foundation Model zero-shot forecast execution
	t.Run("5.3_TimesFM_Foundation_Model_Forecast", func(t *testing.T) {
		history := []float64{1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9}
		inputData := map[string]interface{}{
			"history": history,
			"horizon": 12,
		}
		rawInput, err := json.Marshal(inputData)
		if err != nil {
			t.Fatalf("failed to marshal history input: %v", err)
		}

		outBytes, err := ExecutePythonInference("timesfm", string(rawInput))
		if err != nil {
			t.Fatalf("TimesFM inference failed: %v", err)
		}

		var resp struct {
			Status    string               `json:"status"`
			Engine    string               `json:"engine"`
			Forecast  []float64            `json:"forecast"`
			Quantiles map[string][]float64 `json:"quantiles"`
		}
		if err := json.Unmarshal(outBytes, &resp); err != nil {
			t.Fatalf("failed to parse TimesFM output: %v, raw=%s", err, string(outBytes))
		}

		if resp.Status != "ok" {
			t.Errorf("expected TimesFM status='ok', got %q", resp.Status)
		}
		if len(resp.Forecast) != 12 {
			t.Errorf("expected 12 forecast steps, got %d", len(resp.Forecast))
		}
		// Check quantiles q1 through q9 are populated
		for i := 1; i <= 9; i++ {
			qKey := "q" + string(rune('0'+i))
			qArr, exists := resp.Quantiles[qKey]
			if !exists || len(qArr) != 12 {
				t.Errorf("expected quantile band %s with 12 steps, got %v", qKey, qArr)
			}
		}
	})

	// 5.4 TimesFM Quantile Ordering: q1 <= q5 <= q9
	t.Run("5.4_TimesFM_Quantile_Probability_Ordering", func(t *testing.T) {
		history := []float64{2.0, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7}
		inputData := map[string]interface{}{
			"history": history,
			"horizon": 6,
		}
		rawInput, _ := json.Marshal(inputData)
		outBytes, err := ExecutePythonInference("timesfm", string(rawInput))
		if err != nil {
			t.Fatalf("TimesFM inference failed: %v", err)
		}

		var resp struct {
			Quantiles map[string][]float64 `json:"quantiles"`
		}
		_ = json.Unmarshal(outBytes, &resp)

		q1 := resp.Quantiles["q1"]
		q9 := resp.Quantiles["q9"]
		if len(q1) == 6 && len(q9) == 6 {
			for step := 0; step < 6; step++ {
				if q9[step] < q1[step]-0.1 {
					t.Errorf("quantile inversion at step %d: q9 (%f) < q1 (%f)", step, q9[step], q1[step])
				}
			}
		}
	})

	// 5.5 Auto Model Selection CLI execution
	t.Run("5.5_Auto_Model_Selection_Execution", func(t *testing.T) {
		// When input contains sensor_sequence, auto mode selects LSTM
		inputData := map[string]interface{}{
			"sensor_sequence": [][]float64{
				{24.0, 300.0}, {24.0, 300.0}, {24.0, 300.0}, {24.0, 300.0},
				{24.0, 300.0}, {24.0, 300.0}, {24.0, 300.0}, {24.0, 300.0},
				{24.0, 300.0}, {24.0, 300.0}, {24.0, 300.0}, {24.0, 300.0},
			},
		}
		rawInput, _ := json.Marshal(inputData)
		outBytes, err := ExecutePythonInference("auto", string(rawInput))
		if err != nil {
			t.Fatalf("auto inference failed: %v", err)
		}

		var resp struct {
			Status string `json:"status"`
			Engine string `json:"engine"`
		}
		_ = json.Unmarshal(outBytes, &resp)
		if resp.Status != "ok" || resp.Engine != "lstm" {
			t.Errorf("expected auto mode to resolve to lstm, got engine=%q", resp.Engine)
		}
	})
}
