// telemetry — inbound telemetry and how a payload finds its zone.
//
// Split out of engine.go, which had grown to 3,541 lines. Same package, same code:
// nothing here was rewritten, only moved to a file named after what it does.

package simulation

import (
	"fmt"
	"log"
	"sort"
	"strings"
	"time"
)

// Measurement is one telemetry sample from a physical edge node (ESP32, Pico, CV
// tracker). Pointer fields are nil when the node didn't report that quantity.
// TempReal marks a genuinely measured temperature (DHT22, RP2040 die sensor, ...) as
// opposed to a firmware's simulated placeholder — only real temperatures may pin the
// zone's physics to the sensor.
type Measurement struct {
	Occupancy       *int
	Occupancy2      *int
	Temp            *float64
	Humidity        *float64
	Co2             *float64
	SupplyC         *float64
	AcW             *float64
	Lux             *float64
	PlugW           *float64 // measured plug-circuit draw (SCT-013 clamp), watts
	StripW          *float64 // measured power-strip draw (ACS712 sensor), watts
	CircuitBreakerW *float64 // measured zone Circuit Breaker (CB) power, watts
	CbW             *float64 // alias for CircuitBreakerW
	Source          string
	TempReal        bool
	// AcReal reports whether the node's setpoint commands actually reach an air
	// conditioner, or are merely parsed and logged. A pointer because "not reported"
	// (firmware older than the field) must stay distinct from a node that positively
	// says its IR control is absent.
	AcReal      *bool
	CameraEvent *string
	PirState    *bool
	IrState     *string
	// What the node says it actually applied. The engine knows what it COMMANDED; only
	// these say whether anything happened. Nil = firmware does not report it.
	NodeSetpoint *float64
	NodePlug     *string
	NodeLights   *string
	Mock         *bool // explicit mock payload flag
	Simulated    *bool // explicit simulated payload flag
}

// IsMock reports whether the measurement represents mock, simulated, or synthetic data.
func (m Measurement) IsMock() bool {
	if m.Mock != nil && *m.Mock {
		return true
	}
	if m.Simulated != nil && *m.Simulated {
		return true
	}
	src := strings.ToLower(strings.TrimSpace(m.Source))
	switch src {
	case "mock", "sim", "simulation", "synthetic", "test":
		return true
	}
	if m.Temp != nil && !m.TempReal {
		return true
	}
	return false
}

