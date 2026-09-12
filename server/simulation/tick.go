// tick — the simulation loop and the 2R1C integration.
//
// Split out of engine.go, which had grown to 3,541 lines. Same package, same code:
// nothing here was rewritten, only moved to a file named after what it does.

package simulation

import (
	"math"
	"strings"
	"time"
)

func (e *Engine) Start() {
	ticker := time.NewTicker(33 * time.Millisecond) // ~30 FPS

	for range ticker.C {
		dt := 0.033
		e.mu.Lock()
		if e.Scenario == "fault" {
			dt = 0.3 // Accelerate heating
		} else if e.Scenario == "remediating" {
			dt = 0.6 // Super-accelerate cooling
		} else {
			// Peak Load Scenario: If the building is out of equilibrium (e.g. after a fault),
			// dynamically accelerate time so the user can watch it physically recover back
			// to stable green states quickly, without getting stuck in a thermal limbo!
			maxDev := 0.0
			for _, z := range e.Zones {
				if z.hwFresh() {
					continue // pinned to a live sensor: deviation is reality, not "recovering"
				}
				// Compare against the zone's OWN target. Guessing it from the zone type
				// meant a room whose setpoint differed from the guess read as
				// permanently "recovering" and held the whole building in accelerated
				// time — which also detached the learned models' hour-of-day buckets
				// from real hours.
				sp := z.BaseSetpoint
				if sp == 0 {
					sp = 24.0
				}
				if dev := math.Abs(z.Temp - sp); dev > maxDev {
					maxDev = dev
				}
			}
			if maxDev > 1.0 {
				dt = 2.0 // 60x speed recovery!
			}
		}
		// Physics + optimizer + hardware pinning run as ONE critical section: the MQTT
		// ingestion and HTTP snapshot goroutines mutate/read the same zone state under
		// e.mu, so integrating outside the lock (as before) was a data race.
		e.tick(dt)
		// Advance the simulation clock in step with the physics — the time base the
		// learned room dynamics are identified on (dynamics.go).
		e.simClock += dt

		// Occupancy-driven optimizer + edge actuation (publishes only on state change).
		e.actuateWithDt(dt)
		e.applyHardware()

		// Who is in each room, on the library's diurnal schedule. Runs before the plug
		// sweep and the optimizer read it, so a room that has just emptied is seen as
		// empty on the same tick rather than one behind.
		e.applyOccupancySchedule(time.Now())

		// After-hours plug sweep (APLC): shed/restore switchable sockets on verified
		// vacancy, accumulate avoided energy on wall-clock time.
		e.plugTick(time.Now())

		// One forecaster timestep every histInterval: the LSTM's input window is a
		// real sampled hour, not a photocopied instant.
		e.sampleHistory(time.Now())

		// BESS dispatch: TOU-driven charge/discharge against the last computed building load,
		// integrated on real wall-clock time so the state of charge trends realistically.
		//
		// An undeclared pack is sized to this building first, from the peak it has actually
		// been observed at — the same rule the fan follows. A site that declared its own
		// nameplate is untouched by this.
		// An UNDECLARED pack is a modelled asset, and a modelled asset must not run in
		// real mode. The nameplate SizeToBuilding invents is a reasonable guess for a
		// simulation and a fabrication on a live site: it made the dashboard report a
		// state of charge, and grid power net of a discharge, for a battery nobody had
		// installed — a modelled number travelling on a channel that reads as measured.
		// A DECLARED pack (BESS_POWER_MW / BESS_CAPACITY_MWH) is a real asset the
		// operator has stated, so it keeps dispatching in both modes.
		now := time.Now()
		// e.mode read directly, NOT via IsRealMode(): this runs inside the e.mu critical
		// section above and sync.Mutex is not reentrant, so the accessor would deadlock
		// the tick loop on its first pass.
		if e.mode != ModeReal || e.Bess.Declared {
			if _, peakMw, n := e.observedLoadRange(); n > 0 {
				e.Bess.SizeToBuilding(peakMw)
			}
			e.Bess.Dispatch(now.Sub(e.lastBessAt).Seconds(), e.lastLoadMw, TouBand(now))
		} else {
			// Report the absence rather than the last simulated value.
			e.Bess.Enabled = false
			e.Bess.DischargeMw = 0
		}
		e.lastBessAt = now
		e.mu.Unlock()

		e.broadcast()
	}
}

