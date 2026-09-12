package simulation

import (
	"os"
	"testing"
	"time"

	"econ/schema/Telemetry"
)

// Why this test exists.
//
// The DCV fields were appended to the FlatBuffers schema by hand, because flatc is not
// installed on this machine and the generated Go and TypeScript are checked in. Hand-editing
// generated serialization code has one characteristic failure mode: the writer and the
// reader disagree about a vtable slot, and the result is not a crash but a plausible-looking
// zero. A UI that shows 0% ventilation on a zone the engine is purging is worse than one
// that errors, because nobody investigates a number.
//
// So this asserts the round trip through the real broadcast path: the engine's own bytes,
// decoded by the reader the dashboard's websocket handler uses.
//
// It also writes those bytes to ECON_DCV_FRAME_OUT when set, so the SAME frame can be fed to
// the TypeScript decoder (dashboard/tools/decode_frame.mjs). The two decoders are separate
// hand-edits of the same schema; only feeding one frame to both proves they agree.
func TestBroadcastRoundTrip_DcvFields(t *testing.T) {
	e := NewEngine()

	// Pick a non-critical zone and give it a fresh, stuffy NDIR reading. 1150 ppm is above
	// the comfort guideline, so the loop should be well up the band -- a value that is
	// distinguishable from both the floor (0.15) and a decode failure (0.0).
	// A zone with a DENSITY BASIS, not merely a non-critical one. DesignOccupancy returns 0
	// for programmes that have no occupant density (a plant room, a corridor), and such a
	// zone can be demand-controlled without producing any avoided load -- which is correct,
	// but makes for a test that passes while exercising nothing. Iteration order over a Go
	// map is random, so picking "the first non-critical zone" silently sampled a different
	// zone type on every run.
	// A zone rated for SEVERAL people, because the avoided-load half of DCV is the gap
	// between rated and actual occupancy. On the office fixture most cellular offices are
	// ~12 m2 and rate for exactly 1 person, so seeding "fewer people than rated" is
	// impossible there and the saving is legitimately zero. An earlier version of this test
	// picked the first non-critical zone, got a 1-person office, and asserted a saving that
	// could never occur.
	var zoneID string
	var designOcc int
	for id, z := range e.Zones {
		if d := DesignOccupancy(z.Type, z.AreaM2); !IsCritical(z.Type) && d >= 4 {
			zoneID, designOcc = id, d
			break
		}
	}
	if zoneID == "" {
		t.Skip("fixture has no zone rated for 4+ occupants")
	}
	z := e.Zones[zoneID]
	// Under-occupied: one person in a space rated for designOcc. That gap is exactly what
	// demand-controlled ventilation is worth, and a constant-volume system would ventilate
	// for the full rated headcount regardless.
	z.Occupancy = 1
	z.Temp = z.BaseSetpoint
	z.Setpoint = z.BaseSetpoint
	z.HwCo2 = 1150
	z.HwCo2At = time.Now()

	e.AutoPilot = true
	e.Actuate()

	wantFloor := z.Vent.Floor
	if !z.Vent.Measured {
		t.Fatalf("precondition failed: zone %s is not demand-controlled after Actuate()", zoneID)
	}
	if wantFloor <= MinVentDamperFloor {
		t.Fatalf("precondition failed: floor %v is at the minimum, so this test cannot tell a correct decode from a zeroed one", wantFloor)
	}

	buf := e.BuildFrameForTest()
	if len(buf) == 0 {
		t.Fatal("BuildFrame returned no bytes")
	}
	if out := os.Getenv("ECON_DCV_FRAME_OUT"); out != "" {
		if err := os.WriteFile(out, buf, 0o644); err != nil {
			t.Fatalf("writing frame for the TypeScript decoder: %v", err)
		}
		t.Logf("wrote %d bytes to %s for cross-decoder verification", len(buf), out)
	}

	state := Telemetry.GetRootAsSimState(buf, 0)

	// --- per-zone fields ---
	var found bool
	for i := 0; i < state.ZonesLength(); i++ {
		var zd Telemetry.ZoneData
		if !state.Zones(&zd, i) {
			continue
		}
		if string(zd.Id()) != zoneID {
			continue
		}
		found = true
		if !zd.VentMeasured() {
			t.Errorf("ventMeasured decoded false for a demand-controlled zone — the bool slot (13, vtable offset 30) is wrong")
		}
		if got := float64(zd.VentFloor()); got < wantFloor-1e-4 || got > wantFloor+1e-4 {
			t.Errorf("ventFloor decoded %v, engine computed %v — the float slot (12, vtable offset 28) is wrong", got, wantFloor)
		}
	}
	if !found {
		t.Fatalf("zone %s not present in the broadcast frame", zoneID)
	}

	// --- building totals ---
	g := state.Global(nil)
	if g == nil {
		t.Fatal("frame has no GlobalData")
	}
	if int(g.DcvZones()) != e.dcvZones {
		t.Errorf("dcvZones decoded %d, engine counted %d — the int slot (16, vtable offset 36) is wrong", g.DcvZones(), e.dcvZones)
	}
	if e.dcvZones < 1 {
		t.Errorf("dcvZones = %d after actuating a measured zone, want >= 1", e.dcvZones)
	}
	// The avoided-load figure is only non-zero once broadcast() has run, because that is
	// where it is computed (beside the fresh-air load it modifies -- see ventilation.go for
	// why it is not computed in the loop itself). The zone was seeded at 4 occupants in a
	// space rated for more, so DCV is ventilating for 4 rather than the rated headcount and
	// the difference must show up here.
	if g.DcvAvoidedKw() <= 0 {
		t.Errorf("dcvAvoidedKw = %v, want > 0: zone %s is demand-controlled with 1 of %d rated occupants, so DCV is avoiding fresh-air load for %d people",
			g.DcvAvoidedKw(), zoneID, designOcc, designOcc-1)
	}

	// Fields that existed BEFORE this change must still decode. Appending to a FlatBuffers
	// table is supposed to be safe, but "supposed to be" is exactly what a hand-edit puts at
	// risk: getting StartObject's field count wrong shifts every vtable entry.
	if g.TotalOccupants() < 1 {
		t.Errorf("totalOccupants decoded %d after appending two fields — the vtable size is probably wrong", g.TotalOccupants())
	}
	if g.PlantCop() <= 0 {
		t.Errorf("plantCop decoded %v after appending two fields — existing slots have shifted", g.PlantCop())
	}
}
