package main

import (
	"econ/simulation"
	"testing"
)

// TestForecastGraph_PeakUpperMatchesItsOwnBand pins the contract written on the field
// itself: PeakUpperMw is "peak of the highest decile", so it must be the peak of the
// UpperBand shipped in the same payload.
//
// The LSTM tier used to compute it as lstmPeak*1.10, a different quantity from the band
// it built out of the trajectory. With a flat persistence path at 0.712 MW the payload
// carried UpperBand 0.783 and PeakUpperMw 2.509, and the dashboard — which prints
// PeakUpperMw as "Q9 <n> MW" directly above the dashed band it draws from UpperBand —
// captioned a line at 0.783 MW with the number 2.509 MW.
//
// The TimesFM and fallback tiers already agreed with the band; only this one did not, so
// the check is written against every tier the engine can answer from.
func TestForecastGraph_PeakUpperMatchesItsOwnBand(t *testing.T) {
	engine := simulation.NewEngine()

	fc := BuildForecastGraph(engine, 12)
	if fc == nil {
		t.Fatal("BuildForecastGraph returned nil")
	}
	if len(fc.UpperBand) == 0 {
		t.Skipf("tier %q shipped no upper band; nothing to check", fc.Engine)
	}
	if fc.PeakUpperMw == nil {
		t.Fatalf("tier %q shipped an upper band but no PeakUpperMw", fc.Engine)
	}

	bandPeak := 0.0
	for _, v := range fc.UpperBand {
		if v > bandPeak {
			bandPeak = v
		}
	}

	// Rounded to 4dp on the way out, so compare with a tolerance that allows only that.
	const tol = 1e-4
	diff := *fc.PeakUpperMw - bandPeak
	if diff < -tol || diff > tol {
		t.Errorf("tier %q: PeakUpperMw = %.4f but the peak of its own UpperBand is %.4f.\n"+
			"The dashboard prints the former as the caption for a line drawn from the latter, "+
			"so these must be the same number.", fc.Engine, *fc.PeakUpperMw, bandPeak)
	}

	// The supervised peak is a separate reading and must not have been folded in.
	if fc.LstmPeakMw != nil && *fc.LstmPeakMw > 0 {
		if *fc.PeakUpperMw == round4(*fc.LstmPeakMw*1.10) && bandPeak != round4(*fc.LstmPeakMw*1.10) {
			t.Errorf("tier %q: PeakUpperMw still looks like lstmPeak*1.10 (%.4f) rather than the band peak (%.4f)",
				fc.Engine, *fc.PeakUpperMw, bandPeak)
		}
	}
}

func round4(v float64) float64 {
	return float64(int64(v*10000+0.5)) / 10000
}
