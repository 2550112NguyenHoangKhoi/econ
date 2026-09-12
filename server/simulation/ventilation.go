package simulation

// Demand-controlled ventilation — the loop that acts on measured CO2.
//
// Until this file existed, CO2 was ingested, scored, and used to identify each room's
// air-change rate, but nothing actuated on it: the damper was positioned from thermal error
// alone and a fixed ASHRAE floor. The measurement existed; the control did not, and
// docs/ROADMAP.md said so. This closes that gap.
//
// The rule that shapes the whole design: **only a live NDIR reading may move a damper.**
// `Co2Sim` is a modelled concentration the dashboard shows where no sensor reports, and
// ventilating a building from a modelled ppm would be actuating on the twin's own guess —
// the control equivalent of rule 1. A zone with no sensor keeps exactly the behaviour it had
// before this file: the fixed ventilation floor.
//
// What DCV changes, for a zone that IS measured:
//
//	CO2 low   -> the floor falls toward the area-based minimum. This is the saving: an
//	             occupied-but-sparse room stops being ventilated for a full design
//	             occupancy that is not there.
//	CO2 high  -> the floor rises above what thermal error asked for. This is the comfort
//	             and health half, and it is the half that makes the saving defensible: a
//	             DCV loop that can only close dampers is a cost-cutting device, not a
//	             ventilation strategy.
//
// The area-based minimum is never breached. ASHRAE 62.1 lets DCV modulate the *people*
// component of outdoor air; the *per-area* component is there for the building's own
// emissions — furniture, finishes, cleaning products — which do not leave when the people
// do. MinVentDamperFloor is that component.

import "math"

// VentDemand is why a zone's damper is where it is, on the ventilation side. Separate from
// the thermal demand so the dashboard can say which one is in charge — an operator looking
// at a wide-open damper needs to know whether the room is hot or stuffy.
type VentDemand struct {
	// Floor is the damper position fresh-air demand requires, in [0,1].
	Floor float64
	// Measured is true when a live NDIR reading produced this floor. When false, Floor is
	// the fixed ASHRAE minimum and nothing here was demand-controlled.
	Measured bool
	// Ppm is the measured concentration the floor was computed from; 0 when !Measured.
	Ppm float64
	// Predicted is the concentration this room is heading for under its identified CO2
	// balance, when that balance has been identified. 0 when unknown.
	Predicted float64
	// Reason is a short operator-facing word: "purge", "boost", "trim", "floor", "none".
	Reason string
}

const (
	// dcvHorizonSec is how far ahead the identified CO2 balance is evaluated. Ventilation
	// is slow — a room at 3 ACH needs ~20 min to turn its air over — so reacting only once
	// a limit is crossed means occupants sit above it for the whole recovery. Fifteen
	// minutes is roughly one air change at office rates.
	dcvHorizonSec = 900.0

	// dcvPurgePpm is the concentration at which the damper goes fully open regardless of
	// thermal demand. Above ASHRAE 62.1's ~1000 ppm comfort guideline and below the
	// 1400-1500 ppm at which measurable cognitive effects are reported, so it is a margin
	// rather than a limit being defended.
	dcvPurgePpm = 1200.0
)

// ventDemand computes the fresh-air floor for one zone.
//
// dyn may be nil (no identification yet), in which case the predictive term is skipped and
// the floor is proportional to the measured concentration alone.
func (z *ZoneSim) ventDemand(dyn *Dynamics, c RoomCondition) VentDemand {
	ph := Phys()
	floor := MinVentDamperFloor

	// No live sensor: unchanged behaviour, and the struct says so rather than implying a
	// demand-controlled decision was made.
	if !(z.HwCo2 > 0 && z.co2Fresh()) {
		return VentDemand{Floor: floor, Measured: false, Reason: "none"}
	}

	ppm := z.HwCo2
	out := ph.OutdoorCo2Ppm
	if out <= 0 {
		out = 400.0
	}

	// The band the loop modulates across. Its lower edge is outdoor air plus a small margin
	// — a room reading essentially outdoor air has no occupant load to ventilate for, and
	// its damper belongs at the area floor. Its upper edge is the comfort guideline the
	// baselines already score against, so one number governs both what is called an anomaly
	// and what is acted on.
	lo := out + ph.Co2PpmPerOccupantSteady
	hi := ph.Co2ComfortPpm
	if hi <= lo {
		hi = lo + 400.0
	}

	frac := (ppm - lo) / (hi - lo)
	frac = math.Max(0, math.Min(1, frac))

	// Proportional across the band, from the area floor to fully open.
	floor = MinVentDamperFloor + frac*(MaxDamperPos-MinVentDamperFloor)

	d := VentDemand{Floor: floor, Measured: true, Ppm: ppm}

	// Predictive term. A room whose identified CO2 balance says it will cross the comfort
	// guideline within the horizon opens now rather than when it gets there, because the
	// room cannot turn its air over faster than its own air-change rate allows. Only an
	// identified room contributes this; an unidentified one keeps the proportional answer.
	if dyn != nil && c.Co2Live {
		ol := dyn.Co2OutlookFor(c, hi, dcvHorizonSec)
		if ol.Ok {
			d.Predicted = ol.Predicted
			pf := (ol.Predicted - lo) / (hi - lo)
			pf = math.Max(0, math.Min(1, pf))
			predFloor := MinVentDamperFloor + pf*(MaxDamperPos-MinVentDamperFloor)
			if predFloor > d.Floor {
				d.Floor = predFloor
			}
		}
	}

	switch {
	case ppm >= dcvPurgePpm:
		d.Floor = MaxDamperPos
		d.Reason = "purge"
	case d.Floor > MinVentDamperFloor+0.35:
		d.Reason = "boost"
	case d.Floor <= MinVentDamperFloor+1e-9:
		d.Reason = "floor"
	default:
		d.Reason = "trim"
	}
	return d
}

// Where the saving is computed, and why it is not here.
//
// An earlier version of this file computed the avoided fresh-air load from the damper
// position: design rate x (1 - damper). That was wrong in a way worth recording, because it
// is an easy mistake to make twice. The damper is a SUPPLY-air actuator; outdoor air is
// introduced at the AHU, and the fraction of supply that is outdoor air is not the damper
// position. Sizing a ventilation saving off a damper conflates the two.
//
// The defensible comparison is between headcounts, not damper positions: a constant-volume
// system ventilates for the occupancy a zone is RATED for, a demand-controlled one for the
// people actually in it, and the difference is what DCV is worth. That calculation lives in
// broadcast(), immediately beside the fresh-air load it modifies, so the two are sized
// against the same number by construction. See ventOccupants there.
