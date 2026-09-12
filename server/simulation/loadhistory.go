// loadhistory — observed building load: the series the forecasters consume.
//
// Split out of engine.go, which had grown to 3,541 lines. Same package, same code:
// nothing here was rewritten, only moved to a file named after what it does.

package simulation

import (
	"encoding/json"
	"log"
	"math"
)

// MarshalLoadHistory / LoadLoadHistory persist the load series across restarts.
//
// This matters more than it looks: a foundation model's forecast quality is a function of
// how much real context it gets, and the series only accumulates at one sample per five
// minutes. Discarding it on every redeploy would permanently cap the forecaster at however
// long the process happened to have been up.
// loadHistoryDoc is the persisted form of the recorded load series. The bare []float64
// this replaces could not say WHICH building it described, so a checkout that swapped its
// fixture reloaded the previous building's megawatts as if they were this one's — and the
// zero-shot forecaster, whose whole value is that it reads the building's own history,
// was handed two buildings spliced into one series with no discontinuity marked.
type loadHistoryDoc struct {
	BuildingId string    `json:"buildingId"`
	ModelVer   int       `json:"occupancyModelVersion"`
	Site       string    `json:"site,omitempty"`
	Samples    []float64 `json:"samples"`
}

func (e *Engine) MarshalLoadHistory() ([]byte, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return json.Marshal(loadHistoryDoc{
		BuildingId: e.buildingId, ModelVer: OccupancyModelVersion, Site: SiteFingerprint(),
		Samples: e.loadHist,
	})
}

// BuildingId reports the fixture currently loaded (empty when it declared none).
func (e *Engine) BuildingId() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.buildingId
}

func (e *Engine) LoadLoadHistory(data []byte) error {
	var doc loadHistoryDoc
	if err := json.Unmarshal(data, &doc); err != nil {
		// Legacy form: a bare array, from before the series recorded which building it
		// belonged to. It is accepted, but it cannot prove it describes this building, so
		// it is only trusted when the current fixture declares no id either.
		var legacy []float64
		if err2 := json.Unmarshal(data, &legacy); err2 != nil {
			return err
		}
		doc = loadHistoryDoc{Samples: legacy}
	}
	hist := doc.Samples

	e.mu.Lock()
	defer e.mu.Unlock()

	// A series recorded against a different building is not this building's history.
	// Restoring it would anchor every zero-shot forecast on a building that is not here.
	if doc.BuildingId != e.buildingId {
		log.Printf("[forecast] recorded load history belongs to %q but the loaded building is %q — "+
			"discarding %d samples rather than forecasting this building from another one",
			doc.BuildingId, e.buildingId, len(hist))
		e.loadHist = e.loadHist[:0]
		return nil
	}
	// The recorded megawatts are only this building's if the model that produced them still
	// is. This series is not merely plotted: it is the range the plausibility check refuses
	// a forecast against, the history the zero-shot forecaster reads, and the peak the
	// battery's nameplate is sized from. A load recorded with a population the building
	// never had would keep all three anchored to it.
	if doc.ModelVer != OccupancyModelVersion {
		log.Printf("[forecast] recorded load history was produced under occupancy model v%d, "+
			"this engine is v%d — discarding %d samples; the load this building draws changed "+
			"with the occupancy driving it", doc.ModelVer, OccupancyModelVersion, len(hist))
		e.loadHist = e.loadHist[:0]
		return nil
	}
	if !sameSite(doc.Site) {
		log.Printf("[forecast] recorded load history was measured on network %s but this "+
			"engine is on %s — discarding %d samples. These megawatts are the range the "+
			"plausibility check refuses a forecast against and the peak the battery is sized "+
			"from; both must describe the place the engine is actually running.",
			doc.Site, SiteFingerprint(), len(hist))
		e.loadHist = e.loadHist[:0]
		return nil
	}
	// Only finite, positive samples: a corrupt file must not be able to teach the
	// forecaster that the building drew NaN megawatts.
	e.loadHist = e.loadHist[:0]
	for _, v := range hist {
		if v > 0 && !math.IsNaN(v) && !math.IsInf(v, 0) {
			e.loadHist = append(e.loadHist, v)
		}
	}
	if len(e.loadHist) > loadHistKeep {
		e.loadHist = e.loadHist[len(e.loadHist)-loadHistKeep:]
	}
	return nil
}

// LoadHistory returns the retained building-load series (MW, oldest first) for the
// zero-shot forecaster. Unlike the LSTM window it is NEVER padded: a foundation model
// handles a short series natively, so the honest thing is to hand over exactly what has
// really been measured and let the caller report how much that is.
// ObservedLoadRange reports the lowest and highest building load in the recorded series,
// and how many samples back it. It is what a forecast can be sanity-checked against: a
// predicted peak far outside anything this building has ever been seen at is a statement
// about the model, not about the building.
func (e *Engine) ObservedLoadRange() (min, max float64, n int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.observedLoadRange()
}

// observedLoadRange is the same answer for callers that already hold the lock.
func (e *Engine) observedLoadRange() (min, max float64, n int) {
	// Prefer the running range: it is sampled at the baseline cadence, so it becomes
	// usable evidence within minutes of boot rather than after two hours of 5-minute
	// forecast samples. Fall back to the forecast history for a process that has just
	// restored one and has not yet observed a live tick.
	if e.loadSeen > 0 {
		return e.loadMinMw, e.loadMaxMw, e.loadSeen
	}
	for i, v := range e.loadHist {
		if i == 0 || v < min {
			min = v
		}
		if i == 0 || v > max {
			max = v
		}
	}
	return min, max, len(e.loadHist)
}

func (e *Engine) LoadHistory() []float64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]float64(nil), e.loadHist...)
}

// LastLoadMw returns the latest computed building electrical load in MW.
func (e *Engine) LastLoadMw() float64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.lastLoadMw
}

// ForecastWindow returns the [room_temp(°C), airflow_fraction(0..1)] sequence the
// Python forecaster expects — the REAL sampled last hour, most recent last — plus how
// many of the timesteps are genuine samples. While the buffer is still warming up
// after a boot, the window is left-padded with the oldest real sample (or the current
// state when the buffer is empty), and the caller can report that honestly instead of
// presenting a photocopied instant as an hour of history.
func (e *Engine) ForecastWindow(seqLen int) ([][]float64, int) {
	e.mu.Lock()
	defer e.mu.Unlock()

	real := e.histBuf
	if len(real) > seqLen {
		real = real[len(real)-seqLen:]
	}
	pad := e.currentAvg()
	if len(real) > 0 {
		pad = real[0]
	}

	seq := make([][]float64, seqLen)
	for i := range seq {
		idx := i - (seqLen - len(real))
		s := pad
		if idx >= 0 {
			s = real[idx]
		}
		seq[i] = []float64{s.temp, s.flow}
	}
	return seq, len(real)
}
