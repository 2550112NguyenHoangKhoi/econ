// broadcast — the flatbuffer frame the dashboard receives.
//
// Split out of engine.go, which had grown to 3,541 lines. Same package, same code:
// nothing here was rewritten, only moved to a file named after what it does.

package simulation

import (
	"econ/schema/Telemetry"
	"log"
	"math"
	"time"

	flatbuffers "github.com/google/flatbuffers/go"
	"github.com/gorilla/websocket"
)

func (e *Engine) broadcast() {
	// Metrics + serialization read (and update LastBroadcast*) zone state, so they
	// run under the lock; the websocket writes below happen outside it.
	e.mu.Lock()
	ph := Phys()
	// ---- Live global metrics (all derived from current zone state) ----
	totalHeatW := 0.0 // total thermal load the plant must remove (W)
	totalOccupants := 0
	comfortSum := 0.0     // Σ per-zone thermal-comfort score (report §4.5 discomfort model)
	strainSum := 0.0      // sum of how far zones sit above setpoint (drives plant COP)
	savedLightingW := 0.0 // lighting cut on vacant (set-back) zones
	savedThermalW := 0.0  // cooling demand avoided on vacant (set-back) zones
	alarmCount := 0       // zones far enough past the band to be a genuine alarm
	plugTotalW := 0.0     // live plug draw (measured where clamped, modelled otherwise)
	// Outdoor air is what a setback actually saves against — no lift, no saving.
	tOutside, _ := e.outdoorNow()
	ventW := 0.0        // fresh-air load, the dominant cooling term in a tropical office
	condFloorM2 := 0.0  // conditioned floor area, for the area-scaled electrical baseline
	plugStandbyW := 0.0 // the always-on phantom portion of plugTotalW
	plugShedW := 0.0    // switchable watts currently swept off by the APLC
	// Air-conditioner power measured by a real clamp, and the thermal load / occupancy of
	// the zones it covers. Zero unless an SCT-013 is fitted, in which case that slice of
	// the building's cooling electrical stops being inferred from a COP curve.
	meteredAcW := 0.0
	meteredHeatW := 0.0
	meteredOccupants := 0
	// Half-comfort point: a zone this many °C *beyond* its deadband scores 0.5 comfort.
	const sigmaComfort2 = 2.5 * 2.5
	// °C past the deadband before a zone is "critical". Matches the dashboard's own
	// CRITICAL_MARGIN so the health number and the red banner never disagree.
	const criticalMargin = 5.0
	for id, z := range e.Zones {
		qSolar := z.solarGainW()
		qi := z.BaseHeatGain + float64(z.Occupancy)*100.0 + qSolar
		if e.Scenario == "fault" && id == e.FaultTarget {
			qi *= 5.0
		}
		totalHeatW += qi
		totalOccupants += z.Occupancy
		condFloorM2 += z.AreaM2
		// A zone with a live AC clamp reports the electrical power its air conditioner is
		// actually drawing. Its thermal load and occupancy are tracked alongside so the
		// modelled COP can be lifted off exactly the portion of the building that is
		// measured, and so the achieved COP can be computed as evidence.
		if z.acFresh() && z.HwAcW > 0 {
			meteredAcW += z.HwAcW
			meteredHeatW += qi
			meteredOccupants += z.Occupancy
		}
		sp := z.Setpoint
		if sp == 0 {
			sp = 24.0
		}
		strainSum += math.Max(0, z.Temp-sp)
		// Report §4.5 thermal-discomfort term — excess beyond the deadband penalized
		// quadratically (max(0,|T-Tset|-δ))² — mapped to a bounded [0,1] comfort score.
		// This grades health by *severity* (a 0.1°C overshoot ≈ healthy; a runaway ≈ 0)
		// instead of the old binary in-band / out-of-band flag.
		excess := math.Max(0, math.Abs(z.Temp-sp)-z.Deadband)
		comfortSum += 1.0 / (1.0 + (excess*excess)/sigmaComfort2)
		// A zone this far past its deadband is an alarm, not a drift — counted so health
		// below can charge for it (see the averaging problem there).
		if z.Temp > sp+z.Deadband+criticalMargin {
			alarmCount++
		}
		// Occupancy-driven savings. Two rules, both of which used to be wrong:
		//
		// Lighting: credited only for the zone's OWN installed lighting density, read
		// from the programme library rather than assumed to be office lighting. A plant
		// room and an open-plan floor do not have the same luminaires, and crediting
		// them alike is how a store cupboard came to look like a saving.
		//
		// Cooling: the avoided cooling of a setback is NOT a fixed fraction of the
		// zone's internal gain — that old `BaseHeatGain * 0.25` credited a room for
		// equipment that goes on running whether or not the thermostat moved. What a
		// setback actually avoids is the envelope and ventilation load that the zone no
		// longer has to hold down: raising the setpoint by ΔT cuts conduction against
		// outdoor air in proportion to ΔT over the original lift. That is a smaller,
		// defensible number, and it goes to zero when it should — when there is no
		// temperature difference to exploit.
		if z.Setpoint > z.BaseSetpoint+0.01 {
			if prog, ok := ProgrammeFor(z.Type); ok && !z.LightsOn {
				savedLightingW += z.AreaM2 * prog.LightingWPerM2
			}
			lift := tOutside - z.BaseSetpoint
			if lift > 0 {
				dT := z.Setpoint - z.BaseSetpoint
				uaW := 1.0 / math.Max(z.RIn+z.ROut, 0.05)
				savedThermalW += uaW * math.Min(dT, lift)
			}
		}
		// Plug loads (APLC, plugs.go): the end use the case-study BMS could not see.
		pTot, pStandby := z.plugNowW()
		plugTotalW += pTot
		plugStandbyW += pStandby
		if z.PlugShed {
			plugShedW += z.PlugStandbyW * plugSwitchableFrac
		}
	}

	// Plant coefficient of performance degrades as the building is strained (chillers
	// run harder at higher lift), calculated dynamically from thermodynamic Carnot lift,
	// part-load ratio, and thermal strain.
	avgStrain := 0.0
	if len(e.Zones) > 0 {
		avgStrain = strainSum / float64(len(e.Zones))
	}
	plantCop := CalculateThermodynamicCop(tOutside, Phys().SupplyAirDesignC, totalHeatW, condFloorM2, avgStrain)

	// Fresh air. In Ho Chi Minh City, dehumidifying outdoor air to a supply condition is
	// the LARGEST single cooling term in an office and it is mostly latent — omitting it
	// is why a twin calibrated on internal gains alone under-reports a Vietnamese
	// building by roughly a third. Scales with the people actually present, so it falls
	// away out of hours exactly as a real demand-controlled AHU would let it.
	ventW = float64(totalOccupants) * (ph.OutdoorAirLPerSPerPerson / 1000.0) *
		ph.AirDensityKgPerM3 * ph.VentilationEnthalpyKjPerKg * 1000.0
	totalHeatW += ventW

	coolingOutputMW := totalHeatW / 1e6 // thermal cooling delivered (MW)

	// Cooling electrical. Where a zone's air conditioner is on a real clamp its draw is a
	// MEASUREMENT and is used as one; only the unmetered remainder of the building goes
	// through the modelled COP curve. The metered zones' share of the fresh-air load is
	// attributed by occupancy, because ventW is itself occupancy-driven.
	//
	// With no clamp fitted anywhere, meteredAcW is 0 and this reduces exactly to the
	// previous coolingOutputMW/plantCop.
	meteredVentW := 0.0
	if totalOccupants > 0 {
		meteredVentW = ventW * float64(meteredOccupants) / float64(totalOccupants)
	}
	meteredCoolingW := meteredHeatW + meteredVentW
	unmeteredCoolingW := math.Max(0, totalHeatW-meteredCoolingW)
	coolingElectricalMW := (unmeteredCoolingW/plantCop + meteredAcW) / 1e6

	// The COP the metered zones are ACTUALLY achieving — thermal delivered over electrical
	// drawn. Unlike plantCop this is not a curve; it is the plant measured against itself,
	// and a persistent gap between the two is a commissioning finding. Zero when nothing is
	// clamped, so it is never confused with a modelled figure.
	measuredCop := 0.0
	if meteredAcW > 0 {
		measuredCop = meteredCoolingW / meteredAcW
	}
	// Non-HVAC electrical: lighting, fans, lifts and pumps, scaled by the building's own
	// conditioned floor area rather than a fixed 1.15 MW that was sized for the
	// mis-digitized fixture and did not move when the building did. Plus the LIVE plug
	// figure, so the sweep's effect shows up the moment sockets shed. (Plug loads were
	// 26.4% of the Hanoi case-study tower's energy; hiding them in a constant is how
	// that happens.)
	baseElectricalMW := (condFloorM2*ph.NonHvacBaseWPerM2 + plugTotalW) / 1e6
	buildingLoadMW := coolingElectricalMW + baseElectricalMW
	if buildingLoadMW <= 0 || math.IsNaN(buildingLoadMW) {
		buildingLoadMW = 0.001
	}
	energySavedMW := (savedLightingW + savedThermalW/plantCop) / 1e6
	// Feed the load to the BESS dispatcher (read next tick) and snapshot battery state.
	e.lastLoadMw = buildingLoadMW
	// A pack that is not there reports -1, not 0. Zero percent is a state a REAL battery
	// can genuinely be in, so it cannot also mean "no battery" — and the dashboard was
	// drawing a 59%-charged pack on a live site that has no storage at all, which is a
	// modelled number travelling on a channel that reads as measured. Negative SoC is
	// physically impossible, so it carries the absence unambiguously.
	bessDischargeMW := e.Bess.DischargeMw
	bessSocPct := e.Bess.Soc * 100.0
	if !e.Bess.Enabled {
		bessDischargeMW = 0
		bessSocPct = -1
	}

	// System health = mean per-zone comfort (severity-weighted), per the report's discomfort
	// model, minus a charge for zones actually in alarm. The mean alone is misleading at
	// this scale: one server room cooking at 50 C across 1350 zones averages to 99.93%, so
	// the dashboard cheerfully reported "HEALTH 100%" directly beside its own CRITICAL FAULT
	// banner. Alarms are rare and serious, so each one moves the number an operator watches.
	systemHealth := 100.0
	if len(e.Zones) > 0 {
		systemHealth = 100.0 * comfortSum / float64(len(e.Zones))
	}
	if alarmCount > 0 {
		systemHealth = math.Max(0, systemHealth-math.Min(45.0, 12.0*float64(alarmCount)))
	}

	// [GEMINI IMPLEMENTATION START]
	// Persist metrics to TimescaleDB at most once per second. persistReading
	// (db.go) only enqueues, so this never blocks the broadcast goroutine.
	now := time.Now()
	if e.Persist != nil && now.Sub(e.lastDbSave) > time.Second {
		e.lastDbSave = now
		e.Persist("GLOBAL", "buildingLoadMw", buildingLoadMW)
		e.Persist("GLOBAL", "coolingOutputMw", coolingOutputMW)
		e.Persist("GLOBAL", "systemHealth", systemHealth)
		e.Persist("GLOBAL", "avgCo2", e.avgCo2(totalOccupants))
		// Occupancy as its own GLOBAL series. Without it the dashboard's occupancy chart
		// had nothing to replay after a reload and fell back to plotting avgCo2 under an
		// "OCCUPANCY" heading — which is a different quantity the moment a real NDIR
		// sensor is reporting instead of the occupancy estimate.
		e.Persist("GLOBAL", "totalOccupants", float64(totalOccupants))
		e.Persist("GLOBAL", "plugKw", plugTotalW/1000)
		// The plant's modelled COP and, when anything is clamped, the one it is actually
		// achieving. Two series rather than one: the divergence between them over time is
		// the evidence, and it is only readable if both are stored.
		e.Persist("GLOBAL", "plantCop", plantCop)
		if measuredCop > 0 {
			e.Persist("GLOBAL", "measuredCop", measuredCop)
			e.Persist("GLOBAL", "meteredAcKw", meteredAcW/1000)
		}
		// Feature series for OFFLINE LSTM retraining (backend/forecasting/train.py):
		// the SAME building-average [temp, airflow] the live forecaster consumes, plus
		// the outdoor conditions the envelope integrates against. Persisting them is
		// what lets the model be retrained on the building's OWN accumulated history
		// instead of only synthetic data — the target (buildingLoadMw) is already here.
		avg := e.currentAvg()
		e.Persist("GLOBAL", "avgTemp", avg.temp)
		e.Persist("GLOBAL", "avgAirflow", avg.flow)
		if tOut, live := e.outdoorNow(); live {
			e.Persist("GLOBAL", "outdoorTemp", tOut)
			if e.outdoorHum > 0 {
				e.Persist("GLOBAL", "outdoorHum", e.outdoorHum)
			}
		}
		// Per-zone MODELLED series are written at a slower cadence than the GLOBAL ones.
		//
		// This loop ran every second across every zone, and on the digitized fixture that is
		// 735 zones x 2 series = ~1,470 rows/s of values the simulation can reproduce exactly.
		// It filled the TimescaleDB volume to 49 GB in the 7-day retention window -- 233.7M
		// rows, of which 158k (0.068%) were measured. The disk reaching 100% is what stopped
		// Docker, the forecaster and the browser tests.
		//
		// A modelled temperature does not carry a second of new information every second: it
		// is an integration the engine re-derives on demand. Sampling it once a minute keeps
		// every chart and the LSTM retraining features usable at ~1/60th the volume. Anything
		// a sensor actually reported is untouched -- those are gated on their own freshness
		// below, and measured rows go through persistMeasured at full rate.
		persistZoneModelled := now.Sub(e.lastZoneDbSave) >= time.Minute
		if persistZoneModelled {
			e.lastZoneDbSave = now
		}
		for id, z := range e.Zones {
			if persistZoneModelled {
				e.Persist(id, "temp", z.Temp)
				e.Persist(id, "occupancy", float64(z.Occupancy))
			}
			// Environmentals from a live physical sensor (humidity %, CO2 ppm) get
			// their own history series, each gated on its own sensor still reporting.
			if z.HwHum > 0 && z.humFresh() {
				e.Persist(id, "humidity", z.HwHum)
			}
			if z.HwCo2 > 0 && z.co2Fresh() {
				e.Persist(id, "co2", z.HwCo2)
			}
			// AFDD residual history for sensor-bound zones: the maintenance
			// evidence behind a "dispatch technician" card — how long the room
			// has been drifting from its physics, queryable, not just a live LED.
			if z.ShadowTemp != 0 && z.hwFresh() {
				e.Persist(id, "afddResidual", z.ResidualEma)
			}
		}
	}
	// [GEMINI IMPLEMENTATION END]

	// Fold this tick into the learned operating baselines (baselines.go). Deliberately
	// slower than the 1 Hz DB persist: at one sample per baselineSampleSecs, each
	// hour-of-day bucket's EWMA memory spans days, so it learns a real diurnal normal
	// instead of chasing the last few minutes. The model learns with or without a DB —
	// it is the twin's own memory of what "normal" is, independent of history storage.
	if e.baselines != nil && now.Sub(e.lastBaselineAt) >= baselineSampleSecs*time.Second {
		e.lastBaselineAt = now
		// Running range of the building's load, at the baseline cadence. This is what a
		// forecast is sanity-checked against, and it is kept separately from the 5-minute
		// forecast history for one reason: at one sample per 5 minutes that history needs
		// two hours before it can say anything about this building, and during those two
		// hours an out-of-distribution forecast is free to actuate the building. At the
		// baseline cadence the same evidence is in hand within minutes.
		e.loadSeen++
		if e.loadSeen == 1 || buildingLoadMW < e.loadMinMw {
			e.loadMinMw = buildingLoadMW
		}
		if e.loadSeen == 1 || buildingLoadMW > e.loadMaxMw {
			e.loadMaxMw = buildingLoadMW
		}
		e.baselines.Observe("GLOBAL", "buildingLoadMw", buildingLoadMW, now)
		e.baselines.Observe("GLOBAL", "plugKw", plugTotalW/1000, now)
		for id, z := range e.Zones {
			e.baselines.Observe(id, "temp", z.Temp, now)
			// Only a live NDIR reading teaches the CO2 baseline — a modelled estimate
			// would train the model on its own guess and then flag reality against it.
			if z.HwCo2 > 0 && z.co2Fresh() {
				e.baselines.Observe(id, "co2", z.HwCo2, now)
			}
			// How busy a room is, is itself a learned normal — it is what makes an
			// "unusually crowded for this hour" judgement possible without a rule.
			e.baselines.Observe(id, "occupancy", float64(z.Occupancy), now)
		}
	}

	// Fold this tick into the learned per-room dynamics (dynamics.go). Sampled on the
	// SIMULATION clock, because that is the clock the physics advances on; the model
	// enforces its own spacing, so calling it every broadcast is safe and cheap.
	if e.dynamics != nil {
		conds := e.roomConditions()
		// Evict models for zones the building no longer has, so the identified/learning
		// counts describe the building that exists rather than the one that used to.
		if e.dynamicsPruned != len(conds) {
			live := make(map[string]bool, len(conds))
			for _, c := range conds {
				live[c.Zone] = true
			}
			if n := e.dynamics.Retain(live); n > 0 {
				log.Printf("[dynamics] dropped %d room models for zones no longer in the building", n)
			}
			e.dynamicsPruned = len(conds)
		}
		e.dynamics.Observe(conds, e.simClock)
	}

	// FlatBuffers Serialization
	builder := flatbuffers.NewBuilder(1024)

	// Create Zones
	zoneOffsets := make([]flatbuffers.UOffsetT, 0)
	for id, z := range e.Zones {
		noiseTemp := z.Temp + getNoise(0.08)
		// A lighting or plug-shed flip must stream even when the temperature hasn't
		// moved past the dedupe threshold, or the UI would show it a frame too late.
		if math.Abs(noiseTemp-z.LastBroadcastTemp) > 0.05 || z.LightsOn != z.LastBroadcastLights || z.PlugShed != z.LastBroadcastPlugShed {
			z.LastBroadcastTemp = noiseTemp
			z.LastBroadcastLights = z.LightsOn
			z.LastBroadcastPlugShed = z.PlugShed
			idStr := builder.CreateString(id)
			Telemetry.ZoneDataStart(builder)
			Telemetry.ZoneDataAddId(builder, idStr)
			Telemetry.ZoneDataAddTemp(builder, float32(noiseTemp))
			Telemetry.ZoneDataAddOccupants(builder, int32(z.Occupancy))
			Telemetry.ZoneDataAddLoad(builder, float32(z.BaseHeatGain/1000.0))
			Telemetry.ZoneDataAddLightsOn(builder, z.LightsOn)
			// Measured air quality rides the main stream so the dashboard reads a bound
			// sensor's real humidity/CO2 straight from the telemetry it already consumes,
			// instead of a side poll. Gated on the node still being fresh: a board that
			// dropped off must stop reporting rather than pin its last reading there
			// forever, so zero always means "nothing is measuring this right now".
			var hwHum, hwCo2 float32
			if z.humFresh() {
				hwHum = float32(z.HwHum)
			}
			if z.co2Fresh() {
				hwCo2 = float32(z.HwCo2)
			}
			Telemetry.ZoneDataAddHumidity(builder, hwHum)
			Telemetry.ZoneDataAddCo2(builder, hwCo2)
			zPlugW, _ := z.plugNowW()
			Telemetry.ZoneDataAddPlugW(builder, float32(zPlugW))
			Telemetry.ZoneDataAddPlugShed(builder, z.PlugShed)
			// The supply-air temperature the cooling law used for THIS zone this tick —
			// the measured probe where one reports, the design value otherwise. The
			// dashboard needs it to compute delivered cooling honestly; without it the
			// panel had no choice but to assume the design 12 degC for every zone,
			// including the ones whose probe says otherwise. supplyReal keeps the two
			// distinguishable at the far end.
			Telemetry.ZoneDataAddSupplyC(builder, float32(z.supplyC(z.Setpoint)))
			Telemetry.ZoneDataAddSupplyReal(builder, z.supplyFresh() && z.HwSupplyC > 0)
			var stripW float64
			if z.stripFresh() {
				stripW = z.HwStripW
			}
			Telemetry.ZoneDataAddStripW(builder, float32(stripW))
			zoneOffsets = append(zoneOffsets, Telemetry.ZoneDataEnd(builder))
		}
	}
	Telemetry.SimStateStartZonesVector(builder, len(zoneOffsets))
	for i := len(zoneOffsets) - 1; i >= 0; i-- {
		builder.PrependUOffsetT(zoneOffsets[i])
	}
	zonesVec := builder.EndVector(len(zoneOffsets))

	// Create VAVs
	vavOffsets := make([]flatbuffers.UOffsetT, 0)
	for id, v := range e.Vavs {
		// Measurement noise as a FRACTION of what this box is sized to move, which is what
		// a flow station's accuracy actually is. Both of these were absolute constants
		// (±0.2 and 0.1 m³/s) — a fraction of a percent while every box was mis-sized at
		// ~22 m³/s, and LARGER THAN THE SIGNAL once boxes were sized properly at ~0.13.
		// A house's airflow became mostly noise, and since the noise alone always cleared
		// the dedupe, every VAV re-streamed at 30 Hz and the panel flickered.
		scale := v.NominalFlow
		if scale <= 1e-6 {
			scale = math.Max(v.Flow, 0.05)
		}
		noiseFlow := math.Max(0, v.Flow+getNoise(flowNoiseFrac*scale))
		flowChanged := math.Abs(noiseFlow-v.LastBroadcastFlow) > flowDedupeFrac*scale
		damperChanged := math.Abs(v.DamperPos-v.LastBroadcastDamper) > 0.01
		if flowChanged || damperChanged {
			v.LastBroadcastFlow = noiseFlow
			v.LastBroadcastDamper = v.DamperPos
			idStr := builder.CreateString(id)
			Telemetry.VavDataStart(builder)
			Telemetry.VavDataAddId(builder, idStr)
			Telemetry.VavDataAddAirflow(builder, float32(noiseFlow))
			Telemetry.VavDataAddDamper(builder, float32(v.DamperPos))
			vavOffsets = append(vavOffsets, Telemetry.VavDataEnd(builder))
		}
	}
	Telemetry.SimStateStartVavsVector(builder, len(vavOffsets))
	for i := len(vavOffsets) - 1; i >= 0; i-- {
		builder.PrependUOffsetT(vavOffsets[i])
	}
	vavsVec := builder.EndVector(len(vavOffsets))

	// Create Global
	Telemetry.GlobalDataStart(builder)
	Telemetry.GlobalDataAddBuildingLoadMw(builder, float32(buildingLoadMW))
	Telemetry.GlobalDataAddSystemHealth(builder, float32(systemHealth))
	Telemetry.GlobalDataAddTotalOccupants(builder, int32(totalOccupants))
	Telemetry.GlobalDataAddCoolingOutputMw(builder, float32(coolingOutputMW))
	Telemetry.GlobalDataAddPlantCop(builder, float32(plantCop))
	Telemetry.GlobalDataAddEnergySavedMw(builder, float32(energySavedMW))
	Telemetry.GlobalDataAddBessDischargeMw(builder, float32(bessDischargeMW))
	Telemetry.GlobalDataAddBessSocPct(builder, float32(bessSocPct))
	Telemetry.GlobalDataAddAvgCo2(builder, float32(e.avgCo2(totalOccupants)))
	Telemetry.GlobalDataAddPlugKw(builder, float32(plugTotalW/1000))
	Telemetry.GlobalDataAddPlugStandbyKw(builder, float32(plugStandbyW/1000))
	Telemetry.GlobalDataAddPlugShedKw(builder, float32(plugShedW/1000))
	Telemetry.GlobalDataAddPlugSavedKwh(builder, float32(e.plugSavedKwh))
	Telemetry.GlobalDataAddAutoPilot(builder, e.AutoPilot)
	Telemetry.GlobalDataAddZonesInSetback(builder, int32(e.zonesInSetback))
	// Static pressure from the Hardy-Cross solve. It has been computed every tick since
	// the network model landed and never left the engine, so the topology view's AHU card
	// has been showing a hardcoded 500 Pa placeholder instead of the solver's answer.
	Telemetry.GlobalDataAddAhuPressurePa(builder, float32(e.AhuPressure))
	globalPos := Telemetry.GlobalDataEnd(builder)

	// Build SimState
	Telemetry.SimStateStart(builder)
	Telemetry.SimStateAddTimestamp(builder, time.Now().UnixMilli())
	Telemetry.SimStateAddZones(builder, zonesVec)
	Telemetry.SimStateAddVavs(builder, vavsVec)
	Telemetry.SimStateAddGlobal(builder, globalPos)
	simStatePos := Telemetry.SimStateEnd(builder)

	builder.Finish(simStatePos)
	buf := builder.FinishedBytes()

	conns := make([]*websocket.Conn, 0, len(e.Clients))
	for c := range e.Clients {
		conns = append(conns, c)
	}
	e.mu.Unlock()

	// Network writes happen OUTSIDE the lock: a slow websocket client must never
	// stall the simulation loop or MQTT ingestion.
	var dead []*websocket.Conn
	for _, client := range conns {
		if err := WSWrite(client, websocket.BinaryMessage, buf); err != nil {
			client.Close()
			dead = append(dead, client)
		}
	}
	if len(dead) > 0 {
		e.mu.Lock()
		for _, c := range dead {
			delete(e.Clients, c)
		}
		e.mu.Unlock()
		for _, c := range dead {
			WSForget(c)
		}
	}
}
