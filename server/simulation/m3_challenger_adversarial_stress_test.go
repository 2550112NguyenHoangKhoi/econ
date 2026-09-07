package simulation

import (
	"fmt"
	"math"
	"math/rand"
	"strings"
	"sync"
	"testing"
	"time"
)

// ============================================================================
// EMPIRICAL CHALLENGER TEST SUITE: MILESTONE 3 ADVERSARIAL STRESS VERIFICATION
// ============================================================================
// Author: teamwork_preview_challenger_m3_1
// Scope:
// 1. Slew Rate Stress (MaxDamperSlewRate bounding, no instantaneous leaps)
// 2. Static Pressure Ceiling Stress (P_ahu <= 650 Pa under extreme throttling/high fan pressure)
// 3. Minimum Ventilation Floor (DamperPos >= 0.15 during vacancy/deep setback/negative thermal error)
// 4. Mode Segregation Stress (Strict mock rejection, stripW -> plugs, CB -> plugW)
// ============================================================================

// Helper to create a controlled dual-zone test twin
func newControlledM3Twin() *Engine {
	e := NewEngine()
	e.Zones = make(map[string]*ZoneSim)
	e.Vavs = make(map[string]*VavSim)
	e.SetAutoPilot(true)

	// Zone A: Office
	zA := &ZoneSim{
		BimAssetId:   "zone-office-a",
		Type:         "office",
		BaseSetpoint: 24.0,
		Setpoint:     24.0,
		Temp:         24.0,
		WallTemp:     24.0,
		Occupancy:    2,
		BaseHeatGain: 400.0,
		RIn:          0.001,
		ROut:         0.0011,
		CAir:         5e5,
		CWall:        4e6,
		PlugStandbyW: 100.0,
		MqttTopic:    "zone_a",
	}

	// Zone B: Conference Room
	zB := &ZoneSim{
		BimAssetId:   "zone-conf-b",
		Type:         "meeting-room",
		BaseSetpoint: 23.0,
		Setpoint:     23.0,
		Temp:         23.0,
		WallTemp:     23.0,
		Occupancy:    6,
		BaseHeatGain: 800.0,
		RIn:          0.001,
		ROut:         0.0011,
		CAir:         6e5,
		CWall:        5e6,
		PlugStandbyW: 150.0,
		MqttTopic:    "zone_b",
	}

	e.Zones["zone-office-a"] = zA
	e.Zones["zone-conf-b"] = zB

	vA := &VavSim{
		TargetZone:       "zone-office-a",
		NominalFlow:      0.8,
		DesignResistance: 12.0,
		DamperPos:        1.0,
		TargetDamperPos:  1.0,
		Position:         1.0,
		TargetPosition:   1.0,
	}
	vA.UpdateResistance()

	vB := &VavSim{
		TargetZone:       "zone-conf-b",
		NominalFlow:      1.2,
		DesignResistance: 8.0,
		DamperPos:        1.0,
		TargetDamperPos:  1.0,
		Position:         1.0,
		TargetPosition:   1.0,
	}
	vB.UpdateResistance()

	e.Vavs["vav-office-a"] = vA
	e.Vavs["vav-conf-b"] = vB

	e.sizeFanToBuilding()
	e.doHardyCross()
	return e
}

// ----------------------------------------------------------------------------
// CHECK 1: SLEW RATE STRESS TESTS
// ----------------------------------------------------------------------------

