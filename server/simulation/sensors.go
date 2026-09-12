// sensors — per-sensor freshness, outdoor conditions, supply air, solar gain.
//
// Split out of engine.go, which had grown to 3,541 lines. Same package, same code:
// nothing here was rewritten, only moved to a file named after what it does.

package simulation

import (
	"math"
	"time"
)

// hwFresh reports whether this zone is currently pinned to a live measured temperature.
func (z *ZoneSim) hwFresh() bool {
	return !z.HwTempAt.IsZero() && time.Since(z.HwTempAt) < hwStaleAfter
}

// OutdoorFallbackAt calculates the climatological diurnal outdoor temperature (°C) and
// relative humidity (%) for Ho Chi Minh City at time t. Replaces static flat fallbacks with
// a realistic diurnal temperature swing (25.0°C to 34.0°C) and relative humidity curve (55% to 95%).
func OutdoorFallbackAt(t time.Time) (tempC, humPct float64) {
	// Evaluate hour in local building timezone (UTC+7 for Ho Chi Minh City)
	locTime := t.In(time.FixedZone("ICT", 7*3600))
	hour := float64(locTime.Hour()) + float64(locTime.Minute())/60.0 + float64(locTime.Second())/3600.0

	// Diurnal temperature curve: T_mean = 29.5°C, Delta_T = 4.5°C
	// Minimum 25.0°C at 03:00, Maximum 34.0°C at 15:00
	phaseRad := 2.0 * math.Pi * (hour - 15.0) / 24.0
	tempC = 29.5 + 4.5*math.Cos(phaseRad)

	// Diurnal relative humidity curve: RH_mean = 75%, Delta_RH = 20%
	// Minimum 55% at 15:00 (peak heat), Maximum 95% at 03:00 (dawn cool)
	humPct = 75.0 - 20.0*math.Cos(phaseRad)
	return tempC, humPct
}

// outdoorFallbackC is the baseline climatological temperature for Ho Chi Minh City.
const outdoorFallbackC = 30.0

// outdoorStaleAfter bounds how long one weather reading may keep driving the envelope.
// Open-Meteo refreshes its current conditions on a sub-hourly cadence and the poller asks
// every 10 minutes, so three missed hours means the feed is genuinely down, not jittery.
const outdoorStaleAfter = 3 * time.Hour

// SetOutdoorTemp ingests one outdoor reading from the weather poller. Humidity may be
// zero when the fetch didn't include it; the forecaster path checks for that.
func (e *Engine) SetOutdoorTemp(c float64) {
	e.SetOutdoor(c, 0)
}

func (e *Engine) SetOutdoor(c, humPct float64) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.outdoorTemp = c
	e.outdoorHum = humPct
	e.outdoorAt = time.Now()
}

// OutdoorForForecast reports the outdoor conditions the forecaster should use, and
// whether they are live enough to hand over. Both readings arrive together from
// Open-Meteo, so one freshness verdict covers them.
func (e *Engine) OutdoorForForecast() (tempC, humPct float64, live bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	t, ok := e.outdoorNow()
	if ok && e.outdoorHum > 0 {
		return t, e.outdoorHum, true
	}
	_, humFallback := OutdoorFallbackAt(time.Now())
	return t, humFallback, false
}

// outdoorNow returns the temperature the envelope should integrate against and whether it
// is live weather. Callers must hold e.mu.
func (e *Engine) outdoorNow() (float64, bool) {
	return e.outdoorNowAt(time.Now())
}

// outdoorNowAt returns outdoor temperature evaluated at timestamp now.
func (e *Engine) outdoorNowAt(now time.Time) (float64, bool) {
	if !e.outdoorAt.IsZero() && now.Sub(e.outdoorAt) < outdoorStaleAfter {
		return e.outdoorTemp, true
	}
	tFallback, _ := OutdoorFallbackAt(now)
	return tFallback, false
}

// OutdoorStatus is the /api/weather snapshot: what the physics is using right now.
func (e *Engine) OutdoorStatus() (tempC float64, live bool, ageSec float64) {
	e.mu.Lock()
	defer e.mu.Unlock()
	t, ok := e.outdoorNow()
	age := -1.0
	if !e.outdoorAt.IsZero() {
		age = time.Since(e.outdoorAt).Seconds()
	}
	return t, ok, age
}

// humFresh / co2Fresh report whether a physical sensor is measuring that quantity right
// now. Both are per-field rather than per-node: one sensor on a shared I2C bus can fail
// while its neighbour keeps reporting, and a stale value presented as measured is exactly
// the fabrication the edge firmware goes out of its way to avoid.
func (z *ZoneSim) humFresh() bool {
	return !z.HwHumAt.IsZero() && time.Since(z.HwHumAt) < hwStaleAfter
}

func (z *ZoneSim) co2Fresh() bool {
	return !z.HwCo2At.IsZero() && time.Since(z.HwCo2At) < hwStaleAfter
}

// The three sensors WIRING.md calls "the ones that replace an assumption with a
// measurement". Each has the same shape: the engine evaluates a term against a coefficient
// from the programme library, and a fresh reading from the corresponding probe displaces
// that coefficient for that zone only. Same per-field freshness rule as everything else —
// a probe that falls out of the louvre stops being believed without taking the node with it.
func (z *ZoneSim) supplyFresh() bool {
	return !z.HwSupplyAt.IsZero() && time.Since(z.HwSupplyAt) < hwStaleAfter
}

