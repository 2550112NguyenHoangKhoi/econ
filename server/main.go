package main

// Startup: read the environment, build the engine, register every HTTP route, and run.
//
// This file is meant to read as the wiring diagram for the whole server -- one place that
// names every route and every background loop. Two things that used to live here and are
// not wiring now sit beside it:
//
//	websocket.go     the /ws handler and its origin check
//	command_http.go  the /api/command allow-list, which is a security boundary

import (
	"econ/simulation"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"
)

func main() {
	// Initialize simulation engine
	engine := simulation.NewEngine()

	// 1. Serve building data (supports ?model=home|office|domestic-home|multi-level)
	http.HandleFunc("/api/building-data", buildingDataHandler(engine))

	// 2. Serve Brick Ontology Data (supports ?model=home|office)
	http.HandleFunc("/api/ontology", ontologyDataHandler(engine))

	// 2b. Serve the programme library's dashboard-facing view.
	//
	// The panels need three things the physics already owns: the design supply-air
	// temperature, the plant coefficients that price a setpoint change, and which zone
	// types are critical. Every one of those had been retyped as a JavaScript literal,
	// and the critical-type list had gone stale against the digitizer's own vocabulary —
	// the UI was still excluding "server-room" from its waste and setback advice in a
	// building whose comms rooms are typed "comms-room", so it counted them as waste.
	// One endpoint, read from the same file the engine evaluates.
	// Registered below, once the engine exists: the view carries the building id and the
	// occupancy model version, which is how a browser knows whether the window it has been
	// accumulating in localStorage still describes the series the engine is producing.
	http.HandleFunc("/api/library", func(w http.ResponseWriter, r *http.Request) {
		if corsPreflight(w, r) {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(simulation.Library(engine.BuildingId()))
	})

	// [GEMINI IMPLEMENTATION START]
	initDB()
	engine.Persist = persistReading
	http.HandleFunc("/api/history", historyHandler)
	// [GEMINI IMPLEMENTATION END]

	// State Persistence Store & Cold-Boot Engine Restoration (Milestone 2)
	stateStore := NewStateStore("./data/dashboard-state.json", DB)
	applyPersistentStateToEngine(engine, stateStore)
	http.HandleFunc("/api/state", stateHandler(engine, stateStore))
	go statePersistLoop(stateStore)

	// Dynamic building model switching. Registered here rather than beside the other
	// building routes because the handler needs the state store: switching the engine
	// without also updating the persisted buildingModelType leaves state_sync telling
	// every new client to switch back.
	http.HandleFunc("/api/building/switch", buildingSwitchHandler(engine, stateStore))
	http.HandleFunc("/api/model/switch", buildingSwitchHandler(engine, stateStore))

	// Generic per-zone, per-metric time series (TimescaleDB). The read path for
	// everything the engine persists beyond the two hardcoded history charts — most
	// importantly the AFDD residual, the queryable drift history behind a "dispatch
	// technician" alert. GET /api/series?zone=&metric=&minutes=
	http.HandleFunc("/api/series", seriesHandler)

	// 3. Peak-load forecast: proxy a live-telemetry window to the Python LSTM service.
	http.HandleFunc("/api/forecast", forecastHandler(engine))

	// 4. Physical edge nodes (ESP32 / Pico): which zones are hardware-bound right now.
	// The dashboard polls this to badge zones that mirror a real device.
	http.HandleFunc("/api/hardware", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		json.NewEncoder(w).Encode(engine.HardwareStatus())
	})

	// 4a. Teammate Vision Interface: Accepts JSON payload with detected brand to set IR protocols.
	http.HandleFunc("/api/vision/detection", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		var payload struct {
			ZoneId   string `json:"zone"`
			Protocol string `json:"protocol"` // e.g. "PANASONIC_AC", "ELECTRA_AC"
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if engine.UpdateDetectedProtocol(payload.ZoneId, payload.Protocol) {
			log.Printf("[vision] Zone %s IR protocol dynamically set to: %s", payload.ZoneId, payload.Protocol)
			w.WriteHeader(http.StatusOK)
		} else {
			http.Error(w, "zone not found", http.StatusNotFound)
		}
	})

	// 4b. Hardware Inspector Manual Commands: allows direct human overrides from the device view.
	http.HandleFunc("/api/command", commandHandler(engine))

	// 4c. TEMPORARY bring-up module (devices.go): the raw MQTT view one level below
	// /api/hardware — every node seen, per-field freshness, dropout log, and the
	// measured/modelled split of stored history. Delete this line and devices.go to
	// remove it once the hardware is stable.
	registerDeviceRoutes(func() []simulation.HardwareNode {
		return engine.HardwareStatus()
	})

	// 5. Forecast-driven pre-cooling: GET = window status, POST = open a window now.
	// The background poller (precool.go) opens windows automatically off the LSTM.
	http.HandleFunc("/api/precool", precoolHandler(engine))

	// 6. Live weather: what outdoor temperature the 2R1C envelope is using, and whether
	// it is live Open-Meteo data or the climatological fallback.
	http.HandleFunc("/api/weather", weatherHandler(engine))

	// 7. Blueprint import: digitize a real-world drawing for review, then deploy it as
	// the running building. Deploy/rollback are guarded by ECON_ADMIN_TOKEN when set,
	// back up the previous building automatically, and append to the audit log
	// (blueprint.go).
	http.HandleFunc("/api/digitize", digitizeHandler())
	http.HandleFunc("/api/building", deployBuildingHandler(engine))
	http.HandleFunc("/api/building/backups", backupsHandler())
	http.HandleFunc("/api/building/rollback", rollbackHandler(engine))

	// 8. Plug-load management (APLC): the end use a conventional BMS neither meters nor
	// controls — and the largest one in the Hanoi case study (26.4% of energy). GET =
	// snapshot + phantom leaderboard; POST = sweep policy (guarded, audited, durable).
	loadPlugState(engine)
	http.HandleFunc("/api/plugs", plugsHandler(engine))

	// 9. Learned recommendations (recommendapi.go): the ranked, per-zone anomaly report
	// scored against the online baseline model that replaced the hardcoded threshold
	// cards. The model is restored at boot and checkpointed once a minute so its learned
	// "normal" survives a redeploy.
	loadBaselineState(engine)
	http.HandleFunc("/api/recommendations", recommendationsHandler(engine))

	// 9b. Learned room dynamics (simulation/dynamics.go): the online system identification
	// that gives every room its own physical model — thermal time constant, the cooling its
	// VAV actually delivers, its measured air-change rate. It is what makes the report
	// predictive ("this room breaches in 14 min") instead of only reactive, and it is
	// restored and checkpointed alongside the baselines.
	loadDynamicsState(engine)
	loadLoadHistoryState(engine)
	http.HandleFunc("/api/rooms/models", roomModelsHandler(engine))

	// 10. Downloadable local models (modelexport.go): package the learned baseline model,
	// the identified room models, the LSTM forecaster artifacts, and dependency-free
	// runtimes into one zip so the operator can run recommendations, alerts and room
	// predictions offline from the twin's own processed state. /api/model/recommend sizes
	// that bundle to the machine that will actually run it (modelcatalog.go).
	http.HandleFunc("/api/model", modelInfoHandler(engine))
	http.HandleFunc("/api/model/export", modelExportHandler(engine))
	http.HandleFunc("/api/model/recommend", modelRecommendHandler())

	// 11. Zero-shot load forecasting (forecast.go -> backend/forecasting): Google TimesFM
	// is a pretrained time-series foundation model, so it forecasts this building's load
	// with no training and no fitted scaler. That covers the supervised LSTM's cold start,
	// where it has nothing to offer until train.py has real accumulated history.
	http.HandleFunc("/api/forecast/load", loadForecastHandler(engine))
	http.HandleFunc("/api/forecast/engines", forecastEnginesHandler())

	// 11b. Both forecasters over the same instant, side by side. The supervised LSTM and
	// the zero-shot foundation model answer the same question with opposite trade-offs,
	// and until this endpoint nothing in the system ever put their answers next to each
	// other — which is the only way to decide which one this building should trust.
	http.HandleFunc("/api/forecast/compare", compareForecastHandler(engine))

	// 12. Sustainability & Decarbonization module (carbon.go): Scope 2 operational carbon tracking,
	// predictive maintenance, space utilization efficiency, and live carbon credit recommendations.
	carbonTracker := newCarbonTracker(engine)
	loadSustainabilityState(carbonTracker, engine.BuildingId())
	http.HandleFunc("/api/sustainability", sustainabilityHandler(engine, carbonTracker))

	// 13. Operation Mode REST API (modeapi.go): GET/POST /api/mode to query or switch
	// between Simulation Mode and Real Mode.
	http.HandleFunc("/api/mode", modeHandler(engine, stateStore))

	// Connect to the MQTT broker: ingest real occupancy from the CV/edge layer and
	// publish actuation commands to the ESP32. Non-blocking; the sim runs regardless.
	startMQTT(engine)

	go engine.Start()
	go precoolLoop(engine)
	go weatherLoop(engine)
	go plugPersistLoop(engine)
	go baselinePersistLoop(engine)
	go carbonPersistLoop(carbonTracker, engine)

	// 2. WebSocket endpoint for telemetry streaming
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		handleWebSocket(w, r, engine, stateStore)
	})

	// Start server. PORT is overridable so a second engine can be run alongside a live
	// one — the identification soak takes hours, and having to kill it to test an
	// unrelated change is how a soak never finishes.
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	logAuthPosture()
	log.Printf("ECON Enterprise Backend running on port %s...\n", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}

// statePersistLoop periodically persists the state store to ensure durability.
func statePersistLoop(store *StateStore) {
	if store == nil {
		return
	}
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		_ = store.Save()
	}
}