// IngestTelemetry ingests one sample from the CV/edge layer (MQTT) and marks the zone
// "live" so the physics + optimizer use real data instead of the random seed. This is
// what makes the twin genuinely sensor-driven.
func (e *Engine) IngestTelemetry(zoneRef, topicSuffix string, m Measurement) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	// In Real Mode, strictly reject mock payloads without mutating zone state.
	if e.mode == ModeReal && m.IsMock() {
		log.Printf("[telemetry] REJECTED mock payload for zone %q in Real Mode (source=%q, tempReal=%v)", zoneRef, m.Source, m.TempReal)
		return fmt.Errorf("mock payload strictly rejected in real mode for zone %s", zoneRef)
	}

	z := e.resolveZone(zoneRef)
	if z == nil {
		log.Printf("[telemetry] no zone matches %q; ignoring", zoneRef)
		return fmt.Errorf("no zone matches %q", zoneRef)
	}
	if m.Occupancy != nil || m.Occupancy2 != nil {
		occ := 0
		if m.Occupancy != nil {
			occ += *m.Occupancy
		}
		if m.Occupancy2 != nil {
			occ += *m.Occupancy2
		}
		z.Occupancy = occ
		z.Live = true
	}
	if topicSuffix != "" {
		z.MqttTopic = topicSuffix
	}
	if m.Source != "" {
		z.HwSource = m.Source
	}
	z.HwSeenAt = time.Now()
	z.HwOnline = true
	if m.AcReal != nil {
		// Log the transition only, not every 5 s telemetry cycle.
		if !z.HwAcRealSeen || z.HwAcReal != *m.AcReal {
			if *m.AcReal {
				log.Printf("[actuate] zone=%s has REAL AC control (setpoints reach the unit)", z.BimAssetId)
			} else {
				log.Printf("[actuate] zone=%s reports NO AC control: setpoint commands are parsed but reach no machine, so any saving attributed to its setback is not real", z.BimAssetId)
			}
		}
		z.HwAcReal, z.HwAcRealSeen = *m.AcReal, true
	}
	if m.Temp != nil && m.TempReal {
		z.HwTemp = *m.Temp
		z.HwTempAt = time.Now()
		if z.ShadowTemp == 0 {
			// First real measurement: seed the shadow model at reality so the AFDD
			// residual starts near zero and only grows on genuine divergence.
			z.ShadowTemp = *m.Temp
		}
	}
	// Each environmental field carries its own arrival time. A node reports per-sensor:
	// the SHT30 can keep answering while the NDIR fails its CRC or is unplugged, and the
	// firmware then omits only that field. Timestamping the node as a whole would let the
	// last CO2 reading keep streaming as "measured" for as long as the board still sent
	// temperature.
	if m.Humidity != nil {
		z.HwHum = *m.Humidity
		z.HwHumAt = time.Now()
	}
	if m.Co2 != nil {
		z.HwCo2 = *m.Co2
		z.HwCo2At = time.Now()
	}

	// Map zone Circuit Breaker power to HwPlugW (CB clamp measures total branch power).
	// In Real Mode, zone CB telemetry directly maps to HwPlugW.
	cb := m.CircuitBreakerW
	if cb == nil {
		cb = m.CbW
	}
	if cb != nil {
		z.HwCircuitBreakerW = *cb
		z.HwCircuitBreakerAt = time.Now()
		z.HwPlugW = *cb
		z.HwPlugAt = time.Now()
	} else if m.PlugW != nil {
		z.HwPlugW = *m.PlugW
		z.HwPlugAt = time.Now()
	}

	if m.StripW != nil {
		z.HwStripW = *m.StripW
		z.HwStripAt = time.Now()
	}
	if m.NodePlug != nil {
		z.NodePlugState = *m.NodePlug
		z.NodePlugAt = time.Now()
	}
	if m.NodeSetpoint != nil {
		z.NodeSetpointC = *m.NodeSetpoint
		z.NodeSetpointAt = time.Now()
	}
	if m.NodeLights != nil {
		z.NodeLightsState = *m.NodeLights
		z.NodeLightsAt = time.Now()
	}
	// Measurements that displace an assumption in the model. Each carries its own
	// arrival time for the same reason every other field does: a probe that falls out of
	// the louvre must stop being believed without taking the rest of the node with it.
	if m.SupplyC != nil {
		z.HwSupplyC = *m.SupplyC
		z.HwSupplyAt = time.Now()
	}
	if m.AcW != nil {
		z.HwAcW = *m.AcW
		z.HwAcAt = time.Now()
	}
	if m.CameraEvent != nil {
		z.CameraEvent = m.CameraEvent
	}
	if m.PirState != nil {
		z.PirState = m.PirState
	}
	if m.IrState != nil {
		z.IrState = m.IrState
	}

	if m.Lux != nil {
		z.HwLux = *m.Lux
		z.HwLuxAt = time.Now()
	}
	return nil
}

// SetZoneOccupancy keeps the original CV-layer entry point (yolo_tracker.py publishes
// occupancy-only messages): plain occupancy ingestion, attributed to the CV node.
func (e *Engine) SetZoneOccupancy(zoneRef, topicSuffix string, count int) {
	occ := count
	e.IngestTelemetry(zoneRef, topicSuffix, Measurement{Occupancy: &occ, Source: "cv"})
}

func (e *Engine) UpdateDetectedProtocol(zoneId, protocol string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	z := e.resolveZone(zoneId)
	if z != nil {
		z.DetectedProtocol = protocol
		return true
	}
	return false
}

// resolveZone maps an inbound identifier (real zoneId or demo alias) to a zone. Lock held.
func (e *Engine) resolveZone(ref string) *ZoneSim {
	if z, ok := e.Zones[ref]; ok {
		return z
	}
	if id, ok := demoZoneAlias[ref]; ok {
		if z, ok := e.Zones[id]; ok {
			return z
		}
	}
	// Fallback: a regenerated building changes zoneIds, so an aliased id may not exist.
	// Assign each unknown identifier its own office zone so two physical boards (say an
	// ESP32 and a Pico) demo side by side instead of both landing on the same fallback.
	return e.assignDemoZone(ref)
}

