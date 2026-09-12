// plant — plant efficiency, CO2 balance, hardware binding, pre-cool.
//
// Split out of engine.go, which had grown to 3,541 lines. Same package, same code:
// nothing here was rewritten, only moved to a file named after what it does.

package simulation

import (
	"math"
	"time"
)

// CalculateThermodynamicCop computes the chiller plant Coefficient of Performance (COP)
// dynamically from thermodynamic temperature lift (T_condenser - T_evaporator), Carnot limit,
// Part-Load Ratio (PLR), and thermal strain when AC power current clamp (HwAcW) is omitted.
func CalculateThermodynamicCop(tOutdoorC, tSupplyC, thermalLoadW, condFloorM2, avgStrain float64) float64 {
	ph := Phys()

	// Approach temperatures (condenser and evaporator heat exchangers)
	const (
		condenserApproachK  = 5.0  // T_condenser = T_outdoor + 5 K
		evaporatorApproachK = 3.0  // T_evaporator = T_supply - 3 K
		secondLawEta        = 0.35 // Chiller second-law / exergetic efficiency
	)

	tCondC := tOutdoorC + condenserApproachK
	tEvapC := tSupplyC - evaporatorApproachK

	tCondK := tCondC + 273.15
	tEvapK := tEvapC + 273.15

	liftK := math.Max(2.0, tCondK-tEvapK)
	copCarnot := tEvapK / liftK

	// Part-load ratio (PLR) based on nominal building cooling design capacity (~120 W/m²)
	designCapacityW := math.Max(10000.0, condFloorM2*120.0)
	plr := math.Max(0.1, math.Min(1.2, thermalLoadW/designCapacityW))

	// Gordon-Ng / empirical part-load modifier curve
	fPlr := 0.15 + 1.25*plr - 0.40*plr*plr

	// Strain degradation factor
	strainFactor := math.Max(0.70, 1.0-0.05*avgStrain)

	// Thermodynamic COP
	cop := secondLawEta * copCarnot * fPlr * strainFactor
	return math.Max(ph.CopMin, math.Min(ph.CopMax, cop))
}

// avgCo2 is the building CO2 figure, and it prefers reality: the average of whatever
// fresh NDIR sensors are actually reporting, falling back to dynamic simulated mass balance
// when sensors are missing.
func (e *Engine) avgCo2(totalOccupants int) float64 {
	var sum float64
	var n int
	for _, z := range e.Zones {
		if z.HwCo2 > 0 && z.co2Fresh() {
			sum += z.HwCo2
			n++
		}
	}
	if n > 0 {
		return sum / float64(n)
	}

	// Physics-based dynamic mass balance fallback across simulated zones:
	var simSum float64
	var simCount int
	for _, z := range e.Zones {
		if z.Co2Sim > 0 {
			simSum += z.Co2Sim
			simCount++
		}
	}
	if simCount > 0 {
		return simSum / float64(simCount)
	}

	ph := Phys()
	if len(e.Zones) == 0 {
		return ph.OutdoorCo2Ppm
	}
	return ph.OutdoorCo2Ppm + ph.Co2PpmPerOccupantSteady*float64(totalOccupants)/float64(len(e.Zones))
}

// applyHardware pulls every hardware-bound zone's air temperature toward the physical
// sensor reading — a fast exponential blend (~1 s at 30 FPS) rather than a hard jump,
// so the dashboard never teleports. The thermal model keeps integrating underneath and
// resumes control the moment telemetry goes stale, so unplugging a node degrades
// gracefully back to simulation. Lock held.
func (e *Engine) applyHardware() {
	for _, z := range e.Zones {
		if !z.hwFresh() {
			continue
		}
		z.Temp += (z.HwTemp - z.Temp) * 0.1
		// AFDD residual: how far the measured room has drifted from the sensor-free
		// shadow model. Slow EMA (~2 s time constant at 30 FPS) rejects sensor noise
		// while still catching real faults in well under a minute.
		if z.ShadowTemp != 0 {
			r := math.Abs(z.HwTemp - z.ShadowTemp)
			z.ResidualEma += (r - z.ResidualEma) * 0.02
		}
	}
}

// SetNodeStatus records the broker's Last-Will verdict for an edge node
// (econ/status/<topic> -> "online"/"offline"). An offline node stops pinning its zone
// immediately instead of waiting out the staleness window. Any transition also clears
// the zone's command-dedupe entry: a node that reboots comes back in its firmware
// default state, so the optimizer must re-send the current command even if it is
// unchanged from the engine's point of view.
func (e *Engine) SetNodeStatus(topicSuffix string, online bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for id, z := range e.Zones {
		if z.MqttTopic != topicSuffix {
			continue
		}
		z.HwOnline = online
		delete(e.lastCmd, id)
		if !online {
			// The node is gone, so every sensor hanging off it is gone with it.
			z.HwTempAt = time.Time{}
			z.HwHumAt = time.Time{}
			z.HwCo2At = time.Time{}
			z.HwPlugAt = time.Time{}
			z.HwStripAt = time.Time{}
			z.DetectedProtocol = ""
		}
	}
}

// StartPreCool opens (or extends) a pre-cooling window: for its duration the optimizer
// drives every occupied zone preCoolDelta below its base setpoint, charging the
// building's thermal mass ahead of a forecast demand peak. Called by the LSTM poller
// (precool.go) and by the dashboard's "pre-cool" action. Returns when the window ends.
func (e *Engine) StartPreCool(d time.Duration) time.Time {
	e.mu.Lock()
	defer e.mu.Unlock()
	if until := time.Now().Add(d); until.After(e.PreCoolUntil) {
		e.PreCoolUntil = until
	}
	return e.PreCoolUntil
}

// PreCoolStatus reports whether a pre-cool window is active and when it ends.
func (e *Engine) PreCoolStatus() (bool, time.Time) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return time.Now().Before(e.PreCoolUntil), e.PreCoolUntil
}
