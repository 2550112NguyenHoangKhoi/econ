package simulation

import (
	"math"
	"strings"
	"testing"

	"econ/schema/Telemetry"
	flatbuffers "github.com/google/flatbuffers/go"
)

// TestAutoPilotAirflowActuationConstraints verifies that:
// 1. AutoPilot reads the assessed airflow map (VAV flows, AhuPressure, damper positions).
// 2. Commanded damper positions respect physical limits: bounded in [0.0, 1.0].
// 3. Vacant zones in setback enforce minimum fresh air ventilation floors (theta >= theta_min > 0).
// 4. Actuator movements respect physical slew rate limits (delta_theta <= maxSlewRate * dt).
// 5. Duct static pressure remains safely within structural limits (P_ahu <= 650 Pa).
// 6. Actuation commands dispatched over MQTT carry valid, correctly formatted damper/airflow tokens.
func TestAutoPilotAirflowActuationConstraints(t *testing.T) {
	e := newTestEngine()

	// 1. Setup multi-zone environment with hardware and simulation zones
	hwZone := "zone-office-a"
	simZone := "zone-office-b"
	e.Zones[hwZone].MqttTopic = "esp32_office_a"

	var publishedTopic, publishedCmd string
	e.Publish = func(topic, payload string) {
		publishedTopic = topic
		publishedCmd = payload
	}

	// Baseline initialization
	e.AutoPilot = true
	e.doHardyCross()
	initialPressure := e.AhuPressure
	if initialPressure <= 0 || math.IsNaN(initialPressure) {
		t.Fatalf("invalid initial AHU static pressure: %v", initialPressure)
	}

	// 2. Assess baseline airflow map
	vA := e.Vavs["vav-office-a"]
	vB := e.Vavs["vav-office-b"]
	if vA == nil || vB == nil {
		t.Fatal("expected VAVs for test zones to exist")
	}
	initialFlowA := vA.Flow
	initialFlowB := vB.Flow
	if initialFlowA <= 0 || initialFlowB <= 0 {
		t.Fatalf("expected positive initial flows, got A=%v B=%v", initialFlowA, initialFlowB)
	}

	// 3. Induce Vacancy Setback on Zone A (Hardware zone) and High Cooling Demand on Zone B
	e.Zones[hwZone].Occupancy = 0
	e.Zones[hwZone].VacantTicks = vacancyDelayTicks + 5 // Vacancy dwell satisfied
	e.Zones[simZone].Occupancy = 4
	e.Zones[simZone].Temp = 27.0 // Overheating zone demanding airflow

	// 4. Execute AutoPilot Actuation Step
	dt := 1.0 // 1 second step
	e.ActuateAirflow(dt)

	// --- ASSERTION 1: Command Dispatch Formatting & MQTT Routing ---
	if publishedTopic != "econ/commands/esp32_office_a" {
		t.Fatalf("expected command published to 'econ/commands/esp32_office_a', got %q", publishedTopic)
	}
	if !strings.Contains(publishedCmd, "LIGHTS_OFF") {
		t.Errorf("expected LIGHTS_OFF in command for vacant zone, got %q", publishedCmd)
	}
	if !strings.Contains(publishedCmd, "DAMPER=") && !strings.Contains(publishedCmd, "VAV_SET:") {
		t.Errorf("expected DAMPER command token in published command, got %q", publishedCmd)
	}

	// --- ASSERTION 2: Physical Actuator Bounds [0.0, 1.0] ---
	for id, v := range e.Vavs {
		if v.Position < 0.0 || v.Position > 1.0 {
			t.Fatalf("VAV %s position %.3f violates physical bounds [0.0, 1.0]", id, v.Position)
		}
		if v.DamperPos < 0.0 || v.DamperPos > 1.0 {
			t.Fatalf("VAV %s DamperPos %.3f violates physical bounds [0.0, 1.0]", id, v.DamperPos)
		}
	}

	// --- ASSERTION 3: Minimum Ventilation CFM Floor ---
	// Zone A is vacant; damper must throttle back to save cooling energy but MUST NOT shut to 0.
	const minAllowedVentFrac = 0.15
	if vA.Position < minAllowedVentFrac {
		t.Errorf("vacant zone VAV A throttled to %.3f, violating minimum ventilation floor %.2f",
			vA.Position, minAllowedVentFrac)
	}
	if vA.Flow <= 0 {
		t.Errorf("vacant zone VAV A airflow dropped to 0, starving fresh air ventilation")
	}

	// --- ASSERTION 4: Actuator Slew Rate (Non-Instantaneous Response) ---
	// Actuator cannot step instantaneously. Max slew rate ~ 1/60 per sec.
	const maxSlewPerSec = 0.05 // Conservative upper bound for 1 sec
	deltaA := math.Abs(vA.Position - 1.0)
	if deltaA > maxSlewPerSec {
		t.Errorf("actuator position delta %.4f in 1s exceeds mechanical slew rate limit %.4f",
			deltaA, maxSlewPerSec)
	}
	if deltaA <= 0.001 {
		t.Errorf("actuator position did not move toward target: delta=%.4f", deltaA)
	}

	// --- ASSERTION 5: Duct Static Pressure Limits ---
	// Duct pressure must stay below maximum allowable mechanical limit (650 Pa)
	const maxSafeDuctPressurePa = 650.0
	if e.AhuPressure > maxSafeDuctPressurePa {
		t.Errorf("AHU static pressure %.1f Pa exceeds safe duct limit %.1f Pa",
			e.AhuPressure, maxSafeDuctPressurePa)
	}
	if math.IsNaN(e.AhuPressure) || math.IsInf(e.AhuPressure, 0) {
		t.Fatalf("AHU static pressure became NaN/Inf: %v", e.AhuPressure)
	}

	// --- ASSERTION 6: Airflow Map Re-Assessment Feedback ---
	// Zone B is warm; its target position must be open (>= initial position).
	// Network solve must reflect shifting flows.
	if vB.Flow < initialFlowB*0.95 {
		t.Errorf("overheating zone B flow decreased (%.4f -> %.4f) instead of receiving cooling airflow",
			initialFlowB, vB.Flow)
	}
}

