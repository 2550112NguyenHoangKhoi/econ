// models — learned models: baselines, room dynamics, their persistence.
//
// Split out of engine.go, which had grown to 3,541 lines. Same package, same code:
// nothing here was rewritten, only moved to a file named after what it does.

package simulation

import (
	"encoding/json"
	"log"
	"strings"
	"time"
)

// Recommendations scores the building's current state against the learned baseline model
// (baselines.go / recommend.go) and returns the ranked report the dashboard renders. It
// gathers each zone's live values under e.mu, then releases e.mu before scoring, so the
// engine lock and the baseline lock are never held together (one-way order e.mu →
// baselines.mu everywhere else; this path takes neither pair simultaneously).
func (e *Engine) Recommendations(topN int) RecommendationReport {
	e.mu.Lock()
	realMode := e.mode == ModeReal
	readings := make([]ZoneReading, 0, len(e.Zones))
	caps := make(map[string]ZoneCapability, len(e.Zones))
	var reach HardwareReach
	for id, z := range e.Zones {
		label := strings.TrimPrefix(id, "zone-")
		zr := ZoneReading{
			Zone: id, Label: label, Type: z.Type,
			Temp: z.Temp, Setpoint: z.Setpoint, Occupancy: z.Occupancy, CameraEvent: z.CameraEvent, PirState: z.PirState, IrState: z.IrState,
		}
		if z.HwCo2 > 0 && z.co2Fresh() {
			zr.Co2 = z.HwCo2
			zr.Co2Live = true
		}
		readings = append(readings, zr)
		// What this zone's hardware can actually do, gathered in the same pass and under
		// the same lock as the readings it will be used to judge. See capability.go.
		zc := ZoneCapability{
			NodeBound:      z.HwSource != "" || z.MqttTopic != "",
			NodeOnline:     z.HwOnline,
			AcControlKnown: z.HwAcRealSeen,
			AcControlReal:  z.HwAcReal,
			AcPowerLive:    z.acFresh(),
			AcPowerW:       z.HwAcW,
			IrState:        z.IrState,
		}
		caps[id] = zc

		// The same facts, counted. Every increment is a measurement the zone has actually
		// produced — nothing is assumed for a zone that has reported nothing.
		reach.Zones++
		if zc.NodeBound {
			reach.NodesBound++
			if zc.NodeOnline {
				reach.NodesOnline++
			}
			switch {
			case !zc.AcControlKnown:
				reach.AcUnknown++
			case zc.AcControlReal:
				reach.AcControlled++
			}
		}
		if zc.AcPowerLive {
			reach.AcMetered++
		}
		if zr.Co2Live {
			reach.Co2Sensed++
		}
	}
	conds := e.roomConditions()
	loadMw := e.lastLoadMw
	e.mu.Unlock()

	if e.baselines == nil {
		return RecommendationReport{}
	}
	now := time.Now()
	// Two passes over two different models, merged and ranked together: the baselines say
	// what is abnormal RIGHT NOW, the identified room dynamics say what is about to go
	// wrong and how long there is to act. topN is applied after the merge so a genuinely
	// urgent prediction can outrank a mild present anomaly.
	report := e.baselines.Recommend(readings, loadMw, now, 0)
	var predictive []Recommendation
	if e.dynamics != nil {
		predictive = e.dynamics.PredictiveRecommendations(conds, now)
		report.Model.RoomsIdentified, report.Model.RoomsLearning = e.dynamics.Coverage()
	}
	// In real mode the twin owns no actuators it was not wired to, so a recommendation is
	// checked against the hardware that would have to carry it out before it is ranked:
	// findings that rest on absent hardware are dropped, findings that are measured but
	// cannot be acted on keep their evidence and lose their button. Filtering BEFORE the
	// merge's topN means a withdrawn card promotes a real one instead of leaving a hole.
	// Simulation mode is untouched: there, every modelled actuator responds.
	if realMode {
		report.Recommendations = applyActuationCapability(report.Recommendations, caps)
		predictive = applyActuationCapability(predictive, caps)
	}
	report.Model.RealMode = realMode
	report.Hardware = reach
	return mergeRecommendations(report, predictive, topN)
}

// LoadForecastThreshold returns the learned "high load" line the pre-cool automation
// triggers against — mean + k·σ of the building-load baseline for the coming hour — and
// whether the model has matured enough to trust it. When ok is false the caller keeps its
// fixed fallback, so pre-cooling is data-driven once the twin knows the building and
// safely conventional before that. lead looks slightly ahead so the trigger anticipates
// the peak the forecast is warning about.
func (e *Engine) LoadForecastThreshold(k float64, lead time.Duration) (threshold float64, ok bool) {
	if e.baselines == nil {
		return 0, false
	}
	return e.baselines.LoadThreshold(time.Now().Add(lead), k)
}

