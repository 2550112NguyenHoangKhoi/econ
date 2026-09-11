package main

import (
	"bytes"
	"context"
	"econ/simulation"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// localInferInput is the JSON structure sent to infer.py over stdin or --input.
type localInferInput struct {
	SensorSequence  [][]float64 `json:"sensor_sequence,omitempty"`
	OutdoorTemp     *float64    `json:"outdoor_temp,omitempty"`
	OutdoorHumidity *float64    `json:"outdoor_humidity,omitempty"`
	History         []float64   `json:"history,omitempty"`
	Horizon         int         `json:"horizon,omitempty"`
}

// localInferOutput is the structured JSON emitted by infer.py to stdout.
type localInferOutput struct {
	Status              string               `json:"status"`
	Engine              string               `json:"engine"`
	PredictedPeakLoad   float64              `json:"predicted_peak_load"`
	OutdoorTempUsed     float64              `json:"outdoor_temp_used"`
	OutdoorHumidityUsed float64              `json:"outdoor_humidity_used"`
	WeatherSource       string               `json:"weather_source"`
	TimestepsUsed       int                  `json:"timesteps_used"`
	Forecast            []float64            `json:"forecast,omitempty"`
	Point               []float64            `json:"point,omitempty"`
	Quantiles           map[string][]float64 `json:"quantiles,omitempty"`
	Device              string               `json:"device,omitempty"`
	ZeroShot            bool                 `json:"zero_shot,omitempty"`
	ContextUsed         int                  `json:"context_used,omitempty"`
	Error               string               `json:"error,omitempty"`
}

// resolvePythonInterpreter searches for a suitable python3 binary.
func resolvePythonInterpreter() string {
	if bin := os.Getenv("PYTHON_BIN"); bin != "" {
		if _, err := exec.LookPath(bin); err == nil {
			return bin
		}
	}

	// Prefer python3 from PATH
	if p, err := exec.LookPath("python3"); err == nil {
		return p
	}

	// Check local venv if python3 is not on PATH
	candidates := []string{
		"backend/forecasting/venv/bin/python3",
		"../backend/forecasting/venv/bin/python3",
		"backend/forecasting/venv/bin/python",
		"../backend/forecasting/venv/bin/python",
	}
	for _, c := range candidates {
		if fi, err := os.Stat(c); err == nil && !fi.IsDir() {
			if abs, err := filepath.Abs(c); err == nil {
				return abs
			}
			return c
		}
	}

	if p, err := exec.LookPath("python"); err == nil {
		return p
	}

	return "python3"
}

// resolveInferScript locates backend/forecasting/infer.py or server/modelbundle/infer.py.
func resolveInferScript() (string, error) {
	if custom := os.Getenv("INFER_SCRIPT_PATH"); custom != "" {
		if fi, err := os.Stat(custom); err == nil && !fi.IsDir() {
			return filepath.Abs(custom)
		}
	}

	candidates := []string{
		"backend/forecasting/infer.py",
		"../backend/forecasting/infer.py",
		"server/modelbundle/infer.py",
		"modelbundle/infer.py",
		"./infer.py",
	}

	// Also check relative to executable or working directory
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates,
			filepath.Join(cwd, "backend", "forecasting", "infer.py"),
			filepath.Join(cwd, "..", "backend", "forecasting", "infer.py"),
			filepath.Join(cwd, "modelbundle", "infer.py"),
			filepath.Join(cwd, "server", "modelbundle", "infer.py"),
		)
	}

	for _, path := range candidates {
		if fi, err := os.Stat(path); err == nil && !fi.IsDir() {
			return filepath.Abs(path)
		}
	}

	return "", fmt.Errorf("infer.py script not found across candidate paths")
}

// isIPCEnabled reports whether inter-process Python inference is active.
func isIPCEnabled() bool {
	if os.Getenv("FORECAST_DISABLE_IPC") == "1" || os.Getenv("DISABLE_IPC_FORECAST") == "1" {
		return false
	}
	return true
}

