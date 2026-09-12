package main

import (
	"econ/simulation"
	"math"
	"sort"
	"strings"
)

// Space utilization — floor area against the occupancy actually measured in it.
//
// Split out of carbon.go: this is the only end use in that file that is not energy. It
// compares each zone's area per occupant against its programme's design figure, so an
// under-used floor shows up as area being conditioned for nobody. The design figures come
// from the programme library, not from constants here, per the coefficient rule.

type SpaceUtilizationData struct {
	TotalLiveOccupants       int                    `json:"totalLiveOccupants"`
	TotalBuildingCapacity    int                    `json:"totalBuildingCapacity"`
	OverallEfficiencyPercent float64                `json:"overallEfficiencyPercent"`
	Zones                    []ZoneSpaceUtilization `json:"zones"`
}

type ZoneSpaceUtilization struct {
	ZoneId            string  `json:"zoneId"`
	LiveOccupants     int     `json:"liveOccupants"`
	DesignCapacity    int     `json:"designCapacity"`
	EfficiencyPercent float64 `json:"efficiencyPercent"`
}

// computeSpaceUtilization calculates space utilization efficiency for occupiable zones.
func computeSpaceUtilization(engine *simulation.Engine) SpaceUtilizationData {
	data := SpaceUtilizationData{
		Zones: make([]ZoneSpaceUtilization, 0),
	}
	if engine == nil {
		return data
	}
	// One consistent snapshot: ranging the live map and re-indexing it afterwards raced
	// ReloadBuilding and crashed the engine on a nil zone. See Engine.SnapshotZones.
	zoneSnap := engine.SnapshotZones()
	if len(zoneSnap) == 0 {
		return data
	}

	var zoneIds []string
	for id := range zoneSnap {
		zoneIds = append(zoneIds, id)
	}
	sort.Strings(zoneIds)

	for _, id := range zoneIds {
		z := zoneSnap[id]
		areaPerPerson, occupiable := getDesignAreaPerOccupant(z.Type)
		if !occupiable || areaPerPerson <= 0 {
			// Exclude non-occupiable service zones (corridor, wet-core, plant-room, store, etc.)
			continue
		}

		capacity := int(math.Floor(z.AreaM2 / areaPerPerson))
		if capacity < 1 {
			capacity = 1
		}

		eff := 0.0
		if capacity > 0 {
			eff = math.Round((float64(z.Occupancy)/float64(capacity))*10000.0) / 100.0
		}

		data.TotalLiveOccupants += z.Occupancy
		data.TotalBuildingCapacity += capacity
		data.Zones = append(data.Zones, ZoneSpaceUtilization{
			ZoneId:            id,
			LiveOccupants:     z.Occupancy,
			DesignCapacity:    capacity,
			EfficiencyPercent: eff,
		})
	}

	if data.TotalBuildingCapacity > 0 {
		data.OverallEfficiencyPercent = math.Round((float64(data.TotalLiveOccupants)/float64(data.TotalBuildingCapacity))*10000.0) / 100.0
	}
	return data
}

// getDesignAreaPerOccupant returns design m² per occupant and whether space is occupiable.
func getDesignAreaPerOccupant(zoneType string) (float64, bool) {
	norm := strings.ToLower(strings.TrimSpace(zoneType))

	// Explicit non-occupiable service zones to exclude
	switch norm {
	case "corridor", "wet-core", "store", "plant-room", "comms-room", "mechanical", "server-room":
		return 0, false
	}

	// Programme library inspection
	lib := simulation.Library("")
	if prog, ok := lib.Programmes[norm]; ok {
		if prog.AreaPerOccupantM2 != nil && *prog.AreaPerOccupantM2 > 0 {
			return *prog.AreaPerOccupantM2, true
		}
		return 0, false
	}

	// Heuristic rules for common zone designations
	if strings.Contains(norm, "meeting") || strings.Contains(norm, "conference") {
		return 2.5, true
	}
	if strings.Contains(norm, "office") {
		return 10.0, true
	}
	if strings.Contains(norm, "lobby") {
		return 20.0, true
	}

	return 0, false
}
