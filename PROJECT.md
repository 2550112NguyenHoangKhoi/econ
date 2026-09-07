# Project: ECON Digital Twin — Hardware Expansion, UI Controls, Sustainability & Offline AI Integration

## Architecture
```
+-----------------------------------------------------------------------------------------+
|                                    React Dashboard                                      |
|  +-----------------------+  +--------------------------+  +--------------------------+  |
|  | HardwareInspector.jsx |  | ModeToggle (App.jsx)     |  | SustainabilityPanel.jsx  |  |
|  | - IR Blaster Controls |  | - [Simulation | Real]    |  | - Scope 2 Emissions Card |  |
|  | - Plug/Relay Actuation|  | - useOperationMode hook  |  | - Carbon Credits Quote   |  |
|  | - Damper Overrides    |  |                          |  | - Maintenance Alerts     |  |
|  +-----------+-----------+  +------------+-------------+  +------------+-------------+  |
+--------------|---------------------------|-----------------------------|----------------+
               |                           |                             |
      HTTP POST /api/command       GET/POST /api/mode           GET /api/sustainability
               |                           |                             |
+--------------v---------------------------v-----------------------------v----------------+
|                                      Go Backend                                         |
|  +-----------------------------------------------------------------------------------+  |
|  | REST API Layer (main.go, modeapi.go, commandapi.go, carbon.go)                    |  |
|  | - isSupportedCommand: allows IR_SEND:, PLUG_ON/OFF, DAMPER=, VAV_SET:             |  |
|  | - OperationMode: ModeSimulation (0) vs ModeReal (1)                               |  |
|  +-------------------+-------------------+-------------------------------------------+  |
|                      |                   |                                              |
|      MQTT Command    |                   | Real-time Forecast Query                     |
|      Publishing      |                   | (HTTP -> IPC Fallback)                       |
|                      v                   v                                              |
|            +-------------------+   +-------------------------------------------------+  |
|            | MQTT Broker       |   | Forecast Bridge (forecast.go, forecast_ipc.go)  |  |
|            | econ/commands/..  |   | - 1. HTTP to http://localhost:8000              |  |
|            +---------+---------+   | - 2. IPC/exec to backend/forecasting/infer.py   |  |
|                      |             +------------------------+------------------------+  |
+----------------------|--------------------------------------|---------------------------+
                       |                                      |
                       v                                      v
        +------------------------------+     +----------------------------------+
        | Edge Node Firmware           |     | Local Python AI Models           |
        | - ESP32 / Pico (main.cpp)    |     | - backend/forecasting/model.py   |
        | - IR Blaster (GPIO 19)       |     | - model_weights.pth, scaler.pkl  |
        | - Plug Relay (GPIO 25)       |     | - timesfm_forecaster.py          |
        | - Lighting Relay (GPIO 23)   |     | - infer.py (Standalone CLI)      |
        | - Sensors: ACS712, SHT30..   |     +----------------------------------+
        +------------------------------+
```

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | IR Blaster UI in Hardware Inspector | Expose IR Blaster in `HardwareInspector.jsx` with protocol selector, frequency/bits, hex code input, and manual send button | M1 | Survey 1 / R1 |
| 2 | Edge Node Firmware Device Support | Ensure all devices in `edge/esp32/src/main.cpp` (IR blaster, plug relays, dampers, lighting relays, sensors) have full library support, topic definitions, and command mappings | M1 | Survey 1 / R1 |
| 3 | Manual Actuation UI Controls | Add manual actuation buttons to `HardwareInspector.jsx` for all devices (trigger IR blaster, toggle plugs/relays, override VAV dampers, test CPU strain) | M1 | Survey 1 / R1 |
| 4 | Backend Command Routing & MQTT Actuation | Update `server/main.go:isSupportedCommand` to accept `IR_SEND:`, `PLUG_ON`, `PLUG_OFF`, `DAMPER=`, `VAV_SET:`, `CPU_STRAIN:`, update `applyCommandToZone` to latch twin state, and publish to `econ/commands/<topic>` | M1 | Survey 1 / R1 |
| 5 | Backend Simulation vs. Real Mode API | Implement `server/modeapi.go` exposing `GET /api/mode` and `POST /api/mode` to read and toggle `engine.Mode()` / `engine.SetMode()` with CORS support | M2 | Survey 2 / R2 |
| 6 | Frontend Global Mode Toggle | Add `useOperationMode.js` hook and segmented glassmorphic switch `[Simulation | Real]` in top bar of `dashboard/src/App.jsx` | M2 | Survey 2 / R2 |
| 7 | Mode Segregation & State Synchronization | Verify `ModeReal` rejects mock telemetry and correctly maps `stripW` to plugs and CB to `plugW`, while `ModeSimulation` allows synthetic telemetry | M2 | Survey 2 / R2 |
| 8 | Backend Sustainability Insights | `server/carbon.go` Scope 2 carbon accounting, space utilization, predictive maintenance alerts, and live carbon credit recommendations via `GET /api/sustainability` | M3 | Survey 2 / R3 |
| 9 | Sustainability Recommendations Panel | Build `dashboard/src/SustainabilityRecommendationsPanel.jsx` and `useSustainability.js` polling hook, mounted as 5th tab `SUSTAINABILITY` in `dashboard/src/App.jsx` | M3 | Survey 2 / R3 |
| 10 | Standalone Python Inference CLI Runner | Implement `backend/forecasting/infer.py` (and mirror to `server/modelbundle/infer.py`) to execute PyTorch `PeakLoadLSTM` and fallback/TimesFM predictions directly from disk weights | M4 | Survey 3 / R4 |
| 11 | Go Backend Live AI Inference Engine Bridge | Update `server/forecast.go` / `server/forecast_ipc.go` with inter-process execution `os/exec` / IPC bindings to run local Python models when HTTP service is unavailable | M4 | Survey 3 / R4 |
| 12 | Export Bundle Standalone Model Packaging | Include `infer.py` and runnable instructions in `server/modelexport.go` for exported offline models (`forecast-cpu` / `forecast-accel`) | M4 | Survey 3 / R4 |
| 13 | Comprehensive E2E Testing Suite | Requirement-driven opaque-box tests covering Tiers 1-4 across all 4 requirements, producing `TEST_READY.md` | E2E Track | ORIGINAL_REQUEST |
| 14 | Final E2E Test Pass & Adversarial Hardening | 100% pass on Tiers 1-4, followed by Tier 5 white-box adversarial stress testing by Challengers, followed by Forensic Integrity Audit | M-Final | Acceptance Criteria |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| E2E | E2E Testing Track | Design test infra (`TEST_INFRA.md`), build Tiers 1-4 test suite, publish `TEST_READY.md` | None | DONE (`TEST_READY.md` published, 115 tests passing) |
| M1 | Hardware Inspector & Manual Controls | Firmware library support, backend command routing, IR Blaster & device manual controls UI | None | DONE (Worker M1 handoff: /Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_worker_m1/handoff.md) |
| M2 | Simulation vs. Real Mode Engine & UI Toggle | `GET/POST /api/mode`, mode segregation verification, global React toggle in `App.jsx` | None | DONE (Worker M2 handoff: /Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_worker_m2/handoff.md) |
| M3 | Sustainability Recommendations Backend & UI | Scope 2 carbon accounting, maintenance alerts, carbon credit quote, dedicated UI tab | None | DONE (Worker M3 handoff: /Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_worker_m3/handoff.md) |
| M4 | Local AI Models Live Inference Integration | `infer.py` CLI runner, Go `os/exec` IPC fallback in `forecast.go`, export bundle update | None | DONE (Worker M4 handoff: /Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_worker_m4/handoff.md) |
| M-Final | Final Integration, 100% E2E Pass & Audit | Execute full E2E test suite (Tiers 1-4), Tier 5 adversarial hardening, Forensic Audit | E2E, M1, M2, M3, M4 | DONE |