// executePythonInfer runs infer.py using os/exec.CommandContext, passing input JSON via stdin pipe.
func executePythonInfer(ctx context.Context, modelType string, inputData interface{}) ([]byte, error) {
	scriptPath, err := resolveInferScript()
	if err != nil {
		return nil, fmt.Errorf("local model inference unavailable: %w", err)
	}

	pyBin := resolvePythonInterpreter()

	inputJSON, err := json.Marshal(inputData)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal local inference input: %w", err)
	}

	cmd := exec.CommandContext(ctx, pyBin, scriptPath, "--model", modelType, "--input", "-")
	cmd.Stdin = bytes.NewReader(inputJSON)

	// Set PYTHONPATH to ensure dependencies like typing_extensions in script dir are found
	scriptDir := filepath.Dir(scriptPath)
	env := os.Environ()
	pythonPathFound := false
	for i, e := range env {
		if strings.HasPrefix(e, "PYTHONPATH=") {
			env[i] = fmt.Sprintf("PYTHONPATH=%s:%s", scriptDir, strings.TrimPrefix(e, "PYTHONPATH="))
			pythonPathFound = true
			break
		}
	}
	if !pythonPathFound {
		env = append(env, fmt.Sprintf("PYTHONPATH=%s", scriptDir))
	}
	cmd.Env = env
	cmd.Dir = scriptDir

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	runErr := cmd.Run()
	if runErr != nil {
		errMsg := strings.TrimSpace(stderr.String())
		if errMsg == "" {
			errMsg = runErr.Error()
		}
		return nil, fmt.Errorf("python infer.py execution failed: %s (exit: %v)", errMsg, runErr)
	}

	return stdout.Bytes(), nil
}

// ExecuteLocalInference is the public IPC bridge allowing external callers or tests to invoke local models.
func ExecuteLocalInference(ctx context.Context, modelType string, inputJSON []byte) ([]byte, error) {
	var raw interface{}
	if err := json.Unmarshal(inputJSON, &raw); err != nil {
		return nil, fmt.Errorf("invalid json payload: %w", err)
	}
	return executePythonInfer(ctx, modelType, raw)
}