// MarshalBaselines / LoadBaselines let main.go persist the learned model across restarts
// (recommendapi.go), exactly like the plug savings counter — a model that forgets
// everything it learned on every redeploy would be re-learning "normal" forever. Bytes,
// not the internal map type, so the persistence lives cleanly in package main.
// OccupancyModelVersion stamps every file of learned state with the occupancy model that
// produced it.
//
// Learned state can be stale for a second reason besides describing a different building:
// it can describe THIS building under a different model. Occupancy is an input to almost
// everything the engine learns — the zone temperatures the baselines score, the whole-
// building load they trigger pre-cool from, the recorded megawatt series both forecasters
// read, and the occupant-gain term of every identified room. When that input changes, state
// fit against the old one is not merely imprecise, it is a confident statement about a
// building that no longer exists: the house learned its normal load with twenty-eight
// phantom occupants in it, and the pre-cool trigger, the plausibility check that decides
// whether a forecast is refused, and the battery's own nameplate are all read off it.
//
// Bump this whenever a change alters what the engine will learn. A mismatch discards the
// affected state and relearns, which costs hours of warm-up and buys not acting on a model
// of a building that was never there.
const OccupancyModelVersion = 2

// baselineDoc wraps the learned buckets with the building they were learned from.
//
// Zone buckets are keyed by zoneId, so a different building simply mints different keys.
// The whole-building buckets are keyed "GLOBAL" — the same string in every building — and
// GLOBAL/buildingLoadMw is not merely displayed: it IS the learned trigger the pre-cool
// automation actuates on. Restoring a previous building's version of it told a 72 m2 house
// that it normally draws 0.6 MW, and the automation duly opened real pre-cool windows.
type baselineDoc struct {
	BuildingId string `json:"buildingId"`
	ModelVer   int    `json:"occupancyModelVersion"`
	// Site is the network this state was learned on (see site.go). The building id says
	// which building the model DESCRIBES; it cannot say whether the engine is currently at
	// it. The fixture travels with the machine, so a laptop running the house's fixture
	// somewhere else passes every other check and folds that somewhere-else into the
	// house's learned normal.
	Site  string                           `json:"site,omitempty"`
	Stats map[string]map[int]*baselineStat `json:"stats"`
}

func (e *Engine) MarshalBaselines() ([]byte, error) {
	if e.baselines == nil {
		return []byte("{}"), nil
	}
	e.mu.Lock()
	id := e.buildingId
	e.mu.Unlock()
	return json.Marshal(baselineDoc{
		BuildingId: id, ModelVer: OccupancyModelVersion, Site: SiteFingerprint(),
		Stats: e.baselines.Snapshot(),
	})
}

func (e *Engine) LoadBaselines(data []byte) error {
	if e.baselines == nil {
		return nil
	}
	var doc baselineDoc
	if err := json.Unmarshal(data, &doc); err != nil || doc.Stats == nil {
		// Legacy form: the bare bucket map, from before the model recorded which building
		// it learned from. It also predates the occupancy model version, so it cannot show
		// that it was learned under the occupancy this engine now drives — and a baseline
		// is a statement about what is normal, which is exactly what changed. Verify it
		// parses so a corrupt file is still reported, then discard it and relearn.
		if err2 := e.baselines.LoadState(data); err2 != nil {
			if err != nil {
				return err
			}
			return err2
		}
		e.baselines.Restore(map[string]map[int]*baselineStat{})
		log.Printf("[baselines] restored model records neither a building nor an occupancy " +
			"model version — discarding it and relearning rather than treating another " +
			"building's normal, or this one's under a different occupancy, as this one's")
		return nil
	}
	// State learned under a previous occupancy model describes a building that was never
	// there. Per-zone buckets are as affected as the GLOBAL ones here — the occupancy the
	// rooms were scored against, and the temperatures that followed from it, both changed —
	// so the whole model is dropped rather than partially trusted.
	if doc.ModelVer != OccupancyModelVersion {
		log.Printf("[baselines] learned under occupancy model v%d, this engine is v%d — "+
			"discarding the model and relearning; what a zone's normal looks like changed "+
			"with the occupancy that drives it", doc.ModelVer, OccupancyModelVersion)
		return nil
	}
	if !sameSite(doc.Site) {
		log.Printf("[baselines] learned on network %s but this engine is on %s — discarding "+
			"and relearning. This is what a machine carrying its fixture to another site "+
			"looks like; if instead the router here was replaced, the state was still this "+
			"building's and it will simply relearn.", doc.Site, SiteFingerprint())
		return nil
	}
	e.baselines.Restore(doc.Stats)
	e.pruneStaleZoneState()
	e.mu.Lock()
	id := e.buildingId
	e.mu.Unlock()
	if doc.BuildingId != id {
		if n := e.baselines.DropGlobal(); n > 0 {
			log.Printf("[baselines] learned model belongs to %q but the loaded building is %q — "+
				"dropped %d whole-building buckets; per-zone buckets are keyed by zone and are harmless",
				doc.BuildingId, id, n)
		}
	}
	return nil
}

