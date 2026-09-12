// actuate — setback, lighting and damper decisions.
//
// Split out of engine.go, which had grown to 3,541 lines. Same package, same code:
// nothing here was rewritten, only moved to a file named after what it does.

package simulation

import (
	"fmt"
	"log"
	"math"
	"time"
)

// actuate runs the occupancy-driven optimizer: a zone empty past the safety delay is set
// back (warmer setpoint, which lowers cooling load and shows up as a drop on the
// dashboard) and its lights are commanded off; a reoccupied zone is restored.
//
// Two deliberate design points:
//   - AutoPilot gates the whole thing. When it is off the optimizer is genuinely
//     suspended — setpoints hold wherever they are (manual or last-commanded) and
//     nothing autonomous is claimed. This is what the dashboard's AI toggle now
//     actually controls, end to end, instead of only re-labelling cards.
//   - It acts on EVERY zone, not just hardware-bound ones, so the twin's autonomy is
//     real in the model (physics + streamed savings reflect it). MQTT commands are
//     published ONLY to zones with a real device listening (MqttTopic set) — a pure-sim
//     zone changes state in the engine but we don't spray commands onto topics no board
//     subscribes to.
//
// ActuateAirflow runs the auto-pilot control loop with a specified time step dt,
// enforcing physical constraints and solving fluid dynamics.
func (e *Engine) ActuateAirflow(dt float64) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.actuateWithDt(dt)
}

func (e *Engine) actuate() {
	e.actuateWithDt(1.0)
}

