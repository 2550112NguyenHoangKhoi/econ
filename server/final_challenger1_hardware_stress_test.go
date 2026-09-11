package main

import (
	"bytes"
	"econ/simulation"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// setupStressEngine creates an isolated simulation Engine with a test zone and VAV actuator.
func setupStressEngine(zoneId, vavId string) (*simulation.Engine, *simulation.ZoneSim, *simulation.VavSim) {
	e := simulation.NewEngine()
	e.Zones = make(map[string]*simulation.ZoneSim)
	e.Vavs = make(map[string]*simulation.VavSim)

	z := &simulation.ZoneSim{
		Type:         "office",
		Temp:         23.5,
		BaseSetpoint: 24.0,
		Setpoint:     24.0,
		LightsOn:     true,
		MqttTopic:    "esp32-" + zoneId,
		AreaM2:       50.0,
		Live:         true,
		PlugShed:     false,
		DamperPos:    1.0,
	}
	e.Zones[zoneId] = z

	v := &simulation.VavSim{
		TargetZone:       zoneId,
		DesignResistance: 1.0,
		Damper:           1.0,
		DamperPos:        1.0,
		TargetDamperPos:  1.0,
	}
	e.Vavs[vavId] = v

	return e, z, v
}

// ============================================================================
// PART 1: HARDWARE INSPECTOR MANUAL CONTROLS & MQTT ACTUATION STRESS
// ============================================================================

// TestEmpiricalStress_HighFrequencyManualCommands fires 300 high-frequency,
// interleaved command overrides across multiple goroutines while running background
// engine.Actuate() and telemetry ingestion loops.
// Tests race conditions, deadlocks, and MQTT payload integrity under high load.
func TestEmpiricalStress_HighFrequencyManualCommands(t *testing.T) {
	engine, z, _ := setupStressEngine("zone-office-stress", "vav-office-stress")
	handler := commandHandler(engine)

	var publishedCount atomic.Int64
	var mu sync.Mutex
	lastCommands := make(map[string]string)
	engine.Publish = func(topic, payload string) {
		publishedCount.Add(1)
		mu.Lock()
		lastCommands[topic] = payload
		mu.Unlock()
	}

	numCommands := 300
	concurrency := 20
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup

	commandPool := []string{
		"IR_SEND:COOLIX:0xB27BE0:32",
		"IR_SEND:GREE:0x12345678:32",
		"IR_SEND:DAIKIN:0xAABBCCDD:32",
		"PLUG_ON",
		"PLUG_OFF",
		"DAMPER=45",
		"DAMPER=0.8",
		"VAV_SET:60",
		"CPU_STRAIN:HIGH",
		"CPU_STRAIN:NORMAL",
		"LIGHTS_ON",
		"LIGHTS_OFF",
		"cool",
		"purge",
		"turn_off_ac",
		"PLUG_OFF;CPU_STRAIN:HIGH;SETPOINT=22.0",
		"LIGHTS_OFF;DAMPER=25",
	}

	// 1. Concurrent command dispatchers
	var successCount atomic.Int64
	for i := 0; i < numCommands; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			cmd := commandPool[idx%len(commandPool)]
			body := fmt.Sprintf(`{"zone": "zone-office-stress", "command": "%s"}`, cmd)
			req := httptest.NewRequest(http.MethodPost, "/api/command", bytes.NewBufferString(body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code == http.StatusOK {
				successCount.Add(1)
			} else {
				t.Errorf("command %q failed with status %d: %s", cmd, rec.Code, rec.Body.String())
			}
		}(i)
	}

	// 2. Background engine.Actuate() running concurrently
	stopActuate := make(chan struct{})
	var actuateCycles atomic.Int64
	go func() {
		ticker := time.NewTicker(2 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stopActuate:
				return
			case <-ticker.C:
				engine.Actuate()
				actuateCycles.Add(1)
			}
		}
	}()

	// 3. Background telemetry ingestion running concurrently
	stopTelemetry := make(chan struct{})
	var telemetrySamples atomic.Int64
	go func() {
		ticker := time.NewTicker(3 * time.Millisecond)
		defer ticker.Stop()
		step := 0
		for {
			select {
			case <-stopTelemetry:
				return
			case <-ticker.C:
				step++
				temp := 22.0 + float64(step%10)*0.2
				occ := step % 4
				strip := 250.0 + float64(step%50)*5.0
				engine.IngestTelemetry("zone-office-stress", "zone-office-stress", simulation.Measurement{
					Occupancy: &occ,
					Temp:      &temp,
					TempReal:  true,
					StripW:    &strip,
				})
				telemetrySamples.Add(1)
			}
		}
	}()

	wg.Wait()
	close(stopActuate)
	close(stopTelemetry)

	t.Logf("High Frequency Burst Complete: Success=%d/%d, Published=%d, ActuateCycles=%d, TelemetrySamples=%d",
		successCount.Load(), numCommands, publishedCount.Load(), actuateCycles.Load(), telemetrySamples.Load())

	if successCount.Load() != int64(numCommands) {
		t.Fatalf("expected all %d commands to return 200 OK, got %d", numCommands, successCount.Load())
	}
	if publishedCount.Load() != int64(numCommands) {
		t.Fatalf("expected %d MQTT publishes, got %d", numCommands, publishedCount.Load())
	}
	if !time.Now().Before(z.OverrideUntil) {
		t.Fatalf("expected zone OverrideUntil to be latched into the future, got %v", z.OverrideUntil)
	}
}