// TestAdversarial_SlewRate_AbruptSetpointJump tests that when setpoints jump abruptly,
// damper actuator travel per step dt is strictly bounded by MaxDamperSlewRate * dt.
func TestAdversarial_SlewRate_AbruptSetpointJump(t *testing.T) {
	e := newControlledM3Twin()
	vA := e.Vavs["vav-office-a"]
	zA := e.Zones["zone-office-a"]

	// Set initial damper to 0.50
	vA.DamperPos = 0.50
	vA.TargetDamperPos = 0.50
	vA.Position = 0.50
	vA.TargetPosition = 0.50
	vA.UpdateResistance()

	dts := []float64{0.033, 0.1, 0.5, 1.0, 2.0, 5.0}

	for _, dt := range dts {
		// Test A: Abrupt drop in setpoint (huge cooling demand)
		zA.Setpoint = 16.0
		zA.Temp = 28.0 // thermal error = +12°C -> targetDamper will be clamped to 1.0

		prevPos := vA.DamperPos
		e.ActuateAirflow(dt)
		currPos := vA.DamperPos

		maxAllowedTravel := MaxDamperSlewRate*dt + 1e-7
		actualTravel := math.Abs(currPos - prevPos)

		if actualTravel > maxAllowedTravel {
			t.Fatalf("dt=%.3fs: actual travel %.6f exceeded MaxDamperSlewRate*dt (%.6f) on abrupt setpoint drop",
				dt, actualTravel, maxAllowedTravel)
		}

		// Verify that it did NOT leap to 1.0 instantly
		if actualTravel < (1.0-prevPos)*0.9 && currPos >= 0.999 {
			t.Fatalf("dt=%.3fs: damper leaped instantaneously to 1.0 instead of slewing (from %.3f to %.3f)",
				dt, prevPos, currPos)
		}

		// Verify Position alias is perfectly synchronized
		if math.Abs(vA.Position-vA.DamperPos) > 1e-9 {
			t.Fatalf("dt=%.3fs: v.Position (%.6f) out of sync with v.DamperPos (%.6f)",
				dt, vA.Position, vA.DamperPos)
		}
	}
}

// TestAdversarial_SlewRate_ExtremeThermalErrorDisturbances tests that massive thermal
// error disturbances (-50°C to +80°C) cannot cause instantaneous damper jumps.
func TestAdversarial_SlewRate_ExtremeThermalErrorDisturbances(t *testing.T) {
	e := newControlledM3Twin()
	vA := e.Vavs["vav-office-a"]
	zA := e.Zones["zone-office-a"]

	rng := rand.New(rand.NewSource(42))
	dt := 1.0
	maxTravel := MaxDamperSlewRate*dt + 1e-7

	// Run 200 iterations with wild random temperatures and setpoints
	for iter := 0; iter < 200; iter++ {
		prevPos := vA.DamperPos

		// Random extreme room temp between -20°C and 90°C
		zA.Temp = -20.0 + rng.Float64()*110.0
		zA.Setpoint = 18.0 + rng.Float64()*14.0

		e.ActuateAirflow(dt)

		currPos := vA.DamperPos
		travel := math.Abs(currPos - prevPos)

		if travel > maxTravel {
			t.Fatalf("iter %d: travel %.6f exceeded MaxDamperSlewRate*dt (%.6f) with Temp=%.1f Setpoint=%.1f",
				iter, travel, maxTravel, zA.Temp, zA.Setpoint)
		}

		if currPos < MinDamperPos || currPos > MaxDamperPos {
			t.Fatalf("iter %d: DamperPos %.6f violated physical bounds [0, 1]", iter, currPos)
		}
	}
}

// TestAdversarial_SlewRate_SubSecondMicrosteps tests fine-grained microstep integration
// (e.g. dt = 0.01s) to guarantee no floating-point deadband or underflow anomalies.
func TestAdversarial_SlewRate_SubSecondMicrosteps(t *testing.T) {
	e := newControlledM3Twin()
	vA := e.Vavs["vav-office-a"]
	zA := e.Zones["zone-office-a"]

	vA.DamperPos = 0.20
	vA.Position = 0.20
	vA.TargetDamperPos = 0.20
	vA.TargetPosition = 0.20
	vA.UpdateResistance()

	zA.Temp = 30.0
	zA.Setpoint = 20.0 // cooling error -> demands open damper

	microDt := 0.01 // 10 ms steps
	totalSteps := 100
	for s := 0; s < totalSteps; s++ {
		prev := vA.DamperPos
		e.ActuateAirflow(microDt)
		diff := vA.DamperPos - prev

		maxAllowed := MaxDamperSlewRate*microDt + 1e-8
		if diff > maxAllowed {
			t.Fatalf("microstep %d: slew %.8f > maxAllowed %.8f", s, diff, maxAllowed)
		}
		if diff < 0 {
			t.Fatalf("microstep %d: negative travel %.8f while demanding cooling", s, diff)
		}
	}

	// Over 100 steps of 0.01s (1.0 second total), total travel should equal MaxDamperSlewRate * 1.0s
	expectedTotalTravel := MaxDamperSlewRate * 1.0
	actualTotalTravel := vA.DamperPos - 0.20
	if math.Abs(actualTotalTravel-expectedTotalTravel) > 1e-4 {
		t.Fatalf("expected cumulative travel %.6f over 1.0s of microsteps, got %.6f",
			expectedTotalTravel, actualTotalTravel)
	}
}

