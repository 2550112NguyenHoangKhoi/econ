package simulation

import (
	"testing"
	"time"
)

// Feed the fusion a synthetic CO2 trace at the node's real 5 s cadence.
func drive(p *PresenceFusion, start time.Time, secs int, radar bool, co2 func(i int) float64) time.Time {
	t := start
	for i := 0; i < secs/5; i++ {
		p.Update(t, radar, co2(i), true, t)
		t = t.Add(5 * time.Second)
	}
	return t
}

func TestPersonEntersStaysAndLeaves(t *testing.T) {
	p := &PresenceFusion{}
	now := time.Now()

	// Empty room, CO2 decaying from a previous occupant.
	now = drive(p, now, 300, false, func(i int) float64 { return 900 - float64(i)*2 })
	if p.State != PresenceVacant && p.State != PresenceDeparting {
		t.Fatalf("empty decaying room should be vacant/departing, got %q", p.State)
	}

	// Someone walks in: radar asserts immediately, CO2 has not moved yet.
	base := 780.0
	now = drive(p, now, 60, true, func(i int) float64 { return base })
	if p.State != PresenceArriving {
		t.Fatalf("radar on, CO2 flat -> arriving, got %q", p.State)
	}

	// They stay. CO2 climbs ~6 ppm/min (0.5 ppm per 5 s sample).
	now = drive(p, now, 300, true, func(i int) float64 { return base + float64(i)*0.5 })
	if p.State != PresenceOccupied {
		t.Fatalf("radar on + CO2 rising -> occupied, got %q (slope %.2f)", p.State, p.SlopePpmMin)
	}
	if !p.Confirmed() {
		t.Fatal("occupied state must report Confirmed")
	}

	// They leave: radar clears, CO2 begins to decay.
	peak := base + 30
	now = drive(p, now, 200, false, func(i int) float64 { return peak - float64(i)*0.4 })
	if p.State != PresenceDeparting {
		t.Fatalf("radar off + CO2 falling -> departing, got %q (slope %.2f)", p.State, p.SlopePpmMin)
	}

	// Decay finishes and CO2 settles.
	drive(p, now, 300, false, func(i int) float64 { return 760 })
	if p.State != PresenceVacant {
		t.Fatalf("radar off + CO2 settled -> vacant, got %q (slope %.2f)", p.State, p.SlopePpmMin)
	}
}

// The failure this node actually hit: a radar asserting on something that does not breathe.
func TestRadarFalsePositiveIsDisputedNotTrusted(t *testing.T) {
	p := &PresenceFusion{}
	now := time.Now()
	// Radar stuck on for 10 minutes while CO2 decays steadily — nobody is in the room.
	drive(p, now, 600, true, func(i int) float64 { return 1200 - float64(i)*0.5 })
	if p.State != PresenceDisputed {
		t.Fatalf("radar asserting while CO2 decays -> disputed, got %q (slope %.2f)",
			p.State, p.SlopePpmMin)
	}
	if p.Confirmed() {
		t.Fatal("a disputed radar assertion must never report Confirmed")
	}
}

// An unresolved slope must not be reported as flat: "flat" disputes the radar.
func TestShortWindowDoesNotResolveSlope(t *testing.T) {
	p := &PresenceFusion{}
	now := time.Now()
	for i := 0; i < 3; i++ {
		p.Update(now.Add(time.Duration(i)*5*time.Second), true, 800, true, now.Add(time.Duration(i)*5*time.Second))
	}
	if _, ok := p.Co2SlopePpmPerMin(); ok {
		t.Fatal("slope must be unresolved with only 3 samples")
	}
}

// A CO2 trace swinging faster than room-level respiration allows (observed here when someone
// breathes near the probe) must neither confirm nor dispute -- the fusion falls back to radar.
func TestImplausibleCo2SlopeDoesNotConfirm(t *testing.T) {
	p := &PresenceFusion{}
	now := time.Now()
	// +400 ppm/min: ~40x what one person can produce. Observed on this node during a fault.
	drive(p, now, 300, true, func(i int) float64 { return 800 + float64(i)*33 })
	if !p.Co2Implausible {
		t.Fatalf("slope %.1f ppm/min should be flagged implausible", p.SlopePpmMin)
	}
	if p.State == PresenceOccupied {
		t.Fatal("a fault-level CO2 slope must not confirm occupancy")
	}
}

// A near-field CO2 spike must not flip the state to disputed either: someone breathing on
// the probe is present, even though the reading no longer describes the room.
func TestImplausibleCo2SlopeDoesNotDispute(t *testing.T) {
	p := &PresenceFusion{}
	now := time.Now()
	// Radar asserting for 10 min while CO2 plunges at ~-400 ppm/min (breath clearing away).
	drive(p, now, 600, true, func(i int) float64 { return 6000 - float64(i)*33 })
	if p.State == PresenceDisputed {
		t.Fatalf("a near-field CO2 swing must not dispute a radar assertion (slope %.1f)",
			p.SlopePpmMin)
	}
}
