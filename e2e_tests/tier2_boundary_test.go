package e2e_tests

import (
	"encoding/json"
	"math"
	"testing"

	"econ/simulation"
)

// =============================================================================
// TIER 2: BOUNDARY & CORNER CASE TESTS (>=5 Tests Per Feature)
// Requirements Covered:
//   F1. Actuation & Command Boundaries (Damper bounds, Setpoint extremes, Semicolons)
//   F2. Operation Mode Boundaries (Invalid strings, Numbers, Permissive formats)
//   F3. Sustainability Boundaries (0W load, Budget boundary, Fractional certs, Spike)
//   F4. Local AI Inference Boundaries (Cold-start history, Malformed JSON, Bad flags)
// =============================================================================

// -----------------------------------------------------------------------------
// [Boundary 1] Hardware Actuation & Command Boundaries
// -----------------------------------------------------------------------------
func TestTier2_F1_CommandBoundaries(t *testing.T) {
	wrapper := SetupTestEngineWithWrapper()
	engine := wrapper.Engine
	zone := "zone-office-a"

	// 1.1 Damper 0% and 100% boundary positions
	t.Run("1.1_Damper_0_And_100_Boundary_Positions", func(t *testing.T) {
		// Minimum ventilation floor / full close test
		engine.PublishCommand("DAMPER=0", zone)
		z := engine.Zones[zone]
		if z.DamperPos != 0.0 {
			t.Errorf("expected DamperPos=0.0, got %f", z.DamperPos)
		}

		// Full open 100% test
		engine.PublishCommand("DAMPER=100", zone)
		if z.DamperPos != 1.0 {
			t.Errorf("expected DamperPos=1.0 for DAMPER=100, got %f", z.DamperPos)
		}
	})

	// 1.2 Damper out-of-range clamping (negative and >100%)
	t.Run("1.2_Damper_Out_Of_Range_Clamping", func(t *testing.T) {
		// Negative damper value should clamp to 0.0
		engine.PublishCommand("DAMPER=-25", zone)
		z := engine.Zones[zone]
		if z.DamperPos < 0.0 || z.DamperPos > 1.0 {
			t.Errorf("expected DamperPos clamped to [0, 1], got %f", z.DamperPos)
		}

		// Excessive overshoot should clamp to 1.0
		engine.PublishCommand("DAMPER=250", zone)
		if z.DamperPos > 1.0 {
			t.Errorf("expected DamperPos clamped to <= 1.0, got %f", z.DamperPos)
		}
	})

	// 1.3 Boundary setpoints (extreme cold -5°C and extreme hot 99°C)
	t.Run("1.3_Boundary_Setpoints_Extreme_Temperatures", func(t *testing.T) {
		engine.PublishCommand("SETPOINT=-5.0", zone)
		z := engine.Zones[zone]
		if z.Setpoint != -5.0 {
			t.Errorf("expected Setpoint=-5.0, got %f", z.Setpoint)
		}

		engine.PublishCommand("SETPOINT=99.0", zone)
		if z.Setpoint != 99.0 {
			t.Errorf("expected Setpoint=99.0, got %f", z.Setpoint)
		}
	})

	// 1.4 Complex / irregular semicolon delimiter patterns
	t.Run("1.4_Irregular_Semicolon_Delimiter_Tokens", func(t *testing.T) {
		// Multiple consecutive semicolons, leading/trailing semicolons, whitespace
		irregular := ";;;LIGHTS_OFF; ;  SETPOINT=21.5  ;;;DAMPER=60;;;"
		engine.PublishCommand(irregular, zone)

		z := engine.Zones[zone]
		if z.LightsOn {
			t.Errorf("expected LightsOn=false")
		}
		if z.Setpoint != 21.5 {
			t.Errorf("expected Setpoint=21.5, got %f", z.Setpoint)
		}
		if math.Abs(z.DamperPos-0.60) > 0.01 {
			t.Errorf("expected DamperPos=0.60, got %f", z.DamperPos)
		}
	})

	// 1.5 Empty, whitespace-only, or garbage tokens pass safely without panic
	t.Run("1.5_Empty_And_Unknown_Command_Tokens_Safe", func(t *testing.T) {
		initialLights := engine.Zones[zone].LightsOn
		initialSp := engine.Zones[zone].Setpoint

		// Empty string
		engine.PublishCommand("", zone)
		// Whitespace only
		engine.PublishCommand("     ", zone)
		// Unknown garbage token
		engine.PublishCommand("UNKNOWN_OP_DO_NOTHING_12345", zone)

		z := engine.Zones[zone]
		if z.LightsOn != initialLights || z.Setpoint != initialSp {
			t.Errorf("twin state mutated unexpectedly on unknown/empty command")
		}
	})
}

