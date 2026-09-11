package simulation

import "time"

// TouBand names EVN's retail time-of-use band for an instant.
//
// This lived in bess.go, private to the battery. It had to move: the battery is a
// SIMULATION-ONLY asset — a real deployment has no pack unless it declares one — while
// the tariff clock is a property of the grid connection and is just as true on a site
// with no battery at all. Carbon accounting needs this band in real mode, where
// Bess.Dispatch never runs.
//
// Bands are EVN's published retail schedule:
//
//	offpeak  00:00–06:00, every day
//	peak     17:30–22:30, Monday–Saturday
//	normal   everything else, and all of Sunday outside the small hours
func TouBand(t time.Time) string {
	t = t.In(vnLoc)
	mins := t.Hour()*60 + t.Minute()
	if mins < 6*60 {
		return "offpeak" // 00:00–06:00 daily
	}
	if t.Weekday() != time.Sunday && mins >= 17*60+30 && mins < 22*60+30 {
		return "peak" // 17:30–22:30 Mon–Sat
	}
	return "normal"
}
