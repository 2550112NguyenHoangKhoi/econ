package simulation

import (
	"math"
	"testing"
	"time"
)

// The contract these tests defend, in one place, because it is the part of DCV that is easy
// to break by accident:
//
//  1. A zone with NO live NDIR sensor must behave exactly as it did before DCV existed --
//     fixed floor, Measured=false. Anything else means the loop is actuating on a modelled
//     concentration, which is rule 1 applied to control.
//  2. A measured zone reading essentially outdoor air sits at the area floor, not above it.
//     That is where the saving comes from; if this regresses, DCV silently stops paying.
//  3. A measured zone above the comfort guideline opens hard, and above the purge threshold
//     goes fully open. If THIS regresses, the loop becomes a cost-cutting device that can
//     only close dampers, which is the version that is not defensible.
//  4. The floor is monotonic in concentration. A non-monotonic controller hunts.

// freshCo2Zone builds a zone whose NDIR reading is fresh as of now.
func freshCo2Zone(ppm float64) *ZoneSim {
	return &ZoneSim{
		Type:    "open-office",
		AreaM2:  100,
		HwCo2:   ppm,
		HwCo2At: time.Now(),
	}
}

func TestVentDemand_NoSensorKeepsPreDcvBehaviour(t *testing.T) {
	z := &ZoneSim{Type: "open-office", AreaM2: 100}
	// Co2Sim is deliberately set high: if the loop ever reads the MODELLED concentration
	// this test fails, which is the whole point of it.
	z.Co2Sim = 1800

	d := z.ventDemand(nil, RoomCondition{Zone: "z1"})

	if d.Measured {
		t.Fatalf("a zone with no NDIR sensor reported Measured=true; the loop is reading a modelled ppm")
	}
	if d.Floor != MinVentDamperFloor {
		t.Fatalf("floor = %v, want the fixed minimum %v -- unmeasured zones must not move", d.Floor, MinVentDamperFloor)
	}
	if d.Reason != "none" {
		t.Fatalf("reason = %q, want \"none\"", d.Reason)
	}
}

func TestVentDemand_StaleSensorIsNotMeasured(t *testing.T) {
	z := freshCo2Zone(1500)
	// Older than the freshness window: the value exists but no longer describes the room.
	z.HwCo2At = time.Now().Add(-24 * time.Hour)

	d := z.ventDemand(nil, RoomCondition{Zone: "z1"})

	if d.Measured {
		t.Fatalf("a stale NDIR reading was treated as live; check co2Fresh() and the node's publish interval")
	}
	if d.Floor != MinVentDamperFloor {
		t.Fatalf("floor = %v, want %v", d.Floor, MinVentDamperFloor)
	}
}

func TestVentDemand_OutdoorAirSitsAtTheFloor(t *testing.T) {
	ph := Phys()
	// A room reading outdoor air has no occupant load to ventilate for.
	z := freshCo2Zone(ph.OutdoorCo2Ppm)

	d := z.ventDemand(nil, RoomCondition{Zone: "z1"})

	if !d.Measured {
		t.Fatalf("Measured=false for a fresh reading")
	}
	if math.Abs(d.Floor-MinVentDamperFloor) > 1e-9 {
		t.Fatalf("floor = %v at outdoor concentration, want the area minimum %v -- this is where the DCV saving comes from",
			d.Floor, MinVentDamperFloor)
	}
	if d.Reason != "floor" {
		t.Fatalf("reason = %q, want \"floor\"", d.Reason)
	}
}

func TestVentDemand_NeverBreachesTheAreaMinimum(t *testing.T) {
	// Below outdoor ambient is physically odd but a miscalibrated sensor can report it, and
	// the response must be "clamp", not "close the damper below code minimum".
	z := freshCo2Zone(120)

	d := z.ventDemand(nil, RoomCondition{Zone: "z1"})

	if d.Floor < MinVentDamperFloor {
		t.Fatalf("floor = %v breached the ASHRAE area minimum %v; the per-area component is not people-driven and DCV may not modulate it away",
			d.Floor, MinVentDamperFloor)
	}
}

func TestVentDemand_AtComfortGuidelineOpensFully(t *testing.T) {
	ph := Phys()
	z := freshCo2Zone(ph.Co2ComfortPpm)

	d := z.ventDemand(nil, RoomCondition{Zone: "z1"})

	if d.Floor < MaxDamperPos-1e-9 {
		t.Fatalf("floor = %v at the comfort guideline (%v ppm), want fully open %v",
			d.Floor, ph.Co2ComfortPpm, MaxDamperPos)
	}
}

