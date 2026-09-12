// state — live simulation state: a zone, a VAV, the engine itself.
//
// Split out of engine.go, which had grown to 3,541 lines. Same package, same code:
// nothing here was rewritten, only moved to a file named after what it does.

package simulation

import (
	"math"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Sim Structs
type ZoneSim struct {
	Temp                float64
	WallTemp            float64
	Type                string
	BimAssetId          string
	AreaM2              float64 // real floor area (digitized polygon); sizes plug + lighting models
	Occupancy           int
	BaseHeatGain        float64
	SolarGainMult       float64
	CAir                float64
	CWall               float64
	RIn                 float64
	ROut                float64
	Setpoint            float64
	BaseSetpoint        float64 // occupied setpoint; we set back from this when vacant
	Deadband            float64
	LastBroadcastTemp   float64
	LastBroadcastLights bool // last lighting state sent to clients (change forces a re-send)
	// Occupancy-driven control (real data arrives over MQTT from the CV/edge layer)
	Live             bool      // true once real occupancy has been received for this zone
	VacantTicks      int       // consecutive ticks at 0 occupancy (safety delay before setback)
	LightsOn         bool      // last actuated lighting state
	MqttTopic        string    // telemetry suffix this zone was seen on (commands route back here)
	DetectedProtocol string    // dynamic IR protocol discovered by edge cameras (e.g. "PANASONIC_AC")
	OverrideUntil    time.Time // Latch manual overrides so optimizer doesn't overwrite
	// Hardware-in-the-loop (physical ESP32 / Pico nodes). While the bound node's
	// measured temperature is fresh, the zone's air temp is pulled to the measurement
	// instead of the 2R1C integration — the dashboard shows the physical room, not the
	// model. Simulated placeholder temps never set HwTempAt (see Measurement.TempReal).
	HwSource string    // node kind ("esp32", "pico", "cv", ...); empty = never bound
	HwSeenAt time.Time // last telemetry of any kind from the bound node
	HwTemp   float64   // last measured air temperature (valid only while HwTempAt is fresh)
	HwTempAt time.Time // when HwTemp arrived; zero = node never sent a real temperature
	HwHum    float64   // last measured relative humidity (%), valid while HwHumAt is fresh
	HwHumAt  time.Time // when HwHum arrived; zero = no humidity sensor has ever reported
	HwCo2    float64   // last measured CO2 (ppm), valid while HwCo2At is fresh
	// Measured replacements for values the model otherwise assumes.
	HwSupplyC  float64 // AC discharge temperature (DS18B20) — supersedes supplyAirDesignC
	HwSupplyAt time.Time
	HwAcW      float64 // air-conditioner power (SCT-013) — the real cooling drive term
	HwAcAt     time.Time
	HwLux      float64 // ambient illuminance (BH1750) — a real irradiance proxy
	HwLuxAt    time.Time
	HwCo2At    time.Time // when HwCo2 arrived; zero = no NDIR sensor has ever reported

	// Derived presence: the radar's assertion corroborated (or disputed) by respiration.
	// Separate from Occupancy on purpose -- Occupancy stays exactly what the node measured.
	Presence    *PresenceFusion `json:"presence,omitempty"`
	HwOnline    bool            // broker LWT verdict from econ/status/<topic>
	CameraEvent *string
	PirState    *bool
	IrState     *string

	// Automated Plug Load Control (see plugs.go). PlugStandbyW is sized from the zone's
	// real floor area at build time; PlugShed flips when the after-hours sweep cuts the
	// zone's switchable sockets. HwPlugW/HwPlugAt carry a live SCT-013 clamp reading,
	// under the same per-field freshness rules as every other sensor.
	PlugStandbyW    float64
	PlugShed        bool
	PlugVacantSince time.Time // zero while occupied; set at the moment occupancy hits 0
	HwPlugW         float64
	HwPlugAt        time.Time
	// Actuator state as reported back by the node, with its own arrival time.
	NodePlugState         string
	NodePlugAt            time.Time
	NodeSetpointC         float64
	NodeSetpointAt        time.Time
	NodeLightsState       string
	NodeLightsAt          time.Time
	plugMismatchLogged    bool
	HwStripW              float64
	HwStripAt             time.Time
	HwCircuitBreakerW     float64
	HwCircuitBreakerAt    time.Time
	LastBroadcastPlugShed bool
	// Physics-grounded AFDD (roadmap challenge 2): while a real sensor pins this zone,
	// ShadowTemp keeps integrating the pure 2R1C model with NO sensor pull. The smoothed
	// |measured − modeled| residual is the fault signal — a healthy room tracks its
	// physics, a faulty one (blocked coil, stuck damper, open window) diverges. Needs no
	// training data or fault labels.
	ShadowTemp  float64 // sensor-free model twin of Temp (0 = not yet seeded)
	ResidualEma float64 // smoothed |HwTemp − ShadowTemp| in °C
	// Does this zone's bound node actually drive an air conditioner? The optimizer will
	// happily compute a setback for a zone whose commands terminate in a serial log line;
	// this is what lets the twin distinguish a saving it caused from one it only imagined.
	HwAcReal     bool
	HwAcRealSeen bool // a node has positively reported either way
	// Multi-zone spatial coupling: IDs of adjacent zones sharing internal partition walls
	AdjacentZones []string
	// Dynamic mass balance CO2 concentration (ppm) when NDIR sensor is omitted
	Co2Sim float64
	// Actuator & manual override twin states
	DamperPos float64 // manual or actuated damper position in [0.0, 1.0]
	CpuStrain bool    // test flag: forced CPU strain offload fallback active
}

type VavSim struct {
	TargetZone string
	Resistance float64
	// DesignResistance is what the box is SIZED at — fixed for the life of the building,
	// derived from the zone's own volume at the library's design air-change rate.
	// Splitting the two is what lets a box be sized physically at all.
	DesignResistance float64
	// Damper is the relative restriction multiplier (legacy compatibility: 1.0 = design).
	Damper float64
	// DamperPos is the physical actuator position in [0.0, 1.0] (1.0 = 100% open, 0.0 = closed).
	DamperPos float64
	// Position is an alias of DamperPos for test and API compatibility.
	Position float64
	// TargetDamperPos is the desired actuator position commanded by auto-pilot in [0.0, 1.0].
	TargetDamperPos float64
	// TargetPosition is an alias of TargetDamperPos.
	TargetPosition      float64
	Flow                float64
	NominalFlow         float64 // flow at default resistance; cooling is sized against this
	LastBroadcastFlow   float64
	LastBroadcastDamper float64
}

func (v *VavSim) ensureInitialized() {
	if v.DamperPos == 0 && v.TargetDamperPos == 0 && v.Position == 0 && v.TargetPosition == 0 {
		v.DamperPos = 1.0
		v.Position = 1.0
		v.TargetDamperPos = 1.0
		v.TargetPosition = 1.0
		if v.Damper == 0 {
			v.Damper = 1.0
		}
	} else {
		if v.Position != v.DamperPos {
			if v.Position != 0 {
				v.DamperPos = v.Position
			} else {
				v.Position = v.DamperPos
			}
		}
		if v.TargetPosition != v.TargetDamperPos {
			if v.TargetPosition != 0 {
				v.TargetDamperPos = v.TargetPosition
			} else {
				v.TargetPosition = v.TargetDamperPos
			}
		}
	}
	if v.DesignResistance <= 0 {
		if v.Resistance > 0 {
			v.DesignResistance = v.Resistance
		} else {
			v.DesignResistance = 1.0
			v.Resistance = 1.0
		}
	}
	if v.Resistance <= 0 {
		v.Resistance = v.DesignResistance
	}
}

// UpdateResistance calculates active aerodynamic resistance from physical damper position:
// R_v(theta) = R_design / max(0.01, theta^2)
func (v *VavSim) UpdateResistance() {
	v.ensureInitialized()
	pos := math.Max(MinDamperPos, math.Min(MaxDamperPos, v.DamperPos))
	v.DamperPos = pos
	v.Position = pos
	v.TargetPosition = v.TargetDamperPos

	eff := math.Max(0.01, pos*pos)
	v.Resistance = v.DesignResistance / eff
	if v.DesignResistance > 0 {
		v.Damper = v.Resistance / v.DesignResistance
	}
}

type Engine struct {
	Clients     map[*websocket.Conn]bool
	mu          sync.Mutex
	Zones       map[string]*ZoneSim
	Vavs        map[string]*VavSim
	AhuPressure float64
	PMax        float64
	KFan        float64
	Scenario    string
	FaultTarget string
	// Actuation: set by main.go to the MQTT publisher; nil when no broker is up.
	Publish func(topic, payload string)
	// Persist: set by main.go to the TimescaleDB writer; nil when no DB is up.
	Persist    func(zoneId, sensorType string, value float64)
	lastDbSave time.Time
	lastCmd    map[string]string // zoneId -> last command published (dedupe)
	demoAssign map[string]string // edge-node identifier -> zoneId (sticky demo binding)
	// Forecast-driven pre-cooling: while now < PreCoolUntil the optimizer drives every
	// occupied zone below its base setpoint, charging the building's thermal mass ahead
	// of a predicted demand peak so the chillers can shed load when it lands.
	PreCoolUntil time.Time
	// Battery Energy Storage System: charges off-peak, discharges on peak to shave grid draw.
	Bess       Battery
	lastLoadMw float64   // latest computed building electrical load (MW), fed to BESS dispatch
	lastBessAt time.Time // wall-clock of the last BESS integration step
	// lastOccupancyAt paces the modelled occupancy redraw (applyOccupancySchedule).
	lastOccupancyAt time.Time
	// Separate clock for per-zone modelled persistence, which is sampled far more slowly
	// than the GLOBAL series -- see the write loop in broadcast().
	lastZoneDbSave time.Time
	// Automated Plug Load Control (plugs.go): sweep policy, cumulative avoided energy,
	// and the wall-clock anchor its integration runs on (sim time accelerates; savings
	// must not).
	Plug         PlugConfig
	plugSavedKwh float64
	lastPlugAt   time.Time
	// Autonomous optimizer. AutoPilot is the real control flag the dashboard toggles
	// (over the websocket, main.go): when false, actuate() is suspended and the operator
	// owns the setpoints. zonesInSetback is how many zones it is currently holding in
	// energy-saving setback — the genuine backing for the "autonomous action" UI.
	AutoPilot      bool
	zonesInSetback int
	// Live outdoor conditions from the weather poller (main.go). Same freshness
	// philosophy as the zone sensors: outdoorAt records when the value arrived, and a
	// value the poller has not refreshed within outdoorStaleAfter stops driving the
	// envelope — the physics falls back to climatology rather than integrating against
	// a reading from hours ago as if it were current. Humidity rides along for the
	// LSTM forecaster, which was trained on [.., outdoor_temp, outdoor_humidity].
	outdoorTemp float64
	outdoorHum  float64
	outdoorAt   time.Time
	// Rolling telemetry window for the LSTM forecaster: one [avg room temp, avg airflow
	// fraction] sample every histInterval, most recent last. This is what makes the
	// forecast input a REAL last-hour sequence — including hardware-pinned temperatures
	// — instead of the current instant photocopied twelve times.
	histBuf    []histSample
	lastHistAt time.Time
	// Rolling building-load history (MW) at the same histInterval cadence. The LSTM is fed
	// a short [temp, airflow] window because that is what it was trained on; a time-series
	// FOUNDATION model (Google TimesFM, backend/forecasting/timesfm_forecaster.py) instead
	// forecasts the load series directly and zero-shot, so it wants as much of the real
	// series as we can give it. loadHistKeep spans ~42 h, which covers the daily cycle the
	// forecast is really about.
	loadHist []float64
	// buildingId of the fixture currently loaded, from BuildingData.BuildingId.
	buildingId string
	// Running min/max of the building's electrical load and how many samples back them,
	// accumulated at the baseline cadence. See ObservedLoadRange.
	loadMinMw, loadMaxMw float64
	loadSeen             int
	// Learned operating baselines (baselines.go): the online per-(zone,metric,hour) model
	// that turns the telemetry stream into "normal for this room at this hour", replacing
	// hardcoded thresholds. Feeds both /api/recommendations and the data-driven pre-cool
	// trigger. Self-locked, so it is folded into on the tick and read on the HTTP path
	// without coupling to e.mu.
	baselines      *Baselines
	lastBaselineAt time.Time
	// Learned per-room dynamics (dynamics.go): the online system identification that gives
	// each room a physical identity — its own thermal time constant, the cooling authority
	// its VAV actually delivers, and its measured air-change rate. This is what lets the
	// twin predict where a room is heading instead of only reporting where it is. Self-
	// locked like the baselines (e.mu → dynamics.mu).
	dynamics *Dynamics
	// simClock is the accumulated SIMULATION time in seconds. The tick's dt is deliberately
	// accelerated during faults and recovery, so wall-clock is the wrong time base for
	// anything learning the physics: identifying on this clock keeps every learned time
	// constant in one consistent timescale.
	simClock float64
	// dynamicsPruned is the zone count the room models were last reconciled against, so
	// the eviction sweep runs on a building change rather than on every tick.
	dynamicsPruned int
	// mode represents whether the engine operates on mock/simulated data (default) or strictly real telemetry.
	mode OperationMode
}

// histSample is one forecaster timestep: building-average room temperature and
// building-average airflow fraction (0..1 of nominal), captured together.
type histSample struct {
	temp float64
	flow float64
}

const (
	// histInterval MUST match the cadence the LSTM was trained at (SEQ_LEN=12 steps of
	// 5 minutes — the last hour). Changing one without the other feeds the model a
	// sequence at a timescale it has never seen.
	histInterval = 5 * time.Minute
	histKeep     = 12
	// loadHistKeep is how many load samples to retain for the foundation-model forecaster:
	// 512 × 5 min ≈ 42 hours, enough context for it to see the building's daily shape.
	loadHistKeep = 512

	// Damper travel, as a multiple of a box's DESIGN resistance. Dimensionless on purpose:
	// the control that used these as absolute resistances only worked while every box in
	// every building was initialised to 1.0.
	damperStep = 0.05
	damperMin  = 0.25 // opened past design
	damperMax  = 50.0 // effectively shut

	// Physical damper actuator constraints
	MinDamperPos            = 0.0
	MaxDamperPos            = 1.0
	MinVentDamperFloor      = 0.15       // Continuous fresh air ventilation floor (ASHRAE 62.1 / QCVN 09:2017/BXD)
	MaxDamperSlewRate       = 1.0 / 60.0 // Actuator full stroke travel 60s (~0.0167 s^-1)
	MaxSafeStaticPressurePa = 650.0      // Duct structural safety limit (Pa)

	// Airflow telemetry noise and broadcast dedupe, as fractions of a box's NOMINAL flow.
	// 1.5% is a realistic flow-station accuracy; the dedupe sits above it so ordinary
	// noise does not by itself count as a change worth streaming.
	flowNoiseFrac  = 0.015
	flowDedupeFrac = 0.04
)
