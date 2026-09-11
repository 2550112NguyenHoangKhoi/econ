package simulation

import (
	"testing"
	"time"
)

// A relay that never opened must not accrue savings. This is rule 3 -- no saving from a
// mechanism that does not exist -- applied to the one actuator the node can answer for.
func TestShedSavingsAreNotCreditedWhenTheNodeSaysThePlugIsOn(t *testing.T) {
	now := time.Now()
	z := &ZoneSim{PlugShed: true, NodePlugState: "ON", NodePlugAt: now}
	if !z.plugShedContradicted(now) {
		t.Fatal("commanded shed + node reports ON = contradiction")
	}
}

func TestShedSavingsAreCreditedWhenTheNodeConfirms(t *testing.T) {
	now := time.Now()
	z := &ZoneSim{PlugShed: true, NodePlugState: "OFF", NodePlugAt: now}
	if z.plugShedContradicted(now) {
		t.Fatal("node confirms OFF: must not be treated as a contradiction")
	}
}

// Silence is not a contradiction. An uninstrumented zone, or firmware too old to echo its
// plug state, must be accounted exactly as before rather than losing its modelled savings.
func TestUnreportedPlugStateIsNotAContradiction(t *testing.T) {
	now := time.Now()
	if (&ZoneSim{PlugShed: true}).plugShedContradicted(now) {
		t.Fatal("no plug echo at all: must not contradict")
	}
	stale := &ZoneSim{PlugShed: true, NodePlugState: "ON", NodePlugAt: now.Add(-2 * hwStaleAfter)}
	if stale.plugShedContradicted(now) {
		t.Fatal("node went quiet: stale ON must not keep suppressing the credit")
	}
}

// Nothing was commanded, so there is nothing to contradict.
func TestUnshedZoneIsNeverContradicted(t *testing.T) {
	now := time.Now()
	z := &ZoneSim{PlugShed: false, NodePlugState: "ON", NodePlugAt: now}
	if z.plugShedContradicted(now) {
		t.Fatal("not shed: a plug reporting ON is simply correct")
	}
}

// End to end through plugTick: the accrual itself must stop, not merely the predicate.
func TestPlugTickCreditsNothingWhileContradicted(t *testing.T) {
	now := time.Now()
	mk := func(state string) *Engine {
		e := &Engine{Zones: map[string]*ZoneSim{}, Plug: defaultPlugConfig()}
		e.Zones["z1"] = &ZoneSim{
			MqttTopic: "zone_1", PlugShed: true, PlugStandbyW: 500,
			NodePlugState: state, NodePlugAt: now,
			OverrideUntil: now.Add(time.Hour), // take the manual-override branch
		}
		e.lastPlugAt = now.Add(-time.Second)
		return e
	}
	confirmed, denied := mk("OFF"), mk("ON")
	for i := 1; i <= 5; i++ {
		at := now.Add(time.Duration(i) * time.Second)
		confirmed.plugTick(at)
		denied.plugTick(at)
	}
	if confirmed.plugSavedKwh <= 0 {
		t.Fatalf("a confirmed shed should accrue, got %g", confirmed.plugSavedKwh)
	}
	if denied.plugSavedKwh != 0 {
		t.Fatalf("a contradicted shed must accrue nothing, got %g", denied.plugSavedKwh)
	}
}
