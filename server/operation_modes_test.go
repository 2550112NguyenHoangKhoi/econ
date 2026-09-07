package main

import (
	"testing"

	"econ/simulation"
)

// TestMQTTRealModeRejectsMockPayloads verifies that in Real Mode, handleTelemetry drops
// mock or synthetic payloads over MQTT without mutating zone state.
func TestMQTTRealModeRejectsMockPayloads(t *testing.T) {
	engine := simulation.NewEngine()
	engine.SetMode(simulation.ModeReal)

	// Pick a zone from fixture or create one
	zoneId := "zone-office-lvl1"
	z := engine.Zones[zoneId]
	if z == nil {
		// Fall back to first available zone
		for id, cand := range engine.Zones {
			zoneId = id
			z = cand
			break
		}
	}
	if z == nil {
		t.Skip("no zones available in fixture")
	}

	initialOcc := z.Occupancy
	initialLive := z.Live

	// 1. Explicit mock: true
	handleTelemetry(engine, "econ/telemetry/"+zoneId, []byte(`{"zone":"`+zoneId+`","mock":true,"occupancy":99}`))
	if z.Occupancy != initialOcc || z.Live != initialLive {
		t.Fatalf("mock payload mutated zone in Real Mode: occ=%d live=%v", z.Occupancy, z.Live)
	}

	// 2. Source: "mock"
	handleTelemetry(engine, "econ/telemetry/"+zoneId, []byte(`{"zone":"`+zoneId+`","source":"mock","occupancy":88}`))
	if z.Occupancy != initialOcc {
		t.Fatalf("source:mock payload mutated zone in Real Mode: occ=%d", z.Occupancy)
	}

	// 3. Source: "simulation"
	handleTelemetry(engine, "econ/telemetry/"+zoneId, []byte(`{"zone":"`+zoneId+`","source":"simulation","occupancy":77}`))
	if z.Occupancy != initialOcc {
		t.Fatalf("source:simulation payload mutated zone in Real Mode: occ=%d", z.Occupancy)
	}

	// 4. Placeholder temperature: tempReal false
	handleTelemetry(engine, "econ/telemetry/"+zoneId, []byte(`{"zone":"`+zoneId+`","temperature":22.0,"tempReal":false,"source":"esp32","occupancy":66}`))
	if z.Occupancy != initialOcc {
		t.Fatalf("tempReal:false payload mutated zone in Real Mode: occ=%d", z.Occupancy)
	}

	// 5. Genuine physical payload
	handleTelemetry(engine, "econ/telemetry/"+zoneId, []byte(`{"zone":"`+zoneId+`","temperature":23.5,"tempReal":true,"source":"esp32","occupancy":3}`))
	if z.Occupancy != 3 {
		t.Fatalf("genuine payload failed to update zone: expected occ=3, got %d", z.Occupancy)
	}
}

// TestMQTTSimulationModeAcceptsMockPayloads verifies that in Simulation Mode,
// mock payloads are processed normally.
func TestMQTTSimulationModeAcceptsMockPayloads(t *testing.T) {
	engine := simulation.NewEngine()
	// Ensure Simulation Mode (default)
	engine.SetMode(simulation.ModeSimulation)

	zoneId := "zone-office-lvl1"
	z := engine.Zones[zoneId]
	if z == nil {
		for id, cand := range engine.Zones {
			zoneId = id
			z = cand
			break
		}
	}
	if z == nil {
		t.Skip("no zones available in fixture")
	}

	// 1. Mock payload
	handleTelemetry(engine, "econ/telemetry/"+zoneId, []byte(`{"zone":"`+zoneId+`","mock":true,"source":"mock","occupancy":4}`))
	if z.Occupancy != 4 {
		t.Fatalf("expected occupancy 4 in simulation mode, got %d", z.Occupancy)
	}

	// 2. Placeholder temperature
	handleTelemetry(engine, "econ/telemetry/"+zoneId, []byte(`{"zone":"`+zoneId+`","temperature":21.5,"tempReal":false,"source":"esp32","occupancy":2}`))
	if z.Occupancy != 2 {
		t.Fatalf("expected occupancy 2 in simulation mode, got %d", z.Occupancy)
	}
}

// TestMQTTRealModeMapsStripWAndCB verifies MQTT telemetry ingestion maps stripW to HwStripW
// and circuitBreakerW / cbW to HwPlugW in Real Mode.
func TestMQTTRealModeMapsStripWAndCB(t *testing.T) {
	engine := simulation.NewEngine()
	engine.SetMode(simulation.ModeReal)

	zoneId := "zone-office-lvl1"
	z := engine.Zones[zoneId]
	if z == nil {
		for id, cand := range engine.Zones {
			zoneId = id
			z = cand
			break
		}
	}
	if z == nil {
		t.Skip("no zones available in fixture")
	}

	// 1. Ingest stripW and circuitBreakerW
	payload1 := `{"zone":"` + zoneId + `","stripW":245.5,"circuitBreakerW":1380.0,"source":"esp32","tempReal":true}`
	handleTelemetry(engine, "econ/telemetry/"+zoneId, []byte(payload1))

	if z.HwStripW != 245.5 {
		t.Fatalf("expected HwStripW 245.5, got %v", z.HwStripW)
	}
	if z.HwPlugW != 1380.0 {
		t.Fatalf("expected HwPlugW to be mapped from circuitBreakerW 1380.0, got %v", z.HwPlugW)
	}

	// 2. Ingest cbW alias
	payload2 := `{"zone":"` + zoneId + `","cbW":1250.0,"source":"esp32","tempReal":true}`
	handleTelemetry(engine, "econ/telemetry/"+zoneId, []byte(payload2))
	if z.HwPlugW != 1250.0 {
		t.Fatalf("expected HwPlugW to be mapped from cbW 1250.0, got %v", z.HwPlugW)
	}
}
