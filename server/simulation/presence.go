package simulation

import (
	"encoding/json"
	"math"
	"time"
)

// Presence fusion: radar (fast, binary) corroborated by CO2 (slow, physiological).
//
// The two sensors fail in opposite directions, which is exactly why combining them is worth
// doing rather than averaging them:
//
//   Radar  responds in ~2 s and sees a motionless person, but a 24 GHz beam also sees a fan,
//          a curtain, and the room behind it through a stud wall. It cannot tell you WHY it
//          is asserting.
//   CO2    cannot be triggered by anything but respiration in an ordinary room, so it is the
//          honest arbiter of "is that a person" -- but it lags by minutes and decays slowly,
//          so it can neither open nor close a door promptly.
//
// So radar drives the transitions and CO2 confirms or disputes them. A radar assertion with
// CO2 flat or falling for several minutes is reported as UNCONFIRMED rather than silently
// trusted; that is the false-positive case this node actually hit.
//
// Nothing here overwrites a measured channel. `Occupancy` remains exactly what the node
// reported. This produces a separate, explicitly derived state.

type PresenceState string

const (
	PresenceVacant    PresenceState = "vacant"    // radar clear, CO2 low or decaying
	PresenceArriving  PresenceState = "arriving"  // radar just asserted, CO2 not yet responding
	PresenceOccupied  PresenceState = "occupied"  // radar asserted AND CO2 rising -- confirmed
	PresenceDeparting PresenceState = "departing" // radar cleared, CO2 still elevated/decaying
	PresenceDisputed  PresenceState = "disputed"  // radar asserts, CO2 says nobody is breathing
)

// A CO2 sample. Wall-clock, not sim time: respiration does not accelerate with the sim.
type co2Sample struct {
	at  time.Time
	ppm float64
}

const (
	co2WindowSamples = 48              // ~4 min at the node's 5 s cadence, one per measurement
	co2WindowMin     = 90 * time.Second // shortest span that yields a usable slope
	// One adult emits roughly 18 L/h of CO2. In a small unventilated office that is on the
	// order of 10 ppm/min; with ventilation, a few. +/-1.5 ppm/min is comfortably outside
	// sensor noise (the ACD1200 resolves 1 ppm) while still catching a single occupant.
	co2RisingPpmPerMin  = 1.5
	co2FallingPpmPerMin = -1.5
	// Above this the trace is not ROOM respiration and cannot be used to infer room-level
	// occupancy. One adult in a small unventilated room moves CO2 by ~10 ppm/min; a crowded
	// room with the door shut might reach 50.
	//
	// This node has been observed swinging 1700 ppm in 40 s (+/-400 ppm/min). That is not a
	// broken sensor -- it is someone breathing near the probe. Exhaled air is ~40,000 ppm, so
	// a face close to the inlet saturates it to the 6000 ppm ceiling and back. The sensor is
	// reporting exactly what reaches it; the reading simply stops representing the room.
	//
	// Such a slope neither confirms nor disputes: the state machine falls back to radar
	// alone. Confirming on it would put a near-field artifact behind a room-level claim, and
	// disputing on it would be worse still, since a face at the probe means someone IS there.
	co2ImplausiblePpmPerMin = 100.0
	// How long radar may assert without CO2 corroboration before the claim is disputed.
	// Long enough that a person who walks in and sits still is not called a false positive
	// before their own CO2 has had time to accumulate.
	disputeAfter = 6 * time.Minute
)

// PresenceFusion holds the derived state for one zone.
type PresenceFusion struct {
	samples []co2Sample // unexported: the raw window is an implementation detail

	State       PresenceState `json:"state"`
	SlopePpmMin float64       `json:"co2SlopePpmPerMin"`
	Since       time.Time     `json:"since"` // when State was entered

	Co2Implausible bool `json:"co2Implausible"` // slope beyond what respiration can produce

	radarSince  time.Time
	lastRadar   bool
	initialised bool
	lastCo2At   time.Time // measurement timestamp of the last sample actually retained
}

// MarshalJSON keeps the derived nature of this object explicit on the wire. A consumer
// reading "state":"occupied" must be able to tell at a glance that it is an inference from
// two sensors, not a third sensor -- and whether CO2 actually corroborated it.
func (p *PresenceFusion) MarshalJSON() ([]byte, error) {
	slope, ok := p.Co2SlopePpmPerMin()
	type wire struct {
		State          PresenceState `json:"state"`
		Derived        bool          `json:"derived"`
		Confirmed      bool          `json:"co2Confirmed"`
		SlopeOK        bool          `json:"co2SlopeResolved"`
		SlopePpmMin    float64       `json:"co2SlopePpmPerMin"`
		Implausible    bool          `json:"co2Implausible"`
		Since          time.Time     `json:"since"`
		SecondsInState float64       `json:"secondsInState"`
	}
	implausible := ok && math.Abs(slope) > co2ImplausiblePpmPerMin
	w := wire{
		State: p.State, Derived: true,
		// Confirmed means "respiration agrees", so it cannot be true on a slope the sensor
		// could not physically have produced.
		Confirmed:   p.Confirmed() && !implausible,
		SlopeOK:     ok && !implausible,
		SlopePpmMin: slope, Implausible: implausible, Since: p.Since,
	}
	if !p.Since.IsZero() {
		w.SecondsInState = time.Since(p.Since).Seconds()
	}
	return json.Marshal(w)
}

