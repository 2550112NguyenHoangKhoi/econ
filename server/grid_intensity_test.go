package main

import (
	"econ/simulation"
	"testing"
	"time"
)

// vnTime builds an instant in the building's own timezone. The tariff bands are defined
// against the wall clock in Vietnam, so a test written in UTC would land in the wrong
// band for most of the day.
func vnTime(t *testing.T, weekday time.Weekday, hour, min int) time.Time {
	t.Helper()
	loc, err := time.LoadLocation("Asia/Ho_Chi_Minh")
	if err != nil {
		t.Skipf("tzdata unavailable: %v", err)
	}
	// 2026-09-07 is a Monday; walk forward to the weekday asked for.
	d := time.Date(2026, 9, 7, hour, min, 0, 0, loc)
	return d.AddDate(0, 0, int(weekday-time.Monday+7)%7)
}

// TestGridIntensity_BandsFollowEvnClock pins the three tariff bands to the hours EVN
// actually publishes. A band boundary that drifts would silently re-price every kWh.
func TestGridIntensity_BandsFollowEvnClock(t *testing.T) {
	cases := []struct {
		name    string
		weekday time.Weekday
		h, m    int
		want    string
	}{
		{"just after midnight", time.Tuesday, 0, 30, "offpeak"},
		{"05:59 still offpeak", time.Tuesday, 5, 59, "offpeak"},
		{"06:00 becomes normal", time.Tuesday, 6, 0, "normal"},
		{"midday is normal", time.Tuesday, 12, 0, "normal"},
		{"17:29 still normal", time.Tuesday, 17, 29, "normal"},
		{"17:30 enters peak", time.Tuesday, 17, 30, "peak"},
		{"22:29 still peak", time.Tuesday, 22, 29, "peak"},
		{"22:30 leaves peak", time.Tuesday, 22, 30, "normal"},
		{"Saturday evening is peak", time.Saturday, 19, 0, "peak"},
		{"Sunday evening is NOT peak", time.Sunday, 19, 0, "normal"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := simulation.TouBand(vnTime(t, c.weekday, c.h, c.m)); got != c.want {
				t.Errorf("TouBand = %q, want %q", got, c.want)
			}
		})
	}
}

// TestGridIntensity_MiddayIsCleanestThanEvening is the whole point of the time shape: if
// midday is not cheaper in carbon than the evening peak, shifting load into the solar
// hours cannot be credited, and the pre-cool feature has no carbon story.
func TestGridIntensity_MiddayIsCleanestThanEvening(t *testing.T) {
	midday := simulation.GridIntensityAt(vnTime(t, time.Tuesday, 12, 0))
	evening := simulation.GridIntensityAt(vnTime(t, time.Tuesday, 19, 0))
	night := simulation.GridIntensityAt(vnTime(t, time.Tuesday, 2, 0))

	if !midday.Resolved {
		t.Skip("site coordinates resolve to no characterised grid; shape test not applicable")
	}
	if !(midday.KgCo2ePerKwh < night.KgCo2ePerKwh) {
		t.Errorf("midday (%.4f) should be cleaner than overnight (%.4f): Vietnam's solar fleet runs at midday",
			midday.KgCo2ePerKwh, night.KgCo2ePerKwh)
	}
	if !(night.KgCo2ePerKwh < evening.KgCo2ePerKwh) {
		t.Errorf("overnight baseload (%.4f) should be cleaner than the evening peak (%.4f)",
			night.KgCo2ePerKwh, evening.KgCo2ePerKwh)
	}
}

// TestGridIntensity_ShapePreservesTheAnnualAnchor guards the property the library claims:
// adding a time shape must re-time the annual factor, not quietly change its level.
func TestGridIntensity_ShapePreservesTheAnnualAnchor(t *testing.T) {
	anchor := simulation.GridEmissionFactor()
	if anchor <= 0 {
		t.Fatalf("library annual grid factor is %v, want > 0", anchor)
	}

	// Time-weight the bands over one week: offpeak 42 h, peak 30 h, normal 96 h.
	sample := simulation.GridIntensityAt(vnTime(t, time.Tuesday, 12, 0))
	if !sample.Resolved {
		t.Skip("no characterised grid for this site")
	}
	off := simulation.GridIntensityAt(vnTime(t, time.Tuesday, 2, 0)).KgCo2ePerKwh
	nor := simulation.GridIntensityAt(vnTime(t, time.Tuesday, 12, 0)).KgCo2ePerKwh
	pk := simulation.GridIntensityAt(vnTime(t, time.Tuesday, 19, 0)).KgCo2ePerKwh

	weighted := (42*off + 96*nor + 30*pk) / 168
	drift := (weighted - anchor) / anchor
	if drift < -0.02 || drift > 0.02 {
		t.Errorf("time-weighted mean %.4f drifts %.1f%% from the annual anchor %.4f; the shape must re-time the factor, not re-level it",
			weighted, drift*100, anchor)
	}
}

// TestGridIntensity_CarriesProvenance protects rule 1: an estimated shape must be
// declared as one, so no dashboard can present it as measured.
func TestGridIntensity_CarriesProvenance(t *testing.T) {
	g := simulation.GridIntensityAt(vnTime(t, time.Tuesday, 12, 0))
	if !g.Resolved {
		t.Skip("no characterised grid for this site")
	}
	if g.GridId == "" || g.GridName == "" {
		t.Errorf("resolved intensity must name its grid, got id=%q name=%q", g.GridId, g.GridName)
	}
	if !g.ShapeIsEstimate {
		t.Error("the bundled Vietnamese shape is reasoned from dispatch, not measured; it must report ShapeIsEstimate")
	}
	if g.AnnualKgCo2ePerKwh != simulation.GridEmissionFactor() {
		t.Errorf("anchor reported as %.4f but the library holds %.4f: there must be only one copy of that number",
			g.AnnualKgCo2ePerKwh, simulation.GridEmissionFactor())
	}
}

// TestCarbonTracker_OverrideBeatsTheShape verifies the escape hatch a metered site needs.
func TestCarbonTracker_OverrideBeatsTheShape(t *testing.T) {
	tr := newCarbonTracker(nil)
	tr.gridFactorOverride = 0.42
	if got := tr.gridFactorAt(vnTime(t, time.Tuesday, 19, 0)); got != 0.42 {
		t.Errorf("override should win in every band, got %v", got)
	}
}
