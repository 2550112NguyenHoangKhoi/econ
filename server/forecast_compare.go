package main

import (
	"bytes"
	"econ/simulation"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// Two forecasters, one comparison — and the honesty machinery around it.
//
// The engine can consult a supervised LSTM and a zero-shot foundation model (TimesFM). They
// disagree, and the disagreement is the useful signal, so this file keeps both answers
// intact rather than picking one: engineResult carries either a forecast or the reason
// there is none, because "the LSTM is not trained" and "TimesFM could not download its
// checkpoint" are findings about the twin, not errors to swallow.
//
// checkPlausible is the guard that matters. A forecast far outside the range the building
// has ever actually operated in is reported as implausible rather than plotted as fact --
// a model extrapolating past its own training distribution is exactly when it is most
// confident and least right.

// histIntervalMinutes is the engine's history cadence in minutes — the unit every horizon
// in the forecast response is expressed in.
const histIntervalMinutes = 5

// engineResult is one forecaster's answer, or the reason it has none. Both engines are
// always reported: "the LSTM is not trained" and "TimesFM could not download its
// checkpoint" are findings about the twin, not errors to swallow.
type engineResult struct {
	Available bool      `json:"available"`
	PeakMw    *float64  `json:"peakMw"`           // the comparable number: predicted peak load
	Series    []float64 `json:"series,omitempty"` // TimesFM only — the full horizon
	Error     string    `json:"error,omitempty"`
	// Predictive spread, TimesFM only. The foundation model returns per-decile heads
	// alongside its central path, and the module that produces them argues — correctly —
	// that for a pre-cool decision the spread matters more than the mean, because the
	// decision is about the RISK of the peak. They were decoded in Python and then dropped
	// at this boundary, so no consumer had ever seen them.
	Quantiles     map[string][]float64 `json:"quantiles,omitempty"`
	PeakUpperMw   *float64             `json:"peakUpperMw,omitempty"`   // peak of the highest decile
	UpperQuantile string               `json:"upperQuantile,omitempty"` // which head that was
	// Provenance: how much real history backed this answer. The two engines consume
	// different windows, so neither figure is meaningful without saying which it is.
	RealSamples int    `json:"realSamples"`
	WindowLen   int    `json:"windowLen,omitempty"`
	Basis       string `json:"basis"`
	// Degraded means infer.py answered WITHOUT the model behind it -- torch absent, or the
	// checkpoint missing. The number still has the shape of a forecast and Available stays
	// true, because the endpoint did answer; what must not happen is a consumer rendering
	// it as a model result. The dashboard badges these PLACEHOLDER rather than LIVE.
	Degraded bool `json:"degraded,omitempty"`
	// Plausibility against the building's OWN observed load. A supervised model carries
	// the building it was trained on inside its weights: point the LSTM trained on a
	// 39,776 m2 tower at a 72 m2 house and it answers 2.4 MW for a building that has never
	// drawn more than 0.03 MW. The number is not wrong arithmetic, it is a model being
	// asked about a building it has never seen — and a dashboard that renders it as "the
	// predicted peak" is making a claim the twin cannot support.
	Implausible bool `json:"implausible"`
	// Judged separates "checked against this building's own load range and found sane"
	// from "there was not enough observed history to check at all". Without it the two
	// are indistinguishable downstream — Implausible is false in both cases — and a panel
	// reading only that flag drew a peak-shaving bar of a 2.41 MW forecast against a 5.2 kW
	// house, reported it as 0%, and captioned it as this building's predicted peak. An
	// unmade judgement is not a passing one.
	Judged       bool   `json:"plausibilityJudged"`
	Plausibility string `json:"plausibility,omitempty"`
}

// outOfDistributionFactor is how far outside the observed load range a forecast may sit
// before it is reported as out of distribution. Loads legitimately exceed anything yet
// recorded — that is what a peak forecast is FOR — so this is deliberately loose: it fires
// on an order-of-magnitude mismatch, not on a model predicting a new high.
const outOfDistributionFactor = 4.0

// minRangeSamples is how much observed history is needed before the range means anything.
// Below it no judgement is offered, because "this building has never drawn 2 MW" is not a
// finding when the building has only been watched for four minutes.
const minRangeSamples = 24

// checkPlausible annotates a result against the building's own observed load range.
func checkPlausible(res *engineResult, lo, hi float64, n int) {
	if res.PeakMw == nil {
		return
	}
	// Not enough observed history to say anything. Report that explicitly rather than
	// leaving the result looking checked-and-clear: this is the state right after a
	// restart, or after the engine has discarded a load series recorded under a
	// superseded model, and it is exactly when a wild forecast is least defensible to
	// draw a comparison against.
	if n < minRangeSamples || hi <= 0 {
		res.Judged = false
		if hi <= 0 {
			res.Plausibility = "not assessed: no load has been observed for this building yet, " +
				"so there is no range to check the forecast against. It is shown as reported."
		} else {
			plural := "samples"
			if n == 1 {
				plural = "sample"
			}
			res.Plausibility = fmt.Sprintf(
				"not assessed: this building has only %d recorded load %s and at least %d "+
					"are needed before its own range means anything. The forecast is shown as "+
					"reported and has not been checked against this building.",
				n, plural, minRangeSamples)
		}
		return
	}
	res.Judged = true
	p := *res.PeakMw
	switch {
	case p > hi*outOfDistributionFactor:
		res.Implausible = true
		res.Plausibility = fmt.Sprintf(
			"%.2f MW is %.0fx the highest load this building has been observed at (%.3f MW over %d recorded samples). "+
				"A supervised model carries its training building in its weights; this reads as a model asked about a "+
				"building it was not trained on, not as a forecast of this one.", p, p/hi, hi, n)
	case lo > 0 && p < lo/outOfDistributionFactor:
		res.Implausible = true
		res.Plausibility = fmt.Sprintf(
			"%.3f MW is far below the lowest load this building has been observed at (%.3f MW over %d recorded samples).",
			p, lo, n)
	default:
		res.Plausibility = fmt.Sprintf("within the observed range for this building (%.3f-%.3f MW over %d samples).", lo, hi, n)
	}
}

// compareForecastHandler runs BOTH forecasters over the same instant and returns both
// answers side by side.
//
//	GET /api/forecast/compare[?horizon=N]
//
// The two are not redundant and not interchangeable: the LSTM is supervised and only knows
// this building once train.py has had real history to learn from, while TimesFM is
// pretrained and forecasts a series it has never seen. Until now they were reachable only
// through separate endpoints, so nothing in the system ever put their answers next to each
// other — which is the only way to find out which one to trust for THIS building.
//
// Both are reduced to one comparable scalar: the predicted peak load in MW. For the LSTM
// that is what it emits directly; for TimesFM it is the maximum of the forecast horizon,
// which is the same quantity the pre-cool decision actually turns on.
//
// Neither engine being reachable is a 200 with two unavailable results, not a 503: the
// endpoint's job is to report the state of the forecasting layer, and "both are down" is a
// perfectly good report.
func compareForecastHandler(engine *simulation.Engine) http.HandlerFunc {
	// The LSTM answers in milliseconds; TimesFM may be downloading a multi-gigabyte
	// checkpoint on its first call, so it gets the generous timeout.
	lstmClient := &http.Client{Timeout: 8 * time.Second}
	tfmClient := &http.Client{Timeout: 180 * time.Second}

	return func(w http.ResponseWriter, r *http.Request) {
		if corsPreflight(w, r) {
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Content-Type", "application/json")

		base := os.Getenv("FORECAST_URL")
		if base == "" {
			base = "http://localhost:8000"
		}
		horizon := 12
		if q := r.URL.Query().Get("horizon"); q != "" {
			if n, err := strconv.Atoi(q); err == nil && n >= 1 && n <= 256 {
				horizon = n
			}
		}

		// Both calls go out concurrently: they hit the same service but are independent,
		// and serializing them would make the response wait out TimesFM's cold start
		// before it could report the LSTM's answer.
		type pair struct {
			name string
			res  engineResult
		}
		ch := make(chan pair, 2)

		go func() { ch <- pair{"lstm", queryLSTM(engine, lstmClient, base)} }()
		go func() { ch <- pair{"timesfm", queryTimesFM(engine, tfmClient, base, horizon)} }()

		out := map[string]interface{}{}
		for i := 0; i < 2; i++ {
			p := <-ch
			out[p.name] = p.res
		}

		lstm := out["lstm"].(engineResult)
		tfm := out["timesfm"].(engineResult)
		// Both answers are checked against the same measured range, so "the LSTM is out of
		// distribution and TimesFM is not" is a conclusion the payload can actually carry.
		lo, hi, n := engine.ObservedLoadRange()
		checkPlausible(&lstm, lo, hi, n)
		checkPlausible(&tfm, lo, hi, n)
		out["lstm"] = lstm
		out["timesfm"] = tfm
		out["observedLoad"] = map[string]interface{}{"minMw": lo, "maxMw": hi, "samples": n}
		out["stepMinutes"] = histIntervalMinutes
		out["horizonMinutes"] = horizon * histIntervalMinutes
		out["agreement"] = forecastAgreement(lstm, tfm)
		json.NewEncoder(w).Encode(out)
	}
}

// queryLSTM asks the supervised forecaster for its predicted peak over the sampled window.
func queryLSTM(engine *simulation.Engine, client *http.Client, base string) engineResult {
	req, realSamples := buildForecastRequest(engine)
	res := engineResult{
		RealSamples: realSamples,
		WindowLen:   forecastWindowLen,
		Basis:       "supervised LSTM over a 12-step [avgTemp, airflow] window",
	}
	body, _ := json.Marshal(req)
	resp, err := client.Post(base+"/predict", "application/json", bytes.NewReader(body))
	if err != nil {
		if isIPCEnabled() {
			if ipcRes, ipcErr := queryLSTMIPC(engine, req, realSamples); ipcErr == nil && ipcRes.Available {
				return ipcRes
			}
		}
		res.Error = "forecasting service unreachable: " + err.Error()
		return res
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		if isIPCEnabled() {
			if ipcRes, ipcErr := queryLSTMIPC(engine, req, realSamples); ipcErr == nil && ipcRes.Available {
				return ipcRes
			}
		}
		// 503 here means train.py has not been run — the honest and common case.
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		res.Error = fmt.Sprintf("forecaster returned %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
		return res
	}
	var decoded struct {
		PredictedPeakLoad float64 `json:"predicted_peak_load"`
	}
	if json.NewDecoder(resp.Body).Decode(&decoded) != nil {
		res.Error = "forecaster returned malformed JSON"
		return res
	}
	res.Available = true
	peak := decoded.PredictedPeakLoad
	res.PeakMw = &peak
	return res
}

// queryTimesFM asks the zero-shot foundation model for the coming horizon, reduced to the
// peak it contains. The engine's own minimum-history rule is applied here rather than
// letting the service reject it, so the reason reads as a property of the twin.
func queryTimesFM(engine *simulation.Engine, client *http.Client, base string, horizon int) engineResult {
	history := engine.LoadHistory()
	res := engineResult{
		RealSamples: len(history),
		Basis:       "zero-shot TimesFM over the recorded building-load series",
	}
	if len(history) < timesfmMinHistory {
		res.Error = fmt.Sprintf("not enough load history yet: %d of %d samples "+
			"(the engine records one every %d minutes)", len(history), timesfmMinHistory, histIntervalMinutes)
		return res
	}

	body, _ := json.Marshal(loadForecastRequest{History: history, Horizon: horizon})
	resp, err := client.Post(base+"/forecast/load", "application/json", bytes.NewReader(body))
	if err != nil {
		if isIPCEnabled() {
			if ipcRes, ipcErr := queryTimesFMIPC(engine, horizon, history); ipcErr == nil && ipcRes.Available {
				return ipcRes
			}
		}
		res.Error = "forecasting service unreachable: " + err.Error()
		return res
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		if isIPCEnabled() {
			if ipcRes, ipcErr := queryTimesFMIPC(engine, horizon, history); ipcErr == nil && ipcRes.Available {
				return ipcRes
			}
		}
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		res.Error = fmt.Sprintf("forecaster returned %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
		return res
	}
	var decoded struct {
		Forecast  []float64            `json:"forecast"`
		Point     []float64            `json:"point"`
		Quantiles map[string][]float64 `json:"quantiles"`
	}
	if json.NewDecoder(resp.Body).Decode(&decoded) != nil {
		res.Error = "forecaster returned malformed JSON"
		return res
	}
	series := decoded.Forecast
	if len(series) == 0 {
		series = decoded.Point
	}
	if len(series) == 0 {
		res.Error = "forecaster returned an empty horizon"
		return res
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

	// Carry the spread through. The upper band is the highest-numbered quantile head the
	// checkpoint returned — read that way rather than hardcoded to "q9", because the head
	// count is a property of the checkpoint and 2.5-200m need not match 2.0-500m.
	if len(decoded.Quantiles) > 0 {
		res.Quantiles = decoded.Quantiles
		if key, band := highestQuantile(decoded.Quantiles); band != nil {
			res.UpperQuantile = key
			res.PeakUpperMw = band
		}
	}
	return res
}

// highestQuantile returns the name and peak value of the highest-numbered quantile head
// ("q1".."q9" — deciles, ascending). Heads that are not of that form are ignored rather
// than guessed at.
func highestQuantile(q map[string][]float64) (string, *float64) {
	bestName, bestIdx := "", -1
	for name := range q {
		if len(name) < 2 || name[0] != 'q' {
			continue
		}
		idx, err := strconv.Atoi(name[1:])
		if err != nil {
			continue
		}
		if idx > bestIdx {
			bestIdx, bestName = idx, name
		}
	}
	if bestName == "" || len(q[bestName]) == 0 {
		return "", nil
	}
	peak := q[bestName][0]
	for _, v := range q[bestName][1:] {
		if v > peak {
			peak = v
		}
	}
	return bestName, &peak
}

// forecastAgreement describes how far apart the two engines are, when both answered. It is
// deliberately a description rather than a verdict: with one supervised model possibly
// trained on synthetic data and one zero-shot model, a disagreement says "these need
// comparing against outturn", not "this one is wrong".
func forecastAgreement(lstm, tfm engineResult) map[string]interface{} {
	if !lstm.Available || !tfm.Available || lstm.PeakMw == nil || tfm.PeakMw == nil {
		return map[string]interface{}{
			"comparable": false,
			"note":       "both engines must answer before their forecasts can be compared",
		}
	}
	// An answer this same payload has already flagged as out of distribution is not one
	// half of a model comparison. Reporting "the two engines differ by 2.37 MW (99%)" on a
	// building whose highest observed load is 0.025 MW states a disagreement between two
	// forecasts of THIS building, when one of them is a forecast of a different one — the
	// difference measures the gap between the buildings, not between the models. The panel
	// was rendering that percentage as a headline directly beneath its own "not this
	// building" badge.
	if lstm.Implausible || tfm.Implausible {
		out := map[string]interface{}{
			"comparable": false,
			"note": "the two forecasts cannot be compared: one of them has been flagged as " +
				"out of distribution for this building, so the gap between them measures " +
				"the gap between buildings rather than between models",
		}
		switch {
		case lstm.Implausible && tfm.Implausible:
			out["excluded"] = []string{"lstm", "timesfm"}
		case lstm.Implausible:
			out["excluded"] = []string{"lstm"}
		default:
			out["excluded"] = []string{"timesfm"}
		}
		return out
	}
	a, b := *lstm.PeakMw, *tfm.PeakMw
	diff := a - b
	rel := 0.0
	if denom := math.Max(math.Abs(a), math.Abs(b)); denom > 0 {
		rel = math.Abs(diff) / denom
	}
	return map[string]interface{}{
		"comparable":   true,
		"deltaMw":      diff,
		"relativeDiff": rel,
		"higher":       map[bool]string{true: "lstm", false: "timesfm"}[a >= b],
		"note": "peak MW from each engine over the same instant; neither is ground truth " +
			"until compared against measured outturn",
	}
}

// forecastEnginesHandler surfaces which forecasting engines the Python service can serve
// (GET /model/info there), so the dashboard can show whether the twin is running the
// supervised LSTM, the zero-shot foundation model, or neither — and why.
func forecastEnginesHandler() http.HandlerFunc {
	client := &http.Client{Timeout: 5 * time.Second}
	return func(w http.ResponseWriter, r *http.Request) {
		if corsPreflight(w, r) {
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Content-Type", "application/json")

		base := os.Getenv("FORECAST_URL")
		if base == "" {
			base = "http://localhost:8000"
		}
		resp, err := client.Get(base + "/model/info")
		if err != nil {
			json.NewEncoder(w).Encode(map[string]interface{}{
				"reachable": false,
				"error":     err.Error(),
			})
			return
		}
		defer resp.Body.Close()
		var out map[string]interface{}
		if json.NewDecoder(resp.Body).Decode(&out) != nil {
			out = map[string]interface{}{}
		}
		out["reachable"] = true
		json.NewEncoder(w).Encode(out)
	}
}
