package e2e_tests

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"econ/simulation"
)

// GenerateSineWave synthesizes ADC counts for an AC sinusoidal current.
// Matches the physical sensor characteristics of ESP32 ADC1 with ACS712 / SCT-013.
func GenerateSineWave(
	rmsAmps float64,
	calAPerV float64,
	dividerRatio float64,
	sampleRateHz float64,
	durationSec float64,
	freqHz float64,
	dcVolts float64,
	noiseSigma float64,
	seed int64,
) []int {
	nSamples := int(durationSec * sampleRateHz)
	if nSamples <= 0 {
		nSamples = 100
	}
	samples := make([]int, nSamples)

	// Peak voltage at the ADC pin after voltage divider
	vPeakAdc := (rmsAmps * math.Sqrt(2.0) / calAPerV) * dividerRatio
	dt := 1.0 / sampleRateHz

	rng := rand.New(rand.NewSource(seed))

	for i := 0; i < nSamples; i++ {
		t := float64(i) * dt
		vAc := vPeakAdc * math.Sin(2.0*math.Pi*freqHz*t)
		vTotal := dcVolts + vAc
		noise := rng.NormFloat64() * noiseSigma
		rawCount := vTotal*(4095.0/3.3) + noise
		count := int(math.Round(rawCount))
		if count < 0 {
			count = 0
		}
		if count > 4095 {
			count = 4095
		}
		samples[i] = count
	}
	return samples
}

// CapturedCommand records an MQTT command published by the engine.
type CapturedCommand struct {
	Topic   string
	Payload string
	Time    time.Time
}

// TestEngineWrapper bundles a simulation.Engine with recorded MQTT command history.
type TestEngineWrapper struct {
	Engine   *simulation.Engine
	Commands []CapturedCommand
}

// LastCommand returns the most recent MQTT command captured.
func (w *TestEngineWrapper) LastCommand() (CapturedCommand, bool) {
	if len(w.Commands) == 0 {
		return CapturedCommand{}, false
	}
	return w.Commands[len(w.Commands)-1], true
}

// ClearCommands flushes the recorded command buffer.
func (w *TestEngineWrapper) ClearCommands() {
	w.Commands = nil
}

// SetupTestEngine initializes an in-memory simulation engine with standard building zones.
func SetupTestEngine() *simulation.Engine {
	wrapper := SetupTestEngineWithWrapper()
	return wrapper.Engine
}

// SetupTestEngineWithWrapper initializes an in-memory simulation engine wrapped with command interception.
func SetupTestEngineWithWrapper() *TestEngineWrapper {
	engine := simulation.NewEngine()
	engine.Zones = make(map[string]*simulation.ZoneSim)
	engine.Vavs = make(map[string]*simulation.VavSim)

	irActive := "COOL_24"
	irOff := "OFF"

	// Zone 1: Open Office (standard occupancy, active HVAC)
	engine.Zones["zone-office-a"] = &simulation.ZoneSim{
		Type:         "office",
		Temp:         24.0,
		BaseSetpoint: 24.0,
		Setpoint:     24.0,
		AreaM2:       60.0,
		Occupancy:    5,
		LightsOn:     true,
		IrState:      &irActive,
		MqttTopic:    "esp32-office-01",
		Live:         true,
		PlugShed:     false,
		DamperPos:    1.0,
	}

	// Zone 2: Executive Boardroom (intermittent occupancy, default AC OFF)
	engine.Zones["zone-boardroom"] = &simulation.ZoneSim{
		Type:         "meeting",
		Temp:         23.5,
		BaseSetpoint: 23.5,
		Setpoint:     23.5,
		AreaM2:       40.0,
		Occupancy:    0,
		LightsOn:     false,
		IrState:      &irOff,
		MqttTopic:    "esp32-boardroom-01",
		Live:         true,
		PlugShed:     false,
		DamperPos:    0.5,
	}

	// Zone 3: Server Room (continuous equipment load, 0 occupancy, AC OFF for occupancy recs)
	engine.Zones["zone-server-room"] = &simulation.ZoneSim{
		Type:         "datacenter",
		Temp:         20.0,
		BaseSetpoint: 20.0,
		Setpoint:     20.0,
		AreaM2:       30.0,
		Occupancy:    0,
		LightsOn:     true,
		IrState:      &irOff,
		MqttTopic:    "esp32-server-01",
		Live:         true,
		PlugShed:     false,
		DamperPos:    1.0,
	}

	// Associated VAV dampers for fluid dynamics & actuation testing
	engine.Vavs["vav-office-a"] = &simulation.VavSim{
		TargetZone:       "zone-office-a",
		DesignResistance: 1.0,
		Damper:           1.0,
		DamperPos:        1.0,
		TargetDamperPos:  1.0,
	}
	engine.Vavs["vav-boardroom"] = &simulation.VavSim{
		TargetZone:       "zone-boardroom",
		DesignResistance: 1.0,
		Damper:           0.5,
		DamperPos:        0.5,
		TargetDamperPos:  0.5,
	}

	wrapper := &TestEngineWrapper{
		Engine:   engine,
		Commands: make([]CapturedCommand, 0),
	}

	// Intercept PublishCommand MQTT publications
	engine.Publish = func(topic, payload string) {
		wrapper.Commands = append(wrapper.Commands, CapturedCommand{
			Topic:   topic,
			Payload: payload,
			Time:    time.Now(),
		})
	}

	return wrapper
}