// tick integrates one thermal step. Called only from Start's loop with e.mu held.
func (e *Engine) tick(dt float64) {
	// One ambient for the whole building per step: live weather when the poller has a
	// fresh reading, the HCMC climatological diurnal curve otherwise. Hoisted out of the
	// VAV loop — 891 zones share one sky.
	tOutside, _ := e.outdoorNow()
	tDerivedSupply := e.calculateDynamicSupplyAir(tOutside)

	// Build map from TargetZone to *VavSim
	zoneToVav := make(map[string]*VavSim, len(e.Vavs))
	for _, v := range e.Vavs {
		if v.TargetZone != "" {
			zoneToVav[v.TargetZone] = v
		}
	}

	// Presence fusion, before the physics: radar says a body is there, CO2 says whether it
	// is breathing. Wall-clock, not sim time -- respiration does not accelerate with dt.
	// Only zones bound to a real node participate; a simulated zone has nothing to fuse.
	{
		now := time.Now()
		for _, z := range e.Zones {
			// hwFresh(), not Live. Live is sticky -- it means "real occupancy has been seen
			// at some point" and never goes false -- so gating on it fed the fusion a frozen
			// Occupancy value for as long as a dead node stayed dead, and it went on
			// reporting a presence state derived from telemetry that stopped arriving.
			if z.MqttTopic == "" || !z.Live || !z.hwFresh() {
				continue
			}
			if z.Presence == nil {
				z.Presence = &PresenceFusion{}
			}
			z.Presence.Update(now, z.Occupancy > 0, z.HwCo2, z.co2Fresh(), z.HwCo2At)
		}
	}

	// Thermodynamics & Mass Balance across ALL zones
	for id, z := range e.Zones {
		// Match VAV: targetZone mapping -> exact id -> "vav-" prefix -> trim "zone-" prefix
		v := zoneToVav[id]
		if v == nil {
			v = e.Vavs[id]
		}
		if v == nil {
			v = e.Vavs["vav-"+id]
		}
		if v == nil {
			trimmed := strings.TrimPrefix(id, "zone-")
			v = e.Vavs["vav-"+trimmed]
		}

		// Nominal (non-fault) internal load: base equipment + people + solar. Solar comes
		// from the zone's own aperture and, where a BH1750 reports, the daylight actually
		// arriving rather than the library's reference level (solarGainW).
		qSolar := z.solarGainW()
		qInternalNominal := z.BaseHeatGain + (float64(z.Occupancy) * 100.0) + qSolar

		qInternal := qInternalNominal
		if e.Scenario == "fault" && (id == e.FaultTarget || (v != nil && v.TargetZone == e.FaultTarget)) {
			qInternal *= 5.0 // Thermal runaway strictly on selected fault target
		}

		sp := z.Setpoint
		if sp == 0 {
			sp = 24.0
		}

		if z.WallTemp <= 0 {
			z.WallTemp = z.Temp
		}
		rIn := z.RIn
		if rIn <= 0 {
			rIn = 0.001
		}
		rOut := z.ROut
		if rOut <= 0 {
			rOut = 0.0011
		}
		cAir := z.CAir
		if cAir <= 0 {
			cAir = 5e5
		}
		cAir = math.Max(cAir, Phys().MinZoneCapacitanceJPerK)
		cWall := z.CWall
		if cWall <= 0 {
			cWall = 4e6
		}

		// Size cooling so that at the VAV's NOMINAL flow the room holds setpoint:
		// qCooling(Temp=sp, flow=nominal) must offset the full nominal internal
		// load plus steady-state wall conduction. Normalizing by the VAV's own
		// nominal flow (not a hard-coded 5.4 m3/s) keeps this correct no matter
		// how many VAVs share the AHU.
		qSteadyStateWall := (tOutside - sp) / (rIn + rOut)
		qNominalTotal := qInternalNominal + qSteadyStateWall

		var flowRatio float64
		var ventRate float64
		if v != nil {
			nominalFlow := v.NominalFlow
			if nominalFlow < 1e-6 {
				nominalFlow = v.Flow
			}
			if nominalFlow < 1e-6 {
				nominalFlow = 1.0
			}
			flowRatio = v.Flow / nominalFlow
			ventRate = math.Max(0.001, v.Flow)
		} else {
			flowRatio = 0.0
			ventRate = math.Max(0.001, z.AreaM2*0.001)
		}

		// Discharge temperature: a DS18B20 in the louvre when one is reporting, the
		// dynamic coil heat-exchange derived value otherwise.
		tSupply := z.supplyCWithDefault(sp, tDerivedSupply)

		qCooling := flowRatio * qNominalTotal * ((z.Temp - tSupply) / (sp - tSupply))
		if qCooling < 0 {
			qCooling = 0
		} // Cannot heat with cold air

		// Inter-zone partition conductive heat transfer
		qInterzone := 0.0
		for _, adjId := range z.AdjacentZones {
			if adjZ, ok := e.Zones[adjId]; ok {
				adjRIn := math.Max(adjZ.RIn, 0.0001)
				rPart := math.Max(0.001, (rIn+adjRIn)*2.0)
				qInterzone += (adjZ.Temp - z.Temp) / rPart
			}
		}

		dTAirDt := ((z.WallTemp-z.Temp)/(rIn*cAir) + (qInternal+qInterzone-qCooling)/cAir)
		dTWallDt := ((tOutside-z.WallTemp)/(rOut*cWall) - (z.WallTemp-z.Temp)/(rIn*cWall))

		z.Temp += dTAirDt * dt
		z.WallTemp += dTWallDt * dt

		// Clamp to physically plausible bounds. Guards against numerical runaway when a
		// (possibly mis-digitized) zone pairs a tiny CAir with a large heat load — without
		// this, such a zone integrates to absurd temperatures (e.g. 200+°C) instead of
		// just reading "hot / cooling-starved" like a real failing room.
		z.Temp = math.Max(5.0, math.Min(50.0, z.Temp))
		z.WallTemp = math.Max(5.0, math.Min(50.0, z.WallTemp))

		// Dynamic CO2 mass balance estimation (when NDIR sensor is omitted)
		if z.Co2Sim == 0 {
			z.Co2Sim = Phys().OutdoorCo2Ppm
		}
		roomVol := math.Max(10.0, z.AreaM2*3.0)
		// Mass balance: dC/dt = (ventRate/V) * (C_out - C) + (G_occ * N_occ) / V
		// G_occ = 5.0 ppm*m3/s per occupant (18 L/h/person)
		dCo2Dt := (ventRate/roomVol)*(Phys().OutdoorCo2Ppm-z.Co2Sim) + (5.0*float64(z.Occupancy))/roomVol
		z.Co2Sim += dCo2Dt * dt
		z.Co2Sim = math.Max(350.0, math.Min(5000.0, z.Co2Sim))

		// Physics-grounded AFDD: integrate the sensor-free shadow twin with the
		// same 2R1C dynamics and cooling law, but never pulled toward the hardware
		// measurement (applyHardware skips it). Divergence between the measured
		// room and this twin is the fault signal.
		if z.ShadowTemp != 0 {
			qCoolShadow := flowRatio * qNominalTotal * ((z.ShadowTemp - tSupply) / (sp - tSupply))
			if qCoolShadow < 0 {
				qCoolShadow = 0
			}
			dShadowDt := ((z.WallTemp-z.ShadowTemp)/(rIn*cAir) + (qInternal+qInterzone-qCoolShadow)/cAir)
			z.ShadowTemp += dShadowDt * dt
			z.ShadowTemp = math.Max(5.0, math.Min(50.0, z.ShadowTemp))
		}
	}
}