## Interface Contracts

### 1. Manual Actuation Command Contract (`/api/command`)
- **Endpoint**: `POST /api/command`
- **Request Payload**:
  ```json
  {
    "device_id": "esp32-zone-01",
    "command": "IR_SEND:COOLIX:0xB27BE0:32"
  }
  ```
  Valid commands:
  - `IR_SEND:<protocol>:<hex>:<bits>` (e.g. `IR_SEND:COOLIX:0xB27BE0:32`)
  - `SETPOINT=<temp>` or `HVAC_SET:<temp>` (e.g. `SETPOINT=22.5`)
  - `PLUG_ON` / `PLUG_OFF`
  - `LIGHTS_ON` / `LIGHTS_OFF`
  - `DAMPER=<percent>` or `VAV_SET:<percent>` (e.g. `DAMPER=75`)
  - `CPU_STRAIN:HIGH` / `CPU_STRAIN:NORMAL`
  - Verbs: `turn_off_ac`, `cool`, `purge`, `precool`, `reset`
- **MQTT Topic**: `econ/commands/<device_id>`
- **Response**: `{"status": "ok", "message": "command dispatched"}` (HTTP 200)

### 2. Operation Mode API Contract (`/api/mode`)
- **Endpoints**:
  - `GET /api/mode`: Returns current operation mode.
    ```json
    {
      "mode": "simulation",
      "mode_int": 0,
      "is_real": false,
      "description": "Simulation mode (synthetic and mock telemetry accepted)"
    }
    ```
  - `POST /api/mode`: Sets operation mode.
    ```json
    {
      "mode": "real"
    }
    ```
    (Accepts `"simulation"`, `"sim"`, `"0"`, `"real"`, `"1"`)
    Returns updated mode JSON object (HTTP 200).