func TestVentDemand_PurgeThresholdForcesFullOpen(t *testing.T) {
	z := freshCo2Zone(dcvPurgePpm + 300)

	d := z.ventDemand(nil, RoomCondition{Zone: "z1"})

	if d.Floor != MaxDamperPos {
		t.Fatalf("floor = %v above the purge threshold, want %v", d.Floor, MaxDamperPos)
	}
	if d.Reason != "purge" {
		t.Fatalf("reason = %q, want \"purge\"", d.Reason)
	}
}

func TestVentDemand_MonotonicInConcentration(t *testing.T) {
	// A controller whose output is not monotonic in its input hunts: the damper chases
	// itself and the zone never settles. Walk the whole band and assert it never goes down.
	prev := -1.0
	for ppm := 300.0; ppm <= 2000.0; ppm += 25 {
		d := freshCo2Zone(ppm).ventDemand(nil, RoomCondition{Zone: "z1"})
		if d.Floor < prev-1e-9 {
			t.Fatalf("floor fell from %v to %v as CO2 rose to %v ppm -- the loop is not monotonic and will hunt",
				prev, d.Floor, ppm)
		}
		prev = d.Floor
	}
}

func TestVentDemand_ReadsTheLibraryNotAConstant(t *testing.T) {
	// The comfort guideline describes the building standard, so it belongs in the programme
	// library (rule 2). This test fails if someone reintroduces a literal: it asserts the
	// band's upper edge tracks Phys(), by checking the midpoint of the band lands halfway.
	ph := Phys()
	lo := ph.OutdoorCo2Ppm + ph.Co2PpmPerOccupantSteady
	mid := lo + (ph.Co2ComfortPpm-lo)/2

	d := freshCo2Zone(mid).ventDemand(nil, RoomCondition{Zone: "z1"})

	want := MinVentDamperFloor + 0.5*(MaxDamperPos-MinVentDamperFloor)
	if math.Abs(d.Floor-want) > 1e-6 {
		t.Fatalf("floor = %v at the band midpoint, want %v -- the band is not being read from Phys()", d.Floor, want)
	}
}

// TestActuate_DcvRaisesDamperAboveThermalDemand is the integration half: it drives the real
// actuation pass and checks the damper ends up where ventilation asked, not where thermal
// error alone would have put it.
func TestActuate_DcvRaisesDamperAboveThermalDemand(t *testing.T) {
	e := NewEngine()

	// A zone with a DENSITY BASIS, not merely a non-critical one. DesignOccupancy returns 0
	// for programmes that have no occupant density (a plant room, a corridor), and such a
	// zone can be demand-controlled without producing any avoided load -- which is correct,
	// but makes for a test that passes while exercising nothing. Iteration order over a Go
	// map is random, so picking "the first non-critical zone" silently sampled a different
	// zone type on every run.
	var zoneID string
	for id, z := range e.Zones {
		if !IsCritical(z.Type) && DesignOccupancy(z.Type, z.AreaM2) > 0 {
			zoneID = id
			break
		}
	}
	if zoneID == "" {
		t.Skip("fixture has no occupied-by-density zone")
	}
	z := e.Zones[zoneID]

	// Occupied and exactly at setpoint: thermal demand is the 0.5 bias, nothing more.
	z.Occupancy = 2
	z.Temp = z.BaseSetpoint
	z.Setpoint = z.BaseSetpoint
	z.VacantTicks = 0
	// ...and stuffy. A sensor says so, so the loop is allowed to act.
	z.HwCo2 = 1150
	z.HwCo2At = time.Now()

	e.AutoPilot = true
	e.Actuate()

	if !z.Vent.Measured {
		t.Fatalf("zone %s: Vent.Measured=false with a fresh 1150 ppm reading", zoneID)
	}
	v := e.findVavForZone(zoneID, nil)
	if v == nil {
		t.Skip("zone has no VAV in this fixture")
	}
	if v.TargetDamperPos <= 0.6 {
		t.Fatalf("zone %s: damper target %v at 1150 ppm -- thermal demand alone is ~0.5, so DCV did not raise it",
			zoneID, v.TargetDamperPos)
	}
	if e.dcvZones < 1 {
		t.Fatalf("dcvZones = %d, want at least 1", e.dcvZones)
	}
}
