package main

import (
	"bytes"
	"econ/simulation"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"
)

// forecastRequest mirrors the Python service's POST /predict body. The outdoor fields
// are the engine's own live Open-Meteo readings — handed over so the forecaster and the
// envelope physics never disagree about the weather; omitted (nil) when the feed is
// stale, in which case the Python service falls back to its own fetch and says so.
type forecastRequest struct {
	SensorSequence  [][]float64 `json:"sensor_sequence"`
	OutdoorTemp     *float64    `json:"outdoor_temp,omitempty"`
	OutdoorHumidity *float64    `json:"outdoor_humidity,omitempty"`
}

// forecastWindowLen must match the Python model's SEQ_LEN (12 steps of 5 minutes).
const forecastWindowLen = 12

// buildForecastRequest assembles the /predict body from live engine state. Shared by
// the HTTP proxy below and the pre-cool poller, so every forecast in the system is
// made from the same real inputs.
func buildForecastRequest(engine *simulation.Engine) (forecastRequest, int) {
	window, realSamples := engine.ForecastWindow(forecastWindowLen)
	req := forecastRequest{SensorSequence: window}
	if t, h, live := engine.OutdoorForForecast(); live {
		req.OutdoorTemp = &t
		req.OutdoorHumidity = &h
	}
	return req, realSamples
}

// loadForecastRequest mirrors the Python service's POST /forecast/load body — the zero-shot
// path. Where the LSTM needs a fixed 12-step [temp, airflow] window because that is the
// shape it was trained on, a foundation model takes the raw load series and needs no
// training, no scaler and no feature engineering at all.
type loadForecastRequest struct {
	History []float64 `json:"history"`
	Horizon int       `json:"horizon"`
}

// timesfmMinHistory matches the Python validator: below this there is not enough of a
// series to forecast from, and saying so is better than forecasting from noise.
const timesfmMinHistory = 8

// loadForecastHandler drives Google TimesFM over the building's own recorded load series.
//
//	GET /api/forecast/load[?horizon=N]
//
// This is the twin's cold-start answer to peak-load forecasting. The LSTM cannot say
// anything until train.py has been run against accumulated history; TimesFM is pretrained,
// so it forecasts a building it has never seen from whatever real history exists. The
// response carries how many real samples backed it and the engine/device that served it,
// so a forecast from 20 minutes of history is never mistaken for one from two days.
func loadForecastHandler(engine *simulation.Engine) http.HandlerFunc {
	// Generous timeout: the FIRST call may download a multi-gigabyte checkpoint.
	client := &http.Client{Timeout: 180 * time.Second}
	return func(w http.ResponseWriter, r *http.Request) {
		if corsPreflight(w, r) {
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Content-Type", "application/json")

		history := engine.LoadHistory()
		if len(history) < timesfmMinHistory {
			w.WriteHeader(http.StatusServiceUnavailable)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"error": "not enough load history yet",
				"detail": "the zero-shot forecaster needs at least 8 recorded load samples; " +
					"the engine records one every 5 minutes",
				"samples": len(history), "need": timesfmMinHistory,
			})
			return
		}

		horizon := 12
		if q := r.URL.Query().Get("horizon"); q != "" {
			if n, err := strconv.Atoi(q); err == nil && n >= 1 && n <= 256 {
				horizon = n
			}
		}

		base := os.Getenv("FORECAST_URL")
		if base == "" {
			base = "http://localhost:8000"
		}
		body, _ := json.Marshal(loadForecastRequest{History: history, Horizon: horizon})
		resp, err := client.Post(base+"/forecast/load", "application/json", bytes.NewReader(body))
		if err != nil {
			if isIPCEnabled() {
				if ipcRes, ipcErr := queryTimesFMIPC(engine, horizon, history); ipcErr == nil && ipcRes.Available {
					out := map[string]interface{}{
						"forecast":        ipcRes.Series,
						"quantiles":       ipcRes.Quantiles,
						"engine":          "timesfm",
						"history_samples": len(history),
						"step_minutes":    int(histIntervalMinutes),
						"horizon_minutes": horizon * int(histIntervalMinutes),
					}
					json.NewEncoder(w).Encode(out)
					return
				}
			}
			log.Printf("[forecast] TimesFM service unreachable at %s: %v", base, err)
			w.WriteHeader(http.StatusServiceUnavailable)
			json.NewEncoder(w).Encode(map[string]string{
				"error": "forecasting service unreachable: " + err.Error()})
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode == http.StatusOK {
			var out map[string]interface{}
			if json.NewDecoder(resp.Body).Decode(&out) == nil {
				out["history_samples"] = len(history)
				out["step_minutes"] = int(histIntervalMinutes)
				out["horizon_minutes"] = horizon * int(histIntervalMinutes)
				json.NewEncoder(w).Encode(out)
				return
			}
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(map[string]string{"error": "forecaster returned malformed JSON"})
			return
		}
		w.WriteHeader(resp.StatusCode) // pass through 503 (TimesFM unavailable) etc.
		io.Copy(w, resp.Body)
	}
}