// Co2SlopePpmPerMin fits a least-squares line through the retained samples. Returns false
// when the window is too short to mean anything -- an unresolved slope must not be reported
// as zero, because "flat" is itself a claim that disputes the radar.
func (p *PresenceFusion) Co2SlopePpmPerMin() (float64, bool) {
	n := len(p.samples)
	if n < 4 {
		return 0, false
	}
	span := p.samples[n-1].at.Sub(p.samples[0].at)
	if span < co2WindowMin {
		return 0, false
	}
	t0 := p.samples[0].at
	var sx, sy, sxy, sxx float64
	for _, s := range p.samples {
		x := s.at.Sub(t0).Minutes()
		sx += x
		sy += s.ppm
		sxy += x * s.ppm
		sxx += x * x
	}
	fn := float64(n)
	den := fn*sxx - sx*sx
	if math.Abs(den) < 1e-9 {
		return 0, false
	}
	return (fn*sxy - sx*sy) / den, true
}

// Update advances the state machine. radarPresent is the node's OR'd OT2 reading;
// co2/co2Fresh/co2At come straight from the zone's last measurement -- co2At being the time
// that measurement ARRIVED, not now.
//
// Sampling is keyed on co2At, not on call rate. This is called from the engine tick, which
// runs far more often than the node publishes; appending on every call packed the window
// with duplicates of one reading, so 24 samples spanned a few seconds instead of two minutes
// and the slope never resolved. Retaining one sample per distinct measurement makes the
// window mean the same thing regardless of how often the caller ticks.
func (p *PresenceFusion) Update(now time.Time, radarPresent bool, co2 float64, co2Fresh bool, co2At time.Time) {
	if co2Fresh && co2 > 0 && !co2At.IsZero() && co2At.After(p.lastCo2At) {
		p.lastCo2At = co2At
		p.samples = append(p.samples, co2Sample{at: co2At, ppm: co2})
		if len(p.samples) > co2WindowSamples {
			p.samples = p.samples[len(p.samples)-co2WindowSamples:]
		}
	}

	slope, slopeOK := p.Co2SlopePpmPerMin()
	p.SlopePpmMin = slope
	// A physically impossible slope means the sensor, not the room. Drop it to unresolved so
	// the state machine falls back to radar alone rather than treating noise as evidence.
	p.Co2Implausible = slopeOK && math.Abs(slope) > co2ImplausiblePpmPerMin
	if p.Co2Implausible {
		slopeOK = false
	}

	if !p.initialised {
		p.initialised = true
		p.lastRadar = radarPresent
		p.radarSince = now
		p.Since = now
		if radarPresent {
			p.State = PresenceArriving
		} else {
			p.State = PresenceVacant
		}
		return
	}

	if radarPresent != p.lastRadar {
		p.lastRadar = radarPresent
		p.radarSince = now
	}
	radarHeld := now.Sub(p.radarSince)

	next := p.State
	switch {
	case radarPresent && slopeOK && slope >= co2RisingPpmPerMin:
		// Breathing corroborates the beam. This is the only state that asserts a person.
		next = PresenceOccupied
	case radarPresent && slopeOK && slope <= co2FallingPpmPerMin && radarHeld >= disputeAfter:
		// The beam has asserted for minutes while CO2 decays. Something is moving; the
		// evidence says it is not a person.
		next = PresenceDisputed
	case radarPresent:
		// Asserted, not yet corroborated either way. Stay in arriving unless already
		// confirmed -- a confirmed occupant who stops raising CO2 (window opens, ventilation
		// catches up) should not be demoted while the beam still holds them.
		if p.State != PresenceOccupied && p.State != PresenceDisputed {
			next = PresenceArriving
		}
	case !radarPresent && slopeOK && slope <= co2FallingPpmPerMin:
		next = PresenceDeparting
	case !radarPresent:
		// Beam clear and CO2 no longer falling: the decay has finished, the room is empty.
		if p.State == PresenceDeparting && slopeOK && slope > co2FallingPpmPerMin {
			next = PresenceVacant
		} else if p.State != PresenceDeparting {
			next = PresenceVacant
		}
	}

	if next != p.State {
		p.State = next
		p.Since = now
	}
}

// Confirmed reports whether a human is corroborated by respiration, not merely by the beam.
func (p *PresenceFusion) Confirmed() bool { return p.State == PresenceOccupied }
