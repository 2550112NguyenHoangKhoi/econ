package main

import (
	"econ/simulation"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
)

type switchModelRequest struct {
	Model string `json:"model"`
}

// buildingDataHandler serves building geometry JSON.
// When ?model=home|office|domestic-home|multi-level is provided, it returns that specific model fixture.
// When no query parameter is provided, it returns the active building model loaded in the engine.
func buildingDataHandler(engine *simulation.Engine) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if corsPreflight(w, r) {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")

		modelParam := strings.TrimSpace(r.URL.Query().Get("model"))
		var targetFile string

		if modelParam != "" {
			targetFile = simulation.ModelFileFor(modelParam)
			if targetFile == "" {
				http.Error(w, fmt.Sprintf("unknown building model %q: must be 'multi-level' or 'domestic-home'", modelParam), http.StatusBadRequest)
				return
			}
		} else {
			if engine != nil && engine.BuildingId() == "bldg-econ-house-hcmc" {
				targetFile = simulation.BuildingDataHomeFile
			} else {
				targetFile = simulation.BuildingDataFile
			}
		}

		data, err := os.ReadFile(simulation.DataPath(targetFile))
		if err != nil {
			http.Error(w, "Failed to read building data: "+err.Error(), http.StatusInternalServerError)
			return
		}
		w.Write(data)
	}
}

// ontologyDataHandler serves the Brick Ontology JSON for the active or requested model.
func ontologyDataHandler(engine *simulation.Engine) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if corsPreflight(w, r) {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")

		modelParam := strings.TrimSpace(r.URL.Query().Get("model"))
		targetFile := simulation.OntologyFile

		if modelParam != "" {
			switch strings.ToLower(modelParam) {
			case "home", "domestic-home", "domestic_home", "house", "residential":
				targetFile = simulation.OntologyHomeFile
			default:
				targetFile = simulation.OntologyFile
			}
		} else if engine != nil && engine.BuildingId() == "bldg-econ-house-hcmc" {
			targetFile = simulation.OntologyHomeFile
		}

		path := simulation.DataPath(targetFile)
		data, err := os.ReadFile(path)
		if err != nil {
			// Fallback to standard ontology if specific home ontology is not present
			data, err = os.ReadFile(simulation.DataPath(simulation.OntologyFile))
			if err != nil {
				http.Error(w, "Failed to read ontology data: "+err.Error(), http.StatusInternalServerError)
				return
			}
		}
		w.Write(data)
	}
}

// buildingSwitchHandler dynamically switches the running building model in the simulation engine.
// Accepts JSON {"model": "multi-level" | "domestic-home"} or query param ?model=...
// buildingSwitchHandler reloads the engine onto another building model. It takes the
// state store because the switch is not complete until the PERSISTED toggle agrees:
// state_sync replays stateStore's toggles to every websocket that connects, so a switch
// that moved the engine but left buildingModelType at its old value made the engine tell
// each new client to switch back — which the dashboard obeyed, reverting the operator's
// choice on every reconnect and every panel that remounts a socket.
func buildingSwitchHandler(engine *simulation.Engine, stateStore *StateStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if corsPreflight(w, r) {
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "POST required to switch building model", http.StatusMethodNotAllowed)
			return
		}

		var req switchModelRequest
		if r.Body != nil {
			_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req)
		}
		if req.Model == "" {
			req.Model = r.URL.Query().Get("model")
		}

		req.Model = strings.TrimSpace(req.Model)
		if req.Model == "" {
			http.Error(w, "missing 'model' in request body or query parameter (e.g. 'multi-level' or 'domestic-home')", http.StatusBadRequest)
			return
		}

		targetFile := simulation.ModelFileFor(req.Model)
		if targetFile == "" {
			http.Error(w, fmt.Sprintf("unknown model %q: must be 'multi-level' or 'domestic-home'", req.Model), http.StatusBadRequest)
			return
		}

		data, err := os.ReadFile(simulation.DataPath(targetFile))
		if err != nil {
			http.Error(w, fmt.Sprintf("failed to read model file %s: %v", targetFile, err), http.StatusInternalServerError)
			return
		}

		if err := engine.ReloadBuilding(data); err != nil {
			http.Error(w, fmt.Sprintf("engine failed to reload model: %v", err), http.StatusUnprocessableEntity)
			return
		}

		log.Printf("[model-switch] switched active building to %q (id=%s, %d zones, %d vavs)",
			req.Model, engine.BuildingId(), len(engine.Zones), len(engine.Vavs))

		// Persist the choice and tell every other open dashboard, so the engine's own
		// state_sync now agrees with the building it actually has loaded. Broadcast with
		// no exclusion: the client that asked for the switch has already applied it
		// locally and ignores an update that matches what it is showing.
		if stateStore != nil {
			stateStore.Set("buildingModelType", req.Model)
			if err := stateStore.Save(); err != nil {
				log.Printf("[model-switch] could not persist buildingModelType: %v", err)
			}
			// Fanned out asynchronously: this is a REQUEST handler, and the broadcast
			// writes to every connected dashboard. Doing that inline made the reply to
			// THIS caller wait on the slowest websocket peer — with stale sockets open
			// the switch took 30 s while every other endpoint answered instantly. The
			// switch is already committed above; telling the other clients is not
			// something this caller should have to wait for.
			go BroadcastStateUpdate("buildingModelType", req.Model, nil)
		}

		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":         true,
			"model":      req.Model,
			"buildingId": engine.BuildingId(),
			"zones":      len(engine.Zones),
			"vavs":       len(engine.Vavs),
		})
	}
}
