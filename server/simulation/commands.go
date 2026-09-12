// commands — outbound commands and the manual-override latch.
//
// Split out of engine.go, which had grown to 3,541 lines. Same package, same code:
// nothing here was rewritten, only moved to a file named after what it does.

package simulation

import (
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"
)

// [GEMINI IMPLEMENTATION START]
// PublishCommand dispatches a manual override directly to the edge IoT device,
// bypassing the autonomous optimizer (the "human-in-the-loop" veto). The action is
// normalized to a firmware-valid payload before publishing so the ESP32 (which only
// parses LIGHTS_ON|OFF / SETPOINT= / HVAC_SET:) always gets something it can actuate,
// regardless of which UI panel issued it. The override is transient: the occupancy
// optimizer reasserts control on the next tick.
func (e *Engine) PublishCommand(action, zoneRef string) {
	e.mu.Lock()
	defer e.mu.Unlock()

	z := e.resolveZone(zoneRef)
	topic := zoneRef
	if z != nil && z.MqttTopic != "" {
		topic = z.MqttTopic
	}

	if strings.HasPrefix(action, "CONFIG:") {
		payload := strings.TrimSpace(action[7:])
		log.Printf("[config] manual config payload to %s: %s", topic, payload)
		if e.Publish != nil {
			e.Publish("econ/config/"+topic, payload)
		}
		return
	}

	if z != nil {
		// Set a 15-minute latch so the optimizer respects the human veto
		z.OverrideUntil = time.Now().Add(15 * time.Minute)
	}

	cmd := normalizeOverride(action, z)
	if z != nil {
		// Mirror the veto onto the twin's own state immediately — the 3D lighting,
		// /api/hardware and the optimizer's view must reflect the human command during
		// the latch, not only after the optimizer reasserts control.
		applyCommandToZone(z, cmd)
	}

	// Mirror damper override to VavSim if target is a zone or vav
	upperCmd := strings.ToUpper(cmd)
	if strings.Contains(upperCmd, "DAMPER=") || strings.Contains(upperCmd, "VAV_SET:") {
		vav := e.findVavForZone(zoneRef, nil)
		if vav == nil && z != nil {
			for zid, zone := range e.Zones {
				if zone == z {
					vav = e.findVavForZone(zid, nil)
					break
				}
			}
		}
		if vav != nil {
			for _, tok := range strings.Split(cmd, ";") {
				tok = strings.TrimSpace(tok)
				upperTok := strings.ToUpper(tok)
				valStr := ""
				if strings.HasPrefix(upperTok, "DAMPER=") {
					valStr = tok[len("DAMPER="):]
				} else if strings.HasPrefix(upperTok, "VAV_SET:") {
					valStr = tok[len("VAV_SET:"):]
				}
				if valStr != "" {
					if v, err := strconv.ParseFloat(valStr, 64); err == nil {
						if v > 1.0 {
							v = v / 100.0
						}
						if v < 0.0 {
							v = 0.0
						} else if v > 1.0 {
							v = 1.0
						}
						vav.DamperPos = v
						vav.Position = v
						vav.TargetDamperPos = v
						vav.TargetPosition = v
						vav.Damper = v
					}
				}
			}
		}
	}

	log.Printf("[override] manual command %q (from %q) to %s (latched 15m)", cmd, action, topic)
	if e.Publish != nil {
		e.Publish("econ/commands/"+topic, cmd)
	}
}