// ----------------------------------------------------------------------------
// CHECK 2: STATIC PRESSURE CEILING STRESS TESTS
// ----------------------------------------------------------------------------

// TestAdversarial_StaticPressure_ExtremeThrottlingAllBranches tests that when ALL
// dampers in the building are throttled to minimum or near-zero constriction,
// duct static pressure P_ahu is strictly checked and safety relief protects P_ahu <= 650 Pa.
func TestAdversarial_StaticPressure_ExtremeThrottlingAllBranches(t *testing.T) {
	e := newControlledM3Twin()

	// Throttle all dampers to minimum floor
	for _, v := range e.Vavs {
		v.DamperPos = MinVentDamperFloor
		v.Position = MinVentDamperFloor
		v.TargetDamperPos = MinVentDamperFloor
		v.TargetPosition = MinVentDamperFloor
		v.UpdateResistance()
	}
	e.doHardyCross()

	// Elevate fan pressure to create dangerous backpressure
	e.PMax = 1200.0 // Dangerous fan pressure

	e.doHardyCross()
	initialPahu := e.AhuPressure
	if initialPahu <= MaxSafeStaticPressurePa {
		t.Fatalf("expected initial P_ahu to exceed safety threshold with PMax=1200, got %.2f Pa", initialPahu)
	}

	// Trigger AutoPilot / safety enforcement
	e.ActuateAirflow(1.0)

	if e.AhuPressure > MaxSafeStaticPressurePa {
		t.Fatalf("AhuPressure %.2f Pa still exceeds safety limit %.1f Pa after safety relief",
			e.AhuPressure, MaxSafeStaticPressurePa)
	}

	// Verify relief mechanism: either dampers opened up or fan PMax was backed off
	dampersRelieved := false
	for _, v := range e.Vavs {
		if v.DamperPos > MinVentDamperFloor {
			dampersRelieved = true
			break
		}
	}
	fanModulated := e.PMax < 1200.0

	if !dampersRelieved && !fanModulated {
		t.Fatalf("neither damper opening relief nor fan modulation triggered during overpressure event")
	}
}

// TestAdversarial_StaticPressure_HighFanPressureSurge tests safety response under
// massive fan pressure surges up to 5000 Pa across a 50-zone virtual floor.
func TestAdversarial_StaticPressure_HighFanPressureSurge(t *testing.T) {
	e := NewEngine()
	e.Zones = make(map[string]*ZoneSim)
	e.Vavs = make(map[string]*VavSim)
	e.SetAutoPilot(true)

	// Create 50 branches
	for i := 0; i < 50; i++ {
		zid := fmt.Sprintf("zone-%02d", i)
		vid := fmt.Sprintf("vav-%02d", i)
		e.Zones[zid] = &ZoneSim{
			BimAssetId:   zid,
			BaseSetpoint: 24.0,
			Setpoint:     24.0,
			Temp:         24.0,
			Occupancy:    1,
		}
		v := &VavSim{
			TargetZone:       zid,
			NominalFlow:      0.2,
			DesignResistance: 50.0,
			DamperPos:        0.20,
			Position:         0.20,
			TargetDamperPos:  0.20,
			TargetPosition:   0.20,
		}
		v.UpdateResistance()
		e.Vavs[vid] = v
	}

	surgePressures := []float64{700.0, 1000.0, 2500.0, 5000.0}

	for _, surgeP := range surgePressures {
		e.PMax = surgeP
		e.doHardyCross()

		e.ActuateAirflow(1.0)

		if e.AhuPressure > MaxSafeStaticPressurePa {
			t.Fatalf("surge PMax=%.1f: AhuPressure %.2f Pa breached structural safety limit %.1f Pa",
				surgeP, e.AhuPressure, MaxSafeStaticPressurePa)
		}
		if math.IsNaN(e.AhuPressure) || math.IsInf(e.AhuPressure, 0) {
			t.Fatalf("surge PMax=%.1f: AhuPressure is NaN or Inf: %.2f", surgeP, e.AhuPressure)
		}
	}
}