func (z *ZoneSim) acFresh() bool {
	return !z.HwAcAt.IsZero() && time.Since(z.HwAcAt) < hwStaleAfter
}

func (z *ZoneSim) luxFresh() bool {
	return !z.HwLuxAt.IsZero() && time.Since(z.HwLuxAt) < hwStaleAfter
}

func (z *ZoneSim) stripFresh() bool {
	return !z.HwStripAt.IsZero() && time.Since(z.HwStripAt) < hwStaleAfter
}

// supplyC is the discharge temperature the cooling law is evaluated against: a DS18B20 in
// the louvre when one is reporting, the library's design value otherwise. The cooling law
// divides by (setpoint − supply), so a probe reading at or above setpoint is rejected as
// implausible rather than allowed to produce a division by ~0 — a sensor that has come
// loose and is reading room air must not be able to blow up the physics.
func (z *ZoneSim) supplyC(setpoint float64) float64 {
	return z.supplyCWithDefault(setpoint, Phys().SupplyAirDesignC)
}

// supplyCWithDefault evaluates discharge temperature against a measured DS18B20 probe if fresh,
// or falls back to the dynamic derived supply temperature.
func (z *ZoneSim) supplyCWithDefault(setpoint, defaultSupply float64) float64 {
	if z.supplyFresh() && z.HwSupplyC > 0 && z.HwSupplyC < setpoint-minSupplyLiftC {
		return z.HwSupplyC
	}
	return math.Min(defaultSupply, setpoint-minSupplyLiftC)
}

// calculateDynamicSupplyAir calculates supply air temperature from mixed-air temperature
// and cooling coil heat exchange balance when DS18B20 supply probe is omitted.
func (e *Engine) calculateDynamicSupplyAir(tOutside float64) float64 {
	design := Phys().SupplyAirDesignC
	if len(e.Zones) == 0 {
		return design
	}

	// 1. Calculate return air temperature (flow-weighted average of zone temperatures)
	returnTempSum := 0.0
	totalWeight := 0.0
	for _, v := range e.Vavs {
		if z, ok := e.Zones[v.TargetZone]; ok {
			w := math.Max(0.01, v.Flow)
			returnTempSum += z.Temp * w
			totalWeight += w
		}
	}
	tReturn := 24.0
	if totalWeight > 0 {
		tReturn = returnTempSum / totalWeight
	} else {
		sum := 0.0
		for _, z := range e.Zones {
			sum += z.Temp
		}
		if len(e.Zones) > 0 {
			tReturn = sum / float64(len(e.Zones))
		}
	}

	// 2. Fresh air fraction (approx 15% fresh air intake in standard AHU mixing box)
	const alphaFresh = 0.15
	tMixed := alphaFresh*tOutside + (1.0-alphaFresh)*tReturn

	// 3. Cooling coil heat exchange (chilled water inlet ~7°C, coil effectiveness ~0.80)
	const (
		tChilledWaterIn   = 7.0
		coilEffectiveness = 0.80
	)
	tSupplyDerived := tMixed - coilEffectiveness*(tMixed-tChilledWaterIn)

	// Clamp to physically realistic bounds [8.0°C, 18.0°C]
	return math.Max(8.0, math.Min(18.0, tSupplyDerived))
}

// solarGainW is the zone's solar heat gain at the current timestamp.
func (z *ZoneSim) solarGainW() float64 {
	return z.solarGainWAt(time.Now())
}

// solarGainWAt calculates dynamic solar heat gain at a specific timestamp.
// When a fresh BH1750 ambient light sensor is reporting and electric lights are OFF,
// it scales the solar gain based on the measured daylight illuminance.
// When the sensor is omitted, stale, or contaminated by electric lighting, it computes
// dynamic solar heat gain based on astronomical solar geometry (Spencer/NOAA algorithm)
// and clear-sky GHI modeling.
func (z *ZoneSim) solarGainWAt(now time.Time) float64 {
	ph := Phys()
	if z.SolarGainMult <= 0 {
		return 0.0
	}

	// 1. Measured path: Fresh, uncontaminated BH1750 lux reading
	if z.luxFresh() && z.HwLux > 0 && !z.LightsOn && ph.DaylightReferenceLux > 0 {
		ratio := z.HwLux / ph.DaylightReferenceLux
		scale := math.Max(0, math.Min(maxDaylightRatio, ratio))
		return z.SolarGainMult * ph.SolarGainReferenceW * scale
	}

	// 2. Dynamic Physics Fallback (Requirement R2):
	// Compute astronomical clear-sky Global Horizontal Irradiance (GHI) based on sun position.
	// At solar midnight GHI is strictly 0.0 W/m²; at solar noon it peaks dynamically based on season.
	ghi := ClearSkyGhi(now)
	irrRatio := ghi / 1000.0
	return z.SolarGainMult * ph.SolarGainReferenceW * irrRatio
}

const (
	// minSupplyLiftC is the smallest (setpoint − supply air) the cooling law will evaluate.
	minSupplyLiftC = 1.0
	// maxDaylightRatio caps how far a measured illuminance may amplify the reference solar
	// gain. A sensor in direct sun reads far above any diffuse reference, and an unbounded
	// multiplier would let one badly-placed probe drive a zone's heat balance on its own.
	maxDaylightRatio = 4.0
)