// TestAutoPilotAirflowMultipleStepsToVentilationFloor verifies multi-step transit
// towards the minimum ventilation floor and asserts it strictly clamps at 0.15 without undershooting.
func TestAutoPilotAirflowMultipleStepsToVentilationFloor(t *testing.T) {
	e := newTestEngine()
	hwZone := "zone-office-a"
	e.Zones[hwZone].MqttTopic = "esp32_office_a"

	var lastCmd string
	e.Publish = func(topic, payload string) {
		lastCmd = payload
	}

	e.AutoPilot = true
	e.doHardyCross()

	vA := e.Vavs["vav-office-a"]
	if vA == nil {
		t.Fatal("expected vav-office-a")
	}

	e.Zones[hwZone].Occupancy = 0
	e.Zones[hwZone].VacantTicks = vacancyDelayTicks + 10

	// Step for 100 seconds (60 seconds is full stroke)
	for s := 0; s < 100; s++ {
		e.ActuateAirflow(1.0)
		if vA.Position < MinVentDamperFloor {
			t.Fatalf("second %d: damper position %.4f breached minimum ventilation floor %.2f",
				s, vA.Position, MinVentDamperFloor)
		}
		if vA.Flow <= 0 {
			t.Fatalf("second %d: airflow starved to zero", s)
		}
	}

	// At steady-state vacancy, position must be clamped to MinVentDamperFloor
	if math.Abs(vA.Position-MinVentDamperFloor) > 0.01 {
		t.Errorf("expected damper to settle at MinVentDamperFloor (%.2f), got %.4f",
			MinVentDamperFloor, vA.Position)
	}
	if !strings.Contains(lastCmd, "DAMPER=0.15") {
		t.Errorf("expected DAMPER=0.15 in settled command, got %q", lastCmd)
	}
}