// pruneStaleZoneState drops learned state for zones the CURRENT building does not have.
//
// Per-zone keys never collide the way GLOBAL does, so stale ones are inert — nothing looks
// them up again. They are not inert in the REPORT: coverage counts every bucket the model
// holds, so a five-room house that had once run a 735-zone fixture told its operator it had
// 53,878 established signals. That is a true statement about the file and a false
// impression of the building. It also lets the state files grow without bound across
// re-digitizations.
func (e *Engine) pruneStaleZoneState() {
	e.mu.Lock()
	keep := make(map[string]bool, len(e.Zones))
	for id := range e.Zones {
		keep[id] = true
	}
	e.mu.Unlock()
	e.pruneStaleZoneStateFor(keep)
}

func (e *Engine) pruneStaleZoneStateFor(keep map[string]bool) {
	if len(keep) == 0 {
		return // no building loaded yet: nothing to judge against
	}
	if e.baselines != nil {
		if n := e.baselines.RetainZones(keep); n > 0 {
			log.Printf("[baselines] dropped %d buckets for zones not in this building", n)
		}
	}
	if e.dynamics != nil {
		if n := e.dynamics.RetainZones(keep); n > 0 {
			log.Printf("[dynamics] dropped %d room models for zones not in this building", n)
		}
	}
}

// BaselineCoverage reports the model's maturity (established vs still-learning buckets) —
// the honest readout the recommendations panel shows.
func (e *Engine) BaselineCoverage() (established, learning int) {
	if e.baselines == nil {
		return 0, 0
	}
	return e.baselines.Coverage()
}

// ObserveBaseline records an observation into the engine's learned baseline model.
func (e *Engine) ObserveBaseline(zone, metric string, val float64, at time.Time) {
	if e.baselines != nil {
		e.baselines.Observe(zone, metric, val, at)
	}
}

// roomConditions gathers every room's current physical drivers for the learned dynamics
// model: the terms that actually appear in its energy and mass balances. Lock held.
func (e *Engine) roomConditions() []RoomCondition {
	// Cooling reaches a zone through the VAV that targets it. Normalizing to that VAV's
	// own nominal flow keeps the regressor the physical flow fraction, matching the
	// cooling law the engine integrates (tick).
	flow := make(map[string]float64, len(e.Vavs))
	for _, v := range e.Vavs {
		f := 0.0
		if v.NominalFlow > 1e-6 {
			f = v.Flow / v.NominalFlow
		}
		flow[v.TargetZone] = f
	}
	tOut, _ := e.outdoorNow()

	out := make([]RoomCondition, 0, len(e.Zones))
	for id, z := range e.Zones {
		c := RoomCondition{
			Zone: id, Label: strings.TrimPrefix(id, "zone-"),
			Temp: z.Temp, Setpoint: z.Setpoint, OutdoorC: tOut,
			FlowRatio: flow[id], Occupancy: z.Occupancy,
		}
		// A measured discharge temperature is what the cooling regressor is referenced to,
		// so the identified cooling authority describes the machine that is actually
		// running rather than the design value it was specified with. Left zero when no
		// probe is reporting, which RoomCondition.supplyC() reads as "use the library".
		if z.supplyFresh() && z.HwSupplyC > 0 {
			c.SupplyC = z.HwSupplyC
		}
		// Only a live NDIR reading may teach or be scored by the CO2 balance — a modelled
		// estimate would train the model on the twin's own guess.
		if z.HwCo2 > 0 && z.co2Fresh() {
			c.Co2, c.Co2Live = z.HwCo2, true
		}
		out = append(out, c)
	}
	return out
}

// RoomConditions is the exported snapshot of every room's drivers, used by the model API
// and the export bundle. Takes and releases e.mu.
func (e *Engine) RoomConditions() []RoomCondition {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.roomConditions()
}

