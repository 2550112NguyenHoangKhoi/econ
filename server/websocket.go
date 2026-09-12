package main

import (
	"econ/simulation"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/gorilla/websocket"
)

// The websocket the dashboard lives on, and the origin check in front of it.
//
// Split out of main.go so that file is the wiring diagram it should be. Browsers do not
// apply the same-origin policy to WebSockets, so checkOrigin (auth.go) is the only thing
// between a page the operator happened to open and a socket that can switch the building --
// which is why the upgrader is declared here beside the handler it guards rather than
// among the server's startup lines.

// checkOrigin lives in auth.go. Browsers do not apply the same-origin policy to
// WebSockets, so this is the only thing standing between a page the operator happened to
// open and a socket that can switch the building.
var upgrader = websocket.Upgrader{CheckOrigin: checkOrigin}

func handleWebSocket(w http.ResponseWriter, r *http.Request, engine *simulation.Engine, stores ...*StateStore) {
	var stateStore *StateStore
	if len(stores) > 0 {
		stateStore = stores[0]
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade error: %v", err)
		return
	}
	defer conn.Close()

	// Register with state broadcast hub & send initial state_sync frame before telemetry broadcast attaches
	if stateStore != nil {
		syncFrame := map[string]interface{}{
			"type":    "state_sync",
			"toggles": stateStore.GetAll(),
		}
		if syncBytes, err := json.Marshal(syncFrame); err == nil {
			_ = simulation.WSWrite(conn, websocket.TextMessage, syncBytes)
		}
		RegisterStateWsClient(conn)
		defer UnregisterStateWsClient(conn)
	}

	engine.AddClient(conn)
	defer engine.RemoveClient(conn)

	log.Println("New telemetry client connected!")

	// Telemetry is readable by anyone who got this far; control is not. A connection
	// starts unauthorized and stays that way until it presents the token, so the
	// read-only case (a wall display, a read-only viewer) needs no credential at all.
	// In demo mode (no ECON_ADMIN_TOKEN) every connection is authorized on arrival —
	// the engine warns about that at boot rather than silently pretending otherwise.
	authorized := !authEnforced()

	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			log.Println("Client disconnected")
			break
		}
		// The auth handshake is handled before the command log line: a token must never
		// be written to the log, and every other message is safe to record.
		if tok, isAuth := parseAuthMessage(msg); isAuth {
			authorized = tokenMatches(tok)
			if authorized {
				log.Println("[auth] websocket client authorized for control")
				_ = simulation.WSWrite(conn, websocket.TextMessage, []byte(`{"type":"auth","ok":true}`))
			} else {
				log.Println("[auth] websocket client presented an invalid token")
				_ = simulation.WSWrite(conn, websocket.TextMessage, []byte(`{"type":"auth","ok":false}`))
			}
			continue
		}
		if !authorized {
			log.Printf("[auth] refused command from unauthorized websocket client: %s", string(msg))
			_ = simulation.WSWrite(conn, websocket.TextMessage,
				[]byte(`{"type":"error","error":"unauthorized: send {\"action\":\"auth\",\"token\":\"...\"} before issuing commands"}`))
			continue
		}
		log.Printf("Received command: %s", string(msg))
		// Isolate command handling: a panic here must never take down the whole
		// backend (and thus stop the telemetry stream for every client).
		func() {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("recovered from panic handling command %q: %v", string(msg), r)
				}
			}()
			// [GEMINI IMPLEMENTATION START]
			// Added by Gemini (Antigravity) on June 2026.
			// This block intercepts JSON payloads for manual override vetos
			// sent from the dashboard, parsing them to trigger PublishCommand
			// while leaving legacy string scenarios intact.
			strMsg := string(msg)
			if len(strMsg) > 0 && strMsg[0] == '{' {
				// State persistence toggle action: {"action": "set_state", "key": "...", "value": ...}
				// or {"action": "set_state", "toggles": { ... }}
				var st struct {
					Action  string                 `json:"action"`
					Key     string                 `json:"key"`
					Value   interface{}            `json:"value"`
					Toggles map[string]interface{} `json:"toggles"`
				}
				if json.Unmarshal(msg, &st) == nil && st.Action == "set_state" {
					updates := make(map[string]interface{})
					if st.Toggles != nil {
						for k, v := range st.Toggles {
							updates[k] = v
						}
					}
					if st.Key != "" {
						updates[st.Key] = st.Value
					}
					if len(updates) > 0 && stateStore != nil {
						stateStore.SetAll(updates)
						applyPersistentStateToEngine(engine, stateStore)
						_ = stateStore.Save()
						BroadcastStateBatch(updates, conn)
					}
					return
				}

				// Auto-Pilot toggle carries a bool value, so it is parsed first with its
				// own shape (the override map below is map[string]string and would reject
				// it). This is what makes the dashboard's AI switch a real engine control.
				var ap struct {
					Action string `json:"action"`
					Value  *bool  `json:"value"`
				}
				if json.Unmarshal(msg, &ap) == nil && ap.Action == "autopilot" && ap.Value != nil {
					engine.SetAutoPilot(*ap.Value)
					if stateStore != nil {
						stateStore.Set("autoPilot", *ap.Value)
						_ = stateStore.Save()
						BroadcastStateUpdate("autoPilot", *ap.Value, conn)
					}
					return
				}
				// Model switch command: {"action": "switch_model", "model": "..."} or {"action": "switch_building", "model": "..."}
				var sm struct {
					Action string `json:"action"`
					Model  string `json:"model"`
				}
				if json.Unmarshal(msg, &sm) == nil && (sm.Action == "switch_model" || sm.Action == "switch_building") && sm.Model != "" {
					targetFile := simulation.ModelFileFor(sm.Model)
					if targetFile == "" {
						log.Printf("[ws] unknown model switch target: %q", sm.Model)
						_ = simulation.WSWrite(conn, websocket.TextMessage, []byte(`{"type":"error","error":"unknown model"}`))
						return
					}
					data, err := os.ReadFile(simulation.DataPath(targetFile))
					if err != nil {
						log.Printf("[ws] failed to read building file %q: %v", targetFile, err)
						_ = simulation.WSWrite(conn, websocket.TextMessage, []byte(`{"type":"error","error":"failed to read model file"}`))
						return
					}
					if err := engine.ReloadBuilding(data); err != nil {
						log.Printf("[ws] failed to reload building: %v", err)
						_ = simulation.WSWrite(conn, websocket.TextMessage, []byte(`{"type":"error","error":"failed to reload building"}`))
						return
					}
					if stateStore != nil {
						stateStore.Set("buildingModel", sm.Model)
						_ = stateStore.Save()
						BroadcastStateUpdate("buildingModel", sm.Model, conn)
					}
					log.Printf("[ws] successfully switched model to %q (%s, %d zones, %d vavs)",
						sm.Model, engine.BuildingId(), len(engine.Zones), len(engine.Vavs))
					_ = simulation.WSWrite(conn, websocket.TextMessage, []byte(
						fmt.Sprintf(`{"type":"switch_model","ok":true,"model":%q,"buildingId":%q,"zones":%d,"vavs":%d}`,
							sm.Model, engine.BuildingId(), len(engine.Zones), len(engine.Vavs)),
					))
					return
				}
				var override map[string]string
				if err := json.Unmarshal(msg, &override); err == nil {
					if action, ok := override["action"]; ok {
						if action == "precool" {
							// Building-wide strategy, not a per-zone veto: open a
							// pre-cool window ahead of the predicted demand peak.
							until := engine.StartPreCool(precoolWindow)
							log.Printf("[precool] dashboard opened window until %s", until.Format("15:04:05"))
							return
						}
						if zone, ok := override["zone"]; ok {
							engine.PublishCommand(action, zone)
							return
						}
					}
				}
			}
			// [GEMINI IMPLEMENTATION END]
			engine.SetScenario(strMsg)
		}()
	}
}
