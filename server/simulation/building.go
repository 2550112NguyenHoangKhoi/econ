// building — construction, fixture loading and the airflow network.
//
// Split out of engine.go, which had grown to 3,541 lines. Same package, same code:
// nothing here was rewritten, only moved to a file named after what it does.

package simulation

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"os"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

func NewEngine() *Engine {
	e := &Engine{
		Clients:    make(map[*websocket.Conn]bool),
		Zones:      make(map[string]*ZoneSim),
		Vavs:       make(map[string]*VavSim),
		PMax:       600.0,
		KFan:       0.01,
		Scenario:   "peak",
		lastCmd:    make(map[string]string),
		demoAssign: make(map[string]string),
		lastLoadMw: 0.001,
		Bess:       NewBattery(),
		lastBessAt: time.Now(),
		Plug:       defaultPlugConfig(),
		lastPlugAt: time.Now(),
		AutoPilot:  true,
		baselines:  NewBaselines(),
		dynamics:   NewDynamics(),
		mode:       ParseOperationMode(os.Getenv("ECON_MODE")),
	}

	// Local-first (datapath.go): a deployment that has imported its own blueprint reads
	// its own building, which git neither tracks nor can overwrite on a pull. A fresh
	// clone falls back to the fixture the repository ships.
	path := DataPath(BuildingDataFile)
	data, err := os.ReadFile(path)
	if err != nil {
		log.Printf("Failed to load building data: %v", err)
		return e
	}
	if IsLocal(BuildingDataFile) {
		log.Printf("[building] running THIS DEPLOYMENT's building from %s (not the repository default)", path)
	}
	if err := e.buildFromJSON(data); err != nil {
		log.Printf("Failed to parse building data: %v", err)
	}
	return e
}