// ----------------------------------------------------------------------------
// CHECK 3: MINIMUM VENTILATION FLOOR STRESS TESTS
// ----------------------------------------------------------------------------

// TestAdversarial_MinVentFloor_DeepSetbackVacancy tests that during long-term
// unoccupied vacancy with deep setback, damper position NEVER drops below theta_min = 0.15.
func TestAdversarial_MinVentFloor_DeepSetbackVacancy(t *testing.T) {
	e := newControlledM3Twin()
	zA := e.Zones["zone-office-a"]
	vA := e.Vavs["vav-office-a"]

	// Set zone to vacant
	zA.Occupancy = 0
	zA.VacantTicks = 100 // Exceed vacancyDelayTicks

	// Run 300 seconds of actuation ticks
	for tick := 0; tick < 300; tick++ {
		e.ActuateAirflow(1.0)

		if vA.DamperPos < MinVentDamperFloor-1e-7 {
			t.Fatalf("tick %d: DamperPos %.6f dropped below MinVentDamperFloor (%.2f)",
				tick, vA.DamperPos, MinVentDamperFloor)
		}

		if vA.Position < MinVentDamperFloor-1e-7 {
			t.Fatalf("tick %d: Position alias %.6f dropped below MinVentDamperFloor (%.2f)",
				tick, vA.Position, MinVentDamperFloor)
		}

		if vA.TargetDamperPos < MinVentDamperFloor-1e-7 {
			t.Fatalf("tick %d: TargetDamperPos %.6f dropped below MinVentDamperFloor (%.2f)",
				tick, vA.TargetDamperPos, MinVentDamperFloor)
		}

		// Ensure positive fresh airflow is continuously maintained
		if vA.Flow <= 0 {
			t.Fatalf("tick %d: airflow starved (v.Flow = %.4f) during vacancy setback", tick, vA.Flow)
		}
	}

	// Verify settled state equals exactly MinVentDamperFloor
	if math.Abs(vA.DamperPos-MinVentDamperFloor) > 1e-4 {
		t.Fatalf("expected settled damper to be %.2f, got %.6f", MinVentDamperFloor, vA.DamperPos)
	}
}

// TestAdversarial_MinVentFloor_NegativeThermalErrorOvershoot tests that even when
// a zone is severely overcooled (e.g. Temp = -10°C, Setpoint = 26°C, tempErr = -36°C),
// the damper is strictly clamped at or above MinVentDamperFloor (0.15), never shutting to 0.
func TestAdversarial_MinVentFloor_NegativeThermalErrorOvershoot(t *testing.T) {
	e := newControlledM3Twin()
	zA := e.Zones["zone-office-a"]
	vA := e.Vavs["vav-office-a"]

	// Occupied zone with deep freezing temperature
	zA.Occupancy = 2
	zA.Temp = -10.0
	zA.Setpoint = 26.0

	// Run 100 ticks
	for i := 0; i < 100; i++ {
		e.ActuateAirflow(1.0)

		if vA.TargetDamperPos < MinVentDamperFloor {
			t.Fatalf("step %d: TargetDamperPos %.4f fell below MinVentDamperFloor under negative thermal error",
				i, vA.TargetDamperPos)
		}
		if vA.DamperPos < MinVentDamperFloor-1e-7 {
			t.Fatalf("step %d: DamperPos %.4f fell below MinVentDamperFloor under negative thermal error",
				i, vA.DamperPos)
		}
	}
}

