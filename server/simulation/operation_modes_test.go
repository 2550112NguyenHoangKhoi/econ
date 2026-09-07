package simulation

import (
	"sync"
	"testing"
	"time"
)

// TestOperationModeEnumsAndThreadSafety verifies enum definitions, parsing, string representation,
// and concurrent access safety across goroutines.
func TestOperationModeEnumsAndThreadSafety(t *testing.T) {
	e := newTestEngine()

	// 1. Default mode must be ModeSimulation
	if e.Mode() != ModeSimulation {
		t.Fatalf("expected default mode to be ModeSimulation (%v), got %v", ModeSimulation, e.Mode())
	}
	if e.IsRealMode() {
		t.Fatal("expected IsRealMode() to be false by default")
	}
	if ModeSimulation.String() != "simulation" {
		t.Fatalf("expected ModeSimulation string to be 'simulation', got %q", ModeSimulation.String())
	}
	if ModeReal.String() != "real" {
		t.Fatalf("expected ModeReal string to be 'real', got %q", ModeReal.String())
	}

	// 2. ParseOperationMode
	if ParseOperationMode("real") != ModeReal || ParseOperationMode("REAL") != ModeReal || ParseOperationMode("mode_real") != ModeReal {
		t.Fatal("failed to parse real operation mode")
	}
	if ParseOperationMode("simulation") != ModeSimulation || ParseOperationMode("other") != ModeSimulation {
		t.Fatal("failed to parse simulation operation mode")
	}

	// 3. SetMode to ModeReal
	e.SetMode(ModeReal)
	if e.Mode() != ModeReal {
		t.Fatalf("expected mode to be ModeReal (%v), got %v", ModeReal, e.Mode())
	}
	if !e.IsRealMode() {
		t.Fatal("expected IsRealMode() to be true after SetMode(ModeReal)")
	}

	// 4. Thread-safety: concurrent reads and writes
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			if idx%2 == 0 {
				e.SetMode(ModeReal)
			} else {
				e.SetMode(ModeSimulation)
			}
			_ = e.Mode()
			_ = e.IsRealMode()
		}(i)
	}
	wg.Wait()
}

// TestRealModeStrictlyRejectsMockPayloads verifies that when the engine is in ModeReal,
// any mock payload is strictly rejected with an error and leaves zone state untouched.
func TestRealModeStrictlyRejectsMockPayloads(t *testing.T) {
	e := newTestEngine()
	e.SetMode(ModeReal)

	zoneId := "zone-office-a"
	z := e.Zones[zoneId]
	if z == nil {
		t.Fatalf("zone %s missing from test engine", zoneId)
	}

	// Snapshot pristine state
	initialOcc := z.Occupancy
	initialLive := z.Live
	initialSeenAt := z.HwSeenAt
	initialTemp := z.HwTemp
	initialPlugW := z.HwPlugW
	initialStripW := z.HwStripW

	testCases := []struct {
		name string
		m    Measurement
	}{
		{
			name: "explicit mock flag",
			m:    Measurement{Mock: bp(true), Occupancy: ip(5), Source: "esp32"},
		},
		{
			name: "explicit simulated flag",
			m:    Measurement{Simulated: bp(true), Occupancy: ip(5), Source: "esp32"},
		},
		{
			name: "mock source identifier",
			m:    Measurement{Source: "mock", Occupancy: ip(5)},
		},
		{
			name: "sim source identifier",
			m:    Measurement{Source: "sim", Occupancy: ip(5)},
		},
		{
			name: "simulation source identifier",
			m:    Measurement{Source: "simulation", Occupancy: ip(5)},
		},
		{
			name: "synthetic source identifier",
			m:    Measurement{Source: "synthetic", Occupancy: ip(5)},
		},
		{
			name: "test source identifier",
			m:    Measurement{Source: "test", Occupancy: ip(5)},
		},
		{
			name: "synthetic placeholder temperature (tempReal false)",
			m:    Measurement{Temp: fp(23.5), TempReal: false, Source: "esp32", Occupancy: ip(5)},
		},
		{
			name: "whitespace and case insensitivity on mock source",
			m:    Measurement{Source: "  MOCK  ", Occupancy: ip(5)},
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			err := e.IngestTelemetry(zoneId, "node_test", tc.m)
			if err == nil {
				t.Fatalf("expected error for mock payload (%s) in Real Mode, but got nil", tc.name)
			}

			// Verify zone state remains completely untouched
			if z.Occupancy != initialOcc {
				t.Errorf("zone occupancy mutated: expected %d, got %d", initialOcc, z.Occupancy)
			}
			if z.Live != initialLive {
				t.Errorf("zone Live mutated: expected %v, got %v", initialLive, z.Live)
			}
			if !z.HwSeenAt.Equal(initialSeenAt) {
				t.Errorf("zone HwSeenAt mutated: expected %v, got %v", initialSeenAt, z.HwSeenAt)
			}
			if z.HwTemp != initialTemp {
				t.Errorf("zone HwTemp mutated: expected %v, got %v", initialTemp, z.HwTemp)
			}
			if z.HwPlugW != initialPlugW {
				t.Errorf("zone HwPlugW mutated: expected %v, got %v", initialPlugW, z.HwPlugW)
			}
			if z.HwStripW != initialStripW {
				t.Errorf("zone HwStripW mutated: expected %v, got %v", initialStripW, z.HwStripW)
			}
		})
	}

	// Verify that a genuine physical payload is accepted in ModeReal
	genuinePayload := Measurement{
		Occupancy: ip(3),
		Temp:      fp(22.8),
		TempReal:  true,
		Source:    "esp32",
	}
	if err := e.IngestTelemetry(zoneId, "esp32_real", genuinePayload); err != nil {
		t.Fatalf("genuine payload rejected in Real Mode: %v", err)
	}
	if z.Occupancy != 3 {
		t.Errorf("expected occupancy 3, got %d", z.Occupancy)
	}
	if !z.Live {
		t.Error("expected zone to be live after genuine telemetry")
	}
	if z.HwTemp != 22.8 {
		t.Errorf("expected HwTemp 22.8, got %v", z.HwTemp)
	}
	if z.HwSeenAt.IsZero() {
		t.Error("expected HwSeenAt to be updated")
	}
}

