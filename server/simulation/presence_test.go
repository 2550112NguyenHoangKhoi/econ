package simulation

import (
	"encoding/json"
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

// Losing the CO2 sensor mid-decay must not strand a zone in "departing" forever. Radar alone
// is weak evidence, but a beam clear for a full window is enough to call the room empty.
func TestDepartingFallsBackToVacantWithoutCo2(t *testing.T) {
	p := &PresenceFusion{}
	now := time.Now()
	// Occupied, then the person leaves and CO2 decays -> departing.
	now = drive(p, now, 300, true, func(i int) float64 { return 800 + float64(i)*0.5 })
	now = drive(p, now, 200, false, func(i int) float64 { return 830 - float64(i)*0.4 })
	if p.State != PresenceDeparting {
		t.Fatalf("setup: expected departing, got %q", p.State)
	}
	// CO2 sensor now stops reporting entirely; radar stays clear for 10 minutes.
	for i := 0; i < 120; i++ {
		p.Update(now, false, 0, false, time.Time{})
		now = now.Add(5 * time.Second)
	}
	if p.State != PresenceVacant {
		t.Fatalf("beam clear 10min with no CO2 must reach vacant, stuck in %q", p.State)
	}
}

// co2Confirmed must describe the evidence now, not the decision that set the state. The
// state is sticky on purpose; the confirmation flag must not inherit that.
func TestConfirmedFlagDoesNotOutliveItsEvidence(t *testing.T) {
	p := &PresenceFusion{}
	now := time.Now()
	now = drive(p, now, 300, true, func(i int) float64 { return 800 + float64(i)*0.5 })
	if p.State != PresenceOccupied {
		t.Fatalf("setup: expected occupied, got %q", p.State)
	}
	// CO2 stops reporting; radar keeps asserting. State may stay occupied, but nothing is
	// corroborating it any more.
	for i := 0; i < 200; i++ {
		p.Update(now, true, 0, false, time.Time{})
		now = now.Add(5 * time.Second)
	}
	b, err := p.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	var w map[string]any
	if err := json.Unmarshal(b, &w); err != nil {
		t.Fatal(err)
	}
	if w["co2SlopeResolved"] == true {
		t.Fatal("slope should be unresolved once samples age out")
	}
	if w["co2Confirmed"] == true {
		t.Fatal("co2Confirmed must be false when no slope is resolved")
	}
}

// --- BelievedVacant: the predicate the setback and plug sweep actually gate on ---

// The failure this exists for: an Rd-03 whose OT2 output latches HIGH and stays there.
// Occupancy never drops, so a gate reading it alone never accumulates a vacant tick and
// the whole savings mechanism is disabled with nothing in telemetry to say so.
func TestStuckRadarWithDecayingCo2IsEventuallyBelievedVacant(t *testing.T) {
	z := &ZoneSim{Occupancy: 1, Presence: &PresenceFusion{}}
	now := time.Now()

	// Radar asserts continuously. CO2 decays throughout: nobody is actually here.
	now = drive(z.Presence, now, 900, true, func(i int) float64 { return 1400 - float64(i)*1.0 })
	if z.Presence.State != PresenceDisputed {
		t.Fatalf("beam held while CO2 decays -> disputed, got %q (slope %.2f)",
			z.Presence.State, z.Presence.SlopePpmMin)
	}
	// The dwell is measured from when disputed was ENTERED, not from the end of the trace --
	// the beam had already been asserting against a falling slope for minutes before the
	// state flipped, and that time counts. Anchor the assertions to Since accordingly.
	since := z.Presence.Since
	if z.BelievedVacant(since) {
		t.Fatal("the instant disputed is entered: must NOT yet be treated as vacant")
	}
	if z.BelievedVacant(since.Add(disputedActionDelay - time.Minute)) {
		t.Fatal("one minute short of the dwell: must still not be vacant")
	}
	if !z.BelievedVacant(since.Add(disputedActionDelay + time.Second)) {
		t.Fatal("disputed for the full dwell: should be believed vacant despite Occupancy=1")
	}
}

// A real occupant must never be swept, however long they sit still.
func TestCorroboratedOccupantIsNeverBelievedVacant(t *testing.T) {
	z := &ZoneSim{Occupancy: 1, Presence: &PresenceFusion{}}
	now := time.Now()
	now = drive(z.Presence, now, 900, true, func(i int) float64 { return 700 + float64(i)*0.5 })
	if z.Presence.State != PresenceOccupied {
		t.Fatalf("radar + rising CO2 -> occupied, got %q", z.Presence.State)
	}
	if z.BelievedVacant(now.Add(time.Hour)) {
		t.Fatal("an occupant corroborated by respiration must never be believed vacant")
	}
}

// No CO2 sensor must leave behaviour exactly as it was: trust the presence sensor.
func TestBelievedVacantFallsBackToRawSensorWithoutCo2(t *testing.T) {
	z := &ZoneSim{Occupancy: 1}
	if z.BelievedVacant(time.Now().Add(24 * time.Hour)) {
		t.Fatal("no fusion at all: Occupancy>0 must mean not vacant")
	}
	z.Presence = &PresenceFusion{}
	now := time.Now()
	// Radar held, CO2 never resolves a slope (no samples fresh enough to matter).
	for i := 0; i < 180; i++ {
		z.Presence.Update(now, true, 0, false, time.Time{})
		now = now.Add(5 * time.Second)
	}
	if z.BelievedVacant(now.Add(time.Hour)) {
		t.Fatal("radar asserts and CO2 is unavailable: must not invent vacancy")
	}
}

// The ordinary case still works: nothing asserts presence, so it is vacant immediately.
func TestBelievedVacantWhenNothingAssertsPresence(t *testing.T) {
	z := &ZoneSim{Occupancy: 0, Presence: &PresenceFusion{}}
	if !z.BelievedVacant(time.Now()) {
		t.Fatal("Occupancy=0 must be vacant with no dwell required")
	}
}