// applyCommandToZone applies a firmware-format command string to the engine's zone
// state. Mirrors the edge firmware's parser: ;-separated LIGHTS_x / SETPOINT= /
// HVAC_SET: / IR_SEND: / PLUG_x / DAMPER= / VAV_SET: / CPU_STRAIN: tokens, unknown tokens ignored. Lock held by the caller.
func applyCommandToZone(z *ZoneSim, cmd string) {
	for _, tok := range strings.Split(cmd, ";") {
		tok = strings.TrimSpace(tok)
		upper := strings.ToUpper(tok)
		switch {
		case tok == "LIGHTS_ON" || upper == "LIGHTS_ON":
			z.LightsOn = true
		case tok == "LIGHTS_OFF" || upper == "LIGHTS_OFF":
			z.LightsOn = false
		case tok == "PLUG_ON" || upper == "PLUG_ON":
			z.PlugShed = false
		case tok == "PLUG_OFF" || upper == "PLUG_OFF":
			z.PlugShed = true
		case tok == "CPU_STRAIN:HIGH" || upper == "CPU_STRAIN:HIGH":
			z.CpuStrain = true
		case tok == "CPU_STRAIN:NORMAL" || upper == "CPU_STRAIN:NORMAL":
			z.CpuStrain = false
		case strings.HasPrefix(upper, "SETPOINT="):
			if v, err := strconv.ParseFloat(tok[len("SETPOINT="):], 64); err == nil {
				z.Setpoint = v
			}
		case strings.HasPrefix(upper, "HVAC_SET:"):
			if upper == "HVAC_SET:OFF" {
				off := "OFF"
				z.IrState = &off
			} else if v, err := strconv.ParseFloat(tok[len("HVAC_SET:"):], 64); err == nil {
				z.Setpoint = v
			}
		case strings.HasPrefix(upper, "IR_SEND:"):
			parts := strings.Split(tok, ":")
			if len(parts) >= 2 && parts[1] != "" {
				z.DetectedProtocol = parts[1]
			}
			irStr := tok
			z.IrState = &irStr
		case strings.HasPrefix(upper, "DAMPER=") || strings.HasPrefix(upper, "VAV_SET:"):
			valStr := ""
			if strings.HasPrefix(upper, "DAMPER=") {
				valStr = tok[len("DAMPER="):]
			} else {
				valStr = tok[len("VAV_SET:"):]
			}
			if v, err := strconv.ParseFloat(valStr, 64); err == nil {
				if v > 1.0 {
					v = v / 100.0
				}
				if v < 0.0 {
					v = 0.0
				} else if v > 1.0 {
					v = 1.0
				}
				z.DamperPos = v
			}
		}
	}
}

// normalizeOverride maps the dashboard's high-level override verbs to the
// LIGHTS_x;SETPOINT=y wire format the firmware and optimizer share. Payloads already
// in that format (e.g. "LIGHTS_OFF;SETPOINT=26.0") pass through unchanged.
func normalizeOverride(action string, z *ZoneSim) string {
	a := strings.TrimSpace(action)
	upper := strings.ToUpper(a)
	if strings.HasPrefix(upper, "LIGHTS_") ||
		strings.HasPrefix(upper, "SETPOINT=") ||
		strings.HasPrefix(upper, "HVAC_SET:") ||
		strings.HasPrefix(upper, "IR_SEND:") ||
		upper == "PLUG_ON" || upper == "PLUG_OFF" ||
		strings.HasPrefix(upper, "DAMPER=") ||
		strings.HasPrefix(upper, "VAV_SET:") ||
		strings.HasPrefix(upper, "CPU_STRAIN:") {
		return a // already a firmware command
	}

	switch strings.ToLower(a) {
	case "purge": // emergency air flush: lights off, drive cooling hard
		return "LIGHTS_OFF;SETPOINT=18.0"
	case "turn_off_ac":
		return "HVAC_SET:OFF"

	case "cool": // max cool while occupied
		return "LIGHTS_ON;SETPOINT=20.0"
	case "reset": // hand back to the zone's nominal occupied setpoint
		sp := 24.0
		if z != nil {
			sp = z.BaseSetpoint
		}
		return fmt.Sprintf("LIGHTS_ON;SETPOINT=%.1f", sp)
	default:
		return a // unknown verb: forward verbatim; firmware ignores tokens it can't parse
	}
}

// Broadcast triggers an immediate telemetry broadcast of the active building state to all connected clients.
func (e *Engine) Broadcast() {
	e.broadcast()
}

// BroadcastOnce is an alias for Broadcast for testing.
func (e *Engine) BroadcastOnce() {
	e.broadcast()
}

// [GEMINI IMPLEMENTATION END]
