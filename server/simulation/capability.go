package simulation

// Actuation capability: what the twin is allowed to ask for in REAL mode.
//
// A recommendation is a request to change the building. In simulation the twin owns every
// actuator it models, so any request it makes is carried out and the question does not
// arise. In real mode it owns none of them: a setpoint reaches an air conditioner only if
// someone wired an IR blaster to that room's node and the firmware said so, and a damper
// moves only if a node is bound and the broker still believes it is alive.
//
// The recommendation pass was not asking. It emitted "Room Vacant but AC may be ON" —
// action turn_off_ac — for any zone whose IR state was simply unknown, and the message
// said as much ("its AC might still be running"). That is a recommendation derived from
// the ABSENCE of a measurement, which is the same error rule 1 forbids on the telemetry
// path: a missing field is not evidence of a state. On the house fixture it fired on four
// rooms that have no AC control wired at all, and those four cards filled a list capped at
// eight, crowding out the findings that came from real sensors.
//
// So in real mode every recommendation is now checked against the hardware that would have
// to carry it out. Two different failures, kept distinct, because collapsing them would
// throw away real measurements:
//
//   - The FINDING itself rests on hardware that is not there. There is no evidence, so
//     there is nothing to report, and the recommendation is dropped entirely.
//   - The finding is measured but its REMEDIATION is not wired. The measurement stands and
//     still deserves an operator's attention; only the action button would be a lie. The
//     action is cleared and the card says which hardware is missing, so the gap reads as a
//     commissioning task rather than as silence.
//
// Nothing here runs in simulation mode.

import (
	"fmt"
	"strings"
)

// ZoneCapability is what one zone's bound hardware can actually do right now. Every field
// is a fact the engine already holds — this type only gathers them in one place so the
// recommendation pass can consult them without reaching back into ZoneSim under a second
// lock.
//
// The three-state AC control (known/unknown × real/not) is the point of the whole type.
// "No node has ever told us" and "a node told us there is no AC" are different situations
// and neither of them is "the AC is on".
type ZoneCapability struct {
	NodeBound  bool // a physical node has ever been bound to this zone
	NodeOnline bool // the broker's last-will verdict says that node is alive now

	AcControlKnown bool // a node has positively reported whether its commands reach an AC
	AcControlReal  bool // ...and they do

	AcPowerLive bool    // a current clamp is reporting this zone's AC right now
	AcPowerW    float64 // what it reads (meaningless unless AcPowerLive)

	IrState *string // last AC state the node reported or the engine commanded; nil = never
}

// acRunning reports whether there is positive evidence the air conditioner is running.
//
// Measurement first: a clamp on the AC circuit settles the question outright, in both
// directions — above the library's running threshold the compressor is drawing, at or
// below it the machine is idle and asking to turn it off is a false positive. Only when no
// clamp is reporting does the commanded IR state stand in, and only when the node has
// confirmed that its IR commands reach a real machine; otherwise "not OFF" is just the
// absence of a command, not the presence of cooling.
func (c ZoneCapability) acRunning() (running bool, known bool) {
	if c.AcPowerLive {
		return c.AcPowerW > Phys().AcRunningThresholdW, true
	}
	if c.AcControlKnown && c.AcControlReal && c.IrState != nil {
		return !strings.EqualFold(*c.IrState, "OFF"), true
	}
	return false, false
}

// acControllable reports whether a turn-off command sent to this zone would reach an air
// conditioner: a node that is bound, alive, and has confirmed its IR control is wired to
// one.
func (c ZoneCapability) acControllable() bool {
	return c.NodeBound && c.NodeOnline && c.AcControlKnown && c.AcControlReal
}

// commandable reports whether ANY command published for this zone would be received. The
// engine only publishes to zones with an MQTT topic (see actuate), and a node the broker
// has declared dead will not act on what it never receives.
func (c ZoneCapability) commandable() bool {
	return c.NodeBound && c.NodeOnline
}

// acMissingReason names, in an operator's terms, what is not wired. It is appended to a
// card whose action had to be withdrawn so the panel explains the gap instead of quietly
// dropping the button.
func (c ZoneCapability) acMissingReason() string {
	switch {
	case !c.NodeBound:
		return "no edge node is bound to this zone"
	case !c.NodeOnline:
		return "this zone's edge node is offline (broker last-will)"
	case !c.AcControlKnown:
		return "this zone's node has not reported whether its IR control reaches an air conditioner"
	case !c.AcControlReal:
		return "this zone's node reports that its IR commands do not reach an air conditioner"
	default:
		return ""
	}
}

// applyActuationCapability filters and defangs a ranked recommendation list against the
// hardware actually wired to each zone. Real mode only — the caller decides that.
//
// It runs on the MERGED list (anomalies and predictions together) so one rule covers both
// models, and before topN is applied so that withdrawing a card promotes a real one into
// the list rather than leaving a hole.
func applyActuationCapability(recs []Recommendation, caps map[string]ZoneCapability) []Recommendation {
	out := recs[:0:0] // fresh backing array: the caller's slice is still ranked input
	for _, r := range recs {
		// Building-wide advice (the pre-cool window, the load baseline) is not a per-zone
		// actuation and has no node to check.
		if r.Zone == "" || r.Zone == "GLOBAL" {
			out = append(out, r)
			continue
		}
		zc, hasCap := caps[r.Zone]
		if !hasCap {
			// A zone the engine no longer knows: nothing can be asserted about its
			// hardware, so nothing is claimed on its behalf.
			continue
		}

		switch r.Action {
		case "turn_off_ac":
			// The finding IS the claim that an air conditioner is running and should not
			// be. Without evidence for that claim there is no finding to report.
			running, known := zc.acRunning()
			if !known || !running {
				continue
			}
			if !zc.acControllable() {
				// The AC is measurably running and the room is measurably vacant — a real,
				// reportable waste — but no wired path exists to switch it off from here.
				r.Action = ""
				r.Message = fmt.Sprintf("%s Switching it off from the twin is not possible: %s, so this is a callout rather than a command.",
					r.Message, zc.acMissingReason())
			}
			out = append(out, r)

		case "purge", "cool":
			// These publish a setpoint, damper or HVAC command to the zone's node. The
			// finding behind them is a measurement (temperature, CO2) and stands on its
			// own; only the remediation needs hardware.
			if !zc.commandable() {
				r.Action = ""
				reason := "no edge node is bound to this zone"
				if zc.NodeBound {
					reason = "this zone's edge node is offline (broker last-will)"
				}
				r.Message = fmt.Sprintf("%s No command can be dispatched: %s — the zone is reporting, but nothing here can act on it.",
					r.Message, reason)
			}
			out = append(out, r)

		default:
			// precool is building-wide, and an empty action is advisory already.
			out = append(out, r)
		}
	}
	return out
}