// queryLSTMIPC invokes local PeakLoadLSTM model via inter-process execution of infer.py.
func queryLSTMIPC(engine *simulation.Engine, req forecastRequest, realSamples int) (engineResult, error) {
	res := engineResult{
		RealSamples: realSamples,
		WindowLen:   forecastWindowLen,
		Basis:       "local supervised LSTM via IPC (infer.py)",
	}

	// Plausibility & cold-start check: If no real telemetry samples have been recorded yet,
	// do not serve ungrounded inference unless explicitly forced.
	if realSamples == 0 && os.Getenv("FORCE_LOCAL_INFERENCE") != "1" && os.Getenv("FORCE_IPC") != "1" {
		res.Error = "cold-start: no real telemetry samples recorded yet"
		return res, fmt.Errorf("cold start: no real telemetry samples")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	payload := localInferInput{
		SensorSequence:  req.SensorSequence,
		OutdoorTemp:     req.OutdoorTemp,
		OutdoorHumidity: req.OutdoorHumidity,
	}

	outBytes, err := executePythonInfer(ctx, "lstm", payload)
	if err != nil {
		res.Error = fmt.Sprintf("local LSTM IPC error: %v", err)
		return res, err
	}

	var out localInferOutput
	if err := json.Unmarshal(outBytes, &out); err != nil {
		res.Error = fmt.Sprintf("failed to parse infer.py JSON: %v", err)
		return res, err
	}

	if out.Status != "ok" {
		res.Error = fmt.Sprintf("infer.py reported error: %s", out.Error)
		return res, fmt.Errorf("infer.py error: %s", out.Error)
	}

	peak := out.PredictedPeakLoad
	res.Available = true
	res.PeakMw = &peak
	res.Basis = fmt.Sprintf("supervised LSTM via local infer.py (%s weather: %.1f°C, %.0f%%)",
		out.WeatherSource, out.OutdoorTempUsed, out.OutdoorHumidityUsed)
	return res, nil
}

// queryTimesFMIPC invokes local TimesFM foundation model via inter-process execution of infer.py.
func queryTimesFMIPC(engine *simulation.Engine, horizon int, history []float64) (engineResult, error) {
	res := engineResult{
		RealSamples: len(history),
		Basis:       "zero-shot TimesFM via local infer.py",
	}

	if len(history) < timesfmMinHistory {
		res.Error = fmt.Sprintf("not enough load history yet: %d of %d samples", len(history), timesfmMinHistory)
		return res, fmt.Errorf("not enough load history: %d < %d", len(history), timesfmMinHistory)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	payload := localInferInput{
		History: history,
		Horizon: horizon,
	}

	outBytes, err := executePythonInfer(ctx, "timesfm", payload)
	if err != nil {
		res.Error = fmt.Sprintf("local TimesFM IPC error: %v", err)
		return res, err
	}

	var out localInferOutput
	if err := json.Unmarshal(outBytes, &out); err != nil {
		res.Error = fmt.Sprintf("failed to parse infer.py TimesFM JSON: %v", err)
		return res, err
	}

	if out.Status != "ok" {
		res.Error = fmt.Sprintf("infer.py TimesFM error: %s", out.Error)
		return res, fmt.Errorf("infer.py TimesFM error: %s", out.Error)
	}

	series := out.Forecast
	if len(series) == 0 {
		series = out.Point
	}
	if len(series) == 0 {
		res.Error = "infer.py TimesFM returned empty series"
		return res, fmt.Errorf("infer.py TimesFM returned empty series")
	}

	peak := series[0]
	for _, v := range series[1:] {
		if v > peak {
			peak = v
		}
	}

	res.Available = true
	res.PeakMw = &peak
	res.Series = series

	if len(out.Quantiles) > 0 {
		res.Quantiles = out.Quantiles
		if key, band := highestQuantile(out.Quantiles); band != nil {
			res.UpperQuantile = key
			res.PeakUpperMw = band
		}
	}

	return res, nil
}

// BuildForecastGraphLocal generates a live forecast graph strictly using local Python models via IPC.
func BuildForecastGraphLocal(engine *simulation.Engine, horizon int) *simulation.ForecastGraphData {
	if horizon <= 0 {
		horizon = 12
	}

	req, realSamples := buildForecastRequest(engine)
	history := engine.LoadHistory()

	lstmRes, lstmErr := queryLSTMIPC(engine, req, realSamples)
	tfmRes, tfmErr := queryTimesFMIPC(engine, horizon, history)

	if lstmErr != nil {
		log.Printf("[forecast_ipc] local LSTM inference warning: %v", lstmErr)
	}
	if tfmErr != nil {
		log.Printf("[forecast_ipc] local TimesFM inference warning: %v", tfmErr)
	}

	lo, hi, n := engine.ObservedLoadRange()
	checkPlausible(&lstmRes, lo, hi, n)
	checkPlausible(&tfmRes, lo, hi, n)

	// 1. TimesFM zero-shot foundation model
	if tfmRes.Available && len(tfmRes.Series) > 0 {
		var upperBand []float64
		if tfmRes.Quantiles != nil && tfmRes.UpperQuantile != "" {
			upperBand = tfmRes.Quantiles[tfmRes.UpperQuantile]
		}
		var lstmPeak *float64
		if lstmRes.Available && lstmRes.PeakMw != nil {
			lstmPeak = lstmRes.PeakMw
		}
		return &simulation.ForecastGraphData{
			Engine:         "timesfm",
			Series:         tfmRes.Series,
			UpperBand:      upperBand,
			UpperQuantile:  tfmRes.UpperQuantile,
			PeakUpperMw:    tfmRes.PeakUpperMw,
			LstmPeakMw:     lstmPeak,
			StepMinutes:    histIntervalMinutes,
			HorizonMinutes: len(tfmRes.Series) * histIntervalMinutes,
			Plausible:      !tfmRes.Implausible,
			Plausibility:   tfmRes.Plausibility,
			Samples:        tfmRes.RealSamples,
			Quantiles:      tfmRes.Quantiles,
		}
	}

	// 2. Supervised LSTM model
	if lstmRes.Available && lstmRes.PeakMw != nil {
		series := generateLstmTrajectory(engine, *lstmRes.PeakMw, horizon)
		upperBand := make([]float64, len(series))
		for i, v := range series {
			upperBand[i] = math.Round(v*1.10*10000) / 10000
		}
		upperPeak := math.Round(*lstmRes.PeakMw*1.10*10000) / 10000
		// UpperQuantile names a key into Quantiles, and the dashboard resolves the band
		// by that lookup (useForecastCompare.js). Publish the bands this branch actually
		// computed so the lookup succeeds. The LSTM regressor predicts only a scalar peak,
		// so there is no lower band to report here -- do not invent one.
		quantiles := map[string][]float64{"q5": series, "q9": upperBand}
		return &simulation.ForecastGraphData{
			Engine:         "lstm",
			Series:         series,
			UpperBand:      upperBand,
			UpperQuantile:  "q9",
			PeakUpperMw:    &upperPeak,
			LstmPeakMw:     lstmRes.PeakMw,
			StepMinutes:    histIntervalMinutes,
			HorizonMinutes: horizon * histIntervalMinutes,
			Plausible:      !lstmRes.Implausible,
			Plausibility:   lstmRes.Plausibility,
			Samples:        lstmRes.RealSamples,
			Quantiles:      quantiles,
		}
	}

	// 3. Fallback
	return generateFallbackForecast(engine, horizon)
}