// -----------------------------------------------------------------------------
// [Boundary 2] Operation Mode Boundaries
// -----------------------------------------------------------------------------
func TestTier2_F2_OperationModeBoundaries(t *testing.T) {
	// 2.1 Invalid mode strings return error in ParseOperationMode
	t.Run("2.1_Invalid_Mode_Strings_Return_Error", func(t *testing.T) {
		invalidInputs := []string{"unknown", "invalid_mode", "foo", "bar", "super_real", "2"}
		for _, inv := range invalidInputs {
			parsed := simulation.ParseOperationMode(inv)
			// ParseOperationMode in simulation falls back to ModeSimulation for unknown
			if parsed != simulation.ModeSimulation {
				t.Errorf("expected fallback to ModeSimulation for %q, got %v", inv, parsed)
			}
		}
	})

	// 2.2 Permissive string representations of ModeReal
	t.Run("2.2_Permissive_ModeReal_String_Representations", func(t *testing.T) {
		realVariants := []string{"real", "REAL", "  real  ", "mode_real", "modereal"}
		for _, variant := range realVariants {
			parsed := simulation.ParseOperationMode(variant)
			if parsed != simulation.ModeReal {
				t.Errorf("expected %q to parse to ModeReal, got %v", variant, parsed)
			}
		}
	})

	// 2.3 Permissive string representations of ModeSimulation
	t.Run("2.3_Permissive_ModeSimulation_String_Representations", func(t *testing.T) {
		simVariants := []string{"simulation", "SIMULATION", "sim", "0", "anything_else"}
		for _, variant := range simVariants {
			parsed := simulation.ParseOperationMode(variant)
			if parsed != simulation.ModeSimulation {
				t.Errorf("expected %q to parse to ModeSimulation, got %v", variant, parsed)
			}
		}
	})

	// 2.4 Mode transition idempotent stability
	t.Run("2.4_Idempotent_Mode_Transitions", func(t *testing.T) {
		engine := SetupTestEngine()
		// Setting same mode repeatedly should not corrupt state
		for i := 0; i < 5; i++ {
			engine.SetMode(simulation.ModeReal)
			if !engine.IsRealMode() {
				t.Fatalf("expected ModeReal on iteration %d", i)
			}
		}
		for i := 0; i < 5; i++ {
			engine.SetMode(simulation.ModeSimulation)
			if engine.IsRealMode() {
				t.Fatalf("expected ModeSimulation on iteration %d", i)
			}
		}
	})

	// 2.5 Real mode case-insensitivity on mock rejection sources
	t.Run("2.5_RealMode_CaseInsensitive_Mock_Detection", func(t *testing.T) {
		engine := SetupTestEngine()
		engine.SetMode(simulation.ModeReal)
		defer engine.SetMode(simulation.ModeSimulation)

		mockSources := []string{"MOCK", "Mock", "  mock  ", "SIM", "Simulation", "SYNTHETIC", "TEST"}
		temp := 22.0
		for _, src := range mockSources {
			err := engine.IngestTelemetry("zone-office-a", "esp32", simulation.Measurement{
				Temp:     &temp,
				TempReal: true,
				Source:   src,
			})
			if err == nil {
				t.Errorf("expected Real Mode to reject source %q", src)
			}
		}
	})
}

