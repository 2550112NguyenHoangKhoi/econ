package main

import (
	"bytes"
	"econ/simulation"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestManualCommandOverrides_AllEdgeDevices verifies that the /api/command endpoint
// validates and accepts all edge hardware commands (IR_SEND, PLUG_ON/OFF, DAMPER, VAV_SET, CPU_STRAIN),
// updates the digital twin state immediately in applyCommandToZone, and routes to edge nodes via MQTT.
func TestManualCommandOverrides_AllEdgeDevices(t *testing.T) {
	e := simulation.NewEngine()
	e.Zones = make(map[string]*simulation.ZoneSim)
	e.Vavs = make(map[string]*simulation.VavSim)

	zoneId := "zone-office-a"
	vavId := "vav-office-a"

	z := &simulation.ZoneSim{
		Type:         "office",
		Temp:         23.5,
		BaseSetpoint: 24.0,
		Setpoint:     24.0,
		LightsOn:     true,
		MqttTopic:    "esp32-office-01",
		AreaM2:       50.0,
		Live:         true,
		PlugShed:     false,
		DamperPos:    1.0,
	}
	e.Zones[zoneId] = z

	v := &simulation.VavSim{
		TargetZone:       zoneId,
		DesignResistance: 1.0,
		Damper:           1.0,
		DamperPos:        1.0,
		TargetDamperPos:  1.0,
	}
	e.Vavs[vavId] = v

	var lastTopic, lastPayload string
	e.Publish = func(topic, payload string) {
		lastTopic = topic
		lastPayload = payload
	}

	handler := commandHandler(e)

	// 1. IR Blaster Transmission
	t.Run("IR_SEND command routing and state update", func(t *testing.T) {
		lastTopic, lastPayload = "", ""
		cmd := "IR_SEND:COOLIX:0xB27BE0:32"
		body := `{"zone": "zone-office-a", "command": "` + cmd + `"}`
		req := httptest.NewRequest(http.MethodPost, "/api/command", bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d: %s", rec.Code, rec.Body.String())
		}
		var resp map[string]string
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("failed to decode response JSON: %v", err)
		}
		if resp["status"] != "ok" {
			t.Errorf("expected status 'ok', got %q", resp["status"])
		}

		// Verify MQTT dispatch
		if lastTopic != "econ/commands/esp32-office-01" {
			t.Errorf("expected topic 'econ/commands/esp32-office-01', got %q", lastTopic)
		}
		if lastPayload != cmd {
			t.Errorf("expected payload %q, got %q", cmd, lastPayload)
		}

		// Verify twin state update
		if z.DetectedProtocol != "COOLIX" {
			t.Errorf("expected DetectedProtocol 'COOLIX', got %q", z.DetectedProtocol)
		}
		if z.IrState == nil || *z.IrState != cmd {
			t.Errorf("expected IrState %q, got %v", cmd, z.IrState)
		}
	})

	// 2. Smart Plug Relay Control
	t.Run("PLUG_OFF sheds sockets and dispatches MQTT", func(t *testing.T) {
		lastTopic, lastPayload = "", ""
		body := `{"zone": "zone-office-a", "command": "PLUG_OFF"}`
		req := httptest.NewRequest(http.MethodPost, "/api/command", bytes.NewBufferString(body))
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d: %s", rec.Code, rec.Body.String())
		}
		if !z.PlugShed {
			t.Errorf("expected z.PlugShed == true after PLUG_OFF, got false")
		}
		if lastPayload != "PLUG_OFF" {
			t.Errorf("expected payload 'PLUG_OFF', got %q", lastPayload)
		}
	})

	t.Run("PLUG_ON restores sockets and dispatches MQTT", func(t *testing.T) {
		lastTopic, lastPayload = "", ""
		body := `{"zone": "zone-office-a", "command": "PLUG_ON"}`
		req := httptest.NewRequest(http.MethodPost, "/api/command", bytes.NewBufferString(body))
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d: %s", rec.Code, rec.Body.String())
		}
		if z.PlugShed {
			t.Errorf("expected z.PlugShed == false after PLUG_ON, got true")
		}
		if lastPayload != "PLUG_ON" {
			t.Errorf("expected payload 'PLUG_ON', got %q", lastPayload)
		}
	})

	// 3. VAV Damper Overrides (ratio and percent)
	t.Run("DAMPER=0.65 updates twin state and VAV actuator", func(t *testing.T) {
		lastTopic, lastPayload = "", ""
		body := `{"zone": "zone-office-a", "command": "DAMPER=0.65"}`
		req := httptest.NewRequest(http.MethodPost, "/api/command", bytes.NewBufferString(body))
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d: %s", rec.Code, rec.Body.String())
		}
		if z.DamperPos != 0.65 {
			t.Errorf("expected z.DamperPos 0.65, got %.2f", z.DamperPos)
		}
		if v.DamperPos != 0.65 {
			t.Errorf("expected v.DamperPos 0.65, got %.2f", v.DamperPos)
		}
		if lastPayload != "DAMPER=0.65" {
			t.Errorf("expected payload 'DAMPER=0.65', got %q", lastPayload)
		}
	})

	t.Run("VAV_SET:40 handles percentage scale", func(t *testing.T) {
		lastTopic, lastPayload = "", ""
		body := `{"zone": "zone-office-a", "command": "VAV_SET:40"}`
		req := httptest.NewRequest(http.MethodPost, "/api/command", bytes.NewBufferString(body))
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d: %s", rec.Code, rec.Body.String())
		}
		if z.DamperPos != 0.40 {
			t.Errorf("expected z.DamperPos 0.40, got %.2f", z.DamperPos)
		}
		if v.DamperPos != 0.40 {
			t.Errorf("expected v.DamperPos 0.40, got %.2f", v.DamperPos)
		}
		if lastPayload != "VAV_SET:40" {
			t.Errorf("expected payload 'VAV_SET:40', got %q", lastPayload)
		}
	})

	// 4. Edge CPU Strain Simulation
	t.Run("CPU_STRAIN:HIGH toggles strain fallback", func(t *testing.T) {
		lastTopic, lastPayload = "", ""
		body := `{"zone": "zone-office-a", "command": "CPU_STRAIN:HIGH"}`
		req := httptest.NewRequest(http.MethodPost, "/api/command", bytes.NewBufferString(body))
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d: %s", rec.Code, rec.Body.String())
		}
		if !z.CpuStrain {
			t.Errorf("expected z.CpuStrain == true, got false")
		}
		if lastPayload != "CPU_STRAIN:HIGH" {
			t.Errorf("expected payload 'CPU_STRAIN:HIGH', got %q", lastPayload)
		}
	})

	t.Run("CPU_STRAIN:NORMAL clears strain fallback", func(t *testing.T) {
		lastTopic, lastPayload = "", ""
		body := `{"zone": "zone-office-a", "command": "CPU_STRAIN:NORMAL"}`
		req := httptest.NewRequest(http.MethodPost, "/api/command", bytes.NewBufferString(body))
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d: %s", rec.Code, rec.Body.String())
		}
		if z.CpuStrain {
			t.Errorf("expected z.CpuStrain == false, got true")
		}
		if lastPayload != "CPU_STRAIN:NORMAL" {
			t.Errorf("expected payload 'CPU_STRAIN:NORMAL', got %q", lastPayload)
		}
	})

	// 5. device_id alias support
	t.Run("device_id payload alias", func(t *testing.T) {
		lastTopic, lastPayload = "", ""
		body := `{"device_id": "zone-office-a", "command": "LIGHTS_OFF"}`
		req := httptest.NewRequest(http.MethodPost, "/api/command", bytes.NewBufferString(body))
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d: %s", rec.Code, rec.Body.String())
		}
		if z.LightsOn {
			t.Errorf("expected z.LightsOn == false after LIGHTS_OFF, got true")
		}
	})

	// 6. Compound semicolon command
	t.Run("Compound command: PLUG_OFF;CPU_STRAIN:HIGH", func(t *testing.T) {
		lastTopic, lastPayload = "", ""
		body := `{"zone": "zone-office-a", "command": "PLUG_OFF;CPU_STRAIN:HIGH"}`
		req := httptest.NewRequest(http.MethodPost, "/api/command", bytes.NewBufferString(body))
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d: %s", rec.Code, rec.Body.String())
		}
		if !z.PlugShed || !z.CpuStrain {
			t.Errorf("expected both PlugShed and CpuStrain true, got PlugShed=%v CpuStrain=%v", z.PlugShed, z.CpuStrain)
		}
	})

	// 7. Rejection of unsupported commands
	t.Run("Unsupported command rejected", func(t *testing.T) {
		body := `{"zone": "zone-office-a", "command": "MALICIOUS_DROP_TABLE"}`
		req := httptest.NewRequest(http.MethodPost, "/api/command", bytes.NewBufferString(body))
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 Bad Request, got %d", rec.Code)
		}
	})

	// 8. 15-minute latching verification
	t.Run("Manual override sets 15-minute latch", func(t *testing.T) {
		z.OverrideUntil = time.Time{}
		body := `{"zone": "zone-office-a", "command": "IR_SEND:PANASONIC:0x123456:48"}`
		req := httptest.NewRequest(http.MethodPost, "/api/command", bytes.NewBufferString(body))
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 OK, got %d", rec.Code)
		}
		remaining := time.Until(z.OverrideUntil)
		if remaining < 14*time.Minute || remaining > 15*time.Minute+5*time.Second {
			t.Fatalf("expected ~15m latch, got %v", remaining)
		}
	})
}
