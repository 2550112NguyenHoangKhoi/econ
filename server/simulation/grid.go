package simulation

import (
	"sync"
	"time"
)

// Which grid is this building drawing from, and how dirty is that grid right now?
//
// The site already knows where it is — SiteLat/SiteLon, the same coordinates the weather
// poller and the solar geometry agree on — so the grid is resolved from position rather
// than configured by hand. That is the phone's trick: a device that knows where it is can
// look up the published carbon intensity of the grid it is plugged into, without the
// owner telling it anything.
//
// What this deliberately does NOT do is pretend to measure. It selects a PUBLISHED grid
// factor and applies a documented time shape to it. A site outside every characterised
// grid is reported as unknown and gets a flat shape, because inventing a dispatch curve
// for a grid nobody has published would be a fabricated measurement wearing the clothes
// of a real one.

// GridIntensity is the carbon intensity of the local grid at one instant, with enough
// provenance attached that a consumer can say where it came from.
type GridIntensity struct {
	// KgCo2ePerKwh is the factor to bill this instant's energy at.
	KgCo2ePerKwh float64 `json:"kgCo2ePerKwh"`
	// AnnualKgCo2ePerKwh is the published annual anchor the shape is applied to.
	AnnualKgCo2ePerKwh float64 `json:"annualKgCo2ePerKwh"`
	// GridId is the profile that matched ("" when the site sits outside all of them).
	GridId string `json:"gridId"`
	// GridName is that profile's human name, or a plain statement that it is unknown.
	GridName string `json:"gridName"`
	// TouBand is the tariff band this instant falls in.
	TouBand string `json:"touBand"`
	// Multiplier is the band multiplier applied to the anchor.
	Multiplier float64 `json:"multiplier"`
	// ShapeIsEstimate is true when the time shape is reasoned rather than measured. The
	// dashboard must not present an estimated intensity as a measured one.
	ShapeIsEstimate bool `json:"shapeIsEstimate"`
	// Resolved is false when no profile matched the site's coordinates.
	Resolved bool `json:"resolved"`
}

var (
	gridOnce    sync.Once
	gridId      string
	gridProfile GridProfile
	gridFound   bool
)

// resolveGrid picks the profile whose bounds contain the site, once per process. The site
// does not move while the engine runs; a deployment that relocates restarts it.
func resolveGrid() (string, GridProfile, bool) {
	gridOnce.Do(func() {
		lat, lon := SiteLat(), SiteLon()
		for id, p := range GridShapeLib().Profiles {
			b := p.Bounds
			if lat >= b.LatMin && lat <= b.LatMax && lon >= b.LonMin && lon <= b.LonMax {
				gridId, gridProfile, gridFound = id, p, true
				return
			}
		}
	})
	return gridId, gridProfile, gridFound
}

// GridIntensityAt returns the grid carbon intensity for an instant.
//
// The annual anchor comes from the library's single sourced figure; the band multiplier
// comes from the resolved grid profile. An unresolved site gets the anchor unshaped,
// which is the honest answer rather than a convenient one.
func GridIntensityAt(t time.Time) GridIntensity {
	anchor := GridEmissionFactor()
	band := TouBand(t)

	id, prof, ok := resolveGrid()
	if !ok {
		m := GridShapeLib().UnknownGrid.Multiplier
		if m <= 0 {
			m = 1.0
		}
		return GridIntensity{
			KgCo2ePerKwh:       anchor * m,
			AnnualKgCo2ePerKwh: anchor,
			GridName:           "grid not characterised for this location",
			TouBand:            band,
			Multiplier:         m,
			Resolved:           false,
		}
	}

	m, has := prof.TouBandMultiplier[band]
	if !has || m <= 0 {
		m = 1.0
	}
	return GridIntensity{
		KgCo2ePerKwh:       anchor * m,
		AnnualKgCo2ePerKwh: anchor,
		GridId:             id,
		GridName:           prof.Name,
		TouBand:            band,
		Multiplier:         m,
		ShapeIsEstimate:    prof.TouBandMultiplierEstimate,
		Resolved:           true,
	}
}

// GridFactorAt is the scalar form, for call sites that only need the number.
func GridFactorAt(t time.Time) float64 { return GridIntensityAt(t).KgCo2ePerKwh }
