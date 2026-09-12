// clients — websocket clients, scenarios and the occupancy schedule.
//
// Split out of engine.go, which had grown to 3,541 lines. Same package, same code:
// nothing here was rewritten, only moved to a file named after what it does.

package simulation

import (
	"math"
	"math/rand/v2"
	"time"

	"github.com/gorilla/websocket"
)

func (e *Engine) AddClient(conn *websocket.Conn) {
	e.mu.Lock()
	e.Clients[conn] = true
	e.mu.Unlock()
}

func (e *Engine) SetScenario(s string) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if len(s) > 6 && s[:6] == "fault:" {
		e.Scenario = "fault"
		e.FaultTarget = s[6:]
	} else {
		e.Scenario = s
	}

	for _, v := range e.Vavs {
		z := e.Zones[v.TargetZone]
		// Modulate VAV
		// Modulation is RELATIVE to the box's design position, so the same step means the
		// same thing whatever the box is sized at.
		errorSignal := z.Temp - z.Setpoint
		if errorSignal > z.Deadband/2 {
			v.Damper -= damperStep // too warm: open up
		} else if errorSignal < -z.Deadband/2 {
			v.Damper += damperStep // too cool: throttle back
		}

		if e.Scenario == "fault" && v.TargetZone == e.FaultTarget {
			v.Damper = damperMax // stuck closed
		} else if e.Scenario == "remediating" && (v.TargetZone == e.FaultTarget || z.Type == "core") {
			v.Damper = damperMin // wide open to the faulting zone and the core
		}

		v.Damper = math.Max(damperMin, math.Min(damperMax, v.Damper))
		v.Resistance = v.DesignResistance * v.Damper
		if v.DesignResistance > 0 && v.Resistance > 0 {
			eff := v.DesignResistance / v.Resistance
			eff = math.Max(0.01, math.Min(1.0, eff))
			v.DamperPos = math.Sqrt(eff)
			v.Position = v.DamperPos
			v.TargetDamperPos = v.DamperPos
			v.TargetPosition = v.DamperPos
		}
	}
	e.doHardyCross()
}

func (e *Engine) RemoveClient(conn *websocket.Conn) {
	e.mu.Lock()
	delete(e.Clients, conn)
	e.mu.Unlock()
	WSForget(conn)
}

// --- occupancy -------------------------------------------------------------
//
// Who is in each room. This is the term the whole optimizer turns on: a zone is set back
// when it is empty, its sockets are swept when it has been empty long enough, its fresh-air
// load is its headcount times the library's litres per second per person, and its
// identified thermal model carries an occupant-gain coefficient that only means anything if
// the count actually moves.
//
// It used to be rand.Intn(10), drawn once per zone at boot. See OccupancySchedule in
// library.go for what that cost. What replaces it is the ordinary engineering model: the
// zone's own digitized floor area over its programme's design occupant density, scaled by a
// diurnal profile, with a small draw-to-draw variation so a learned baseline has a real
// spread to measure against.
//
// Nothing here is a measurement and nothing here pretends to be. A zone bound to a PIR or a
// CV tracker is skipped entirely — z.Live is set the moment real occupancy arrives, and the
// model never writes over it.

// scheduledOccupancy is the modelled headcount for a zone of this programme and area at
// this moment, including the library's draw-to-draw variation.
func scheduledOccupancy(zoneType string, areaM2 float64, at time.Time) int {
	design := DesignOccupancy(zoneType, areaM2)
	if design <= 0 {
		return 0
	}
	frac := OccupancyFractionAt(zoneType, at.In(vnLoc).Hour())
	if frac <= 0 {
		return 0
	}
	mean := float64(design) * frac
	// Vary the draw around the scheduled mean. Without this every day is identical and
	// the learned baseline's standard deviation collapses toward zero, which turns the
	// first genuine change into an anomaly of unbounded sigma.
	if j := Occupancy().JitterFraction; j > 0 {
		mean += getNoise(mean * j)
	}
	n := int(math.Round(mean))
	if n < 0 {
		n = 0
	}
	// The schedule says a fraction of the design count is present; it cannot conjure more
	// people than the room is designed to hold.
	if n > design {
		n = design
	}
	return n
}

// applyOccupancySchedule refreshes every modelled zone's headcount. Lock held.
//
// The count is redrawn on the library's cadence rather than every tick: at 30 fps a fresh
// draw each frame would be pure noise, and both the vacancy delay before a setback and the
// identification's excitation gate need the count to hold still long enough to mean
// something.
func (e *Engine) applyOccupancySchedule(now time.Time) {
	every := Occupancy().ResampleMinutes
	if every <= 0 {
		every = 20
	}
	if !e.lastOccupancyAt.IsZero() && now.Sub(e.lastOccupancyAt) < time.Duration(every*float64(time.Minute)) {
		return
	}
	e.lastOccupancyAt = now
	for _, z := range e.Zones {
		// A real sensor owns this zone's occupancy; the model must never overwrite a
		// measurement (rule 1).
		if z.Live {
			continue
		}
		z.Occupancy = scheduledOccupancy(z.Type, z.AreaM2, now)
	}
}

func getNoise(std float64) float64 {
	u, v := 0.0, 0.0
	for u == 0 {
		u = rand.Float64()
	}
	for v == 0 {
		v = rand.Float64()
	}
	return math.Sqrt(-2.0*math.Log(u)) * math.Cos(2.0*math.Pi*v) * std
}