// TestSimulationModeAcceptsMockPayloads verifies that in ModeSimulation, mock payloads
// are accepted normally without returning an error.
func TestSimulationModeAcceptsMockPayloads(t *testing.T) {
	e := newTestEngine()
	// ModeSimulation is the default
	if e.IsRealMode() {
		t.Fatal("engine must be in ModeSimulation by default")
	}

	zoneId := "zone-office-a"
	z := e.Zones[zoneId]

	// 1. Mock payload with mock source and flag
	mockMsg := Measurement{
		Mock:      bp(true),
		Source:    "mock",
		Occupancy: ip(4),
	}
	if err := e.IngestTelemetry(zoneId, "sim_node", mockMsg); err != nil {
		t.Fatalf("mock payload rejected in Simulation Mode: %v", err)
	}
	if z.Occupancy != 4 {
		t.Errorf("expected occupancy 4 in simulation mode, got %d", z.Occupancy)
	}
	if !z.Live {
		t.Error("expected zone to be live in simulation mode")
	}

	// 2. Placeholder temperature with tempReal: false
	placeholderMsg := Measurement{
		Temp:      fp(25.0),
		TempReal:  false,
		Source:    "esp32",
		Occupancy: ip(2),
	}
	if err := e.IngestTelemetry(zoneId, "sim_node", placeholderMsg); err != nil {
		t.Fatalf("placeholder payload rejected in Simulation Mode: %v", err)
	}
	if z.Occupancy != 2 {
		t.Errorf("expected occupancy 2 in simulation mode, got %d", z.Occupancy)
	}
	// In Simulation Mode, tempReal: false still prevents pinning HwTemp (as per physical sensor contract)
	if z.HwTempAt.After(time.Now().Add(-time.Second)) {
		t.Error("tempReal: false must not pin HwTemp even in simulation mode")
	}
}

// TestRealModeMapsStripWToPlugs verifies that in Real Mode, incoming stripW (ACS712 power strip sensor)
// maps directly to z.HwStripW and drives z.plugNowW() and PlugSnapshot.
func TestRealModeMapsStripWToPlugs(t *testing.T) {
	e := newTestEngine()
	e.SetMode(ModeReal)

	zoneId := "zone-office-a"
	z := e.Zones[zoneId]
	z.PlugStandbyW = 100.0

	// Ingest stripW measurement
	stripPower := 285.5
	m := Measurement{
		StripW:   fp(stripPower),
		Source:   "esp32",
		TempReal: true,
	}

	if err := e.IngestTelemetry(zoneId, "esp32_strip", m); err != nil {
		t.Fatalf("failed to ingest stripW in Real Mode: %v", err)
	}

	// 1. Verify HwStripW is stored
	if z.HwStripW != stripPower {
		t.Fatalf("expected HwStripW %v, got %v", stripPower, z.HwStripW)
	}
	if !z.stripFresh() {
		t.Fatal("expected stripFresh() to be true")
	}

	// 2. Verify plugNowW() returns HwStripW as total plug load
	total, standby := z.plugNowW()
	if total != stripPower {
		t.Fatalf("expected plugNowW() total to return stripW %v, got %v", stripPower, total)
	}
	if standby != 100.0 {
		t.Fatalf("expected standby %v, got %v", 100.0, standby)
	}

	// 3. Verify PlugSnapshot metered zones and totals
	snap := e.PlugSnapshot(10)
	if snap.MeteredZones < 1 {
		t.Fatalf("expected at least 1 metered zone in PlugSnapshot, got %d", snap.MeteredZones)
	}
	if snap.TotalKw <= 0 {
		t.Fatalf("expected positive TotalKw in PlugSnapshot, got %v", snap.TotalKw)
	}

	// 4. Verify staleness fallback: when strip reading becomes stale, plugNowW falls back
	z.HwStripAt = time.Now().Add(-hwStaleAfter - time.Second)
	if z.stripFresh() {
		t.Fatal("expected stripFresh() to be false after stale duration")
	}
	modelTotal, _ := z.plugNowW()
	if modelTotal == stripPower {
		t.Fatal("stale strip measurement must not drive plugNowW")
	}
}

