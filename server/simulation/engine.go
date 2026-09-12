// Package simulation is the physics engine: a 2R1C heat balance per zone, the models
// identified from each room's own history, and the actuation those models drive.
//
// engine.go carried all of it in 3,541 lines. It is now split by what the code does, so
// that the file you open matches the question you arrived with:
//
//	fixture.go      the JSON shapes the digitizer emits, before any of it is live
//	state.go        live state: ZoneSim, VavSim, Engine
//	building.go     construction, fixture loading, the Hardy Cross airflow network
//	telemetry.go    inbound measurements and how a payload finds its zone
//	actuate.go      setback, lighting and damper decisions
//	sensors.go      per-sensor freshness, outdoor conditions, supply air, solar gain
//	plant.go        plant COP, CO2 balance, hardware binding, pre-cool
//	models.go       learned baselines and room dynamics, and their persistence
//	hardware.go     the hardware node view the dashboard renders
//	clients.go      websocket clients, scenarios, the occupancy schedule
//	tick.go         the simulation loop and the integration itself
//	loadhistory.go  observed building load, the series the forecasters consume
//	broadcast.go    the flatbuffer frame the dashboard receives
//	commands.go     outbound commands and the manual-override latch
//
// The split is by responsibility, not by size, and no behaviour changed with it.
package simulation