### 3. Sustainability API Contract (`/api/sustainability`)
- **Endpoint**: `GET /api/sustainability`
- **Response**:
  ```json
  {
    "scope2_emissions_kg": 42.5,
    "grid_factor": 0.5,
    "space_utilization_pct": 78.4,
    "maintenance_alerts": [
      {
        "device": "plug_strip",
        "type": "power_surge",
        "severity": "warning",
        "message": "Power surge detected on plug strip"
      }
    ],
    "carbon_offset_recommendation": {
      "budget_kg": 50.0,
      "deficit_kg": 0.0,
      "needed_certificates": 0,
      "certificate_cost_usd": 12.5,
      "total_offset_cost_usd": 0.0,
      "action_recommended": false
    }
  }
  ```

### 4. Local Python Inference IPC Contract
- **CLI Command**: `python3 backend/forecasting/infer.py --model lstm --input '<json_string>'` (or via stdin)
- **Input JSON**:
  ```json
  {
    "sensor_sequence": [[24.5, 450.0], [24.6, 455.0], ... (12 steps)],
    "outdoor_temp": 31.0,
    "outdoor_humidity": 65.0
  }
  ```
- **Output JSON**:
  ```json
  {
    "predicted_peak_load": 1.85,
    "outdoor_temp_used": 31.0,
    "outdoor_humidity_used": 65.0,
    "engine": "lstm",
    "status": "ok"
  }
  ```
- TimesFM query:
  `python3 backend/forecasting/infer.py --model timesfm --input '{"history": [1.2, 1.3, ...], "horizon": 12}'`

## Code Layout
- `edge/esp32/src/main.cpp` — Edge node firmware (pins, IR protocols, command parser)
- `server/main.go` — Backend route registry and command validation
- `server/modeapi.go` — Operation mode REST API handlers (GET/POST /api/mode)
- `server/carbon.go` — Scope 2 carbon accounting & sustainability engine
- `server/forecast.go` & `server/forecast_ipc.go` — Go-to-Python forecasting bridge & IPC execution
- `server/modelexport.go` — Model bundle packaging (.zip export)
- `backend/forecasting/infer.py` — Standalone local Python inference script
- `dashboard/src/HardwareInspector.jsx` — Hardware Inspector UI with manual controls & IR blaster
- `dashboard/src/App.jsx` — Dashboard navigation, mode toggle switch, and sustainability tab
- `dashboard/src/useOperationMode.js` — Mode toggle state hook
- `dashboard/src/SustainabilityRecommendationsPanel.jsx` — Sustainability Recommendations UI panel
- `dashboard/src/useSustainability.js` — Sustainability data hook
