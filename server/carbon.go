package main

// Operational Scope 2 carbon accounting: the building's measured electrical draw
// integrated into energy, and energy into emissions at the grid's carbon intensity.
//
// Three neighbours carry the parts that are not that:
//
//	carbon_market.go       the voluntary-market price feed and what offsetting would cost
//	carbon_utilization.go  floor area against measured occupancy — the one non-energy end use
//	carbon_state.go        persistence of the two running integrals, and the HTTP handler
//
// The rule this file exists to keep: emissions are computed from power the twin actually
// metered. A modelled watt and a measured watt are not interchangeable here, because the
// output is a number someone may report.

import (
	"econ/simulation"
	"fmt"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Default configuration constants
const (
	defaultCarbonBudgetKg  = 50.0 // kgCO2e target budget
	defaultCarbonMarketURL = "https://api.coingecko.com/api/v3/simple/price?ids=toucan-protocol-base-carbon-tonne&vs_currencies=usd"
	// defaultMarketFallbackPrice is the last-resort benchmark used only if the library
	// cannot be read. The authoritative value, with its reasoning, is
	// carbonMarket.fallbackSpotUsdPerTon in programme-library.json -- a market coefficient
	// belongs there, not here (rule 2). See newCarbonMarketClient.
	defaultMarketFallbackPrice = 12.50 // USD per metric ton
	defaultMarketCacheTTL      = 10 * time.Minute
	defaultHTTPTimeout         = 8 * time.Second
	sustainabilityStatePath    = "./data/sustainability-state.json"

	// Predictive maintenance diagnostic thresholds
	powerStripRatedWatts          = 2000.0 // W
	acRatedWatts                  = 3500.0 // W
	powerSurgeDeltaWatts          = 1000.0 // W
	runtimeMaintenanceHours       = 2000.0 // hours
	activeEquipmentWattsThreshold = 5.0    // equipment draw to increment runtime
)

// SustainabilityPayload models the unified REST payload defined in PROJECT.md.
type SustainabilityPayload struct {
	Timestamp                   string                          `json:"timestamp"`
	CarbonAccounting            CarbonAccountingData            `json:"carbonAccounting"`
	SpaceUtilization            SpaceUtilizationData            `json:"spaceUtilization"`
	PredictiveMaintenance       PredictiveMaintenanceData       `json:"predictiveMaintenance"`
	CarbonCreditRecommendations CarbonCreditRecommendationsData `json:"carbonCreditRecommendations"`
}

type CarbonAccountingData struct {
	GridEmissionFactorKgPerKwh float64 `json:"gridEmissionFactorKgPerKwh"`
	// Grid says WHICH grid that factor belongs to, which tariff band it was read in, and
	// whether its time shape is an estimate. Without this the dashboard cannot tell a
	// measured intensity from a modelled one, and would present both the same way.
	Grid                               simulation.GridIntensity `json:"grid"`
	InstantaneousPowerW                float64                  `json:"instantaneousPowerW"`
	InstantaneousEmissionRateKgPerHour float64                  `json:"instantaneousEmissionRateKgPerHour"`
	CumulativeEmissionsKgCO2e          float64                  `json:"cumulativeEmissionsKgCO2e"`
	Breakdown                          PowerBreakdownData       `json:"breakdown"`
}

// PowerBreakdownData is the end-use disaggregation, with the provenance that makes it
// readable.
//
// The watts alone were ambiguous in the one direction that matters. AcW sums only measured
// clamps (z.HwAcW), so a building with no clamp fitted reported "HVAC: 0 W" -- while PlugW
// falls back to the MODELLED standby when no clamp reports, so plugs showed the whole
// building. The panel drew one bar at 100% plugs and 0 W HVAC on a building whose chillers
// were running, which is CLAUDE.md rule 1 verbatim: "A fabricated zero on a current clamp
// tells the twin the compressor is off."
//
// The measured/metered flags let a reader tell "measured, and it is zero" from "nothing is
// measuring this", so the UI can render the second as "not metered" rather than as a fact
// about the building.
type PowerBreakdownData struct {
	PlugW  float64 `json:"plugW"`
	StripW float64 `json:"stripW"`
	AcW    float64 `json:"acW"`
	// Zones contributing a genuine clamp reading to each figure. Zero means the number
	// above is not a measurement of that end use.
	PlugMeteredZones  int `json:"plugMeteredZones"`
	StripMeteredZones int `json:"stripMeteredZones"`
	AcMeteredZones    int `json:"acMeteredZones"`
	// PlugModelledZones counts zones whose plug figure came from the standby MODEL rather
	// than a clamp -- the asymmetry that made the bar read as it did.
	PlugModelledZones int `json:"plugModelledZones"`
}

type PredictiveMaintenanceData struct {
	ActiveAlertsCount int                `json:"activeAlertsCount"`
	Warnings          []MaintenanceAlert `json:"warnings"`
}

type MaintenanceAlert struct {
	EquipmentId     string   `json:"equipmentId"`
	ZoneId          string   `json:"zoneId"`
	Type            string   `json:"type"`
	Severity        string   `json:"severity"`
	Message         string   `json:"message"`
	MetricValue     float64  `json:"metricValue"`
	Threshold       float64  `json:"threshold"`
	Timestamp       string   `json:"timestamp"`
	Troubleshooting []string `json:"troubleshooting"`
	HealthScore     float64  `json:"healthScore"`
}

// CarbonTracker manages operational Scope 2 carbon accounting, space utilization, and equipment diagnostics.
type CarbonTracker struct {
	mu     sync.Mutex
	engine *simulation.Engine
	// gridFactorOverride is a flat kgCO2e/kWh from GRID_EMISSION_FACTOR; 0 means "use the
	// library anchor shaped by time of day" (gridFactorAt below).
	gridFactorOverride        float64
	carbonBudgetKg            float64
	cumulativeEmissionsKgCO2e float64
	lastTickAt                time.Time
	marketClient              *CarbonMarketClient
	equipmentRuntimeHours     map[string]float64
	lastEquipmentPower        map[string]float64
}

// newCarbonTracker initializes a new CarbonTracker instance with environment configuration.
func newCarbonTracker(engine *simulation.Engine) *CarbonTracker {
	// A site that has metered its own supply contract sets GRID_EMISSION_FACTOR and that
	// flat number wins. Everyone else gets the library's sourced annual factor, shaped
	// across the tariff day by the grid profile resolved from the site's coordinates.
	//
	// This used to be a hardcoded 0.5 kgCO2e/kWh. The library already carried a sourced
	// 0.6766 for the Vietnamese grid and nothing read it, so every emission this engine
	// has ever reported was 26% low.
	gridFactorOverride := 0.0
	if gfStr := os.Getenv("GRID_EMISSION_FACTOR"); gfStr != "" {
		if gf, err := strconv.ParseFloat(gfStr, 64); err == nil && gf > 0 {
			gridFactorOverride = gf
		}
	}

	carbonBudget := defaultCarbonBudgetKg
	if cbStr := os.Getenv("CARBON_BUDGET_KG"); cbStr != "" {
		if cb, err := strconv.ParseFloat(cbStr, 64); err == nil && cb > 0 {
			carbonBudget = cb
		}
	}

	return &CarbonTracker{
		engine:                engine,
		gridFactorOverride:    gridFactorOverride,
		carbonBudgetKg:        carbonBudget,
		marketClient:          NewCarbonMarketClient("", defaultMarketCacheTTL),
		equipmentRuntimeHours: make(map[string]float64),
		lastEquipmentPower:    make(map[string]float64),
		lastTickAt:            time.Now(),
	}
}

// SetCumulativeEmissions manually sets cumulative emissions (useful in tests).
func (t *CarbonTracker) SetCumulativeEmissions(kg float64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.cumulativeEmissionsKgCO2e = kg
}

// SetCarbonBudget manually sets the carbon budget (useful in tests).
func (t *CarbonTracker) SetCarbonBudget(kg float64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.carbonBudgetKg = kg
}

// SetEquipmentRuntimeHours updates equipment runtime hours (useful in predictive maintenance tests).
func (t *CarbonTracker) SetEquipmentRuntimeHours(equipId string, hours float64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.equipmentRuntimeHours[equipId] = hours
}

// gridFactorAt is the carbon intensity to bill an instant's energy at: the operator's
// flat override when one is set, otherwise the time-shaped grid intensity for right now.
// Energy consumed in the evening peak is charged at the peak rate, which is what makes
// shifting load into the solar hours show up as avoided carbon rather than only as
// avoided cost.
func (t *CarbonTracker) gridFactorAt(now time.Time) float64 {
	if t.gridFactorOverride > 0 {
		return t.gridFactorOverride
	}
	return simulation.GridFactorAt(now)
}

// RecordEnergy integrates energy and carbon emissions for a given load and duration.
func (t *CarbonTracker) RecordEnergy(powerW float64, dtSec float64) (energyKwh float64, kgCO2e float64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	energyKwh, kgCO2e = CalculateScope2Emissions(powerW, dtSec, t.gridFactorAt(time.Now()))
	t.cumulativeEmissionsKgCO2e += kgCO2e
	return energyKwh, kgCO2e
}

type equipMeasurement struct {
	equipId   string
	zoneId    string
	power     float64
	threshold float64
	isAc      bool
}

// Snapshot evaluates live engine telemetry and generates the unified SustainabilityPayload.
func (t *CarbonTracker) Snapshot(engine *simulation.Engine, now time.Time) SustainabilityPayload {
	t.mu.Lock()
	defer t.mu.Unlock()

	if now.IsZero() {
		now = time.Now()
	}

	// One grid reading for the whole snapshot, so the energy booked below and the rate
	// shown on screen are billed at the same instant's intensity.
	gridNow := simulation.GridIntensityAt(now)
	if t.gridFactorOverride > 0 {
		gridNow = simulation.GridIntensity{
			KgCo2ePerKwh:       t.gridFactorOverride,
			AnnualKgCo2ePerKwh: t.gridFactorOverride,
			GridName:           "operator override (GRID_EMISSION_FACTOR)",
			TouBand:            simulation.TouBand(now),
			Multiplier:         1.0,
			Resolved:           true,
		}
	}

	dtSec := 0.0
	if !t.lastTickAt.IsZero() {
		dtSec = now.Sub(t.lastTickAt).Seconds()
		if dtSec < 0 {
			dtSec = 0
		} else if dtSec > 3600 {
			dtSec = 1.0
		}
	}
	t.lastTickAt = now

	// 1. Gather electrical telemetry across zones
	var plugW, stripW, acW float64
	var plugMetered, stripMetered, acMetered, plugModelled int
	var equipList []equipMeasurement

	zoneSnap := map[string]*simulation.ZoneSim{}
	if engine != nil {
		zoneSnap = engine.SnapshotZones()
	}
	if len(zoneSnap) > 0 {
		var zoneIds []string
		for id := range zoneSnap {
			zoneIds = append(zoneIds, id)
		}
		sort.Strings(zoneIds)

		for _, id := range zoneIds {
			z := zoneSnap[id]

			// Plug draw. A clamp reading is a measurement; the standby figure is the
			// model standing in for one, and the two are counted separately so the
			// payload can say which the total is made of.
			pW := 0.0
			if z.HwPlugW > 0 {
				pW = z.HwPlugW
				plugMetered++
			} else if z.PlugStandbyW > 0 {
				pW = z.PlugStandbyW
				plugModelled++
			}
			plugW += pW

			// Strip draw
			sW := 0.0
			if z.HwStripW > 0 {
				sW = z.HwStripW
				stripMetered++
			}
			stripW += sW

			// AC draw. Measured only -- there is deliberately no model fallback here, so
			// the count is what tells a reader whether 0 W means "off" or "unmeasured".
			aW := 0.0
			if z.HwAcW > 0 {
				aW = z.HwAcW
				acMetered++
			}
			acW += aW

			if sW > 0 {
				equipList = append(equipList, equipMeasurement{
					equipId:   "strip-" + id,
					zoneId:    id,
					power:     sW,
					threshold: powerStripRatedWatts,
					isAc:      false,
				})
			}
			if aW > 0 {
				equipList = append(equipList, equipMeasurement{
					equipId:   "ac-" + id,
					zoneId:    id,
					power:     aW,
					threshold: acRatedWatts,
					isAc:      true,
				})
			}
		}
	}

	totalPowerW := plugW + stripW + acW
	if dtSec > 0 && totalPowerW > 0 && (engine == nil || engine.IsRealMode()) {
		_, carbonKg := CalculateScope2Emissions(totalPowerW, dtSec, gridNow.KgCo2ePerKwh)
		t.cumulativeEmissionsKgCO2e += carbonKg
	}

	instantaneousEmissionRate := (totalPowerW / 1000.0) * gridNow.KgCo2ePerKwh

	// 2. Predictive maintenance diagnostics
	warnings := make([]MaintenanceAlert, 0)

	if engine == nil || engine.IsRealMode() {
		for _, eq := range equipList {
			// Track equipment runtime hours
			if eq.power > activeEquipmentWattsThreshold && dtSec > 0 {
				t.equipmentRuntimeHours[eq.equipId] += dtSec / 3600.0
			}

			// Over-capacity detection
			if eq.power > eq.threshold {
				name := "Power strip"
				if eq.isAc {
					name = "AC unit"
				}
				healthScore := 100.0 - ((eq.power / eq.threshold) * 10.0)
				if healthScore < 0 {
					healthScore = 0
				}
				warnings = append(warnings, MaintenanceAlert{
					EquipmentId:     eq.equipId,
					ZoneId:          eq.zoneId,
					Type:            "over_capacity",
					Severity:        "warning",
					Message:         fmt.Sprintf("%s load exceeded rated threshold (%.1fW > %.0fW)", name, eq.power, eq.threshold),
					MetricValue:     eq.power,
					Threshold:       eq.threshold,
					Timestamp:       now.UTC().Format(time.RFC3339),
					Troubleshooting: []string{"Verify equipment isn't pulling short-circuit current", "Unplug non-essential devices from the circuit", "Inspect power supply for overheating"},
					HealthScore:     math.Round(healthScore),
				})
			}

			// Transient surge detection
			lastP, exists := t.lastEquipmentPower[eq.equipId]
			if exists && (eq.power-lastP) > powerSurgeDeltaWatts {
				delta := eq.power - lastP
				warnings = append(warnings, MaintenanceAlert{
					EquipmentId:     eq.equipId,
					ZoneId:          eq.zoneId,
					Type:            "power_surge",
					Severity:        "warning",
					Message:         fmt.Sprintf("Transient power surge detected on %s: delta +%.1fW exceeds %.0fW threshold (%.1fW -> %.1fW)", eq.equipId, delta, powerSurgeDeltaWatts, lastP, eq.power),
					MetricValue:     delta,
					Threshold:       powerSurgeDeltaWatts,
					Timestamp:       now.UTC().Format(time.RFC3339),
					Troubleshooting: []string{"Check for compressor stall or heavy inductive load startup", "Inspect capacitors and motor windings", "Deploy power quality analyzer to verify harmonic distortion"},
					HealthScore:     70.0,
				})
			}
			t.lastEquipmentPower[eq.equipId] = eq.power
		}

		// Runtime hours maintenance check (> 2000 hours)
		var runtimeEquipIds []string
		for eqId := range t.equipmentRuntimeHours {
			runtimeEquipIds = append(runtimeEquipIds, eqId)
		}
		sort.Strings(runtimeEquipIds)

		for _, eqId := range runtimeEquipIds {
			hours := t.equipmentRuntimeHours[eqId]
			if hours > runtimeMaintenanceHours {
				zoneId := strings.TrimPrefix(strings.TrimPrefix(eqId, "strip-"), "ac-")
				healthScore := 100.0 * (runtimeMaintenanceHours / hours)
				if healthScore < 0 {
					healthScore = 0
				}
				warnings = append(warnings, MaintenanceAlert{
					EquipmentId:     eqId,
					ZoneId:          zoneId,
					Type:            "runtime_exceeded",
					Severity:        "warning",
					Message:         fmt.Sprintf("Equipment runtime exceeded maintenance threshold (%.1f hours > %.0f hours)", hours, runtimeMaintenanceHours),
					MetricValue:     math.Round(hours*10.0) / 10.0,
					Threshold:       runtimeMaintenanceHours,
					Timestamp:       now.UTC().Format(time.RFC3339),
					Troubleshooting: []string{"Schedule preventative maintenance window", "Replace HEPA filters and clean coils", "Check bearings and lubricate moving parts", "Perform IR thermography scan"},
					HealthScore:     math.Round(healthScore),
				})
			}
		}
	} else {
		// Clear surge tracking so we don't get false surges when switching back to RealMode
		t.lastEquipmentPower = make(map[string]float64)
	}

	// 3. Space utilization efficiency
	spaceData := computeSpaceUtilization(engine)

	// 4. Carbon credit recommendations with live market quote
	quote, _ := t.marketClient.GetQuote()
	recData := CalculateOffsetRecommendation(t.cumulativeEmissionsKgCO2e, t.carbonBudgetKg, quote)

	return SustainabilityPayload{
		Timestamp: now.UTC().Format(time.RFC3339),
		CarbonAccounting: CarbonAccountingData{
			GridEmissionFactorKgPerKwh:         gridNow.KgCo2ePerKwh,
			Grid:                               gridNow,
			InstantaneousPowerW:                math.Round(totalPowerW*10.0) / 10.0,
			InstantaneousEmissionRateKgPerHour: math.Round(instantaneousEmissionRate*1000.0) / 1000.0,
			CumulativeEmissionsKgCO2e:          math.Round(t.cumulativeEmissionsKgCO2e*100.0) / 100.0,
			Breakdown: PowerBreakdownData{
				PlugW:             math.Round(plugW*10.0) / 10.0,
				StripW:            math.Round(stripW*10.0) / 10.0,
				AcW:               math.Round(acW*10.0) / 10.0,
				PlugMeteredZones:  plugMetered,
				StripMeteredZones: stripMetered,
				AcMeteredZones:    acMetered,
				PlugModelledZones: plugModelled,
			},
		},
		SpaceUtilization: spaceData,
		PredictiveMaintenance: PredictiveMaintenanceData{
			ActiveAlertsCount: len(warnings),
			Warnings:          warnings,
		},
		CarbonCreditRecommendations: recData,
	}
}