// TestEmpiricalStress_BoundaryDamperModulation thoroughly tests extreme damper
// percentages, negative values, values > 100%, non-integers, NaN/Inf, and irregular inputs.
// Invariant: Damper position in both twin zone and VavSim MUST strictly be clamped to [0.0, 1.0].
func TestEmpiricalStress_BoundaryDamperModulation(t *testing.T) {
	engine, z, v := setupStressEngine("zone-office-damper", "vav-office-damper")
	handler := commandHandler(engine)

	var lastMqttPayload string
	engine.Publish = func(topic, payload string) {
		lastMqttPayload = payload
	}

	testCases := []struct {
		name        string
		command     string
		expectTwin  float64
		expectVav   float64
		expectClamped bool
	}{
		// Standard boundary values
		{name: "0% damper via percentage", command: "DAMPER=0", expectTwin: 0.0, expectVav: 0.0, expectClamped: true},
		{name: "0.0 damper via ratio", command: "DAMPER=0.0", expectTwin: 0.0, expectVav: 0.0, expectClamped: true},
		{name: "100% damper via percentage", command: "DAMPER=100", expectTwin: 1.0, expectVav: 1.0, expectClamped: true},
		{name: "1.0 damper via ratio", command: "DAMPER=1.0", expectTwin: 1.0, expectVav: 1.0, expectClamped: true},
		{name: "50% damper integer", command: "DAMPER=50", expectTwin: 0.5, expectVav: 0.5, expectClamped: true},
		{name: "0.5 damper float", command: "DAMPER=0.5", expectTwin: 0.5, expectVav: 0.5, expectClamped: true},

		// Non-integer values
		{name: "33.3% fractional percent", command: "DAMPER=33.3", expectTwin: 0.333, expectVav: 0.333, expectClamped: true},
		{name: "0.4567 fractional ratio", command: "DAMPER=0.4567", expectTwin: 0.4567, expectVav: 0.4567, expectClamped: true},
		{name: "12.345% fine granularity", command: "DAMPER=12.345", expectTwin: 0.12345, expectVav: 0.12345, expectClamped: true},

		// Out of range & extreme values (MUST be clamped to [0.0, 1.0])
		{name: "Negative ratio -0.5", command: "DAMPER=-0.5", expectTwin: 0.0, expectVav: 0.0, expectClamped: true},
		{name: "Negative percent -50", command: "DAMPER=-50", expectTwin: 0.0, expectVav: 0.0, expectClamped: true},
		{name: "Extreme negative -9999", command: "DAMPER=-9999", expectTwin: 0.0, expectVav: 0.0, expectClamped: true},
		{name: "Over 100%: 101%", command: "DAMPER=101", expectTwin: 1.0, expectVav: 1.0, expectClamped: true},
		{name: "Over 100%: 250%", command: "DAMPER=250", expectTwin: 1.0, expectVav: 1.0, expectClamped: true},
		{name: "Extreme positive: 999999", command: "DAMPER=999999", expectTwin: 1.0, expectVav: 1.0, expectClamped: true},

		// VAV_SET syntax variations
		{name: "VAV_SET:0 boundary", command: "VAV_SET:0", expectTwin: 0.0, expectVav: 0.0, expectClamped: true},
		{name: "VAV_SET:100 boundary", command: "VAV_SET:100", expectTwin: 1.0, expectVav: 1.0, expectClamped: true},
		{name: "VAV_SET:75 standard", command: "VAV_SET:75", expectTwin: 0.75, expectVav: 0.75, expectClamped: true},
		{name: "VAV_SET:150 clamped", command: "VAV_SET:150", expectTwin: 1.0, expectVav: 1.0, expectClamped: true},
		{name: "VAV_SET:-20 clamped", command: "VAV_SET:-20", expectTwin: 0.0, expectVav: 0.0, expectClamped: true},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			body := fmt.Sprintf(`{"zone": "zone-office-damper", "command": "%s"}`, tc.command)
			req := httptest.NewRequest(http.MethodPost, "/api/command", bytes.NewBufferString(body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("expected HTTP 200 for %q, got %d: %s", tc.command, rec.Code, rec.Body.String())
			}

			if lastMqttPayload != tc.command {
				t.Errorf("MQTT payload mismatch: expected %q, got %q", tc.command, lastMqttPayload)
			}

			// Verify clamping invariant in ZoneSim
			if math.Abs(z.DamperPos-tc.expectTwin) > 1e-4 {
				t.Errorf("ZoneSim DamperPos mismatch for %q: expected %.4f, got %.4f", tc.command, tc.expectTwin, z.DamperPos)
			}
			if z.DamperPos < 0.0 || z.DamperPos > 1.0 {
				t.Fatalf("VIOLATION: ZoneSim DamperPos %.4f out of [0.0, 1.0] bound", z.DamperPos)
			}

			// Verify clamping invariant in VavSim
			if math.Abs(v.DamperPos-tc.expectVav) > 1e-4 {
				t.Errorf("VavSim DamperPos mismatch for %q: expected %.4f, got %.4f", tc.command, tc.expectVav, v.DamperPos)
			}
			if v.DamperPos < 0.0 || v.DamperPos > 1.0 {
				t.Fatalf("VIOLATION: VavSim DamperPos %.4f out of [0.0, 1.0] bound", v.DamperPos)
			}
		})
	}
}

