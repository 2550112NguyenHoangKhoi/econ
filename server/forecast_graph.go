package main

import (
	"econ/simulation"
	"math"
	"os"
	"time"
)

// Assembling the forecast series the dashboard and the recommendations embed.
//
// Split out of forecast.go: everything here is shaping, not querying. It takes whichever
// forecaster answered and builds the plotted trajectory around it, and it owns the
// fallback used when none did -- which is why the fallback is named as such in the data it
// returns rather than presented as a model output.

// BuildForecastGraph queries the available forecasting models (TimesFM foundation model or LSTM)
// and returns a ForecastGraphData structure for embedding into RecommendationReport or direct API responses.
func BuildForecastGraph(engine *simulation.Engine, horizon int) *simulation.ForecastGraphData {
	if horizon <= 0 {
		horizon = 12
	}
	base := os.Getenv("FORECAST_URL")
	if base == "" {
		base = "http://localhost:8000"
	}

	lstmClient := getForecastHttpClient(2 * time.Second)
	tfmClient := getForecastHttpClient(3 * time.Second)

	type pair struct {
		name string
		res  engineResult
	}
	ch := make(chan pair, 2)
	go func() { ch <- pair{"lstm", queryLSTM(engine, lstmClient, base)} }()
	go func() { ch <- pair{"timesfm", queryTimesFM(engine, tfmClient, base, horizon)} }()

	var lstm, tfm engineResult
	for i := 0; i < 2; i++ {
		p := <-ch
		if p.name == "lstm" {
			lstm = p.res
		} else {
			tfm = p.res
		}
	}

	lo, hi, n := engine.ObservedLoadRange()
	checkPlausible(&lstm, lo, hi, n)
	checkPlausible(&tfm, lo, hi, n)

	// 1. Primary: TimesFM zero-shot foundation model (has full trajectory & quantile bands)
	if tfm.Available && len(tfm.Series) > 0 {
		var upperBand []float64
		if tfm.Quantiles != nil && tfm.UpperQuantile != "" {
			upperBand = tfm.Quantiles[tfm.UpperQuantile]
		}
		var lstmPeak *float64
		if lstm.Available && lstm.PeakMw != nil {
			lstmPeak = lstm.PeakMw
		}
		return &simulation.ForecastGraphData{
			Engine:         "timesfm",
			Series:         tfm.Series,
			UpperBand:      upperBand,
			UpperQuantile:  tfm.UpperQuantile,
			PeakUpperMw:    tfm.PeakUpperMw,
			LstmPeakMw:     lstmPeak,
			StepMinutes:    histIntervalMinutes,
			HorizonMinutes: len(tfm.Series) * histIntervalMinutes,
			Plausible:      !tfm.Implausible,
			Plausibility:   tfm.Plausibility,
			Samples:        tfm.RealSamples,
			Quantiles:      tfm.Quantiles,
		}
	}

	// 2. Secondary: Supervised LSTM model (provides peak MW)
	if lstm.Available && lstm.PeakMw != nil {
		series := generateLstmTrajectory(engine, *lstm.PeakMw, horizon)
		upperBand := make([]float64, len(series))
		for i, v := range series {
			upperBand[i] = math.Round(v*1.10*10000) / 10000
		}
		// PeakUpperMw is "peak of the highest decile" (see the field's own comment), so it
		// has to be the peak of the UpperBand this tier actually ships. It used to be
		// lstmPeak*1.10, which is a different quantity entirely: with a flat persistence
		// trajectory at 0.712 MW the band was 0.783 MW while this reported 2.509 MW, so the
		// chart's header announced "Q9 2.509 MW" over a dashed band drawn at 0.783 — a
		// factor of 3.2 between the label and the line beside it. The LSTM's own peak
		// prediction is not lost; it travels as LstmPeakMw and is drawn as the separate
		// supervised-peak reference.
		upperPeak := 0.0
		for _, v := range upperBand {
			if v > upperPeak {
				upperPeak = v
			}
		}
		upperPeak = math.Round(upperPeak*10000) / 10000

		// Expose the bands this tier already computed under the names it already claims.
		// It returned UpperQuantile "q9" and a populated UpperBand while leaving Quantiles
		// nil, so anything doing Quantiles[UpperQuantile] -- the obvious way to read this
		// payload, and what the TimesFM tier above and the fallback below both support --
		// got nothing back. Same numbers, same names, now actually reachable.
		//
		// q1 is deliberately absent: this tier computes a central trajectory and a +10%
		// upper bound and nothing else. The fallback publishes a q1 because it genuinely
		// derives a lower bound; inventing one here would be fabricating a figure no model
		// produced.
		quantiles := map[string][]float64{
			"q5": series,
			"q9": upperBand,
		}

		return &simulation.ForecastGraphData{
			Engine:         "lstm",
			Series:         series,
			UpperBand:      upperBand,
			UpperQuantile:  "q9",
			Quantiles:      quantiles,
			PeakUpperMw:    &upperPeak,
			LstmPeakMw:     lstm.PeakMw,
			StepMinutes:    histIntervalMinutes,
			HorizonMinutes: horizon * histIntervalMinutes,
			Plausible:      !lstm.Implausible,
			Plausibility:   lstm.Plausibility,
			Samples:        lstm.RealSamples,
		}
	}

	// 3. Fallback: Cold-start or offline forecasting service
	return generateFallbackForecast(engine, horizon)
}