// TestRealModeMapsZoneCBToPlugW verifies that in Real Mode, incoming zone Circuit Breaker power
// (CircuitBreakerW / CbW) maps directly to z.HwPlugW.
func TestRealModeMapsZoneCBToPlugW(t *testing.T) {
	e := newTestEngine()
	e.SetMode(ModeReal)

	zoneId := "zone-office-a"
	z := e.Zones[zoneId]

	// 1. Ingest via CircuitBreakerW
	cbWatts := 1450.0
	m1 := Measurement{
		CircuitBreakerW: fp(cbWatts),
		Source:          "esp32",
		TempReal:        true,
	}
	if err := e.IngestTelemetry(zoneId, "esp32_cb", m1); err != nil {
		t.Fatalf("failed to ingest CircuitBreakerW: %v", err)
	}

	if z.HwPlugW != cbWatts {
		t.Fatalf("expected HwPlugW to map to CB watts %v, got %v", cbWatts, z.HwPlugW)
	}
	if z.HwCircuitBreakerW != cbWatts {
		t.Fatalf("expected HwCircuitBreakerW %v, got %v", cbWatts, z.HwCircuitBreakerW)
	}
	if !z.plugFresh() {
		t.Fatal("expected plugFresh() to be true when zone CB is mapped to HwPlugW")
	}

	// Verify HardwareStatus reflects the CB reading in PlugW
	hwNodes := e.HardwareStatus()
	var found *HardwareNode
	for i := range hwNodes {
		if hwNodes[i].ZoneId == zoneId {
			found = &hwNodes[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("zone %s not found in HardwareStatus", zoneId)
	}
	if found.PlugW != cbWatts {
		t.Fatalf("expected HardwareStatus PlugW to be %v, got %v", cbWatts, found.PlugW)
	}

	// 2. Ingest via CbW alias
	cbWatts2 := 1280.0
	m2 := Measurement{
		CbW:      fp(cbWatts2),
		Source:   "esp32",
		TempReal: true,
	}
	if err := e.IngestTelemetry(zoneId, "esp32_cb2", m2); err != nil {
		t.Fatalf("failed to ingest CbW: %v", err)
	}
	if z.HwPlugW != cbWatts2 {
		t.Fatalf("expected HwPlugW to map to CbW %v, got %v", cbWatts2, z.HwPlugW)
	}
	if z.HwCircuitBreakerW != cbWatts2 {
		t.Fatalf("expected HwCircuitBreakerW %v, got %v", cbWatts2, z.HwCircuitBreakerW)
	}
}

// TestRealModeConcurrentStripWAndZoneCBDisaggregation verifies that stripW (power strip)
// and zone CB (circuit breaker) coexist harmoniously: stripW maps to plugs (plugNowW),
// and CB maps to circuit branch power (HwPlugW).
func TestRealModeConcurrentStripWAndZoneCBDisaggregation(t *testing.T) {
	e := newTestEngine()
	e.SetMode(ModeReal)

	zoneId := "zone-office-a"
	z := e.Zones[zoneId]
	z.PlugStandbyW = 120.0

	stripW := 175.5
	cbW := 1580.0

	m := Measurement{
		StripW:          fp(stripW),
		CircuitBreakerW: fp(cbW),
		Source:          "esp32",
		TempReal:        true,
	}

	if err := e.IngestTelemetry(zoneId, "esp32_subboard", m); err != nil {
		t.Fatalf("failed to ingest disaggregated power telemetry: %v", err)
	}

	// Check plugNowW() uses stripW (power strip end-use)
	totalPlug, _ := z.plugNowW()
	if totalPlug != stripW {
		t.Fatalf("expected plugNowW() to return stripW %v, got %v", stripW, totalPlug)
	}

	// Check HwPlugW is mapped from CircuitBreakerW (branch level)
	if z.HwPlugW != cbW {
		t.Fatalf("expected HwPlugW to map from CircuitBreakerW %v, got %v", cbW, z.HwPlugW)
	}
	if z.HwStripW != stripW {
		t.Fatalf("expected HwStripW %v, got %v", stripW, z.HwStripW)
	}

	// Check HardwareStatus exposes both
	hwNodes := e.HardwareStatus()
	var node *HardwareNode
	for i := range hwNodes {
		if hwNodes[i].ZoneId == zoneId {
			node = &hwNodes[i]
			break
		}
	}
	if node == nil {
		t.Fatalf("zone %s not found in HardwareStatus", zoneId)
	}
	if node.PlugW != cbW {
		t.Errorf("expected HardwareNode.PlugW == %v, got %v", cbW, node.PlugW)
	}
	if node.StripW != stripW {
		t.Errorf("expected HardwareNode.StripW == %v, got %v", stripW, node.StripW)
	}
}