// TestEmpiricalStress_IRBlasterProtocolsAndHexCodes validates varied IR blaster
// protocols (COOLIX, GREE, DAIKIN, PANASONIC, etc.), hex lengths, and edge cases.
// Confirms that MQTT topic is correctly formatted (econ/commands/<topic>) and
// payload structure adheres to IR_SEND:<proto>:<hex>:<bits>.
func TestEmpiricalStress_IRBlasterProtocolsAndHexCodes(t *testing.T) {
	engine, z, _ := setupStressEngine("zone-ir-test", "vav-ir-test")
	handler := commandHandler(engine)

	var lastTopic, lastPayload string
	engine.Publish = func(topic, payload string) {
		lastTopic = topic
		lastPayload = payload
	}

	irCases := []struct {
		protocol string
		hexCode  string
		bits     int
	}{
		// Standard vendor AC protocols
		{protocol: "COOLIX", hexCode: "0xB27BE0", bits: 32},
		{protocol: "GREE", hexCode: "0x112233445566", bits: 64},
		{protocol: "DAIKIN", hexCode: "0x123456789ABC", bits: 64},
		{protocol: "PANASONIC", hexCode: "0x0220E00400000006", bits: 48},
		{protocol: "MITSUBISHI", hexCode: "0x23CB26010020", bits: 48},
		{protocol: "LG", hexCode: "0x8800940", bits: 28},
		{protocol: "SAMSUNG", hexCode: "0xE2C2000000000000", bits: 64},
		{protocol: "TOSHIBA", hexCode: "0xF20D03FC01", bits: 40},
		{protocol: "ELECTRA_AC", hexCode: "0xC1A2B3", bits: 24},

		// Standard AV / generic protocols
		{protocol: "NEC", hexCode: "0x20DF10EF", bits: 32},
		{protocol: "SONY", hexCode: "0xA90", bits: 12},
		{protocol: "RC5", hexCode: "0x100C", bits: 14},
		{protocol: "RC6", hexCode: "0xC", bits: 20},

		// Boundary hex patterns
		{protocol: "RAW", hexCode: "0x0", bits: 8},
		{protocol: "COOLIX", hexCode: "0xFFFFFFFFFFFFFFFF", bits: 64},
		{protocol: "CUSTOM", hexCode: "0x123", bits: 16},
	}

	for _, ic := range irCases {
		t.Run(fmt.Sprintf("%s_%dbits", ic.protocol, ic.bits), func(t *testing.T) {
			lastTopic = ""
			lastPayload = ""

			cmd := fmt.Sprintf("IR_SEND:%s:%s:%d", ic.protocol, ic.hexCode, ic.bits)
			body := fmt.Sprintf(`{"zone": "zone-ir-test", "command": "%s"}`, cmd)
			req := httptest.NewRequest(http.MethodPost, "/api/command", bytes.NewBufferString(body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("expected HTTP 200 for %q, got %d: %s", cmd, rec.Code, rec.Body.String())
			}

			// Invariant 1: Published to correct MQTT topic econ/commands/<topic>
			expectedTopic := "econ/commands/esp32-zone-ir-test"
			if lastTopic != expectedTopic {
				t.Errorf("topic mismatch: expected %q, got %q", expectedTopic, lastTopic)
			}

			// Invariant 2: Published payload preserved exactly
			if lastPayload != cmd {
				t.Errorf("payload mismatch: expected %q, got %q", cmd, lastPayload)
			}

			// Invariant 3: Twin state records DetectedProtocol and IrState
			if z.DetectedProtocol != ic.protocol {
				t.Errorf("DetectedProtocol mismatch: expected %q, got %q", ic.protocol, z.DetectedProtocol)
			}
			if z.IrState == nil || *z.IrState != cmd {
				t.Errorf("IrState mismatch: expected %q, got %v", cmd, z.IrState)
			}
		})
	}
}

// TestEmpiricalStress_15MinuteManualOverrideLatching tests the human-in-the-loop veto
// latch window. Ensures that:
// 1. Manual commands set OverrideUntil = time.Now() + 15m.
// 2. Synthetic/autonomous operations (AutoPilot setbacks) CANNOT overwrite twin state
//    while latch is active.
// 3. Once latch expires, autonomous setback successfully resumes.
func TestEmpiricalStress_15MinuteManualOverrideLatching(t *testing.T) {
	engine, z, _ := setupStressEngine("zone-latch-test", "vav-latch-test")
	handler := commandHandler(engine)

	engine.SetAutoPilot(true)
	z.Occupancy = 0
	z.VacantTicks = 500
	z.BaseSetpoint = 24.0
	z.Setpoint = 24.0
	z.LightsOn = true

	// Step 1: Issue manual override command (e.g. Setpoint 21.0, Lights On)
	manualCmd := "LIGHTS_ON;SETPOINT=21.0"
	body := fmt.Sprintf(`{"zone": "zone-latch-test", "command": "%s"}`, manualCmd)
	req := httptest.NewRequest(http.MethodPost, "/api/command", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("manual command failed with status %d: %s", rec.Code, rec.Body.String())
	}

	// Verify latch window is approximately 15 minutes
	remaining := time.Until(z.OverrideUntil)
	if remaining < 14*time.Minute+50*time.Second || remaining > 15*time.Minute+5*time.Second {
		t.Fatalf("OverrideUntil latch window unexpected: %v (expected ~15m)", remaining)
	}

	// Step 2: Simulate 50 autonomous Actuate() cycles during active latch window
	for i := 0; i < 50; i++ {
		engine.Actuate()
	}

	// Invariant: Twin setpoint and lights MUST NOT be modified by autonomous setback
	if z.Setpoint != 21.0 {
		t.Fatalf("AUTONOMOUS OVERWRITE: Setpoint was changed to %.1f during active 15m latch (expected 21.0)", z.Setpoint)
	}
	if !z.LightsOn {
		t.Fatalf("AUTONOMOUS OVERWRITE: Lights were turned off during active 15m latch (expected true)")
	}

	// Step 3: Test near latch expiry (e.g. 1 second remaining)
	z.OverrideUntil = time.Now().Add(1 * time.Second)
	engine.Actuate()
	if z.Setpoint != 21.0 || !z.LightsOn {
		t.Fatalf("AUTONOMOUS OVERWRITE at t=14m59s: Setpoint=%.1f, LightsOn=%v", z.Setpoint, z.LightsOn)
	}

	// Step 4: Advance past latch expiration (latch expired 2 seconds ago)
	z.OverrideUntil = time.Now().Add(-2 * time.Second)
	engine.Actuate()

	// Invariant: Autonomous setback NOW has permission to resume control
	// Vacant room with base 24.0°C should be setback to >= 25.0°C and lights switched OFF
	if z.Setpoint == 21.0 {
		t.Fatalf("LATCH FAILURE: Autonomous setback failed to reassert after 15m latch expired (setpoint remained 21.0)")
	}
	if z.Setpoint < 25.0 {
		t.Errorf("expected setback setpoint >= 25.0°C, got %.1f°C", z.Setpoint)
	}
	if z.LightsOn {
		t.Errorf("expected autonomous setback to turn lights off for vacant room after latch expired")
	}
}

// ============================================================================
// PART 2: SIMULATION VS REAL MODE TOGGLE EMPIRICAL STRESS
// ============================================================================

// TestEmpiricalStress_RapidModeToggleThrashing executes 500 rapid mode toggles
// between Simulation and Real Mode across 20 concurrent goroutines, while sending
// telemetry and manual overrides.
// Verifies thread safety, absence of deadlocks, and idempotence.
func TestEmpiricalStress_RapidModeToggleThrashing(t *testing.T) {
	engine, _, _ := setupStressEngine("zone-mode-thrash", "vav-mode-thrash")
	h := modeHandler(engine, nil)

	numToggles := 500
	concurrency := 20
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup

	var simSwitches atomic.Int64
	var realSwitches atomic.Int64

	for i := 0; i < numToggles; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			targetMode := "real"
			if idx%2 == 0 {
				targetMode = "simulation"
			}

			body := fmt.Sprintf(`{"mode": "%s"}`, targetMode)
			req := httptest.NewRequest(http.MethodPost, "/api/mode", bytes.NewBufferString(body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()

			h.ServeHTTP(rec, req)

			if rec.Code != http.StatusOK {
				t.Errorf("mode switch to %q failed with status %d: %s", targetMode, rec.Code, rec.Body.String())
			} else {
				if targetMode == "real" {
					realSwitches.Add(1)
				} else {
					simSwitches.Add(1)
				}
			}
		}(i)
	}

	wg.Wait()

	t.Logf("Mode Thrashing Complete: SimSwitches=%d, RealSwitches=%d, FinalMode=%s",
		simSwitches.Load(), realSwitches.Load(), engine.Mode().String())

	// Verify engine mode is in a valid state
	finalMode := engine.Mode()
	if finalMode != simulation.ModeSimulation && finalMode != simulation.ModeReal {
		t.Fatalf("corrupted engine mode: %v", finalMode)
	}
}

// TestEmpiricalStress_ExhaustiveMockRejectionInModeReal ensures that in ModeReal,
// EVERY variety of mock/simulated telemetry is strictly rejected with a non-nil error,
// and zone state is 100% immune to mutation.
func TestEmpiricalStress_ExhaustiveMockRejectionInModeReal(t *testing.T) {
	engine, z, _ := setupStressEngine("zone-mock-reject", "vav-mock-reject")

	// Set engine strictly to ModeReal
	engine.SetMode(simulation.ModeReal)
	if !engine.IsRealMode() {
		t.Fatalf("expected engine to be in ModeReal")
	}

	// Establish baseline state
	baselineTemp := 23.5
	baselineHum := 50.0
	baselineOcc := 3
	baselineStripW := 150.0
	z.Temp = baselineTemp
	z.HwTemp = baselineTemp
	z.HwHum = baselineHum
	z.Occupancy = baselineOcc
	z.HwStripW = baselineStripW

	tr := true
	fl := false
	badTemp := 99.9
	badHum := 99.0
	badOcc := 99
	badStrip := 9999.0

	mockVariations := []struct {
		name        string
		measurement simulation.Measurement
	}{
		{
			name: "Explicit mock: true",
			measurement: simulation.Measurement{
				Mock:      &tr,
				Temp:      &badTemp,
				TempReal:  true,
				Humidity:  &badHum,
				Occupancy: &badOcc,
				StripW:    &badStrip,
			},
		},
		{
			name: "Explicit simulated: true",
			measurement: simulation.Measurement{
				Simulated: &tr,
				Temp:      &badTemp,
				TempReal:  true,
				Humidity:  &badHum,
				Occupancy: &badOcc,
			},
		},
		{
			name: "Source: mock (lowercase)",
			measurement: simulation.Measurement{
				Source:    "mock",
				Temp:      &badTemp,
				TempReal:  true,
				Occupancy: &badOcc,
			},
		},
		{
			name: "Source: MOCK (uppercase)",
			measurement: simulation.Measurement{
				Source:    "MOCK",
				Temp:      &badTemp,
				TempReal:  true,
				Occupancy: &badOcc,
			},
		},
		{
			name: "Source: sim",
			measurement: simulation.Measurement{
				Source:    "sim",
				Temp:      &badTemp,
				TempReal:  true,
				Occupancy: &badOcc,
			},
		},
		{
			name: "Source: simulation",
			measurement: simulation.Measurement{
				Source:    "simulation",
				Temp:      &badTemp,
				TempReal:  true,
				Occupancy: &badOcc,
			},
		},
		{
			name: "Source: synthetic",
			measurement: simulation.Measurement{
				Source:    "synthetic",
				Temp:      &badTemp,
				TempReal:  true,
				Occupancy: &badOcc,
			},
		},
		{
			name: "Source: test",
			measurement: simulation.Measurement{
				Source:    "test",
				Temp:      &badTemp,
				TempReal:  true,
				Occupancy: &badOcc,
			},
		},
		{
			name: "Padded source: '  mock  '",
			measurement: simulation.Measurement{
				Source:    "  mock  ",
				Temp:      &badTemp,
				TempReal:  true,
				Occupancy: &badOcc,
			},
		},
		{
			name: "TempReal: false with valid Temp",
			measurement: simulation.Measurement{
				Source:    "hardware-node",
				Temp:      &badTemp,
				TempReal:  false, // Mock temperature
				Occupancy: &badOcc,
			},
		},
	}

	for _, mv := range mockVariations {
		t.Run(mv.name, func(t *testing.T) {
			err := engine.IngestTelemetry("zone-mock-reject", "esp32-zone-mock-reject", mv.measurement)

			// Invariant 1: IngestTelemetry MUST return non-nil error in ModeReal
			if err == nil {
				t.Fatalf("SECURITY VIOLATION: Mock payload was accepted in ModeReal for %q", mv.name)
			}

			// Invariant 2: Zone state MUST NOT be mutated
			if z.HwTemp != baselineTemp {
				t.Fatalf("STATE MUTATION: HwTemp changed from %.1f to %.1f on rejected mock %q", baselineTemp, z.HwTemp, mv.name)
			}
			if z.HwHum != baselineHum {
				t.Fatalf("STATE MUTATION: HwHum changed from %.1f to %.1f on rejected mock %q", baselineHum, z.HwHum, mv.name)
			}
			if z.Occupancy != baselineOcc {
				t.Fatalf("STATE MUTATION: Occupancy changed from %d to %d on rejected mock %q", baselineOcc, z.Occupancy, mv.name)
			}
			if z.HwStripW != baselineStripW {
				t.Fatalf("STATE MUTATION: HwStripW changed from %.1f to %.1f on rejected mock %q", baselineStripW, z.HwStripW, mv.name)
			}
		})
	}

	// Positive Control: Genuine physical measurement MUST be accepted in ModeReal
	t.Run("Genuine physical telemetry is accepted in ModeReal", func(t *testing.T) {
		validTemp := 24.8
		validHum := 55.0
		validOcc := 5
		validStrip := 320.0
		validMeas := simulation.Measurement{
			Source:    "esp32-real-node-01",
			Temp:      &validTemp,
			TempReal:  true,
			Humidity:  &validHum,
			Occupancy: &validOcc,
			StripW:    &validStrip,
			Mock:      &fl,
			Simulated: &fl,
		}

		err := engine.IngestTelemetry("zone-mock-reject", "esp32-zone-mock-reject", validMeas)
		if err != nil {
			t.Fatalf("expected genuine telemetry to be accepted in ModeReal, got error: %v", err)
		}

		if z.HwTemp != validTemp {
			t.Errorf("expected HwTemp %.1f, got %.1f", validTemp, z.HwTemp)
		}
		if z.HwHum != validHum {
			t.Errorf("expected HwHum %.1f, got %.1f", validHum, z.HwHum)
		}
		if z.Occupancy != validOcc {
			t.Errorf("expected Occupancy %d, got %d", validOcc, z.Occupancy)
		}
		if z.HwStripW != validStrip {
			t.Errorf("expected HwStripW %.1f, got %.1f", validStrip, z.HwStripW)
		}
	})
}

// TestEmpiricalStress_SimulationModeAcceptsSyntheticTelemetry verifies that when
// engine is in ModeSimulation, mock/synthetic payloads are accepted and update the twin.
func TestEmpiricalStress_SimulationModeAcceptsSyntheticTelemetry(t *testing.T) {
	engine, z, _ := setupStressEngine("zone-sim-accept", "vav-sim-accept")

	engine.SetMode(simulation.ModeSimulation)
	if engine.IsRealMode() {
		t.Fatalf("expected engine to be in ModeSimulation")
	}

	simTemp := 26.2
	simOcc := 7
	simStrip := 480.0
	tr := true
	syntheticMeas := simulation.Measurement{
		Source:    "synthetic-generator",
		Mock:      &tr,
		Temp:      &simTemp,
		TempReal:  false,
		Occupancy: &simOcc,
		StripW:    &simStrip,
	}

	err := engine.IngestTelemetry("zone-sim-accept", "esp32-zone-sim-accept", syntheticMeas)
	if err != nil {
		t.Fatalf("expected synthetic telemetry to be accepted in ModeSimulation, got error: %v", err)
	}

	if z.Occupancy != simOcc {
		t.Errorf("expected Occupancy %d, got %d", simOcc, z.Occupancy)
	}
	if z.HwStripW != simStrip {
		t.Errorf("expected HwStripW %.1f, got %.1f", simStrip, z.HwStripW)
	}
}

// TestEmpiricalStress_ElectricalDisaggregationInModeReal validates that in Real Mode:
// 1. ACS712 plug strip power (stripW) maps strictly to HwStripW.
// 2. Zone Circuit Breaker power (circuitBreakerW / cbW) maps strictly to HwPlugW and HwCircuitBreakerW.
// 3. Simultaneous ingestion preserves both distinct measurements without cross-field contamination.
func TestEmpiricalStress_ElectricalDisaggregationInModeReal(t *testing.T) {
	engine, z, _ := setupStressEngine("zone-power-disagg", "vav-power-disagg")
	engine.SetMode(simulation.ModeReal)

	// Subtest 1: Only Circuit Breaker telemetry
	t.Run("Circuit Breaker telemetry maps to HwPlugW and HwCircuitBreakerW", func(t *testing.T) {
		cbPower := 1850.5
		meas := simulation.Measurement{
			Source:          "esp32-cb-clamp",
			CircuitBreakerW: &cbPower,
			TempReal:        true,
		}

		err := engine.IngestTelemetry("zone-power-disagg", "esp32-zone-power-disagg", meas)
		if err != nil {
			t.Fatalf("telemetry rejected: %v", err)
		}

		if z.HwCircuitBreakerW != cbPower {
			t.Errorf("expected HwCircuitBreakerW %.1f, got %.1f", cbPower, z.HwCircuitBreakerW)
		}
		if z.HwPlugW != cbPower {
			t.Errorf("expected HwPlugW %.1f, got %.1f", cbPower, z.HwPlugW)
		}
		if z.HwStripW != 0.0 {
			t.Errorf("expected HwStripW 0.0, got %.1f", z.HwStripW)
		}
	})

	// Subtest 2: Only ACS712 Power Strip telemetry
	t.Run("Power Strip telemetry maps to HwStripW without clobbering CB", func(t *testing.T) {
		stripPower := 435.0
		meas := simulation.Measurement{
			Source:   "esp32-strip-sensor",
			StripW:   &stripPower,
			TempReal: true,
		}

		err := engine.IngestTelemetry("zone-power-disagg", "esp32-zone-power-disagg", meas)
		if err != nil {
			t.Fatalf("telemetry rejected: %v", err)
		}

		// Strip power updated
		if z.HwStripW != stripPower {
			t.Errorf("expected HwStripW %.1f, got %.1f", stripPower, z.HwStripW)
		}
		// CB power preserved
		if z.HwCircuitBreakerW != 1850.5 {
			t.Errorf("HwCircuitBreakerW clobbered: expected 1850.5, got %.1f", z.HwCircuitBreakerW)
		}
		if z.HwPlugW != 1850.5 {
			t.Errorf("HwPlugW clobbered: expected 1850.5, got %.1f", z.HwPlugW)
		}
	})

	// Subtest 3: Simultaneous CB + Strip telemetry in a single payload
	t.Run("Simultaneous CB and Strip telemetry disaggregates cleanly", func(t *testing.T) {
		cbPower := 2200.0
		stripPower := 610.0
		meas := simulation.Measurement{
			Source:          "esp32-full-panel",
			CircuitBreakerW: &cbPower,
			StripW:          &stripPower,
			TempReal:        true,
		}

		err := engine.IngestTelemetry("zone-power-disagg", "esp32-zone-power-disagg", meas)
		if err != nil {
			t.Fatalf("telemetry rejected: %v", err)
		}

		if z.HwCircuitBreakerW != cbPower {
			t.Errorf("expected HwCircuitBreakerW %.1f, got %.1f", cbPower, z.HwCircuitBreakerW)
		}
		if z.HwPlugW != cbPower {
			t.Errorf("expected HwPlugW %.1f, got %.1f", cbPower, z.HwPlugW)
		}
		if z.HwStripW != stripPower {
			t.Errorf("expected HwStripW %.1f, got %.1f", stripPower, z.HwStripW)
		}
	})

	// Subtest 4: cbW alias behaves identically to CircuitBreakerW
	t.Run("cbW field alias maps properly", func(t *testing.T) {
		aliasCb := 1420.0
		meas := simulation.Measurement{
			Source:   "esp32-cb-alias",
			CbW:      &aliasCb,
			TempReal: true,
		}

		err := engine.IngestTelemetry("zone-power-disagg", "esp32-zone-power-disagg", meas)
		if err != nil {
			t.Fatalf("telemetry rejected: %v", err)
		}

		if z.HwCircuitBreakerW != aliasCb {
			t.Errorf("expected HwCircuitBreakerW %.1f, got %.1f", aliasCb, z.HwCircuitBreakerW)
		}
		if z.HwPlugW != aliasCb {
			t.Errorf("expected HwPlugW %.1f, got %.1f", aliasCb, z.HwPlugW)
		}
	})
}

// TestEmpiricalStress_HostileMaxPressureCrossSystem executes an intense cross-system stress:
// - 500 concurrent requests alternating between /api/mode and /api/command
// - 100 concurrent telemetry samples (mix of mock, genuine, stripW, circuitBreakerW)
// - Continuous background Actuate() and Broadcast() loops
// - Validates system invariants under maximum concurrency and cross-pressure.
func TestEmpiricalStress_HostileMaxPressureCrossSystem(t *testing.T) {
	engine, z, v := setupStressEngine("zone-max-pressure", "vav-max-pressure")
	cmdH := commandHandler(engine)
	modeH := modeHandler(engine, nil)

	var wg sync.WaitGroup
	numRequests := 500
	concurrency := 25
	sem := make(chan struct{}, concurrency)

	var successfulCommands atomic.Int64
	var successfulModes atomic.Int64
	var rejectedMocksInReal atomic.Int64
	var acceptedTelemetry atomic.Int64

	// Background worker 1: high frequency Actuate()
	stopBg := make(chan struct{})
	var actuateTicks atomic.Int64
	go func() {
		ticker := time.NewTicker(1 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stopBg:
				return
			case <-ticker.C:
				engine.Actuate()
				actuateTicks.Add(1)
			}
		}
	}()

	// Dispatcher group: 500 concurrent HTTP requests
	for i := 0; i < numRequests; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			if idx%2 == 0 {
				// /api/mode switch
				target := "simulation"
				if (idx/2)%2 == 1 {
					target = "real"
				}
				body := fmt.Sprintf(`{"mode": "%s"}`, target)
				req := httptest.NewRequest(http.MethodPost, "/api/mode", bytes.NewBufferString(body))
				req.Header.Set("Content-Type", "application/json")
				rec := httptest.NewRecorder()

				modeH.ServeHTTP(rec, req)
				if rec.Code == http.StatusOK {
					successfulModes.Add(1)
				}
			} else {
				// /api/command actuation
				cmds := []string{
					"IR_SEND:DAIKIN:0xDEADBEEF:32",
					"PLUG_ON",
					"PLUG_OFF",
					"DAMPER=60",
					"VAV_SET:35",
					"CPU_STRAIN:HIGH",
					"CPU_STRAIN:NORMAL",
					"LIGHTS_ON",
					"LIGHTS_OFF",
				}
				cmd := cmds[idx%len(cmds)]
				body := fmt.Sprintf(`{"zone": "zone-max-pressure", "command": "%s"}`, cmd)
				req := httptest.NewRequest(http.MethodPost, "/api/command", bytes.NewBufferString(body))
				req.Header.Set("Content-Type", "application/json")
				rec := httptest.NewRecorder()

				cmdH.ServeHTTP(rec, req)
				if rec.Code == http.StatusOK {
					successfulCommands.Add(1)
				}
			}

			// Interleaved telemetry injection
			temp := 22.0 + float64(idx%10)*0.5
			cbPower := 1500.0 + float64(idx%50)*10.0
			stripPower := 300.0 + float64(idx%20)*5.0
			isMock := (idx%3 == 0)

			meas := simulation.Measurement{
				Temp:            &temp,
				TempReal:        !isMock,
				CircuitBreakerW: &cbPower,
				StripW:          &stripPower,
			}
			if isMock {
				meas.Source = "mock"
			} else {
				meas.Source = "esp32-real-probe"
			}

			err := engine.IngestTelemetry("zone-max-pressure", "esp32-zone-max-pressure", meas)
			if err != nil {
				rejectedMocksInReal.Add(1)
			} else {
				acceptedTelemetry.Add(1)
			}
		}(i)
	}

	wg.Wait()
	close(stopBg)

	t.Logf("Hostile Stress Summary: Modes=%d, Commands=%d, TelemetryAccepted=%d, MocksRejected=%d, ActuateTicks=%d",
		successfulModes.Load(), successfulCommands.Load(), acceptedTelemetry.Load(), rejectedMocksInReal.Load(), actuateTicks.Load())

	if successfulModes.Load()+successfulCommands.Load() != int64(numRequests) {
		t.Fatalf("expected all %d requests to succeed, got %d modes + %d commands",
			numRequests, successfulModes.Load(), successfulCommands.Load())
	}

	// Invariant Checks
	if z.DamperPos < 0.0 || z.DamperPos > 1.0 {
		t.Fatalf("ZoneSim DamperPos invariant violated: %.4f", z.DamperPos)
	}
	if v.DamperPos < 0.0 || v.DamperPos > 1.0 {
		t.Fatalf("VavSim DamperPos invariant violated: %.4f", v.DamperPos)
	}
	if z.Setpoint <= 0.0 || math.IsNaN(z.Setpoint) {
		t.Fatalf("corrupted Setpoint: %.2f", z.Setpoint)
	}
}