// TrainOccupancyBaseline folds N observations into the zone's occupancy baseline.
func TrainOccupancyBaseline(engine *simulation.Engine, zone string, mean float64, std float64, numObservations int, now time.Time) {
	rng := rand.New(rand.NewSource(42))
	for i := 0; i < numObservations; i++ {
		val := mean + rng.NormFloat64()*std
		if val < 0 {
			val = 0
		}
		engine.ObserveBaseline(zone, "occupancy", val, now)
	}
}

// FindZoneRecommendation searches the list of recommendations for a specific zone, metric, and action.
func FindZoneRecommendation(recs []simulation.Recommendation, zone string, metric string, action string) *simulation.Recommendation {
	for i := range recs {
		if (zone == "" || recs[i].Zone == zone) &&
			(metric == "" || recs[i].Metric == metric) &&
			(action == "" || recs[i].Action == action) {
			return &recs[i]
		}
	}
	return nil
}

// AssertRecommendationBasis checks whether a recommendation matches the expected basis ("learned" or "standard").
func AssertRecommendationBasis(t *testing.T, rec *simulation.Recommendation, expectedBasis string) {
	t.Helper()
	if rec == nil {
		t.Fatalf("expected recommendation but got nil")
	}
	if rec.Basis != expectedBasis {
		t.Fatalf("expected recommendation Basis=%q, got Basis=%q (id=%s, msg=%s)",
			expectedBasis, rec.Basis, rec.Id, rec.Message)
	}
}

// CalculateExpectedScope2Emissions derives the authoritative Scope 2 carbon emission (in kgCO2e).
// Formula: E_kg = (Watts / 1000.0) * hours * gridEmissionFactor
func CalculateExpectedScope2Emissions(watts float64, hours float64, gridFactor float64) float64 {
	kwh := (watts / 1000.0) * hours
	return kwh * gridFactor
}

// CalculateExpectedCarbonCreditOffset derives the expected offset deficit, whole certificates, and cost.
func CalculateExpectedCarbonCreditOffset(budgetKg float64, emissionsKg float64, pricePerTonUSD float64) (deficitKg float64, certs int, costUSD float64) {
	if emissionsKg <= budgetKg {
		return 0.0, 0, 0.0
	}
	deficitKg = emissionsKg - budgetKg
	// Whole certificates: 1 certificate = 1 metric ton = 1,000 kgCO2e
	certs = int(math.Ceil(deficitKg / 1000.0))
	costUSD = float64(certs) * pricePerTonUSD
	return deficitKg, certs, costUSD
}

// ExecutePythonInference invokes backend/forecasting/infer.py directly via CLI.
func ExecutePythonInference(model string, inputJSON string, extraArgs ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	candidates := []string{
		"../backend/forecasting/infer.py",
		"backend/forecasting/infer.py",
		"../../backend/forecasting/infer.py",
	}
	var scriptPath string
	for _, c := range candidates {
		if fi, err := os.Stat(c); err == nil && !fi.IsDir() {
			scriptPath, _ = filepath.Abs(c)
			break
		}
	}
	if scriptPath == "" {
		return nil, fmt.Errorf("infer.py not found in candidates: %v", candidates)
	}

	forecastingDir := filepath.Dir(scriptPath)

	args := []string{scriptPath, "--model", model, "--input", inputJSON}
	args = append(args, extraArgs...)

	cmd := exec.CommandContext(ctx, "python3", args...)
	cmd.Env = append(os.Environ(),
		"PYTHONPATH="+forecastingDir,
		"PYTHONNOUSERSITE=1",
	)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	if err != nil {
		return nil, fmt.Errorf("infer.py execution failed (%v): stdout=%s stderr=%s",
			err, stdout.String(), stderr.String())
	}

	return stdout.Bytes(), nil
}

// ParseFloatOrZero converts a string to float64 safely.
func ParseFloatOrZero(s string) float64 {
	v, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0.0
	}
	return v
}

// ParseIntOrZero converts a string to int safely.
func ParseIntOrZero(s string) int {
	v, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil {
		return 0
	}
	return v
}

// JSONDecode parses JSON into destination v.
func JSONDecode(data []byte, v interface{}) error {
	return json.Unmarshal(data, v)
}