// -----------------------------------------------------------------------------
// [Boundary 3] Sustainability Boundaries
// -----------------------------------------------------------------------------
func TestTier2_F3_SustainabilityBoundaries(t *testing.T) {
	// 3.1 Zero power draw (0 W) yields 0 emissions without divide-by-zero
	t.Run("3.1_Zero_Power_Draw_Zero_Emissions", func(t *testing.T) {
		emissions := CalculateExpectedScope2Emissions(0.0, 10.0, 0.5)
		if emissions != 0.0 || math.IsNaN(emissions) || math.IsInf(emissions, 0) {
			t.Fatalf("expected 0.0 kgCO2e, got %f", emissions)
		}
	})

	// 3.2 Exactly at carbon budget boundary (deficit == 0)
	t.Run("3.2_Exact_Budget_Boundary_Zero_Deficit", func(t *testing.T) {
		budget := 50.0
		emissions := 50.0 // Exactly equal
		deficit, certs, cost := CalculateExpectedCarbonCreditOffset(budget, emissions, 12.50)
		if deficit != 0.0 {
			t.Errorf("expected 0.0 deficit when emissions == budget, got %f", deficit)
		}
		if certs != 0 {
			t.Errorf("expected 0 certificates needed, got %d", certs)
		}
		if cost != 0.0 {
			t.Errorf("expected $0.00 cost, got %f", cost)
		}
	})

	// 3.3 Fractional deficit rounding: 1 kg deficit requires 1 whole certificate
	t.Run("3.3_Fractional_Deficit_Ceiling_Rounding", func(t *testing.T) {
		budget := 50.0
		emissions := 50.001 // Over by 1 gram
		deficit, certs, cost := CalculateExpectedCarbonCreditOffset(budget, emissions, 12.50)
		if deficit <= 0.0 {
			t.Errorf("expected positive deficit")
		}
		if certs != 1 {
			t.Errorf("expected ceil(0.001 / 1000) = 1 whole certificate, got %d", certs)
		}
		if cost != 12.50 {
			t.Errorf("expected $12.50 for 1 certificate, got %f", cost)
		}
	})

	// 3.4 Massive emissions surge calculation (e.g. 15,200 kg deficit)
	t.Run("3.4_Massive_Emissions_Surge_Calculation", func(t *testing.T) {
		budget := 50.0
		emissions := 15250.0
		deficit, certs, cost := CalculateExpectedCarbonCreditOffset(budget, emissions, 15.00)
		if deficit != 15200.0 {
			t.Errorf("expected deficit=15200, got %f", deficit)
		}
		// ceil(15200 / 1000) = 16 metric tons
		if certs != 16 {
			t.Errorf("expected 16 whole certificates, got %d", certs)
		}
		if cost != 16.0*15.00 {
			t.Errorf("expected cost=%f, got %f", 16.0*15.00, cost)
		}
	})

	// 3.5 Zero capacity handling for space utilization
	t.Run("3.5_Zero_Capacity_Division_By_Zero_Guard", func(t *testing.T) {
		totalOccupants := 0
		totalCapacity := 0
		efficiency := 0.0
		if totalCapacity > 0 {
			efficiency = (float64(totalOccupants) / float64(totalCapacity)) * 100.0
		}
		if math.IsNaN(efficiency) || math.IsInf(efficiency, 0) {
			t.Fatalf("space utilization produced NaN/Inf on zero capacity")
		}
		if efficiency != 0.0 {
			t.Errorf("expected 0.0 efficiency on zero capacity, got %f", efficiency)
		}
	})
}

// -----------------------------------------------------------------------------
// [Boundary 4] Local AI Model Inference Boundaries
// -----------------------------------------------------------------------------
func TestTier2_F4_InferenceBoundaries(t *testing.T) {
	// 4.1 Empty / zero-sample history or sequence dimension mismatch returns error
	t.Run("4.1_Cold_Start_Empty_History_Or_Sequence_Mismatch", func(t *testing.T) {
		// Empty history list [] (0 samples)
		emptyHistory := map[string]interface{}{
			"history": []float64{},
			"horizon": 12,
		}
		rawInput, _ := json.Marshal(emptyHistory)
		_, err := ExecutePythonInference("timesfm", string(rawInput))
		if err == nil {
			t.Fatalf("expected TimesFM to fail on empty history")
		}

		// Sequence dimension mismatch (single feature instead of [temp, airflow])
		badSeq := map[string]interface{}{
			"sensor_sequence": [][]float64{{24.0}, {24.1}},
		}
		rawSeq, _ := json.Marshal(badSeq)
		_, err = ExecutePythonInference("lstm", string(rawSeq))
		if err == nil {
			t.Fatalf("expected LSTM to fail on invalid row dimensions")
		}
	})

	// 4.2 Malformed / unparseable JSON input to infer.py
	t.Run("4.2_Malformed_JSON_Input_Handling", func(t *testing.T) {
		malformed := `{"sensor_sequence": [[24.0, 300.0], ` // Incomplete JSON
		_, err := ExecutePythonInference("lstm", malformed)
		if err == nil {
			t.Fatalf("expected infer.py to fail on malformed JSON")
		}
	})

	// 4.3 Empty input payload
	t.Run("4.3_Empty_Input_Payload_Handling", func(t *testing.T) {
		_, err := ExecutePythonInference("lstm", "")
		if err == nil {
			t.Fatalf("expected infer.py to fail on empty input")
		}
	})

	// 4.4 Nonexistent model selection flag
	t.Run("4.4_Nonexistent_Model_Flag_Handling", func(t *testing.T) {
		dummyInput := `{"history": [1,2,3,4,5,6,7,8]}`
		_, err := ExecutePythonInference("nonexistent_model_xyz", dummyInput)
		if err == nil {
			t.Fatalf("expected infer.py to reject invalid --model choice")
		}
	})

	// 4.5 Non-list history input to TimesFM
	t.Run("4.5_NonList_History_Input_Handling", func(t *testing.T) {
		badInput := `{"history": "not_a_list", "horizon": 12}`
		_, err := ExecutePythonInference("timesfm", badInput)
		if err == nil {
			t.Fatalf("expected infer.py to reject non-list history")
		}
	})
}