// currentAvg computes the building-average room temperature and airflow fraction —
// one forecaster timestep. Airflow is normalized to each VAV's nominal flow so it
// matches the model's training scale (raw m³/s would be far out of distribution).
// Hardware-pinned zone temperatures are naturally included: z.Temp IS the measured
// value while a sensor is fresh. Lock held.
func (e *Engine) currentAvg() histSample {
	tempSum := 0.0
	for _, z := range e.Zones {
		tempSum += z.Temp
	}
	flowSum := 0.0
	for _, v := range e.Vavs {
		frac := 0.0
		if v.NominalFlow > 1e-6 {
			frac = v.Flow / v.NominalFlow
		}
		flowSum += math.Max(0, math.Min(1, frac))
	}
	s := histSample{temp: 24.0, flow: 0.5}
	if len(e.Zones) > 0 {
		s.temp = tempSum / float64(len(e.Zones))
	}
	if len(e.Vavs) > 0 {
		s.flow = flowSum / float64(len(e.Vavs))
	}
	return s
}

// sampleHistory appends one timestep to the forecaster's rolling window every
// histInterval. Called from Start's loop with e.mu held; the first tick seeds the
// buffer immediately so a fresh boot has at least one real sample.
func (e *Engine) sampleHistory(now time.Time) {
	if !e.lastHistAt.IsZero() && now.Sub(e.lastHistAt) < histInterval {
		return
	}
	e.lastHistAt = now
	e.histBuf = append(e.histBuf, e.currentAvg())
	if len(e.histBuf) > histKeep {
		e.histBuf = e.histBuf[len(e.histBuf)-histKeep:]
	}
	// The same timestep for the load series the foundation-model forecaster consumes. Only
	// a real computed load is recorded — a zero here would teach the forecaster that the
	// building went dark, so pre-boot ticks are skipped rather than logged as 0 MW.
	if e.lastLoadMw > 0 {
		e.loadHist = append(e.loadHist, e.lastLoadMw)
		if len(e.loadHist) > loadHistKeep {
			e.loadHist = e.loadHist[len(e.loadHist)-loadHistKeep:]
		}
	}
}