// TestAdversarial_MinVentFloor_RecoveryFromSubFloorFault tests that if an external
// fault or manual override initially placed a damper at 0.02 (below floor),
// the auto-pilot loop safely slews the damper UP to MinVentDamperFloor (0.15).
func TestAdversarial_MinVentFloor_RecoveryFromSubFloorFault(t *testing.T) {
	e := newControlledM3Twin()
	zA := e.Zones["zone-office-a"]
	vA := e.Vavs["vav-office-a"]

	// Vacant room
	zA.Occupancy = 0
	zA.VacantTicks = 60

	// Inject sub-floor damper position
	vA.DamperPos = 0.02
	vA.Position = 0.02
	vA.TargetDamperPos = 0.02
	vA.TargetPosition = 0.02
	vA.UpdateResistance()

	for s := 0; s < 20; s++ {
		prev := vA.DamperPos
		e.ActuateAirflow(1.0)
		if vA.DamperPos < prev-1e-8 {
			t.Fatalf("second %d: damper moved downwards from sub-floor position (prev=%.4f, curr=%.4f)",
				s, prev, vA.DamperPos)
		}
	}

	// Must have slewed upwards towards 0.15
	if vA.DamperPos <= 0.02 {
		t.Fatalf("damper failed to recover upwards from sub-floor 0.02, still at %.4f", vA.DamperPos)
	}
}

// ----------------------------------------------------------------------------
// CHECK 4: MODE SEGREGATION STRESS TESTS
// ----------------------------------------------------------------------------

// TestAdversarial_ModeSegregation_TrojanAndSneakyPayloads tests that in Real Mode,
// any payload carrying mock indicators (explicit flag, synthetic source, tempReal=false)
// is 100% rejected, while clean genuine telemetry is accepted.
func TestAdversarial_ModeSegregation_TrojanAndSneakyPayloads(t *testing.T) {
	e := newControlledM3Twin()
	e.SetMode(ModeReal)

	zoneId := "zone-office-a"
	zA := e.Zones[zoneId]

	tr := true
	fls := false
	tempVal := 22.5

	// Trojan payloads: realistic values but hidden mock markers
	trojans := []struct {
		name string
		m    Measurement
	}{
		{"Explicit Mock True", Measurement{Temp: &tempVal, TempReal: true, Source: "esp32", Mock: &tr}},
		{"Explicit Simulated True", Measurement{Temp: &tempVal, TempReal: true, Source: "esp32", Simulated: &tr}},
		{"Source Mock Lower", Measurement{Temp: &tempVal, TempReal: true, Source: "mock"}},
		{"Source Mock Upper Spaces", Measurement{Temp: &tempVal, TempReal: true, Source: "  MOCK  "}},
		{"Source Sim", Measurement{Temp: &tempVal, TempReal: true, Source: "sim"}},
		{"Source Simulation", Measurement{Temp: &tempVal, TempReal: true, Source: "simulation"}},
		{"Source Synthetic", Measurement{Temp: &tempVal, TempReal: true, Source: "synthetic"}},
		{"Source Test", Measurement{Temp: &tempVal, TempReal: true, Source: "test"}},
		{"TempReal False Placeholder", Measurement{Temp: &tempVal, TempReal: false, Source: "esp32"}},
	}

	for _, tc := range trojans {
		t.Run(tc.name, func(t *testing.T) {
			err := e.IngestTelemetry(zoneId, "node_trojan", tc.m)
			if err == nil {
				t.Fatalf("expected Real Mode to reject trojan payload %q, but err was nil", tc.name)
			}
			if !strings.Contains(strings.ToLower(err.Error()), "reject") {
				t.Fatalf("expected error message to contain 'reject', got %q", err.Error())
			}
			// Verify zone state was NOT mutated
			if zA.HwTemp == tempVal {
				t.Fatalf("zone HwTemp was corrupted by rejected payload %q", tc.name)
			}
		})
	}

	// Verify genuine clean payload IS accepted
	genuine := Measurement{
		Temp:     &tempVal,
		TempReal: true,
		Source:   "esp32",
		Mock:     &fls,
	}
	if err := e.IngestTelemetry(zoneId, "node_real", genuine); err != nil {
		t.Fatalf("genuine real payload was unexpectedly rejected: %v", err)
	}
	if zA.HwTemp != tempVal {
		t.Fatalf("expected HwTemp to be updated to %.1f, got %.1f", tempVal, zA.HwTemp)
	}

	// Verify Simulation Mode accepts mock payloads freely
	e.SetMode(ModeSimulation)
	mockMsg := Measurement{
		Temp:     &tempVal,
		TempReal: false,
		Source:   "simulation",
	}
	if err := e.IngestTelemetry(zoneId, "node_sim", mockMsg); err != nil {
		t.Fatalf("Simulation Mode must accept mock payload, but got: %v", err)
	}
}

