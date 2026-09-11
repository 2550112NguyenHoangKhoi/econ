package main

import (
	"archive/zip"
	"bytes"
	"context"
	"econ/simulation"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// TestLocalModelInference_RawIPCExecution verifies that the Go backend executes
// infer.py via IPC and receives valid JSON predictions from PyTorch PeakLoadLSTM.
func TestLocalModelInference_RawIPCExecution(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	input := localInferInput{
		SensorSequence: [][]float64{
			{24.0, 0.4}, {24.2, 0.4}, {24.5, 0.5}, {24.8, 0.5},
			{25.0, 0.6}, {25.2, 0.6}, {25.5, 0.7}, {25.8, 0.7},
			{26.0, 0.8}, {26.2, 0.8}, {26.5, 0.9}, {27.0, 1.0},
		},
		OutdoorTemp:     floatPtr(31.5),
		OutdoorHumidity: floatPtr(68.0),
	}
	inputBytes, err := json.Marshal(input)
	if err != nil {
		t.Fatalf("failed to marshal input JSON: %v", err)
	}

	outBytes, err := ExecuteLocalInference(ctx, "lstm", inputBytes)
	if err != nil {
		t.Fatalf("ExecuteLocalInference failed: %v", err)
	}

	var out localInferOutput
	if err := json.Unmarshal(outBytes, &out); err != nil {
		t.Fatalf("failed to parse output JSON: %v (raw: %s)", err, string(outBytes))
	}

	if out.Status != "ok" {
		t.Fatalf("expected status 'ok', got %q (error: %s)", out.Status, out.Error)
	}
	if out.Engine != "lstm" {
		t.Errorf("expected engine 'lstm', got %q", out.Engine)
	}
	if out.PredictedPeakLoad <= 0 {
		t.Errorf("expected positive predicted peak load, got %f", out.PredictedPeakLoad)
	}
	if out.TimestepsUsed != 12 {
		t.Errorf("expected 12 timesteps used, got %d", out.TimestepsUsed)
	}
	if out.OutdoorTempUsed != 31.5 {
		t.Errorf("expected outdoor temp 31.5, got %f", out.OutdoorTempUsed)
	}
	if out.OutdoorHumidityUsed != 68.0 {
		t.Errorf("expected outdoor humidity 68.0, got %f", out.OutdoorHumidityUsed)
	}
}

// TestLocalModelInference_QueryLSTMIPC_Direct tests direct invocation of queryLSTMIPC.
func TestLocalModelInference_QueryLSTMIPC_Direct(t *testing.T) {
	origForce := os.Getenv("FORCE_IPC")
	os.Setenv("FORCE_IPC", "1")
	defer os.Setenv("FORCE_IPC", origForce)

	engine := simulation.NewEngine()
	req := forecastRequest{
		SensorSequence: [][]float64{
			{25.0, 0.5}, {25.0, 0.5}, {25.0, 0.5}, {25.0, 0.5},
			{25.0, 0.5}, {25.0, 0.5}, {25.0, 0.5}, {25.0, 0.5},
			{25.0, 0.5}, {25.0, 0.5}, {25.0, 0.5}, {25.0, 0.5},
		},
		OutdoorTemp:     floatPtr(30.0),
		OutdoorHumidity: floatPtr(70.0),
	}

	res, err := queryLSTMIPC(engine, req, 12)
	if err != nil {
		t.Fatalf("queryLSTMIPC returned error: %v", err)
	}
	if !res.Available {
		t.Fatalf("expected res.Available to be true, error: %s", res.Error)
	}
	if res.PeakMw == nil || *res.PeakMw <= 0 {
		t.Fatalf("expected valid non-zero peak load, got %v", res.PeakMw)
	}
	// Basis must describe what actually produced the number. Without torch installed,
	// infer.py answers from its placeholder branch and Basis says so -- asserting
	// "supervised LSTM" there would be asserting the very claim the placeholder must not
	// make. Check the degraded contract instead, so both environments are covered.
	if res.Degraded {
		if strings.Contains(res.Basis, "supervised LSTM") {
			t.Errorf("a degraded result must not describe itself as the supervised LSTM, got %q", res.Basis)
		}
		if res.Basis == "" {
			t.Error("a degraded result must say why it is degraded, got an empty basis")
		}
	} else if !strings.Contains(res.Basis, "supervised LSTM") {
		t.Errorf("expected basis to describe supervised LSTM, got %q", res.Basis)
	}
}

// TestLocalModelInference_LiveHTTPFallbackToIPC verifies that when FORECAST_URL is unreachable,
// BuildForecastGraph seamlessly falls back to local Python model execution and produces
// a genuine non-fallback forecast.
func TestLocalModelInference_LiveHTTPFallbackToIPC(t *testing.T) {
	origURL := os.Getenv("FORECAST_URL")
	os.Setenv("FORECAST_URL", "http://127.0.0.1:59999") // unreachable port
	defer os.Setenv("FORECAST_URL", origURL)

	origForce := os.Getenv("FORCE_IPC")
	os.Setenv("FORCE_IPC", "1")
	defer os.Setenv("FORCE_IPC", origForce)

	origClient := forecastHttpClient
	forecastHttpClient = nil
	defer func() { forecastHttpClient = origClient }()

	engine := simulation.NewEngine()
	engine.SetOutdoor(31.0, 65.0)

	graph := BuildForecastGraph(engine, 12)
	if graph == nil {
		t.Fatal("expected non-nil ForecastGraphData")
	}

	// CRITICAL REQUIREMENT: Must NOT fall back to persistence dummy engine!
	if graph.Engine == "fallback" {
		t.Fatalf("expected live local AI model engine ('lstm' or 'timesfm'), but got %q", graph.Engine)
	}
	if graph.Engine != "lstm" && graph.Engine != "timesfm" {
		t.Fatalf("unexpected engine %q", graph.Engine)
	}

	if graph.LstmPeakMw == nil || *graph.LstmPeakMw <= 0 {
		t.Fatalf("expected valid non-zero LstmPeakMw, got %v", graph.LstmPeakMw)
	}
	if len(graph.Series) != 12 {
		t.Errorf("expected 12 points in Series, got %d", len(graph.Series))
	}
	if len(graph.UpperBand) != 12 {
		t.Errorf("expected 12 points in UpperBand, got %d", len(graph.UpperBand))
	}
	if graph.StepMinutes != 5 {
		t.Errorf("expected StepMinutes 5, got %d", graph.StepMinutes)
	}
	if graph.HorizonMinutes != 60 {
		t.Errorf("expected HorizonMinutes 60, got %d", graph.HorizonMinutes)
	}
	if graph.Plausibility == "" {
		t.Errorf("expected non-empty Plausibility description")
	}
}

// TestLocalModelInference_BuildForecastGraphLocal verifies direct local graph generation.
func TestLocalModelInference_BuildForecastGraphLocal(t *testing.T) {
	origForce := os.Getenv("FORCE_IPC")
	os.Setenv("FORCE_IPC", "1")
	defer os.Setenv("FORCE_IPC", origForce)

	engine := simulation.NewEngine()
	engine.SetOutdoor(32.0, 70.0)

	graph := BuildForecastGraphLocal(engine, 12)
	if graph == nil {
		t.Fatal("expected non-nil ForecastGraphData")
	}
	if graph.Engine != "lstm" && graph.Engine != "timesfm" {
		t.Fatalf("expected local AI model engine, got %q", graph.Engine)
	}
	if graph.LstmPeakMw == nil || *graph.LstmPeakMw <= 0 {
		t.Fatalf("expected valid positive LstmPeakMw, got %v", graph.LstmPeakMw)
	}
}

// TestLocalModelInference_PhysicalMonotonicity verifies that the local model produces
// higher predicted load for hotter conditions with higher cooling demand.
func TestLocalModelInference_PhysicalMonotonicity(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	coolSeq := make([][]float64, 12)
	for i := range coolSeq {
		coolSeq[i] = []float64{22.0, 0.3}
	}
	coolInput := localInferInput{
		SensorSequence:  coolSeq,
		OutdoorTemp:     floatPtr(26.0),
		OutdoorHumidity: floatPtr(60.0),
	}
	coolBytes, _ := json.Marshal(coolInput)
	coolOutBytes, err := ExecuteLocalInference(ctx, "lstm", coolBytes)
	if err != nil {
		t.Fatalf("cool inference failed: %v", err)
	}

	hotSeq := make([][]float64, 12)
	for i := range hotSeq {
		hotSeq[i] = []float64{28.0, 0.9}
	}
	hotInput := localInferInput{
		SensorSequence:  hotSeq,
		OutdoorTemp:     floatPtr(34.0),
		OutdoorHumidity: floatPtr(75.0),
	}
	hotBytes, _ := json.Marshal(hotInput)
	hotOutBytes, err := ExecuteLocalInference(ctx, "lstm", hotBytes)
	if err != nil {
		t.Fatalf("hot inference failed: %v", err)
	}

	var coolOut, hotOut localInferOutput
	json.Unmarshal(coolOutBytes, &coolOut)
	json.Unmarshal(hotOutBytes, &hotOut)

	if hotOut.PredictedPeakLoad < coolOut.PredictedPeakLoad {
		t.Fatalf("monotonicity violation: hot load (%f MW) should be >= cool load (%f MW)",
			hotOut.PredictedPeakLoad, coolOut.PredictedPeakLoad)
	}
}

// TestLocalModelInference_CLI_FlagsAndStdin verifies that infer.py can be invoked
// via --input argument and via standard input pipe.
func TestLocalModelInference_CLI_FlagsAndStdin(t *testing.T) {
	scriptPath, err := resolveInferScript()
	if err != nil {
		t.Fatalf("failed to locate infer.py: %v", err)
	}
	pyBin := resolvePythonInterpreter()

	payload := `{"sensor_sequence": [[24.0, 0.5],[24.0, 0.5],[24.0, 0.5],[24.0, 0.5],[24.0, 0.5],[24.0, 0.5],[24.0, 0.5],[24.0, 0.5],[24.0, 0.5],[24.0, 0.5],[24.0, 0.5],[24.0, 0.5]], "outdoor_temp": 30.0, "outdoor_humidity": 70.0}`

	// 1. Test via --input argument
	cmd1 := exec.Command(pyBin, scriptPath, "--model", "lstm", "--input", payload)
	cmd1.Dir = scriptPath[:strings.LastIndex(scriptPath, "/")]
	out1, err1 := cmd1.CombinedOutput()
	if err1 != nil {
		t.Fatalf("CLI invocation via --input failed: %v, output: %s", err1, string(out1))
	}
	var res1 localInferOutput
	if err := json.Unmarshal(out1, &res1); err != nil || res1.Status != "ok" {
		t.Fatalf("CLI --input output malformed or not ok: %s", string(out1))
	}

	// 2. Test via standard input pipe
	cmd2 := exec.Command(pyBin, scriptPath, "--model", "lstm")
	cmd2.Dir = scriptPath[:strings.LastIndex(scriptPath, "/")]
	cmd2.Stdin = strings.NewReader(payload)
	out2, err2 := cmd2.CombinedOutput()
	if err2 != nil {
		t.Fatalf("CLI invocation via stdin pipe failed: %v, output: %s", err2, string(out2))
	}
	var res2 localInferOutput
	if err := json.Unmarshal(out2, &res2); err != nil || res2.Status != "ok" {
		t.Fatalf("CLI stdin output malformed or not ok: %s", string(out2))
	}

	if res1.PredictedPeakLoad <= 0 || res2.PredictedPeakLoad <= 0 {
		t.Fatalf("expected positive predicted peak load from both CLI runs")
	}
}

// TestLocalModelInference_ExportBundleIncludesInfer verifies that downloading the
// offline model bundle (.zip) includes infer.py and the trained forecaster weights.
func TestLocalModelInference_ExportBundleIncludesInfer(t *testing.T) {
	engine := simulation.NewEngine()
	handler := modelExportHandler(engine)

	req := httptest.NewRequest("GET", "/api/model/export?tier=forecast-cpu", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200 OK, got %d", rec.Code)
	}

	body := rec.Body.Bytes()
	zipReader, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatalf("failed to open zip reader: %v", err)
	}

	fileMap := make(map[string]*zip.File)
	for _, f := range zipReader.File {
		fileMap[f.Name] = f
	}

	// Verify infer.py is present in bundle
	if _, ok := fileMap["infer.py"]; !ok {
		t.Errorf("infer.py missing from root of exported zip bundle")
	}

	// Verify forecaster weights, scaler, and config are present
	expectedFiles := []string{
		"README.md",
		"MANIFEST.json",
		"recommender.py",
		"econ_local.py",
		"forecaster/model_weights.pth",
		"forecaster/scaler.pkl",
		"forecaster/config.json",
	}
	for _, expected := range expectedFiles {
		if _, ok := fileMap[expected]; !ok {
			t.Errorf("expected file %q missing from exported zip bundle", expected)
		}
	}

	// Verify README.md contains instructions for running infer.py
	if readmeFile, ok := fileMap["README.md"]; ok {
		rc, err := readmeFile.Open()
		if err == nil {
			defer rc.Close()
			content, _ := io.ReadAll(rc)
			if !strings.Contains(string(content), "infer.py") {
				t.Errorf("README.md in bundle does not mention infer.py instructions")
			}
		}
	}
}

func floatPtr(v float64) *float64 {
	return &v
}