// TestAutoPilotDuctStaticPressureSafetyCeiling verifies that under high system resistance
// and elevated fan pressures, the static pressure safety limit relieves pressure and stays <= 650 Pa.
func TestAutoPilotDuctStaticPressureSafetyCeiling(t *testing.T) {
	e := newTestEngine()
	e.AutoPilot = true
	e.doHardyCross()

	// Artificially inflate PMax to simulate high fan discharge pressure
	e.PMax = 950.0

	// Throttle all dampers to minimum to create high backpressure
	for _, v := range e.Vavs {
		v.DamperPos = MinVentDamperFloor
		v.TargetDamperPos = MinVentDamperFloor
		v.UpdateResistance()
	}

	// Run Hardy Cross without safety check to verify raw pressure would exceed 650 Pa
	e.doHardyCross()
	if e.AhuPressure <= MaxSafeStaticPressurePa {
		t.Logf("raw AhuPressure %.1f did not exceed 650 Pa; forcing higher fan pressure", e.AhuPressure)
		e.PMax = 1200.0
		e.doHardyCross()
	}

	// Now actuate with auto-pilot: safety supervision must relieve duct pressure
	e.ActuateAirflow(1.0)

	if e.AhuPressure > MaxSafeStaticPressurePa {
		t.Fatalf("auto-pilot failed to enforce static pressure safety ceiling: AhuPressure=%.1f > %.1f Pa",
			e.AhuPressure, MaxSafeStaticPressurePa)
	}
	if math.IsNaN(e.AhuPressure) || math.IsInf(e.AhuPressure, 0) {
		t.Fatalf("invalid AHU static pressure: %v", e.AhuPressure)
	}
}

// TestAutoPilotFlatBuffersDamperSerialization verifies that live damper positions
// are serialized into the FlatBuffers Telemetry.VavData buffer.
func TestAutoPilotFlatBuffersDamperSerialization(t *testing.T) {
	builder := flatbuffers.NewBuilder(1024)

	idStr := builder.CreateString("vav-office-a")
	testDamperPos := float32(0.72)
	testFlow := float32(1.45)

	Telemetry.VavDataStart(builder)
	Telemetry.VavDataAddId(builder, idStr)
	Telemetry.VavDataAddAirflow(builder, testFlow)
	Telemetry.VavDataAddDamper(builder, testDamperPos)
	offset := Telemetry.VavDataEnd(builder)
	builder.Finish(offset)

	buf := builder.FinishedBytes()

	// Deserialize and verify fields
	vavData := Telemetry.GetRootAsVavData(buf, 0)
	if string(vavData.Id()) != "vav-office-a" {
		t.Errorf("expected ID 'vav-office-a', got %q", string(vavData.Id()))
	}
	if math.Abs(float64(vavData.Damper()-testDamperPos)) > 1e-4 {
		t.Errorf("expected Damper %.3f, got %.3f", testDamperPos, vavData.Damper())
	}
	if math.Abs(float64(vavData.Airflow()-testFlow)) > 1e-4 {
		t.Errorf("expected Airflow %.3f, got %.3f", testFlow, vavData.Airflow())
	}
}

// TestAutoPilotOccupiedCoolingModulation verifies that an occupied zone
// with rising temperature modulates its damper open to increase airflow.
func TestAutoPilotOccupiedCoolingModulation(t *testing.T) {
	e := newTestEngine()
	e.AutoPilot = true
	e.doHardyCross()

	z := e.Zones["zone-office-a"]
	v := e.Vavs["vav-office-a"]
	z.Occupancy = 3
	z.VacantTicks = 0
	z.BaseSetpoint = 24.0
	z.Setpoint = 24.0
	z.Temp = 24.0

	// Set initial damper to 0.5
	v.DamperPos = 0.5
	v.TargetDamperPos = 0.5
	v.Position = 0.5
	v.UpdateResistance()
	e.doHardyCross()
	initialFlow := v.Flow

	// Now room heats up to 26.5°C (thermal demand error = +2.5°C)
	z.Temp = 26.5

	// Run 10 seconds of actuation
	for i := 0; i < 10; i++ {
		e.ActuateAirflow(1.0)
	}

	// Damper must have slewed open towards higher cooling demand
	if v.DamperPos <= 0.5 {
		t.Errorf("expected damper to open beyond 0.5 for warm occupied room, got %.4f", v.DamperPos)
	}
	if v.Flow <= initialFlow {
		t.Errorf("expected flow to increase (initial=%.4f, now=%.4f)", initialFlow, v.Flow)
	}
}
