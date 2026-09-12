package simulation

// Forward prediction — what the learned coefficients say a room is about to do.
//
// dynamics.go identifies each room's thermal and CO2 balances; this file evaluates them
// forward. All of it is closed-form arithmetic on a first-order response, so there is no
// integration and no state: equilibrium, the value at a horizon, and the time to cross a
// limit all fall out of the same exponential. SetbackCeiling inverts the thermal one —
// given how long recovery may take, how far may the setpoint move.

import "math"

// ThermalOutlook is the learned forward prediction for one room: where it settles under
// the drivers it has right now, where it will be at the horizon, and how long until it
// crosses a limit. All of it is closed-form arithmetic on the learned coefficients.
type ThermalOutlook struct {
	Ok          bool
	Equilibrium float64 // °C the room trends to if nothing changes (clamped to physical range)
	Predicted   float64 // °C at the requested horizon (clamped)
	TauMin      float64 // effective time constant under the current flow, minutes
	SecsToLimit float64 // seconds until it crosses limit; <0 = it never does
	Samples     int
	// Extrapolated marks an equilibrium that sits outside anything this room has been
	// observed doing. A linear fit has no idea it is being asked to extrapolate: hold a
	// busy room at 15% airflow forever and the arithmetic will happily promise 50°C. The
	// crossing TIME stays trustworthy in that situation (it depends on the early part of
	// the curve, which is inside the identified regime) but the asymptote does not, so the
	// caller must present it as a direction of travel rather than a number.
	Extrapolated bool
}

const (
	// The physical range the engine's own integration clamps to (engine.go tick). A
	// prediction has no business claiming anything outside the band the twin can represent.
	physMinC = 5.0
	physMaxC = 50.0
	// credibleMaxC is where a predicted settling point stops being a forecast and starts
	// being an extrapolation artefact worth labelling as one.
	credibleMaxC = 45.0
)

func clampC(v float64) float64 { return math.Max(physMinC, math.Min(physMaxC, v)) }

// ThermalOutlookFor integrates the learned first-order response forward in closed form.
//
// With the drivers held constant the balance is dT/dt = k·(T_eq − T), where the effective
// rate k = θ0 − θ1·flow (positive: envelope coupling plus the cooling the VAV is
// delivering), so T(t) = T_eq + (T0 − T_eq)·e^(−k·t) exactly.
func (d *Dynamics) ThermalOutlookFor(c RoomCondition, limit, horizonSec float64) ThermalOutlook {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.thermalOutlookLocked(c, limit, horizonSec)
}

// thermalOutlookLocked is the same computation with d.mu already held, so a pass over
// every room takes the lock once rather than once per room. Caller must hold d.mu.
func (d *Dynamics) thermalOutlookLocked(c RoomCondition, limit, horizonSec float64) ThermalOutlook {
	zd := d.rooms[c.Zone]
	if !zd.thermalUsable() {
		return ThermalOutlook{}
	}
	th := zd.Thermal.Theta
	env, cool, occ, base := th[0], th[1], th[2], th[3]

	// k in per-hour units; positive because env > 0 and cool < 0.
	k := env - cool*c.FlowRatio
	if k <= 1e-6 {
		return ThermalOutlook{}
	}
	// Solving 0 = env·(T_out − T) + cool·flow·(T − T_supply) + occ·people + base for T.
	eq := (env*c.OutdoorC - cool*c.FlowRatio*c.supplyC() + occ*float64(c.Occupancy) + base) / k
	if math.IsNaN(eq) || math.IsInf(eq, 0) {
		return ThermalOutlook{}
	}

	hHours := horizonSec / 3600.0
	predicted := eq + (c.Temp-eq)*math.Exp(-k*hHours)

	out := ThermalOutlook{
		Ok:           true,
		Equilibrium:  clampC(eq),
		Predicted:    clampC(predicted),
		TauMin:       60.0 / k,
		SecsToLimit:  -1,
		Samples:      zd.Thermal.N,
		Extrapolated: eq > credibleMaxC || eq < physMinC,
	}

	// Time to cross the limit, if it ever does. Only meaningful when the room is heading
	// toward the limit from the safe side and its equilibrium actually lies beyond it.
	if eq > limit && c.Temp < limit {
		ratio := (limit - eq) / (c.Temp - eq) // both negative → positive, < 1
		if ratio > 0 && ratio < 1 {
			out.SecsToLimit = -math.Log(ratio) / k * 3600.0
		}
	}
	return out
}

// Co2Outlook is the learned ventilation prediction for one room.
type Co2Outlook struct {
	Ok          bool
	Equilibrium float64 // ppm the room settles at under its current occupancy (clamped)
	Predicted   float64 // ppm at the requested horizon (clamped)
	AchPerHour  float64 // learned air-change rate
	SecsToLimit float64 // seconds until it crosses limit; <0 = it never does
	Samples     int
	// Extrapolated: same caveat as the thermal outlook. A very low identified ACH divided
	// into a large occupancy load produces an arithmetically valid but operationally
	// meaningless asymptote, so it is labelled rather than quoted as fact.
	Extrapolated bool
}