// neverAutoBind is a SAFETY FLOOR under IsCritical, not a replacement for it.
//
// Criticality properly lives in the programme library (rule: coefficients belong in data),
// and IsCritical is the authority. But IsCritical answers false for every type when the
// library cannot be read — a stripped deployment, a container missing its data mount, a
// unit test — because the fallback library ships no programmes at all. That turns a missing
// file into "auto-bind a bring-up node into the comms room", which is precisely the room
// this must never choose. So the name is checked too: it costs nothing when the library is
// present and agrees, and it holds the line when the library is absent.
//
// Matching on substrings of a GENERATED type name is exactly the brittleness that caused
// the bug this function was fixed for, so it is used only to EXCLUDE (a false positive
// merely picks a different room) and never to include.
func neverAutoBind(zoneType string) bool {
	t := strings.ToLower(zoneType)
	for _, bad := range []string{"comms", "server", "plant", "mechanical", "switch", "riser", "ups"} {
		if strings.Contains(t, bad) {
			return true
		}
	}
	return false
}

// assignDemoZone gives an unrecognized edge-node identifier a stable, distinct office
// zone: the first unknown node gets the lexicographically-smallest office, the second
// the next one, and so on (deterministic despite Go's randomized map iteration; wraps
// around if there are somehow more nodes than offices). Lock held.
func (e *Engine) assignDemoZone(ref string) *ZoneSim {
	if id, ok := e.demoAssign[ref]; ok {
		return e.Zones[id]
	}
	// Match office-LIKE types, not the literal string "office".
	//
	// This used to test `z.Type == "office"` and return nil when nothing matched, which
	// silently discarded every sample a physical node sent. The digitizer emits
	// `cellular-office` (285 zones) and `open-office` (103) — no zone in the shipped
	// fixture is typed exactly "office" — so a real ESP32 publishing measured temperature,
	// humidity and occupancy had all of it dropped at the door, while the hardware
	// inspector (which watches the raw MQTT stream one level below this) went on showing
	// the node as healthy. That is exactly the failure the inspector exists to expose, and
	// exactly the one a literal string comparison against generated type names invites.
	//
	// The fallback matters as much as the match: a node that reaches the engine must land
	// SOMEWHERE rather than have its measurements thrown away over a naming mismatch. A
	// wrongly-placed measurement is visible and correctable; a dropped one is neither.
	// Critical spaces are excluded because binding a bring-up node to a comms room would
	// hand it a space the optimizer must never set back.
	preferred := make([]string, 0, 16)
	fallback := make([]string, 0, 16)
	for id, z := range e.Zones {
		if IsCritical(z.Type) || neverAutoBind(z.Type) {
			continue
		}
		if strings.Contains(strings.ToLower(z.Type), "office") {
			preferred = append(preferred, id)
		} else {
			fallback = append(fallback, id)
		}
	}
	pool, why := preferred, "office"
	if len(pool) == 0 {
		pool, why = fallback, "non-critical (no office-like zone in this building)"
	}
	if len(pool) == 0 {
		log.Printf("[edge] node %q cannot be bound: this building has no non-critical zone", ref)
		return nil
	}
	sort.Strings(pool)
	id := pool[len(e.demoAssign)%len(pool)]
	e.demoAssign[ref] = id
	log.Printf("[edge] node %q bound to zone %s (%s, type %q)", ref, id, why, e.Zones[id].Type)
	return e.Zones[id]
}

const vacancyDelayTicks = 90 // ~3s at 30 FPS — stand-in for the real safety time-delay

const (
	// preCoolDelta is how far below the occupied setpoint zones run during a
	// forecast-triggered pre-cool window.
	preCoolDelta = 1.5 // °C
	// fixedSetbackC is the conventional vacancy setback, used only until a room has been
	// identified. It used to be applied unconditionally to every zone; the depth is now
	// asked of each room's own thermal model (Dynamics.SetbackCeiling), because the right
	// answer depends on how fast that specific room recovers.
	fixedSetbackC = 4.0 // °C
	// setbackRecoverySecs is the budget a setback room is given to return to setpoint once
	// occupancy comes back — the constraint the learned depth is solved against.
	setbackRecoverySecs = 1800.0 // 30 min
	// afddThreshold flags a zone whose measured temperature has drifted this far
	// (smoothed) from its sensor-free 2R1C shadow model.
	afddThreshold = 2.0 // °C
)
