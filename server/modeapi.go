package main

import (
	"econ/simulation"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
)

// modeResponse represents the standard JSON response payload for GET and POST /api/mode.
// It provides both snake_case and camelCase fields to support all API contracts seamlessly.
type modeResponse struct {
	OK          bool   `json:"ok"`
	Mode        string `json:"mode"`
	ModeInt     int    `json:"mode_int"`
	IsReal      bool   `json:"is_real"`
	IsRealCamel bool   `json:"isReal"`
	Description string `json:"description"`
}

// modeRequest represents the expected JSON payload for POST /api/mode.
type modeRequest struct {
	Mode interface{} `json:"mode"`
}

// parseOperationMode parses various representations of mode into simulation.OperationMode.
// It accepts: "simulation", "sim", "0", "real", "1", numbers 0 and 1, booleans, etc.
func parseOperationMode(val interface{}) (simulation.OperationMode, error) {
	if val == nil {
		return simulation.ModeSimulation, fmt.Errorf("mode cannot be nil")
	}

	switch v := val.(type) {
	case string:
		cleaned := strings.ToLower(strings.TrimSpace(v))
		switch cleaned {
		case "real", "1", "mode_real", "modereal", "true", "real_mode":
			return simulation.ModeReal, nil
		case "simulation", "sim", "0", "mode_simulation", "modesimulation", "false", "sim_mode":
			return simulation.ModeSimulation, nil
		default:
			return simulation.ModeSimulation, fmt.Errorf("invalid mode %q: must be 'simulation', 'sim', '0', 'real', or '1'", v)
		}
	case float64:
		if v == 1 {
			return simulation.ModeReal, nil
		} else if v == 0 {
			return simulation.ModeSimulation, nil
		}
		return simulation.ModeSimulation, fmt.Errorf("invalid mode numeric value %v: must be 0 or 1", v)
	case int:
		if v == 1 {
			return simulation.ModeReal, nil
		} else if v == 0 {
			return simulation.ModeSimulation, nil
		}
		return simulation.ModeSimulation, fmt.Errorf("invalid mode integer value %d: must be 0 or 1", v)
	case bool:
		if v {
			return simulation.ModeReal, nil
		}
		return simulation.ModeSimulation, nil
	default:
		return simulation.ModeSimulation, fmt.Errorf("unsupported mode type %T", val)
	}
}

// buildModeResponse constructs the standardized modeResponse payload.
func buildModeResponse(m simulation.OperationMode) modeResponse {
	isReal := (m == simulation.ModeReal)
	desc := "Simulation mode (synthetic and mock telemetry accepted)"
	if isReal {
		desc = "Real mode (strictly ingests genuine physical hardware telemetry and rejects mock data)"
	}
	return modeResponse{
		OK:          true,
		Mode:        m.String(),
		ModeInt:     int(m),
		IsReal:      isReal,
		IsRealCamel: isReal,
		Description: desc,
	}
}

// modeHandler exposes GET and POST /api/mode for querying and toggling the engine operation mode.
// modeHandler reads and switches the engine's operation mode. It takes the state store
// for the same reason buildingSwitchHandler does: applyPersistentStateToEngine pushes the
// PERSISTED operationMode back onto the engine on every set_state, so a mode changed here
// and not written back left a stale toggle that silently reverted the engine the next
// time any dashboard toggled anything at all.
func modeHandler(engine *simulation.Engine, stateStore *StateStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if corsPreflight(w, r) {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")

		if engine == nil {
			http.Error(w, `{"error":"Engine not initialized"}`, http.StatusInternalServerError)
			return
		}

		switch r.Method {
		case http.MethodGet:
			_ = json.NewEncoder(w).Encode(buildModeResponse(engine.Mode()))
			return

		case http.MethodPost:
			var targetVal interface{}

			// 1. Try reading JSON body
			if r.Body != nil {
				bodyBytes, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
				if err == nil && len(bodyBytes) > 0 {
					var req modeRequest
					if err := json.Unmarshal(bodyBytes, &req); err == nil && req.Mode != nil {
						targetVal = req.Mode
					} else {
						// Fallback: check if the body is a direct string like "real" or "1"
						var rawStr string
						if err := json.Unmarshal(bodyBytes, &rawStr); err == nil && rawStr != "" {
							targetVal = rawStr
						} else {
							trimmed := strings.TrimSpace(string(bodyBytes))
							if trimmed != "" && !strings.HasPrefix(trimmed, "{") {
								targetVal = trimmed
							}
						}
					}
				}
			}

			// 2. Try query parameter if not in body
			if targetVal == nil || targetVal == "" {
				if qMode := r.URL.Query().Get("mode"); qMode != "" {
					targetVal = qMode
				}
			}

			if targetVal == nil || targetVal == "" {
				http.Error(w, `{"error":"missing 'mode' in request body or query parameter (must be 'real', '1', 'simulation', 'sim', or '0')"}`, http.StatusBadRequest)
				return
			}

			parsedMode, err := parseOperationMode(targetVal)
			if err != nil {
				http.Error(w, fmt.Sprintf(`{"error":%q}`, err.Error()), http.StatusBadRequest)
				return
			}

			engine.SetMode(parsedMode)
			log.Printf("[mode] Operation mode switched to %q (isReal=%v)", parsedMode.String(), engine.IsRealMode())

			// Keep the persisted copy in step with the engine, and tell the other open
			// dashboards. Without this the two disagree and the stale one wins.
			if stateStore != nil {
				stateStore.Set("operationMode", parsedMode.String())
				if err := stateStore.Save(); err != nil {
					log.Printf("[mode] could not persist operationMode: %v", err)
				}
				BroadcastStateUpdate("operationMode", parsedMode.String(), nil)
			}

			_ = json.NewEncoder(w).Encode(buildModeResponse(engine.Mode()))
			return

		default:
			http.Error(w, `{"error":"Method not allowed"}`, http.StatusMethodNotAllowed)
		}
	}
}
