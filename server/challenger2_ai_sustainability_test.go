package main

import (
	"context"
	"econ/simulation"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

// =========================================================================
// SECTION 1: Local AI Live Inference & PyTorch Variance Stress Tests
// =========================================================================

// TestChallenger2_PyTorchVarianceAndRealExecution verifies that the local AI
// model produces distinct, varying output predictions across different input sequences
// (confirming genuine PyTorch neural network forward passes rather than fixed mocks).
func TestChallenger2_PyTorchVarianceAndRealExecution(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cases := []struct {
		name     string
		temp     float64
		airflow  float64
		outTemp  float64
		outHum   float64
	}{
		{"cold_idle", 19.0, 100.0, 18.0, 45.0},
		{"moderate_cool", 22.0, 250.0, 26.0, 55.0},
		{"standard_comfort", 24.5, 400.0, 31.0, 65.0},
		{"warm_demand", 27.0, 600.0, 36.0, 75.0},
		{"extreme_hot_peak", 31.0, 850.0, 42.0, 80.0},
	}

	predictions := make(map[string]float64)
	for _, tc := range cases {
		seq := make([][]float64, 12)
		for i := 0; i < 12; i++ {
			seq[i] = []float64{tc.temp, tc.airflow}
		}
		inp := localInferInput{
			SensorSequence:  seq,
			OutdoorTemp:     &tc.outTemp,
			OutdoorHumidity: &tc.outHum,
		}
		rawInp, err := json.Marshal(inp)
		if err != nil {
			t.Fatalf("[%s] marshal failed: %v", tc.name, err)
		}

		outBytes, err := ExecuteLocalInference(ctx, "lstm", rawInp)
		if err != nil {
			t.Fatalf("[%s] ExecuteLocalInference failed: %v", tc.name, err)
		}

		var out localInferOutput
		if err := json.Unmarshal(outBytes, &out); err != nil {
			t.Fatalf("[%s] unmarshal failed: %v, raw: %s", tc.name, err, string(outBytes))
		}
		if out.Status != "ok" {
			t.Fatalf("[%s] status not ok: %s", tc.name, out.Error)
		}
		if out.Engine != "lstm" {
			t.Errorf("[%s] expected engine 'lstm', got %s", tc.name, out.Engine)
		}
		if out.PredictedPeakLoad <= 0 {
			t.Errorf("[%s] expected positive predicted load, got %f", tc.name, out.PredictedPeakLoad)
		}
		predictions[tc.name] = out.PredictedPeakLoad
		t.Logf("[%s] -> predicted_peak_load: %.4f MW", tc.name, out.PredictedPeakLoad)
	}

	// Verify all 5 predictions are strictly unique (proves not a fixed mock value)
	seen := make(map[float64]bool)
	for name, val := range predictions {
		if seen[val] {
			t.Fatalf("Duplicate prediction detected: %s produced identical output %f. Real inference requires variance!", name, val)
		}
		seen[val] = true
	}

	// Verify physical monotonicity: colder sequence must yield <= hotter sequence
	if predictions["cold_idle"] >= predictions["extreme_hot_peak"] {
		t.Fatalf("Monotonicity violation: cold_idle (%.4f MW) >= extreme_hot_peak (%.4f MW)",
			predictions["cold_idle"], predictions["extreme_hot_peak"])
	}
}

// TestChallenger2_SequenceLengthVariations verifies padding (<12) and truncation (>12).
func TestChallenger2_SequenceLengthVariations(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	baseTemp := 25.0
	baseFlow := 400.0
	outTemp := 32.0
	outHum := 65.0

	// 1. Sequence length = 12 (standard reference)
	refSeq := make([][]float64, 12)
	for i := 0; i < 12; i++ {
		refSeq[i] = []float64{baseTemp, baseFlow}
	}
	refInp, _ := json.Marshal(localInferInput{
		SensorSequence:  refSeq,
		OutdoorTemp:     &outTemp,
		OutdoorHumidity: &outHum,
	})
	refBytes, err := ExecuteLocalInference(ctx, "lstm", refInp)
	if err != nil {
		t.Fatalf("ref 12-sample inference failed: %v", err)
	}
	var refOut localInferOutput
	json.Unmarshal(refBytes, &refOut)
	refPred := refOut.PredictedPeakLoad

	// 2. Length < 12 (1, 3, 7, 11 samples) -> Must pad to 12
	shortLengths := []int{1, 3, 7, 11}
	for _, l := range shortLengths {
		shortSeq := make([][]float64, l)
		for i := 0; i < l; i++ {
			shortSeq[i] = []float64{baseTemp, baseFlow}
		}
		shortInp, _ := json.Marshal(localInferInput{
			SensorSequence:  shortSeq,
			OutdoorTemp:     &outTemp,
			OutdoorHumidity: &outHum,
		})
		outBytes, err := ExecuteLocalInference(ctx, "lstm", shortInp)
		if err != nil {
			t.Fatalf("[len=%d] inference failed: %v", l, err)
		}
		var out localInferOutput
		json.Unmarshal(outBytes, &out)
		if out.Status != "ok" {
			t.Fatalf("[len=%d] expected ok, got %s", l, out.Error)
		}
		if out.TimestepsUsed != 12 {
			t.Errorf("[len=%d] expected timesteps_used 12, got %d", l, out.TimestepsUsed)
		}
		diff := math.Abs(out.PredictedPeakLoad - refPred)
		if diff > 1e-4 {
			t.Errorf("[len=%d] padding mismatch: got %f, expected %f (diff %e)", l, out.PredictedPeakLoad, refPred, diff)
		}
	}

	// 3. Length > 12 (15, 30, 60 samples) -> Must truncate to last 12
	longLengths := []int{15, 30, 60}
	for _, l := range longLengths {
		longSeq := make([][]float64, l)
		for i := 0; i < l-12; i++ {
			longSeq[i] = []float64{10.0, 50.0}
		}
		for i := l - 12; i < l; i++ {
			longSeq[i] = []float64{baseTemp, baseFlow}
		}
		longInp, _ := json.Marshal(localInferInput{
			SensorSequence:  longSeq,
			OutdoorTemp:     &outTemp,
			OutdoorHumidity: &outHum,
		})
		outBytes, err := ExecuteLocalInference(ctx, "lstm", longInp)
		if err != nil {
			t.Fatalf("[len=%d] inference failed: %v", l, err)
		}
		var out localInferOutput
		json.Unmarshal(outBytes, &out)
		if out.Status != "ok" {
			t.Fatalf("[len=%d] expected ok, got %s", l, out.Error)
		}
		diff := math.Abs(out.PredictedPeakLoad - refPred)
		if diff > 1e-4 {
			t.Errorf("[len=%d] truncation failed: got %f, expected %f (diff %e)", l, out.PredictedPeakLoad, refPred, diff)
		}
	}
}

// TestChallenger2_ExtremeWeatherAndNegativeInputs verifies subzero temps, high temps, and negative airflow/power.
func TestChallenger2_ExtremeWeatherAndNegativeInputs(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	baseSeq := make([][]float64, 12)
	for i := 0; i < 12; i++ {
		baseSeq[i] = []float64{24.0, 350.0}
	}

	// Subzero temperatures (-25°C, -40°C)
	for _, subzero := range []float64{-25.0, -40.0} {
		hum := 30.0
		inp, _ := json.Marshal(localInferInput{
			SensorSequence:  baseSeq,
			OutdoorTemp:     &subzero,
			OutdoorHumidity: &hum,
		})
		outBytes, err := ExecuteLocalInference(ctx, "lstm", inp)
		if err != nil {
			t.Fatalf("subzero temp %.1f failed: %v", subzero, err)
		}
		var out localInferOutput
		json.Unmarshal(outBytes, &out)
		if out.Status != "ok" || out.PredictedPeakLoad < 0 {
			t.Errorf("subzero temp %.1f returned invalid result: %+v", subzero, out)
		}
	}

	// Extreme high temp (> 50°C: 52°C, 55°C)
	for _, highTemp := range []float64{52.0, 55.0} {
		hum := 60.0
		inp, _ := json.Marshal(localInferInput{
			SensorSequence:  baseSeq,
			OutdoorTemp:     &highTemp,
			OutdoorHumidity: &hum,
		})
		outBytes, err := ExecuteLocalInference(ctx, "lstm", inp)
		if err != nil {
			t.Fatalf("extreme high temp %.1f failed: %v", highTemp, err)
		}
		var out localInferOutput
		json.Unmarshal(outBytes, &out)
		if out.Status != "ok" || out.OutdoorTempUsed != highTemp {
			t.Errorf("extreme high temp %.1f mismatch: %+v", highTemp, out)
		}
	}

	// Negative power/airflow draws: [-100.0, -500.0]
	negSeq := make([][]float64, 12)
	for i := 0; i < 12; i++ {
		negSeq[i] = []float64{20.0, -250.0}
	}
	temp := 28.0
	hum := 50.0
	inp, _ := json.Marshal(localInferInput{
		SensorSequence:  negSeq,
		OutdoorTemp:     &temp,
		OutdoorHumidity: &hum,
	})
	outBytes, err := ExecuteLocalInference(ctx, "lstm", inp)
	if err != nil {
		t.Fatalf("negative airflow inference failed: %v", err)
	}
	var out localInferOutput
	json.Unmarshal(outBytes, &out)
	if out.Status != "ok" {
		t.Fatalf("negative airflow expected ok, got: %s", out.Error)
	}
	if out.PredictedPeakLoad < 0.0 {
		t.Errorf("expected non-negative clamp for negative inputs, got %f", out.PredictedPeakLoad)
	}
}

// TestChallenger2_TimesFMVariedHorizons verifies TimesFM foundation model across horizons (1, 12, 24).
func TestChallenger2_TimesFMVariedHorizons(t *testing.T) {
	history := []float64{1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9}
	for _, horizon := range []int{1, 12, 24} {
		func(h int) {
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()

			inp, _ := json.Marshal(localInferInput{
				History: history,
				Horizon: h,
			})
			outBytes, err := ExecuteLocalInference(ctx, "timesfm", inp)
			if err != nil {
				t.Fatalf("[TimesFM H=%d] inference failed: %v", h, err)
			}
			var out localInferOutput
			if err := json.Unmarshal(outBytes, &out); err != nil {
				t.Fatalf("[TimesFM H=%d] parse failed: %v", h, err)
			}
			if out.Status != "ok" {
				t.Fatalf("[TimesFM H=%d] expected ok, got %s", h, out.Error)
			}
			forecast := out.Forecast
			if len(forecast) == 0 {
				forecast = out.Point
			}
			if len(forecast) != h {
				t.Errorf("[TimesFM H=%d] expected %d steps, got %d", h, h, len(forecast))
			}
			if out.Device != "mps" && out.Device != "cpu" && out.Device != "cuda" {
				t.Errorf("[TimesFM H=%d] unexpected device %s", h, out.Device)
			}
			t.Logf("[TimesFM H=%d] success: %d steps, device: %s, zero_shot: %v", h, len(forecast), out.Device, out.ZeroShot)
		}(horizon)
	}
}

// TestChallenger2_IPCSubprocessBridgeUnderOfflineHTTP verifies that when FORECAST_URL is down,
// BuildForecastGraph automatically falls back to local Python IPC and serves genuine predictions.
func TestChallenger2_IPCSubprocessBridgeUnderOfflineHTTP(t *testing.T) {
	origURL := os.Getenv("FORECAST_URL")
	origForce := os.Getenv("FORCE_IPC")
	os.Setenv("FORECAST_URL", "http://127.0.0.1:58888") // dead port
	os.Setenv("FORCE_IPC", "1")
	defer func() {
		os.Setenv("FORECAST_URL", origURL)
		os.Setenv("FORCE_IPC", origForce)
	}()

	forecastHttpClient = nil

	engine := simulation.NewEngine()
	engine.SetOutdoor(33.0, 70.0)

	graph := BuildForecastGraph(engine, 12)
	if graph == nil {
		t.Fatal("BuildForecastGraph returned nil")
	}

	if graph.Engine != "lstm" && graph.Engine != "timesfm" {
		t.Fatalf("expected live local AI model engine ('lstm' or 'timesfm'), got dummy fallback %q", graph.Engine)
	}
	if graph.LstmPeakMw == nil || *graph.LstmPeakMw <= 0 {
		t.Fatalf("expected non-nil positive peak load, got %v", graph.LstmPeakMw)
	}
	if len(graph.Series) != 12 {
		t.Errorf("expected 12 series elements, got %d", len(graph.Series))
	}
}

// =========================================================================
// SECTION 2: Sustainability & Carbon Accounting Stress Tests
// =========================================================================

// TestChallenger2_CarbonZeroAndFractionalLoads tests 0kW loads and fractional watt precision.
func TestChallenger2_CarbonZeroAndFractionalLoads(t *testing.T) {
	gridFactor := 0.5

	// Case 1: Exactly 0kW (0 Watts)
	kwh0, kg0 := CalculateScope2Emissions(0.0, 3600.0, gridFactor)
	if kwh0 != 0.0 || kg0 != 0.0 {
		t.Errorf("[0W load] expected (0.0, 0.0), got (%f, %f)", kwh0, kg0)
	}

	// Case 2: Fractional micro-load (0.001W for 1 hour)
	kwhFrac, kgFrac := CalculateScope2Emissions(0.001, 3600.0, gridFactor)
	expectedKwhFrac := 0.001 / 1000.0
	expectedKgFrac := expectedKwhFrac * gridFactor
	if math.Abs(kwhFrac-expectedKwhFrac) > 1e-9 || math.Abs(kgFrac-expectedKgFrac) > 1e-9 {
		t.Errorf("[fractional 0.001W] precision error: got (%e, %e), expected (%e, %e)",
			kwhFrac, kgFrac, expectedKwhFrac, expectedKgFrac)
	}

	// Case 3: Realistic load (1000W for 1 hour with 0.5 kg/kWh -> exactly 0.5 kgCO2e)
	kwh1000, kg1000 := CalculateScope2Emissions(1000.0, 3600.0, gridFactor)
	if kwh1000 != 1.0 || kg1000 != 0.5 {
		t.Errorf("[1000W load] expected (1.0 kWh, 0.5 kgCO2e), got (%f, %f)", kwh1000, kg1000)
	}
}

// TestChallenger2_MegaSurgeAndOverCapacity tests 10,000kW (10,000,000W) load surge.
func TestChallenger2_MegaSurgeAndOverCapacity(t *testing.T) {
	megaWatts := 10000.0 * 1000.0 // 10,000 kW = 10,000,000 W
	engine := &simulation.Engine{
		Zones: map[string]*simulation.ZoneSim{
			"mega-industrial-zone": {
				Type:     "open-office",
				AreaM2:   50000.0,
				HwStripW: megaWatts,
			},
		},
	}
	engine.SetMode(simulation.ModeReal)
	tracker := newCarbonTracker(engine)
	now := time.Now()

	// Initial snapshot with 10MW load
	snap := tracker.Snapshot(engine, now)

	// Verify no numerical overflow or NaN
	if math.IsNaN(snap.CarbonAccounting.InstantaneousPowerW) || math.IsInf(snap.CarbonAccounting.InstantaneousPowerW, 0) {
		t.Fatalf("InstantaneousPowerW overflowed to NaN or Inf: %f", snap.CarbonAccounting.InstantaneousPowerW)
	}
	if snap.CarbonAccounting.InstantaneousPowerW != megaWatts {
		t.Errorf("expected InstantaneousPowerW %.1f, got %.1f", megaWatts, snap.CarbonAccounting.InstantaneousPowerW)
	}

	// Over capacity alert should be triggered (10MW >> 2000W rated power strip)
	foundOverCapacity := false
	for _, w := range snap.PredictiveMaintenance.Warnings {
		if w.Type == "over_capacity" && w.EquipmentId == "strip-mega-industrial-zone" {
			foundOverCapacity = true
			if w.MetricValue != megaWatts {
				t.Errorf("expected metric value %.1f, got %.1f", megaWatts, w.MetricValue)
			}
		}
	}
	if !foundOverCapacity {
		t.Errorf("expected over_capacity alert for 10MW load on power strip")
	}

	// Now simulate a further surge of +2000W in next tick to test transient surge
	engine.Zones["mega-industrial-zone"].HwStripW += 2000.0
	snapSurge := tracker.Snapshot(engine, now.Add(time.Second))
	foundSurge := false
	for _, w := range snapSurge.PredictiveMaintenance.Warnings {
		if w.Type == "power_surge" {
			foundSurge = true
			if w.MetricValue != 2000.0 {
				t.Errorf("expected transient surge metric value 2000.0, got %f", w.MetricValue)
			}
		}
	}
	if !foundSurge {
		t.Errorf("expected power_surge alert for +2000W delta on top of 10MW")
	}
}

// TestChallenger2_SpaceUtilizationAdversarial tests 0 occupants, negative occupants, and >200% overcapacity.
func TestChallenger2_SpaceUtilizationAdversarial(t *testing.T) {
	// Case 1: 0 occupants across all zones
	eng0 := &simulation.Engine{
		Zones: map[string]*simulation.ZoneSim{
			"z1": {Type: "open-office", AreaM2: 50.0, Occupancy: 0},
			"z2": {Type: "meeting-room", AreaM2: 25.0, Occupancy: 0},
		},
	}
	s0 := computeSpaceUtilization(eng0)
	if s0.TotalLiveOccupants != 0 {
		t.Errorf("[0-occ] expected 0 occupants, got %d", s0.TotalLiveOccupants)
	}
	if s0.OverallEfficiencyPercent != 0.0 {
		t.Errorf("[0-occ] expected 0.0%% efficiency, got %f", s0.OverallEfficiencyPercent)
	}

	// Case 2: Negative occupants (sensor error / underflow: -3 occupants)
	engNeg := &simulation.Engine{
		Zones: map[string]*simulation.ZoneSim{
			"z1": {Type: "open-office", AreaM2: 50.0, Occupancy: -3},
		},
	}
	sNeg := computeSpaceUtilization(engNeg)
	// Must not crash or panic
	if sNeg.TotalLiveOccupants != -3 {
		t.Errorf("[neg-occ] expected -3 occupants recorded, got %d", sNeg.TotalLiveOccupants)
	}

	// Case 3: Severe Overcapacity (>200%, e.g. 500%)
	engOver := &simulation.Engine{
		Zones: map[string]*simulation.ZoneSim{
			"packed-floor": {Type: "open-office", AreaM2: 50.0, Occupancy: 50},
		},
	}
	sOver := computeSpaceUtilization(engOver)
	if sOver.TotalBuildingCapacity != 5 {
		t.Errorf("[overcapacity] expected capacity 5, got %d", sOver.TotalBuildingCapacity)
	}
	if sOver.TotalLiveOccupants != 50 {
		t.Errorf("[overcapacity] expected 50 occupants, got %d", sOver.TotalLiveOccupants)
	}
	if sOver.OverallEfficiencyPercent != 1000.0 {
		t.Errorf("[overcapacity] expected 1000.0%% efficiency, got %f", sOver.OverallEfficiencyPercent)
	}

	// Case 4: Non-occupiable zone filtering
	engService := &simulation.Engine{
		Zones: map[string]*simulation.ZoneSim{
			"office":     {Type: "open-office", AreaM2: 100.0, Occupancy: 8}, // capacity 10
			"corridor":   {Type: "corridor", AreaM2: 200.0, Occupancy: 10},  // ignored
			"wet-core":   {Type: "wet-core", AreaM2: 50.0, Occupancy: 5},    // ignored
			"plant-room": {Type: "plant-room", AreaM2: 300.0, Occupancy: 2}, // ignored
		},
	}
	sServ := computeSpaceUtilization(engService)
	if sServ.TotalBuildingCapacity != 10 {
		t.Errorf("[service-zones] expected capacity 10, got %d", sServ.TotalBuildingCapacity)
	}
	if sServ.TotalLiveOccupants != 8 {
		t.Errorf("[service-zones] expected 8 occupants, got %d", sServ.TotalLiveOccupants)
	}
	if len(sServ.Zones) != 1 {
		t.Errorf("[service-zones] expected 1 occupiable zone, got %d", len(sServ.Zones))
	}
}

// TestChallenger2_CarbonOffsetCertificateCeiling verifies certificate count is computed as ceiling of deficit.
func TestChallenger2_CarbonOffsetCertificateCeiling(t *testing.T) {
	quote := MarketQuote{
		Source:                   "Toucan Protocol BCT (CoinGecko)",
		SpotPricePerMetricTonUSD: 15.00,
		Currency:                 "USD",
		IsLive:                   true,
		FetchedAt:                time.Now().UTC().Format(time.RFC3339),
	}

	budget := 50.0 // kgCO2e

	testCases := []struct {
		emissions     float64
		overBudget    bool
		expectedDef   float64
		expectedCerts int
	}{
		{40.0, false, 0.0, 0},        // Under budget
		{50.0, false, 0.0, 0},        // Exactly on budget
		{50.001, true, 0.0, 1},       // 0.001 kg deficit (1 gram) -> ceil(0.000001 ton) = 1 cert
		{51.0, true, 1.0, 1},         // 1 kg deficit -> ceil(0.001 ton) = 1 cert
		{1049.9, true, 999.9, 1},     // 999.9 kg deficit -> ceil(0.9999 ton) = 1 cert
		{1050.0, true, 1000.0, 1},    // exactly 1000 kg (1 ton) -> ceil(1.0) = 1 cert
		{1050.1, true, 1000.1, 2},    // 1000.1 kg (> 1 ton) -> ceil(1.0001) = 2 certs
		{2550.0, true, 2500.0, 3},    // 2500 kg (2.5 tons) -> ceil(2.5) = 3 certs
		{10050.0, true, 10000.0, 10}, // 10,000 kg (10 tons) -> 10 certs
	}

	for _, tc := range testCases {
		rec := CalculateOffsetRecommendation(tc.emissions, budget, quote)
		if rec.OverBudget != tc.overBudget {
			t.Errorf("[emissions=%.3f] expected overBudget=%v, got %v", tc.emissions, tc.overBudget, rec.OverBudget)
		}
		if rec.WholeCertificatesNeeded != tc.expectedCerts {
			t.Errorf("[emissions=%.3f] expected %d whole certificates (ceiling rule), got %d (deficit: %.4f kg)",
				tc.emissions, tc.expectedCerts, rec.WholeCertificatesNeeded, rec.DeficitKgCO2e)
		}
		if tc.overBudget {
			expectedCost := math.Round((rec.CreditsNeededMetricTons*quote.SpotPricePerMetricTonUSD)*1000.0) / 1000.0
			if math.Abs(rec.EstimatedCostUSD-expectedCost) > 1e-3 {
				t.Errorf("[emissions=%.3f] cost mismatch: got %f, expected %f", tc.emissions, rec.EstimatedCostUSD, expectedCost)
			}
		}
	}
}

// TestChallenger2_ToucanNetworkFallbackAndTimeout verifies fallback behavior when external Toucan API fails or times out.
func TestChallenger2_ToucanNetworkFallbackAndTimeout(t *testing.T) {
	// Case 1: Mock server returning HTTP 500 Internal Error
	errServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "upstream service unavailable", http.StatusInternalServerError)
	}))
	defer errServer.Close()

	client500 := NewCarbonMarketClient(errServer.URL, 5*time.Minute)
	client500.SetHTTPClient(testClientForServer(errServer))
	quote500, err := client500.GetQuote()
	if err != nil {
		t.Fatalf("expected graceful fallback without Go error, got: %v", err)
	}
	if quote500.IsLive != false {
		t.Errorf("expected isLive=false for fallback quote, got %v", quote500.IsLive)
	}
	if quote500.SpotPricePerMetricTonUSD != defaultMarketFallbackPrice {
		t.Errorf("expected fallback price $%.2f, got $%.2f", defaultMarketFallbackPrice, quote500.SpotPricePerMetricTonUSD)
	}

	// Case 2: Unreachable port / connection refused
	deadClient := NewCarbonMarketClient("http://127.0.0.1:59998/price", 5*time.Minute)
	quoteDead, err := deadClient.GetQuote()
	if err != nil {
		t.Fatalf("expected graceful fallback for unreachable host, got error: %v", err)
	}
	if quoteDead.SpotPricePerMetricTonUSD != defaultMarketFallbackPrice {
		t.Errorf("expected fallback price $%.2f, got $%.2f", defaultMarketFallbackPrice, quoteDead.SpotPricePerMetricTonUSD)
	}

	// Case 3: Live successful price parsing with cache TTL
	callCount := 0
	liveServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"toucan-protocol-base-carbon-tonne": {"usd": 18.75}}`)
	}))
	defer liveServer.Close()

	cachedClient := NewCarbonMarketClient(liveServer.URL, 1*time.Second)
	cachedClient.SetHTTPClient(testClientForServer(liveServer))
	// Fetch 1: hits live server
	q1, err := cachedClient.GetQuote()
	if err != nil || !q1.IsLive || q1.SpotPricePerMetricTonUSD != 18.75 {
		t.Fatalf("Fetch 1 failed: %+v, err: %v", q1, err)
	}
	if callCount != 1 {
		t.Errorf("expected callCount 1, got %d", callCount)
	}

	// Fetch 2: should hit in-memory cache, NOT call HTTP server again
	q2, err := cachedClient.GetQuote()
	if err != nil || q2.SpotPricePerMetricTonUSD != 18.75 {
		t.Fatalf("Fetch 2 failed: %+v", q2)
	}
	if callCount != 1 {
		t.Errorf("expected cached quote without HTTP call, but callCount is %d", callCount)
	}

	// Expire cache manually
	cachedClient.ClearCache()
	q3, err := cachedClient.GetQuote()
	if err != nil || q3.SpotPricePerMetricTonUSD != 18.75 {
		t.Fatalf("Fetch 3 failed: %+v", q3)
	}
	if callCount != 2 {
		t.Errorf("expected cache miss after ClearCache, callCount: %d", callCount)
	}
}