func (e *Engine) actuateWithDt(dt float64) {
	actuateNow := time.Now()
	if dt <= 0 {
		dt = 0.033
	}
	zoneToVav := e.getZoneToVavMap()

	if !e.AutoPilot {
		// Suspended: release the optimizer's setbacks so the operator is handed a
		// normally-conditioned building at its occupied baseline, not zones stranded in
		// stale setback. Manual overrides (the human-in-the-loop veto latch) are left
		// untouched — turning off automation must not stomp a human command.
		for _, z := range e.Zones {
			if time.Now().Before(z.OverrideUntil) {
				continue
			}
			z.Setpoint = z.BaseSetpoint
			z.LightsOn = true
		}
		e.zonesInSetback = 0
		e.doHardyCross()
		return
	}
	preCool := time.Now().Before(e.PreCoolUntil)
	// One ambient for the recovery calculation, hoisted out of the zone loop.
	tOutForSetback, _ := e.outdoorNow()
	setback := 0

	// Drivers for the demand-controlled ventilation loop, gathered once. roomConditions()
	// is a whole-building pass; calling it per zone would be O(zones²) on a 735-zone
	// fixture, which is the shape of regression this project has already paid for once.
	condByZone := make(map[string]RoomCondition, len(e.Zones))
	for _, c := range e.roomConditions() {
		condByZone[c.Zone] = c
	}
	// dcvZones is recounted every pass. The avoided-load figure that pairs with it is NOT
	// computed here: it belongs beside the fresh-air load in broadcast(), so the two can
	// never disagree about what headcount they were sized against.
	e.dcvZones = 0

	updatedVavs := make(map[*VavSim]bool, len(e.Vavs))

	for id, z := range e.Zones {
		v := e.findVavForZone(id, zoneToVav)

		if time.Now().Before(z.OverrideUntil) {
			if z.Setpoint > z.BaseSetpoint+0.01 {
				setback++ // a manual veto can itself be a setback; still count it
			}
			continue // Respect the human-in-the-loop manual override latch
		}
		// BelievedVacant, not Occupancy: a presence sensor stuck HIGH would otherwise
		// pin VacantTicks at zero forever and disable setback entirely, silently.
		if z.BelievedVacant(actuateNow) {
			if z.Occupancy > 0 && z.VacantTicks == 0 {
				log.Printf("[presence] zone=%s radar asserts occupancy but CO2 has been "+
					"decaying for %s — treating as vacant for setback", id,
					actuateNow.Sub(z.Presence.Since).Round(time.Minute))
			}
			z.VacantTicks++
		} else {
			z.VacantTicks = 0
		}
		// A critical space is never set back, however empty it looks. A comms room has
		// no occupants by design, so vacancy is not evidence that it may drift — and
		// raising its setpoint does not reduce the heat its equipment makes. The plug
		// sweep has always known this (PlugConfig.CriticalTypes); the setback did not,
		// and on the digitized fixture that disagreement is where the overwhelming
		// majority of credited savings came from. Both now read the same library flag.
		if IsCritical(z.Type) {
			z.Setpoint = z.BaseSetpoint
			z.LightsOn = true
			z.Vent = z.ventDemand(e.dynamics, condByZone[id])
			if v != nil {
				v.TargetDamperPos = MaxDamperPos
				v.TargetPosition = MaxDamperPos
			}
			continue
		}
		vacant := z.BelievedVacant(actuateNow) && z.VacantTicks >= vacancyDelayTicks

		desiredLights := !vacant
		desiredSp := z.BaseSetpoint
		targetDamper := 1.0

		if vacant {
			// Setback depth is asked of the room's own identified physics rather than
			// being the same number everywhere: how far can THIS room drift and still be
			// back at setpoint within the recovery budget once someone returns? A light,
			// responsive room earns a deeper setback (more energy saved); a heavy one that
			// cannot catch up gets a shallower one. Falls back to the conventional fixed
			// figure until the room is identified.
			delta := fixedSetbackC
			if e.dynamics != nil {
				if learned, ok := e.dynamics.SetbackCeiling(id, z.BaseSetpoint, tOutForSetback, setbackRecoverySecs); ok {
					delta = learned
				}
			}
			desiredSp = z.BaseSetpoint + delta
			setback++
			// Vacant zone: throttle damper to minimum ventilation floor to save cooling energy
			targetDamper = MinVentDamperFloor
		} else if preCool {
			// Forecast says a demand peak is coming: run occupied zones slightly cold
			// now (cheap thermal-mass charge) so chillers can shed load at the peak.
			desiredSp = z.BaseSetpoint - preCoolDelta
			tempErr := z.Temp - desiredSp
			targetDamper = math.Max(MinVentDamperFloor, math.Min(MaxDamperPos, 0.6+0.25*tempErr))
		} else {
			// Occupied zone: modulate damper based on thermal error (Temp - Setpoint)
			tempErr := z.Temp - z.Setpoint
			targetDamper = math.Max(MinVentDamperFloor, math.Min(MaxDamperPos, 0.5+0.25*tempErr))
		}
		z.Setpoint = desiredSp
		z.LightsOn = desiredLights

		// Demand-controlled ventilation. The damper serves two masters -- cooling and fresh
		// air -- and it has to satisfy whichever asks for more, so the two demands are
		// computed separately and combined with max() rather than one overwriting the other.
		//
		// targetDamper above is the thermal demand. vent.Floor is the fresh-air demand, and
		// for a zone with no NDIR sensor it is exactly the fixed MinVentDamperFloor this
		// code used before, so an unmeasured zone behaves identically to before DCV existed.
		thermalDamper := math.Max(MinVentDamperFloor, math.Min(MaxDamperPos, targetDamper))
		vent := z.ventDemand(e.dynamics, condByZone[id])
		z.Vent = vent
		if vent.Measured {
			e.dcvZones++
		}
		targetDamper = math.Max(thermalDamper, vent.Floor)

		if v != nil {
			v.TargetDamperPos = math.Max(MinVentDamperFloor, math.Min(MaxDamperPos, targetDamper))
			v.TargetPosition = v.TargetDamperPos
		}

		lightStr := "OFF"
		if desiredLights {
			lightStr = "ON"
		}
		cmd := fmt.Sprintf("LIGHTS_%s;SETPOINT=%.1f", lightStr, desiredSp)

		// Automatically apply turn_off_ac recommendation if AutoPilot is on and zone is vacant
		if vacant || (z.PirState != nil && !*z.PirState) {
			if z.IrState == nil || *z.IrState != "OFF" {
				cmd = "HVAC_SET:OFF"
				cmd = fmt.Sprintf("LIGHTS_%s;%s", lightStr, cmd)
			}
		}

		if z.DetectedProtocol != "" {
			cmd = fmt.Sprintf("PROTOCOL=%s;%s", z.DetectedProtocol, cmd)
		}

		// Append ;DAMPER=%.2f to MQTT commands
		damperVal := 1.0
		if v != nil {
			maxTravel := MaxDamperSlewRate * dt
			diff := v.TargetDamperPos - v.DamperPos
			if math.Abs(diff) <= maxTravel {
				v.DamperPos = v.TargetDamperPos
			} else if diff > 0 {
				v.DamperPos += maxTravel
			} else {
				v.DamperPos -= maxTravel
			}
			v.DamperPos = math.Max(MinDamperPos, math.Min(MaxDamperPos, v.DamperPos))
			v.Position = v.DamperPos
			v.UpdateResistance()
			damperVal = v.DamperPos
			updatedVavs[v] = true
		}
		cmd = fmt.Sprintf("%s;DAMPER=%.2f", cmd, damperVal)

		if e.lastCmd[id] != cmd {
			e.lastCmd[id] = cmd
			// Only command zones a real device is bound to; sim zones just changed state.
			if z.MqttTopic != "" && e.Publish != nil {
				log.Printf("[actuate] zone=%s occ=%d -> %s", id, z.Occupancy, cmd)
				e.Publish("econ/commands/"+z.MqttTopic, cmd)
			}
		}
	}

	// Update slew rate and resistance for any VAVs not matched directly to a zone loop iteration
	for _, v := range e.Vavs {
		if updatedVavs[v] {
			continue
		}
		if v.DamperPos != v.TargetDamperPos {
			maxTravel := MaxDamperSlewRate * dt
			diff := v.TargetDamperPos - v.DamperPos
			if math.Abs(diff) <= maxTravel {
				v.DamperPos = v.TargetDamperPos
			} else if diff > 0 {
				v.DamperPos += maxTravel
			} else {
				v.DamperPos -= maxTravel
			}
			v.DamperPos = math.Max(MinDamperPos, math.Min(MaxDamperPos, v.DamperPos))
			v.Position = v.DamperPos
			v.UpdateResistance()
		}
	}

	// Dynamic fluid network coupling: solve Hardy Cross
	e.doHardyCross()

	// Enforce static pressure safety ceiling (<= 650 Pa)
	e.enforceStaticPressureSafety()

	e.zonesInSetback = setback
}

// SetAutoPilot toggles the autonomous optimizer. Off suspends actuate() (the operator
// holds control); on resumes occupancy-driven setback on the next tick.
func (e *Engine) SetAutoPilot(on bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.AutoPilot != on {
		log.Printf("[autopilot] %v", on)
	}
	e.AutoPilot = on
}

// Actuate runs the occupancy-driven optimizer step under e.mu.
func (e *Engine) Actuate() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.actuate()
}

// hwStaleAfter bounds how long a measured temperature keeps pinning a zone: past it the
// node is presumed unplugged and the 2R1C model takes back over. Nodes publish every
// 2–5 s, so 20 s tolerates a few dropped messages without flapping.
const hwStaleAfter = 20 * time.Second