// forecastHandler proxies a live-telemetry window to the Python LSTM forecaster and returns its
// JSON ({predicted_peak_load, outdoor_temp_used, outdoor_humidity_used, weather_source}),
// annotated with the window's provenance (window_real_samples / window_len) so the AI layer
// can say "warming up: 3/12 real samples" instead of presenting padding as history. This is
// the human-in-the-loop hook for the dashboard/optimizer: the Go engine owns the building state,
// the Python service owns the model. FORECAST_URL points at the service (compose: forecasting:8000).
func forecastHandler(engine *simulation.Engine) http.HandlerFunc {
	client := &http.Client{Timeout: 8 * time.Second}
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Content-Type", "application/json")

		base := os.Getenv("FORECAST_URL")
		if base == "" {
			base = "http://localhost:8000"
		}

		req, realSamples := buildForecastRequest(engine)
		body, _ := json.Marshal(req)
		resp, err := client.Post(base+"/predict", "application/json", bytes.NewReader(body))
		if err != nil {
			if isIPCEnabled() {
				if ipcRes, ipcErr := queryLSTMIPC(engine, req, realSamples); ipcErr == nil && ipcRes.Available && ipcRes.PeakMw != nil {
					out := map[string]interface{}{
						"predicted_peak_load": *ipcRes.PeakMw,
						"window_real_samples": realSamples,
						"window_len":          forecastWindowLen,
						"weather_source":      "local_ipc",
						"engine":              "lstm",
					}
					lo, hi, n := engine.ObservedLoadRange()
					checkPlausible(&ipcRes, lo, hi, n)
					out["implausible"] = ipcRes.Implausible
					out["plausibility_judged"] = ipcRes.Judged
					if ipcRes.Plausibility != "" {
						out["plausibility"] = ipcRes.Plausibility
					}
					out["observed_min_mw"], out["observed_max_mw"], out["observed_samples"] = lo, hi, n
					json.NewEncoder(w).Encode(out)
					return
				}
			}
			log.Printf("[forecast] service unreachable at %s: %v", base, err)
			w.WriteHeader(http.StatusServiceUnavailable)
			json.NewEncoder(w).Encode(map[string]string{
				"error": "forecasting service unreachable: " + err.Error()})
			return
		}
		defer resp.Body.Close()

		// Annotate a successful prediction with the input window's provenance. Anything
		// that doesn't decode as a JSON object (error bodies, 503s) passes through as-is.
		if resp.StatusCode == http.StatusOK {
			var out map[string]interface{}
			if json.NewDecoder(resp.Body).Decode(&out) == nil {
				out["window_real_samples"] = realSamples
				out["window_len"] = forecastWindowLen
				// Same plausibility check the compare endpoint applies, on the same
				// measured range — this is the endpoint the AI panel reads, so it is the
				// one that most needs to say when the model is answering about a
				// different building than the one it is pointed at.
				if peak, ok := out["predicted_peak_load"].(float64); ok {
					lo, hi, n := engine.ObservedLoadRange()
					res := engineResult{PeakMw: &peak}
					checkPlausible(&res, lo, hi, n)
					out["implausible"] = res.Implausible
					out["plausibility_judged"] = res.Judged
					if res.Plausibility != "" {
						out["plausibility"] = res.Plausibility
					}
					out["observed_min_mw"], out["observed_max_mw"], out["observed_samples"] = lo, hi, n
				}
				json.NewEncoder(w).Encode(out)
				return
			}
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(map[string]string{"error": "forecaster returned malformed JSON"})
			return
		}
		w.WriteHeader(resp.StatusCode) // pass through 503 (model not trained) etc.
		io.Copy(w, resp.Body)
	}
}

var forecastHttpClient *http.Client

func getForecastHttpClient(timeout time.Duration) *http.Client {
	if forecastHttpClient != nil {
		return forecastHttpClient
	}
	return &http.Client{Timeout: timeout}
}
