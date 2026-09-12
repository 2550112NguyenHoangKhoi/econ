// fixture — building fixture: the JSON shapes the digitizer emits.
//
// Split out of engine.go, which had grown to 3,541 lines. Same package, same code:
// nothing here was rewritten, only moved to a file named after what it does.

package simulation

// Building Data structs
type ThermalProps struct {
	BaseHeatLoad        float64 `json:"baseHeatLoad"`
	Setpoint            float64 `json:"setpoint"`
	Deadband            float64 `json:"deadband"`
	SolarGainMultiplier float64 `json:"solarGainMultiplier"`
	RWall               float64 `json:"rWall"`
	CAir                float64 `json:"cAir"`
}

type HvacMap struct {
	VavId string `json:"vavId"`
}

type ZoneData struct {
	ZoneId            string       `json:"zoneId"`
	ZoneType          string       `json:"zoneType"`
	BimAssetId        string       `json:"bim_asset_id"`
	Volume            float64      `json:"volume"`
	WallArea          float64      `json:"wallArea"`
	Polygon           [][]float64  `json:"polygon"` // floor outline in metres; sizes the plug model
	ThermalProperties ThermalProps `json:"thermalProperties"`
	HvacMapping       HvacMap      `json:"hvacMapping"`
}

type FloorData struct {
	// Height is the floor-to-floor height in metres. It is what turns a digitized floor
	// AREA into the air VOLUME each VAV is sized against, so a building with 4 m floors
	// gets proportionally more supply air than one with 2.8 m floors.
	Height float64    `json:"height"`
	Zones  []ZoneData `json:"zones"`
}

type BuildingData struct {
	// BuildingId identifies WHICH building a fixture describes. The engine keeps it so
	// state that belongs to one specific building — the recorded load series the zero-shot
	// forecaster reads from — can be recognised as belonging to a different one and
	// discarded, rather than being stitched onto the current building's history.
	BuildingId string      `json:"buildingId"`
	Floors     []FloorData `json:"floors"`
}