const (
	// co2CredibleMax is roughly the worst a real occupied room reaches; beyond this the
	// balance is extrapolating rather than forecasting.
	co2CredibleMax = 5000.0
	co2PhysMax     = 40000.0
)

func clampPpm(v float64) float64 {
	return math.Max(outdoorCo2Ppm, math.Min(co2PhysMax, v))
}

// Co2OutlookFor is the same closed-form integration for the mass balance:
// dC/dt = φ1·(C_out − C) + (φ0·people + φ2), which settles at
// C_eq = C_out + (φ0·people + φ2)/φ1 and approaches it at rate φ1.
func (d *Dynamics) Co2OutlookFor(c RoomCondition, limit, horizonSec float64) Co2Outlook {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.co2OutlookLocked(c, limit, horizonSec)
}

// co2OutlookLocked is the lock-held variant, for whole-building passes. Caller holds d.mu.
func (d *Dynamics) co2OutlookLocked(c RoomCondition, limit, horizonSec float64) Co2Outlook {
	zd := d.rooms[c.Zone]
	if !zd.co2Usable() {
		return Co2Outlook{}
	}
	ph := zd.Co2.Theta
	gen, ach, base := ph[0], ph[1], ph[2]

	eq := outdoorCo2Ppm + (gen*float64(c.Occupancy)+base)/ach
	if math.IsNaN(eq) || math.IsInf(eq, 0) {
		return Co2Outlook{}
	}
	hHours := horizonSec / 3600.0
	predicted := eq + (c.Co2-eq)*math.Exp(-ach*hHours)

	out := Co2Outlook{
		Ok: true, Equilibrium: clampPpm(eq), Predicted: clampPpm(predicted),
		AchPerHour: ach, SecsToLimit: -1, Samples: zd.Co2.N,
		Extrapolated: eq > co2CredibleMax,
	}
	if eq > limit && c.Co2 < limit {
		ratio := (limit - eq) / (c.Co2 - eq)
		if ratio > 0 && ratio < 1 {
			out.SecsToLimit = -math.Log(ratio) / ach * 3600.0
		}
	}
	return out
}

// --- learned setback depth ---------------------------------------------------

const (
	// setbackMinC / setbackMaxC bound what the learned answer may recommend. The floor
	// keeps a setback worth having; the ceiling stops an unrealistically fast-recovering
	// fit from parking a room somewhere a returning occupant would notice on the way back.
	setbackMinC = 1.5
	setbackMaxC = 6.0
	// setbackSafetyC is held back from the theoretical maximum. The recovery calculation
	// assumes the room gets full flow the moment it is called for, which a shared AHU
	// under morning load does not always deliver.
	setbackSafetyC = 0.5
)

// SetbackCeiling answers, for one room: how far above its occupied setpoint can this room
// be parked while vacant, and still be back at setpoint within recoverSec once someone
// returns?
//
// This replaces a fixed "+4 °C for every zone", which is the same category of mistake the
// baselines replaced — a number that is simultaneously too timid for a light, responsive
// room and too aggressive for a heavy one that cannot recover before the floor fills up.
// The room's own identified response answers it directly. Recovery at full cooling obeys
// T(t) = T_eq + (T_sb − T_eq)·e^(−k·t) with k = θ₀ − θ₁ (full flow), so the deepest
// recoverable start point is T_sb = T_eq + (setpoint − T_eq)·e^(k·t_recover).
//
// ok is false when the room has no trusted model or cannot reach setpoint at all, and the
// caller keeps its conventional fixed setback — the same discipline as everywhere else
// here: act on the learned value only when there genuinely is one.
func (d *Dynamics) SetbackCeiling(zone string, setpoint, outdoorC float64, recoverSec float64) (deltaC float64, ok bool) {
	if recoverSec <= 0 || setpoint <= 0 {
		return 0, false
	}
	d.mu.Lock()
	defer d.mu.Unlock()

	zd := d.rooms[zone]
	if !zd.thermalUsable() {
		return 0, false
	}
	th := zd.Thermal.Theta
	env, cool, occ, base := th[0], th[1], th[2], th[3]

	// Recovery is evaluated at FULL flow and with the room empty — the conditions that
	// actually apply while it is being brought back before occupants arrive.
	k := env - cool*1.0
	if k <= 1e-6 {
		return 0, false
	}
	eqFull := (env*outdoorC - cool*1.0*Phys().SupplyAirDesignC + occ*0 + base) / k
	// A room that cannot get below its own setpoint even at full cooling has no recovery
	// margin to spend; setting it back at all risks never catching up.
	if eqFull >= setpoint-0.1 {
		return 0, false
	}

	hours := recoverSec / 3600.0
	tSb := eqFull + (setpoint-eqFull)*math.Exp(k*hours)
	delta := tSb - setpoint - setbackSafetyC
	if math.IsNaN(delta) || math.IsInf(delta, 0) {
		return 0, false
	}
	if delta < setbackMinC {
		// The room is too sluggish to recover from a worthwhile setback in the budget.
		// Reporting the floor is wrong here — say so and let the caller decide.
		return setbackMinC, true
	}
	if delta > setbackMaxC {
		delta = setbackMaxC
	}
	return delta, true
}