// buildFromJSON populates Zones/Vavs from a building-data.json payload. It is the single
// construction path: NewEngine uses it at boot and ReloadBuilding uses it when a freshly
// digitized blueprint is deployed. Not locked — callers own the locking discipline.
func (e *Engine) buildFromJSON(data []byte) error {
	var bd BuildingData
	if err := json.Unmarshal(data, &bd); err != nil {
		return err
	}
	e.buildingId = bd.BuildingId

	for _, f := range bd.Floors {
		for _, z := range f.Zones {
			if z.HvacMapping.VavId != "" {
				// Each VAV is sized for the room it serves, via its design airflow.
				//
				// Every box used to be created with Resistance 1.0, which made the network
				// solve share a FIXED fan capacity equally among however many boxes the
				// building happened to have. Per-box flow was therefore a function of the
				// zone COUNT and nothing else: 735 boxes each got a plausible trickle, and
				// the same fan through a house's two boxes gave 21.9 m3/s each — about
				// 150,000 m3/h into 72 m2. Resistance now comes from the zone's own volume
				// at the library's design air-change rate, so flow follows the room.
				dr := vavResistanceFor(z, f.Height)
				e.Vavs[z.HvacMapping.VavId] = &VavSim{
					TargetZone:       z.ZoneId,
					DesignResistance: dr,
					Damper:           1.0,
					DamperPos:        1.0,
					Position:         1.0,
					TargetDamperPos:  1.0,
					TargetPosition:   1.0,
					Resistance:       dr,
					Flow:             0,
				}
			}

			// A zone with no setpoint in the fixture takes its programme's setpoint from
			// the library, not a guess keyed off one hardcoded zone type.
			temp := z.ThermalProperties.Setpoint
			if temp == 0 {
				temp = 24.0
				if prog, ok := ProgrammeFor(z.ZoneType); ok && prog.SetpointC > 0 {
					temp = prog.SetpointC
				}
			}

			baseSp := z.ThermalProperties.Setpoint
			if baseSp == 0 {
				baseSp = temp
			}
			// Plug standby scales with real floor area (shoelace over the digitized
			// polygon; volume/3m where only a volume exists; a small default otherwise).
			areaM2 := polygonAreaM2(z.Polygon)
			if areaM2 <= 0 && z.Volume > 0 {
				areaM2 = z.Volume / 3.0
			}
			if areaM2 <= 0 {
				areaM2 = plugDefaultAreaM2
			}
			e.Zones[z.ZoneId] = &ZoneSim{
				Temp:       temp,
				WallTemp:   temp,
				Type:       z.ZoneType,
				BimAssetId: z.BimAssetId,
				// Occupancy comes from the zone's own area and its programme's design
				// density, scaled by the hour (see applyOccupancySchedule). It was
				// rand.Intn(10) — a uniform 0..9 people drawn once and never changed,
				// which put seven people in a 4 m2 bathroom and made vacancy impossible.
				Occupancy:     scheduledOccupancy(z.ZoneType, areaM2, time.Now()),
				BaseHeatGain:  z.ThermalProperties.BaseHeatLoad,
				SolarGainMult: z.ThermalProperties.SolarGainMultiplier,
				// Floor CAir: some digitized zones (e.g. tiny "server rooms") carry an
				// unrealistically small air capacitance that makes the explicit-Euler thermal
				// integration unstable (runaway temps). A modest floor keeps it stable; steady
				// state is unaffected since it depends on the heat balance, not CAir.
				CAir:  math.Max(z.ThermalProperties.CAir, Phys().MinZoneCapacitanceJPerK),
				CWall: 4000000.0,
				// Split the zone's derived envelope resistance into inside-surface and
				// outside-surface halves. The old form added a fixed 0.1 K/W to ROut,
				// which is fine against the raw fixture's flat 0.2 but swamps a real
				// envelope: a 200 m2 perimeter office works out near 0.005 K/W total, so
				// that constant alone was a 20x error and set the zone's time constant
				// almost single-handedly.
				RIn:                 z.ThermalProperties.RWall * Phys().RInFraction,
				ROut:                z.ThermalProperties.RWall * (1 - Phys().RInFraction),
				Setpoint:            z.ThermalProperties.Setpoint,
				BaseSetpoint:        baseSp,
				Deadband:            z.ThermalProperties.Deadband,
				LastBroadcastTemp:   -999.0, // force immediate broadcast on first frame for new/reloaded zones
				LightsOn:            true,
				LastBroadcastLights: true,
				AreaM2:              areaM2,
				PlugStandbyW:        areaM2 * plugStandbyWPerM2,
			}
		}
	}

	// Learned state for rooms this building does not contain is dropped now that the new
	// zone set is known. (Per-zone keys never collide the way GLOBAL does, so these are
	// inert — but they are counted, and a five-room house reporting 53,878 established
	// signals is a true statement about the file and a false impression of the building.)
	keep := make(map[string]bool, len(e.Zones))
	for id := range e.Zones {
		keep[id] = true
	}
	e.pruneStaleZoneStateFor(keep)

	// Order matters: the fan curve has to be scaled to this building's network BEFORE the
	// network is solved, or the nominal flows below are captured against the previous
	// building's fan. (They were: sizeFanToBuilding was appended after this block, so
	// NominalFlow — the figure the cooling model normalises against — was solved with the
	// unscaled PMax.)
	e.sizeFanToBuilding()
	e.doHardyCross()
	// Capture each VAV's nominal flow (at the design damper position) so the cooling
	// model can be normalized to it regardless of how many VAVs share the AHU. It is also
	// the scale this box's telemetry noise and broadcast dedupe are expressed against.
	for _, v := range e.Vavs {
		v.NominalFlow = v.Flow
	}

	return nil
}