// TestAdversarial_ModeSegregation_StripWAndCircuitBreakerSegregation tests that
// in Real Mode:
// - stripW (ACS712 power strip) maps to z.HwStripW and drives plugNowW()
// - circuitBreakerW / cbW (branch clamp) maps to z.HwPlugW and z.HwCircuitBreakerW
// - concurrent presence of both correctly preserves sub-metered plug vs branch hierarchy
func TestAdversarial_ModeSegregation_StripWAndCircuitBreakerSegregation(t *testing.T) {
	e := newControlledM3Twin()
	e.SetMode(ModeReal)

	zoneId := "zone-office-a"
	zA := e.Zones[zoneId]

	stripWatts := 215.4
	cbWatts := 1850.0

	m := Measurement{
		Source:          "esp32",
		TempReal:        true,
		StripW:          &stripWatts,
		CircuitBreakerW: &cbWatts,
	}

	if err := e.IngestTelemetry(zoneId, "node_power", m); err != nil {
		t.Fatalf("failed to ingest real power telemetry: %v", err)
	}

	// 1. Check direct mapping
	if zA.HwStripW != stripWatts {
		t.Fatalf("expected HwStripW == %.1f, got %.1f", stripWatts, zA.HwStripW)
	}
	if zA.HwCircuitBreakerW != cbWatts {
		t.Fatalf("expected HwCircuitBreakerW == %.1f, got %.1f", cbWatts, zA.HwCircuitBreakerW)
	}
	if zA.HwPlugW != cbWatts {
		t.Fatalf("expected HwPlugW == %.1f, got %.1f", cbWatts, zA.HwPlugW)
	}

	// 2. Check plugNowW() arbitration: stripW has higher granularity and drives plug load
	totalPlug, _ := zA.plugNowW()
	if totalPlug != stripWatts {
		t.Fatalf("expected plugNowW() to return stripW (%.1f), got %.1f", stripWatts, totalPlug)
	}

	// 3. Test CbW alias
	cbAlias := 1620.0
	m2 := Measurement{
		Source:   "esp32",
		TempReal: true,
		CbW:      &cbAlias,
	}
	if err := e.IngestTelemetry(zoneId, "node_cb", m2); err != nil {
		t.Fatalf("failed to ingest CbW alias: %v", err)
	}
	if zA.HwCircuitBreakerW != cbAlias {
		t.Fatalf("expected HwCircuitBreakerW to update to CbW alias %.1f, got %.1f",
			cbAlias, zA.HwCircuitBreakerW)
	}
	if zA.HwPlugW != cbAlias {
		t.Fatalf("expected HwPlugW to update to CbW alias %.1f, got %.1f",
			cbAlias, zA.HwPlugW)
	}
}

// TestAdversarial_ConcurrentTelemetryAndActuationRaceStress launches concurrent
// ingestion of real telemetry and actuation ticks under high load to verify zero race conditions.
func TestAdversarial_ConcurrentTelemetryAndActuationRaceStress(t *testing.T) {
	e := newControlledM3Twin()
	e.SetMode(ModeReal)

	stop := make(chan struct{})
	var wg sync.WaitGroup

	// Telemetry workers
	for w := 0; w < 5; w++ {
		wg.Add(1)
		go func(workerId int) {
			defer wg.Done()
			rng := rand.New(rand.NewSource(int64(workerId)))
			for {
				select {
				case <-stop:
					return
				default:
					temp := 20.0 + rng.Float64()*10.0
					strip := 100.0 + rng.Float64()*200.0
					cb := 1000.0 + rng.Float64()*1000.0
					m := Measurement{
						Source:          "esp32",
						TempReal:        true,
						Temp:            &temp,
						StripW:          &strip,
						CircuitBreakerW: &cb,
					}
					_ = e.IngestTelemetry("zone-office-a", "node_race", m)
					time.Sleep(1 * time.Millisecond)
				}
			}
		}(w)
	}

	// Actuator worker
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				e.ActuateAirflow(0.05)
				time.Sleep(2 * time.Millisecond)
			}
		}
	}()

	time.Sleep(250 * time.Millisecond)
	close(stop)
	wg.Wait()
}
