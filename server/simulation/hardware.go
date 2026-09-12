// hardware — the hardware node view the dashboard renders.
//
// Split out of engine.go, which had grown to 3,541 lines. Same package, same code:
// nothing here was rewritten, only moved to a file named after what it does.

package simulation

import (
	"sort"
	"time"
)

// HardwareNode is one physical edge-node binding as reported by GET /api/hardware.
type HardwareNode struct {
	ZoneId     string  `json:"zoneId"`
	Topic      string  `json:"topic"`
	Source     string  `json:"source"`
	Online     bool    `json:"online"`
	TempPinned bool    `json:"tempPinned"`
	Occupancy  int     `json:"occupancy"`
	ZoneTemp   float64 `json:"zoneTemp"`
	HwTemp     float64 `json:"hwTemp"`
	Humidity   float64 `json:"humidity"`
	Co2        float64 `json:"co2"`
	LightsOn   bool    `json:"lightsOn"`
	Setpoint   float64 `json:"setpoint"`
	AgeSec     float64 `json:"ageSec"`
	// Physics-grounded AFDD outputs (zero until the zone's first real temperature).
	ShadowTemp float64 `json:"shadowTemp"`
	Residual   float64 `json:"residual"`
	AfddAlert  bool    `json:"afddAlert"`
	// APLC: live clamp watts (0 = no meter reporting) and current sweep state.
	PlugW    float64 `json:"plugW"`
	PlugShed bool    `json:"plugShed"`
	StripW   float64 `json:"stripW"`
	// Closed-loop AC control: whether this node's setpoint commands reach a real machine.
	// AcControlKnown is false for firmware predating the acReal field.
	AcReal         bool `json:"acReal"`
	AcControlKnown bool `json:"acControlKnown"`
	// [GEMINI IMPLEMENTATION START]
	DetectedProtocol string  `json:"detectedProtocol"`
	PirState         *bool   `json:"pirState"`
	CameraEvent      *string `json:"cameraEvent"`
	IrState          *string `json:"irState"`
	// [GEMINI IMPLEMENTATION END]

	// Derived presence: the radar's assertion cross-checked against respiration. Carried
	// beside Occupancy, never instead of it -- Occupancy remains the node's raw measurement,
	// and this says whether CO2 agrees with it.
	Presence *PresenceFusion `json:"presence,omitempty"`
}

// HardwareStatus snapshots every zone currently bound to a physical edge node, for the
// dashboard's live-hardware indicators.
func (e *Engine) HardwareStatus() []HardwareNode {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := []HardwareNode{}
	for id, z := range e.Zones {
		if z.HwSeenAt.IsZero() {
			continue
		}
		age := time.Since(z.HwSeenAt).Seconds()
		// Report an environmental only while its own sensor is still reporting, so this
		// endpoint agrees with the telemetry stream rather than showing a last-known value
		// the dashboard has already dropped.
		hum, co2, plugW, stripW := 0.0, 0.0, 0.0, 0.0
		if z.humFresh() {
			hum = z.HwHum
		}
		if z.co2Fresh() {
			co2 = z.HwCo2
		}
		if z.plugFresh() {
			plugW = z.HwPlugW
		}
		if z.stripFresh() {
			stripW = z.HwStripW
		}
		out = append(out, HardwareNode{
			ZoneId:     id,
			Topic:      z.MqttTopic,
			Source:     z.HwSource,
			Online:     z.HwOnline && age < 60,
			TempPinned: z.hwFresh(),
			Occupancy:  z.Occupancy,
			ZoneTemp:   z.Temp,
			HwTemp:     z.HwTemp,
			Humidity:   hum,
			Co2:        co2,
			LightsOn:   z.LightsOn,
			Setpoint:   z.Setpoint,
			AgeSec:     age,
			ShadowTemp: z.ShadowTemp,
			Residual:   z.ResidualEma,
			AfddAlert:  z.ShadowTemp != 0 && z.ResidualEma > afddThreshold,
			PlugW:      plugW,
			PlugShed:   z.PlugShed,
			StripW:     stripW,
			// Whether this node's setpoint commands actually reach an air conditioner.
			AcReal:         z.HwAcReal,
			AcControlKnown: z.HwAcRealSeen,
			// [GEMINI IMPLEMENTATION START]
			DetectedProtocol: z.DetectedProtocol,
			PirState:         z.PirState,
			CameraEvent:      z.CameraEvent,
			IrState:          z.IrState,
			// [GEMINI IMPLEMENTATION END]
			Presence: z.Presence,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ZoneId < out[j].ZoneId })
	return out
}