// generateLstmTrajectory returns an honest persistence payload for the horizon rather than synthesizing
// fake cubic spline curves (smooth = t*t*(3-2*t)), preserving the LSTM predicted peak in LstmPeakMw.
func generateLstmTrajectory(engine *simulation.Engine, peakMw float64, horizon int) []float64 {
	if horizon <= 0 {
		horizon = 12
	}
	history := engine.LoadHistory()
	curLoad := engine.LastLoadMw()
	if curLoad <= 0 && len(history) > 0 {
		curLoad = history[len(history)-1]
	}
	if curLoad <= 0 {
		curLoad = peakMw * 0.85
	}
	if curLoad <= 0 {
		curLoad = 0.025
	}
	// Honest persistence baseline: do NOT fabricate a cubic Hermite spline curve.
	// The LSTM regressor predicts only a scalar peak, not a multi-step curve.
	series := make([]float64, horizon)
	val := math.Round(curLoad*10000) / 10000
	for i := 0; i < horizon; i++ {
		series[i] = val
	}
	return series
}

// generateFallbackForecast creates an honest baseline payload based on engine load history or physics baseline
// without synthesizing fake sinusoidal or spline curves.
func generateFallbackForecast(engine *simulation.Engine, horizon int) *simulation.ForecastGraphData {
	if horizon <= 0 {
		horizon = 12
	}
	history := engine.LoadHistory()
	lo, hi, n := engine.ObservedLoadRange()
	curLoad := engine.LastLoadMw()
	if curLoad <= 0 && len(history) > 0 {
		curLoad = history[len(history)-1]
	}
	if curLoad <= 0 {
		curLoad = 0.025
	}

	val := math.Round(curLoad*10000) / 10000
	upVal := math.Round(val*1.15*10000) / 10000
	lowVal := math.Round(val*0.90*10000) / 10000

	series := make([]float64, horizon)
	upperBand := make([]float64, horizon)
	quantiles := make(map[string][]float64)
	q1 := make([]float64, horizon)
	q5 := make([]float64, horizon)
	q9 := make([]float64, horizon)

	peak := val
	peakUpper := upVal

	// Honest persistence baseline: do NOT synthesize sine waves or fake fluctuations.
	for i := 0; i < horizon; i++ {
		series[i] = val
		q5[i] = val
		q1[i] = lowVal
		upperBand[i] = upVal
		q9[i] = upVal
	}
	quantiles["q1"] = q1
	quantiles["q5"] = q5
	quantiles["q9"] = q9

	res := engineResult{PeakMw: &peak}
	checkPlausible(&res, lo, hi, n)

	samples := len(history)
	if samples == 0 && n > 0 {
		samples = n
	}

	return &simulation.ForecastGraphData{
		Engine:         "fallback",
		Series:         series,
		UpperBand:      upperBand,
		UpperQuantile:  "q9",
		PeakUpperMw:    &peakUpper,
		LstmPeakMw:     &peak,
		StepMinutes:    histIntervalMinutes,
		HorizonMinutes: horizon * histIntervalMinutes,
		Plausible:      !res.Implausible,
		Plausibility:   res.Plausibility,
		Samples:        samples,
		Quantiles:      quantiles,
	}
}
