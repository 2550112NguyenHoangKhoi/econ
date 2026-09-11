package main

import (
	"econ/simulation"

	"encoding/json"
	"github.com/gorilla/websocket"
	"io"
	"log"
	"net/http"
	"sync"
	"time"
)

// stateResponse represents the standard response structure for /api/state endpoints.
type stateResponse struct {
	OK         bool                   `json:"ok"`
	BuildingId string                 `json:"buildingId"`
	UpdatedAt  string                 `json:"updatedAt"`
	Toggles    map[string]interface{} `json:"toggles"`
	Key        string                 `json:"key,omitempty"`
	Value      interface{}            `json:"value,omitempty"`
}

// statePostRequest parses the incoming payload for POST /api/state.
type statePostRequest struct {
	Toggles    map[string]interface{} `json:"toggles"`
	Key        string                 `json:"key"`
	Value      interface{}            `json:"value"`
	BuildingId string                 `json:"buildingId"`
}

// StateHub manages active WebSocket connections for state synchronization.
type StateHub struct {
	mu      sync.RWMutex
	clients map[wsSender]bool
}

// wsSender abstracts the WriteMessage method of websocket.Conn for easy testing and loose coupling.
type wsSender interface {
	WriteMessage(messageType int, data []byte) error
}

var globalStateHub = &StateHub{
	clients: make(map[wsSender]bool),
}

// RegisterStateWsClient adds a WebSocket client to the state broadcast hub.
func RegisterStateWsClient(client wsSender) {
	if client == nil {
		return
	}
	globalStateHub.mu.Lock()
	defer globalStateHub.mu.Unlock()
	globalStateHub.clients[client] = true
}

// UnregisterStateWsClient removes a WebSocket client from the state broadcast hub.
func UnregisterStateWsClient(client wsSender) {
	if client == nil {
		return
	}
	globalStateHub.mu.Lock()
	defer globalStateHub.mu.Unlock()
	delete(globalStateHub.clients, client)
}

// BroadcastStateUpdate transmits a single state_update frame to connected clients.
func BroadcastStateUpdate(key string, value interface{}, exclude wsSender) {
	globalStateHub.mu.RLock()
	conns := make([]wsSender, 0, len(globalStateHub.clients))
	for c := range globalStateHub.clients {
		if exclude == nil || c != exclude {
			conns = append(conns, c)
		}
	}
	globalStateHub.mu.RUnlock()

	now := time.Now().UTC().Format(time.RFC3339)
	payload := map[string]interface{}{
		"type":      "state_update",
		"key":       key,
		"value":     value,
		"timestamp": now,
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}

	// 1 is websocket.TextMessage
	for _, c := range conns {
		_ = safeStateSend(c, 1, data)
	}
}

// safeStateSend routes real websocket connections through the per-connection write
// lock so a state_update cannot interleave with the engine's telemetry broadcast.
// Test doubles implement wsSender without being a *websocket.Conn and pass through.
func safeStateSend(c wsSender, messageType int, data []byte) error {
	if conn, ok := c.(*websocket.Conn); ok {
		return simulation.WSWrite(conn, messageType, data)
	}
	return c.WriteMessage(messageType, data)
}

// BroadcastStateBatch transmits state_update frames for multiple updated toggles.
func BroadcastStateBatch(toggles map[string]interface{}, exclude wsSender) {
	if len(toggles) == 0 {
		return
	}
	globalStateHub.mu.RLock()
	conns := make([]wsSender, 0, len(globalStateHub.clients))
	for c := range globalStateHub.clients {
		if exclude == nil || c != exclude {
			conns = append(conns, c)
		}
	}
	globalStateHub.mu.RUnlock()

	now := time.Now().UTC().Format(time.RFC3339)
	for k, v := range toggles {
		payload := map[string]interface{}{
			"type":      "state_update",
			"key":       k,
			"value":     v,
			"timestamp": now,
		}
		data, err := json.Marshal(payload)
		if err == nil {
			for _, c := range conns {
				_ = safeStateSend(c, 1, data)
			}
		}
	}
}

// stateHandler provides the REST handler for GET and POST /api/state.
func stateHandler(engine *simulation.Engine, store *StateStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if corsPreflight(w, r) {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")

		if store == nil {
			http.Error(w, `{"error":"State store not initialized"}`, http.StatusInternalServerError)
			return
		}

		switch r.Method {
		case http.MethodGet:
			queryKey := r.URL.Query().Get("key")
			all := store.GetAll()

			resp := stateResponse{
				OK:         true,
				BuildingId: store.BuildingId(),
				UpdatedAt:  store.UpdatedAt().Format(time.RFC3339),
				Toggles:    all,
			}
			if queryKey != "" {
				resp.Key = queryKey
				resp.Value = all[queryKey]
			}
			_ = json.NewEncoder(w).Encode(resp)
			return

		case http.MethodPost:
			r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1 MB limit
			bodyBytes, err := io.ReadAll(r.Body)
			if err != nil {
				http.Error(w, `{"error":"Failed to read request body"}`, http.StatusBadRequest)
				return
			}

			var req statePostRequest
			if err := json.Unmarshal(bodyBytes, &req); err != nil {
				// Fallback: try parsing body as a direct map of toggles e.g. {"autoPilot": false}
				var directMap map[string]interface{}
				if err2 := json.Unmarshal(bodyBytes, &directMap); err2 != nil {
					http.Error(w, `{"error":"Invalid JSON payload"}`, http.StatusBadRequest)
					return
				}
				req.Toggles = directMap
			}

			updatedToggles := make(map[string]interface{})

			if req.BuildingId != "" {
				store.SetBuildingId(req.BuildingId)
			}

			if req.Toggles != nil {
				for k, v := range req.Toggles {
					updatedToggles[k] = v
				}
			}

			if req.Key != "" {
				updatedToggles[req.Key] = req.Value
			}

			if len(updatedToggles) == 0 {
				http.Error(w, `{"error":"No toggles or key/value provided to update"}`, http.StatusBadRequest)
				return
			}

			// Store and update
			store.SetAll(updatedToggles)

			// Apply to live engine if applicable
			if engine != nil {
				applyPersistentStateToEngine(engine, store)
			}

			// Durably persist to storage
			if err := store.Save(); err != nil {
				log.Printf("[state] Warning: failed to save state store: %v", err)
			}

			// Broadcast updates to all connected WebSocket clients
			BroadcastStateBatch(updatedToggles, nil)

			resp := stateResponse{
				OK:         true,
				BuildingId: store.BuildingId(),
				UpdatedAt:  store.UpdatedAt().Format(time.RFC3339),
				Toggles:    store.GetAll(),
			}
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(resp)
			return

		default:
			http.Error(w, `{"error":"Method not allowed"}`, http.StatusMethodNotAllowed)
		}
	}
}