// ReloadBuilding swaps the running twin onto a new building — the deploy step of the
// blueprint import flow. The physics loop, MQTT ingestion and HTTP snapshots all touch
// zone state under e.mu, so the swap happens in one critical section: clients simply see
// one tick of the old building followed by one tick of the new one. Everything keyed to
// the old zones (edge-node demo bindings, actuation dedupe, fault target, pre-cool
// window) is dropped rather than remapped — a binding onto a zone that no longer exists
// is a lie, and the node will re-bind on its next telemetry.
func (e *Engine) ReloadBuilding(data []byte) error {
	// Validate on scratch state first so a malformed upload cannot leave a half-built twin.
	scratch := &Engine{Zones: map[string]*ZoneSim{}, Vavs: map[string]*VavSim{}, PMax: 600.0, KFan: 0.01}
	if err := scratch.buildFromJSON(data); err != nil {
		return err
	}
	if len(scratch.Zones) == 0 {
		return fmt.Errorf("blueprint produced zero zones")
	}
	// Structural sanity a professional deployment needs stated, not assumed:
	// duplicate zoneIds would silently last-write-win in the map (two rooms, one
	// simulated), and an absurd zone count is a corrupt or hostile payload, not a
	// building — the physics loop is O(zones) at 30 Hz.
	var declared struct {
		Floors []struct {
			Zones []struct {
				ZoneId string `json:"zoneId"`
			} `json:"zones"`
		} `json:"floors"`
	}
	if err := json.Unmarshal(data, &declared); err == nil {
		n := 0
		for _, f := range declared.Floors {
			n += len(f.Zones)
		}
		if n > 50000 {
			return fmt.Errorf("%d zones exceeds the 50,000-zone limit", n)
		}
		if n != len(scratch.Zones) {
			return fmt.Errorf("%d zones declared but only %d unique zoneIds — duplicate ids in the payload", n, len(scratch.Zones))
		}
	}

	e.mu.Lock()
	defer e.mu.Unlock()
	e.Zones = map[string]*ZoneSim{}
	e.Vavs = map[string]*VavSim{}
	e.lastCmd = map[string]string{}
	e.demoAssign = map[string]string{}
	e.FaultTarget = ""
	e.Scenario = "peak"
	e.PreCoolUntil = time.Time{}
	// The recorded building-load series belongs to the building that produced it. Carrying
	// it across a redeploy hands the zero-shot forecaster one series stitched from two
	// different buildings and tells it that is one building's history — a 39,776 m2 tower
	// at 1.6 MW followed by a 72 m2 house at 0.01 MW, with no discontinuity marked. The
	// forecast that comes back is then anchored on a building that is no longer there.
	// Identification and baselines are keyed per zone and per (zone, metric, hour), so they
	// survive a redeploy correctly; this one is a single global series and does not.
	if n := len(e.loadHist); n > 0 {
		log.Printf("[forecast] building replaced — discarding %d recorded load samples "+
			"from the previous building; the zero-shot forecaster restarts its context", n)
		e.loadHist = e.loadHist[:0]
	}
	// The observed range describes the previous building too, and it is what forecasts are
	// judged against — keeping it would judge this building's forecasts against another
	// building's megawatts.
	e.loadMinMw, e.loadMaxMw, e.loadSeen = 0, 0, 0
	// Whole-building learned baselines are keyed "GLOBAL", the one key that is identical
	// across buildings. Per-zone buckets are keyed by zoneId and are simply never looked up
	// again, but GLOBAL/buildingLoadMw is read by the pre-cool automation as this
	// building's normal load — so leaving it in place hands the new building the previous
	// one's megawatts as its own trigger.
	if e.baselines != nil {
		if n := e.baselines.DropGlobal(); n > 0 {
			log.Printf("[baselines] building replaced — dropped %d whole-building buckets "+
				"learned from the previous building", n)
		}
	}
	if err := e.buildFromJSON(data); err != nil {
		return err // unreachable in practice: scratch already parsed this payload
	}
	log.Printf("[building] reloaded: %d zones, %d VAVs", len(e.Zones), len(e.Vavs))
	return nil
}

// zoneVolumeM3 recovers a zone's air volume from whatever the fixture carries: an explicit
// volume, else the digitized polygon area at the floor height. Zero when neither is known,
// and the caller falls back rather than inventing a room.
func zoneVolumeM3(z ZoneData, floorHeightM float64) float64 {
	if z.Volume > 0 {
		return z.Volume
	}
	area := polygonAreaM2(z.Polygon)
	h := floorHeightM
	if h <= 0 {
		h = 2.8
	}
	if area > 0 {
		return area * h
	}
	return 0
}

// vavResistanceFor turns a zone's design airflow into the box resistance the network solve
// needs: at the design static, Flow = sqrt(P/R), so R = P / V̇².
func vavResistanceFor(z ZoneData, floorHeightM float64) float64 {
	ph := Phys()
	vol := zoneVolumeM3(z, floorHeightM)
	if vol <= 0 {
		return 1.0 // nothing to size from — the historical default
	}
	design := vol * ph.SupplyAirDesignAch / 3600.0 // m³/s
	if design <= 0 {
		return 1.0
	}
	// R = P / V̇² at the design static. Deliberately NOT clamped to the damper's range:
	// that range is relative to this value, not a bound on it.
	r := ph.AhuDesignPressurePa / (design * design)
	if !(r > 0) || math.IsInf(r, 0) {
		return 1.0
	}
	return r
}

// sizeFanToBuilding scales the fan curve so the network settles at the design static for
// THIS building. PMax was a constant (600) chosen for one tower; with per-zone resistances
// it has to follow the network, or a small building would sit far off its design point.
//
//	P = R_sys · PMax / (KFan + R_sys)  ⟹  PMax = P_design · (KFan/R_sys + 1)
func (e *Engine) sizeFanToBuilding() {
	if len(e.Vavs) == 0 {
		return
	}
	sumInvSqrtR := 0.0
	for _, v := range e.Vavs {
		sumInvSqrtR += 1.0 / math.Sqrt(v.Resistance)
	}
	if sumInvSqrtR <= 0 {
		return
	}
	rSys := 1.0 / (sumInvSqrtR * sumInvSqrtR)
	pDesign := Phys().AhuDesignPressurePa
	e.PMax = pDesign * (e.KFan/rSys + 1.0)
}

