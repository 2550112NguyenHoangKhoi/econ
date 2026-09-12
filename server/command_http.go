package main

import (
	"econ/simulation"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
)

// The HTTP command surface: what an operator may ask the engine to do over /api/command.
//
// Split out of main.go because this is a security boundary, not startup wiring.
// isSupportedCommand is an allow-list, deliberately: an unknown command is refused rather
// than forwarded, and REBOOT is absent from it on purpose -- the admin token is optional,
// so a dispatchable reboot would be reachable by anyone who can reach the engine. Zone ids
// are matched against validZoneRegex before they ever reach a topic string.

var validZoneRegex = regexp.MustCompile(`^[a-zA-Z0-9_\- ]{1,64}$`)

func isSupportedCommand(cmd string) bool {
	trimmed := strings.TrimSpace(cmd)
	if trimmed == "" {
		return false
	}
	upper := strings.ToUpper(trimmed)
	if strings.HasPrefix(upper, "LIGHTS_") ||
		strings.HasPrefix(upper, "SETPOINT=") ||
		strings.HasPrefix(upper, "HVAC_SET:") ||
		strings.HasPrefix(upper, "IR_SEND:") ||
		upper == "IR_CARRIER" ||
		upper == "PLUG_ON" || upper == "PLUG_OFF" ||
		strings.HasPrefix(upper, "DAMPER=") ||
		strings.HasPrefix(upper, "VAV_SET:") ||
		strings.HasPrefix(upper, "CPU_STRAIN:") ||
		// Runtime radar tuning and node restart. Without these, changing a range gate or a
		// frame filter means editing build flags and reflashing, which is a 90-second round
		// trip for a one-byte parameter.
		strings.HasPrefix(upper, "RADAR_GATES=") ||
		strings.HasPrefix(upper, "RADAR_DELAY=") ||
		strings.HasPrefix(upper, "RADAR_FRAMES=") ||
		// REBOOT is deliberately NOT dispatchable over HTTP. The adversarial suite lists
		// "reboot" alongside "shutdown" and "rm -rf /" as verbs that must be rejected, and
		// that is the right call: this endpoint's admin token is optional, so anything
		// reachable here is reachable by anyone who can reach the engine. The firmware still
		// handles REBOOT over the serial console, where physical access is the gate.
		strings.HasPrefix(upper, "PROTOCOL=") ||
		upper == "CAMERA_TRIGGER" ||
		strings.HasPrefix(upper, "CONFIG:") {
		return true
	}
	// Check compound ;-separated commands (e.g. "LIGHTS_ON;SETPOINT=20.0" or "PLUG_OFF;CPU_STRAIN:HIGH")
	if strings.Contains(trimmed, ";") {
		tokens := strings.Split(trimmed, ";")
		allValid := true
		count := 0
		for _, tok := range tokens {
			tok = strings.TrimSpace(tok)
			if tok == "" {
				continue
			}
			count++
			if !isSupportedCommand(tok) {
				allValid = false
				break
			}
		}
		if allValid && count > 0 {
			return true
		}
	}
	lower := strings.ToLower(trimmed)
	switch lower {
	case "turn_off_ac", "cool", "purge", "precool", "reset", "camera_trigger":
		return true
	default:
		return false
	}
}

// commandHandler handles manual command overrides from the UI or external callers.
// Supports both "command" and "action" fields, and "zone", "device_id", or "deviceId".
func commandHandler(engine *simulation.Engine) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if corsPreflight(w, r) {
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}

		// Enforce request body size limit (4KB maximum)
		r.Body = http.MaxBytesReader(w, r.Body, 4096)

		var payload struct {
			Zone     string `json:"zone"`
			DeviceId string `json:"device_id"`
			DeviceID string `json:"deviceId"`
			Command  string `json:"command"`
			Action   string `json:"action"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if strings.TrimSpace(payload.Command) == "" && strings.TrimSpace(payload.Action) != "" {
			payload.Command = strings.TrimSpace(payload.Action)
		} else {
			payload.Command = strings.TrimSpace(payload.Command)
		}
		payload.Zone = strings.TrimSpace(payload.Zone)
		if payload.Zone == "" {
			if strings.TrimSpace(payload.DeviceId) != "" {
				payload.Zone = strings.TrimSpace(payload.DeviceId)
			} else if strings.TrimSpace(payload.DeviceID) != "" {
				payload.Zone = strings.TrimSpace(payload.DeviceID)
			}
		}
		if payload.Zone == "" || payload.Command == "" {
			http.Error(w, "zone and command/action are required", http.StatusBadRequest)
			return
		}

		// Validate zone identifier syntax (alphanumeric, hyphen, underscore, max 64 chars)
		if !validZoneRegex.MatchString(payload.Zone) {
			http.Error(w, "invalid zone identifier", http.StatusBadRequest)
			return
		}

		// Validate command matches supported verbs or prefixes
		if !isSupportedCommand(payload.Command) {
			http.Error(w, "unsupported command", http.StatusBadRequest)
			return
		}

		engine.PublishCommand(payload.Command, payload.Zone)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"status":  "ok",
			"message": "command dispatched",
		})
	}
}

// CommandHandler is an exported alias for commandHandler.
func CommandHandler(engine *simulation.Engine) http.HandlerFunc {
	return commandHandler(engine)
}