// RoomModels returns each room's learned physical identity (time constant, cooling
// authority, air-change rate). Gathers labels under e.mu, then reads the dynamics model
// after releasing it — preserving the one-way lock order.
func (e *Engine) RoomModels() []RoomModel {
	if e.dynamics == nil {
		return nil
	}
	e.mu.Lock()
	labels := make(map[string]string, len(e.Zones))
	for id := range e.Zones {
		labels[id] = strings.TrimPrefix(id, "zone-")
	}
	e.mu.Unlock()
	return e.dynamics.RoomModels(labels)
}

// DynamicsCoverage reports how many rooms the twin has actually identified vs. how many
// are still being learned.
func (e *Engine) DynamicsCoverage() (identified, learning int) {
	if e.dynamics == nil {
		return 0, 0
	}
	return e.dynamics.Coverage()
}

// MarshalDynamics / LoadDynamics persist the identified room models across restarts, the
// same way the baselines are persisted — re-identifying every room from scratch on each
// redeploy would throw away days of learning.
// dynamicsDoc wraps the identified room models with the building they were identified in.
//
// Unlike the baselines, whose GLOBAL keys were the only colliding ones, EVERY key here can
// collide: zone ids are minted from the room's name and level, so `zone-office-lvl1` and
// `zone-bathroom-lvl1` are what ANY house scanned by housify_fixture.py produces. Restoring
// across a building change therefore applies one physical room's identified time constant,
// cooling authority and air-change rate to a different physical room — and these are not
// display figures: they drive the predictions, the "this room cannot hold setpoint at full
// flow, dispatch maintenance" finding, and the setback gate. A wrong conclusion delivered
// with full confidence is worse than no conclusion.
type dynamicsDoc struct {
	BuildingId string                     `json:"buildingId"`
	ModelVer   int                        `json:"occupancyModelVersion"`
	Site       string                     `json:"site,omitempty"`
	Rooms      map[string]json.RawMessage `json:"rooms"`
}

func (e *Engine) MarshalDynamics() ([]byte, error) {
	if e.dynamics == nil {
		return []byte("{}"), nil
	}
	inner, err := e.dynamics.MarshalState()
	if err != nil {
		return nil, err
	}
	var rooms map[string]json.RawMessage
	if err := json.Unmarshal(inner, &rooms); err != nil {
		return nil, err
	}
	e.mu.Lock()
	id := e.buildingId
	e.mu.Unlock()
	return json.Marshal(dynamicsDoc{
		BuildingId: id, ModelVer: OccupancyModelVersion, Site: SiteFingerprint(), Rooms: rooms,
	})
}

func (e *Engine) LoadDynamics(data []byte) error {
	if e.dynamics == nil {
		return nil
	}
	var doc dynamicsDoc
	if err := json.Unmarshal(data, &doc); err != nil || doc.Rooms == nil {
		// Legacy form: the bare room map, from before the file recorded which building it
		// was identified in. It cannot prove it describes this building, so it is only
		// trusted when the current fixture declares no id either.
		e.mu.Lock()
		id := e.buildingId
		e.mu.Unlock()
		if id != "" {
			log.Printf("[dynamics] room models carry no building id but the loaded building " +
				"is known — discarding rather than applying another building's rooms")
			return nil
		}
		return e.dynamics.LoadState(data)
	}
	e.mu.Lock()
	id := e.buildingId
	e.mu.Unlock()
	if doc.BuildingId != id {
		log.Printf("[dynamics] room models were identified in %q but the loaded building is %q — "+
			"discarding %d rooms; zone ids collide across buildings, so restoring them would "+
			"apply one room's physics to another", doc.BuildingId, id, len(doc.Rooms))
		return nil
	}
	// Occupancy is a regressor in the thermal fit. A fit identified when it was a constant
	// carries an occupant-gain coefficient that the data never constrained, held at its
	// prior by the ridge term; keeping it would present a number as identified that was
	// only ever assumed.
	if doc.ModelVer != OccupancyModelVersion {
		log.Printf("[dynamics] room models were identified under occupancy model v%d, this "+
			"engine is v%d — discarding %d rooms and re-identifying; occupancy is a regressor "+
			"in the thermal fit", doc.ModelVer, OccupancyModelVersion, len(doc.Rooms))
		return nil
	}
	if !sameSite(doc.Site) {
		log.Printf("[dynamics] room models were identified on network %s but this engine is "+
			"on %s — discarding %d rooms. An identified time constant and cooling authority "+
			"belong to a physical room in a physical place, not to a fixture id.",
			doc.Site, SiteFingerprint(), len(doc.Rooms))
		return nil
	}
	inner, err := json.Marshal(doc.Rooms)
	if err != nil {
		return err
	}
	return e.dynamics.LoadState(inner)
}