func (e *Engine) doHardyCross() {
	needsSizing := false
	for _, v := range e.Vavs {
		if v.Resistance <= 0 || v.DesignResistance <= 0 {
			v.ensureInitialized()
			v.UpdateResistance()
			needsSizing = true
		}
	}
	if needsSizing {
		e.sizeFanToBuilding()
	}

	sumInvSqrtR := 0.0
	for _, v := range e.Vavs {
		if v.Resistance > 0 {
			sumInvSqrtR += 1.0 / math.Sqrt(v.Resistance)
		}
	}
	if sumInvSqrtR <= 0 {
		return
	}
	R_system := 1.0 / (sumInvSqrtR * sumInvSqrtR)

	Q_total_sq := e.PMax / (e.KFan + R_system)
	e.AhuPressure = R_system * Q_total_sq

	for _, v := range e.Vavs {
		if v.Resistance > 0 {
			v.Flow = math.Sqrt(math.Max(0, e.AhuPressure) / v.Resistance)
		}
	}
}

// enforceStaticPressureSafety ensures duct static pressure does not exceed structural safety limit (650 Pa).
// If P_ahu > 650 Pa, dampers are commanded open to relieve pressure, and if necessary fan speed is modulated down.
func (e *Engine) enforceStaticPressureSafety() {
	if e.AhuPressure <= MaxSafeStaticPressurePa {
		return
	}
	// Relieve duct static pressure by commanding dampers open
	relieved := false
	for _, v := range e.Vavs {
		if v.DamperPos < MaxDamperPos {
			v.DamperPos = math.Min(MaxDamperPos, v.DamperPos+0.15)
			v.Position = v.DamperPos
			if v.TargetDamperPos < v.DamperPos {
				v.TargetDamperPos = v.DamperPos
				v.TargetPosition = v.TargetDamperPos
			}
			v.UpdateResistance()
			relieved = true
		}
	}
	if relieved {
		e.doHardyCross()
	}
	// If still above safety ceiling after commanding dampers open, modulate fan down
	if e.AhuPressure > MaxSafeStaticPressurePa {
		ratio := MaxSafeStaticPressurePa / e.AhuPressure
		e.PMax *= ratio
		e.doHardyCross()
		if e.AhuPressure > MaxSafeStaticPressurePa {
			e.AhuPressure = MaxSafeStaticPressurePa
		}
	}
}

// SnapshotZones returns the zone map copied under the engine lock.
//
// Callers outside this package were ranging over e.Zones directly and then re-indexing
// it, which is two bugs at once. ReloadBuilding replaces the whole map under e.mu when
// the operator switches building, so an unlocked reader races a map write — and one that
// collects ids first and looks them up afterwards gets a nil *ZoneSim for every id that
// vanished in between. That is precisely how the engine died: a switch from the 735-zone
// tower to the 5-zone house landed mid-scan in the carbon snapshot, and the nil
// dereference took the whole process down with exit 2 and no restart policy.
//
// The copy is shallow: the map is safe to range, and the ZoneSim values behind it are the
// engine's live ones, as they were for the previous direct readers.
func (e *Engine) SnapshotZones() map[string]*ZoneSim {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make(map[string]*ZoneSim, len(e.Zones))
	for id, z := range e.Zones {
		out[id] = z
	}
	return out
}

func (e *Engine) getZoneToVavMap() map[string]*VavSim {
	m := make(map[string]*VavSim, len(e.Vavs))
	for _, v := range e.Vavs {
		if v.TargetZone != "" {
			m[v.TargetZone] = v
		}
	}
	return m
}

func (e *Engine) findVavForZone(zoneId string, zoneToVav map[string]*VavSim) *VavSim {
	if zoneToVav != nil {
		if v, ok := zoneToVav[zoneId]; ok {
			return v
		}
	}
	if v, ok := e.Vavs[zoneId]; ok {
		return v
	}
	if v, ok := e.Vavs["vav-"+zoneId]; ok {
		return v
	}
	trimmed := strings.TrimPrefix(zoneId, "zone-")
	if v, ok := e.Vavs["vav-"+trimmed]; ok {
		return v
	}
	return nil
}

// demoZoneAlias maps inbound MQTT identifiers (demo node names / aliases) to a real
// building zone. In a full deployment the payload would carry the actual zoneId.
var demoZoneAlias = map[string]string{
	"zone_1":  "zone-north-west-office-lvl4",
	"Level 4": "zone-north-west-office-lvl4",
}
