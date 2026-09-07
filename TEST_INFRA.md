# Test Infrastructure Specification: ECON Digital Twin E2E Testing Suite

## 1. Overview & Test Philosophy
The ECON Digital Twin End-to-End (E2E) Testing Suite provides rigorous, opaque-box, requirement-driven automated verification across all 4 core project capabilities:
1. **Hardware Inspector & IR Blaster Controls**: Arbitrary IR hex dispatch, protocol selection, manual device actuation (plug relays, lighting relays, VAV dampers, and CPU strain testing).
2. **Simulation vs. Real Operation Mode**: Dynamic switching via REST API (`GET /api/mode`, `POST /api/mode`), strict mock telemetry rejection in Real Mode, electrical disaggregation (`stripW` to plugs, zone CB to `plugW`), and global UI toggle synchronization.
3. **Sustainability Recommendations & Carbon Accounting**: Scope 2 operational carbon calculations, space utilization efficiency, predictive maintenance diagnostics, dynamic carbon credit offset purchasing recommendations, and dedicated UI panel mounting.
4. **Local AI Model Live Inference**: Standalone Python CLI inference runner (`infer.py`), zero-shot foundation model forecasting (Google TimesFM 2.0/2.5), supervised peak cooling load regression (PeakLoadLSTM), and Go backend inter-process execution (IPC) fallback.

All expected outputs are explicitly derived from documented system specifications in `PROJECT.md` and `ORIGINAL_REQUEST.md`, physical sensor characteristics (ACS712, SCT-013, 2R1C thermodynamics), and mathematical carbon accounting formulas ($E = P_{\text{kW}} \times t_{\text{h}} \times \text{EF}_{\text{grid}}$).

---

## 2. Directory Layout
```
econ/
├── e2e_tests/                              # Go E2E Testing Suite (Tiers 1-4)
│   ├── go.mod                              # Module declaration (replaces econ => ../server)
│   ├── helpers.go                          # Reusable test harness, generators & oracles
│   ├── tier1_feature_test.go               # Tier 1: Feature Coverage (>=5 tests per feature)
│   ├── tier2_boundary_test.go              # Tier 2: Boundary & Corner Cases (>=5 tests per feature)
│   ├── tier3_interaction_test.go          # Tier 3: Cross-Feature Combinations
│   ├── tier4_scenarios_test.go            # Tier 4: Real-World Day-in-the-Life Scenarios
│   └── firmware/
│       └── test_firmware_offload_e2e.cpp   # Standalone C++ edge host test harness
├── server/                                 # Go Backend Core & REST Endpoints
│   ├── modeapi.go                          # GET /api/mode, POST /api/mode
│   ├── carbon.go                           # Scope 2 Carbon Accounting & /api/sustainability
│   ├── forecast_ipc.go                     # Go-to-Python IPC execution bridge
│   ├── command_override_test.go            # Backend command routing unit tests
│   └── modeapi_test.go                     # Mode API unit tests
├── dashboard/                              # React Frontend Dashboard
│   ├── src/
│   │   ├── HardwareInspector.jsx           # IR Blaster & Manual Actuation Controls UI
│   │   ├── useOperationMode.js             # Operation Mode Hook
│   │   ├── SustainabilityRecommendationsPanel.jsx # Sustainability UI Tab
│   │   └── useSustainability.js            # Sustainability Data Polling Hook
│   ├── verify_mode_toggle.js               # Frontend Mode Toggle Automated Verification
│   └── verify_e2e_controls.js              # Comprehensive E2E UI Verification Script
└── backend/forecasting/                    # Local AI Models
    ├── infer.py                            # Standalone CLI / IPC Inference Runner
    ├── model.py                            # PyTorch PeakLoadLSTM Definition
    ├── model_weights.pth                   # Trained LSTM state dictionary
    ├── scaler.pkl                          # Fitted StandardScaler
    └── timesfm_forecaster.py               # Google TimesFM Foundation Model Wrapper
```

---

## 3. Test Runner Commands

### 3.1 Go End-to-End Testing Suite (All Tiers)
Run the full 4-tier E2E test suite from the repository root:
```bash
cd /Users/nguyenhoangkhoi/Documents/econ/e2e_tests && go test -v -count=1 .
```

To run individual tiers:
- **Tier 1 (Feature Coverage)**:
  ```bash
  cd /Users/nguyenhoangkhoi/Documents/econ/e2e_tests && go test -v -count=1 -run "TestTier1" .
  ```
- **Tier 2 (Boundary & Corner Cases)**:
  ```bash
  cd /Users/nguyenhoangkhoi/Documents/econ/e2e_tests && go test -v -count=1 -run "TestTier2" .
  ```
- **Tier 3 (Cross-Feature Combinations)**:
  ```bash
  cd /Users/nguyenhoangkhoi/Documents/econ/e2e_tests && go test -v -count=1 -run "TestTier3" .
  ```
- **Tier 4 (Real-World Day-in-the-Life Scenarios)**:
  ```bash
  cd /Users/nguyenhoangkhoi/Documents/econ/e2e_tests && go test -v -count=1 -run "TestTier4" .
  ```

### 3.2 Backend Server Unit & Integration Suite
Run all server module tests:
```bash
cd /Users/nguyenhoangkhoi/Documents/econ/server && go test -v -count=1 ./...
```
- **Command Overrides & MQTT Routing**:
  ```bash
  cd /Users/nguyenhoangkhoi/Documents/econ/server && go test -v -count=1 -run "TestManualCommandOverrides" .
  ```
- **Mode API & Mode Segregation**:
  ```bash
  cd /Users/nguyenhoangkhoi/Documents/econ/server && go test -v -count=1 -run "TestModeAPI" .
  ```
- **Scope 2 Carbon & Sustainability API**:
  ```bash
  cd /Users/nguyenhoangkhoi/Documents/econ/server && go test -v -count=1 -run "TestCarbon" .
  ```

### 3.3 Frontend Dashboard Automated Verification
Run frontend automated test harnesses:
```bash
cd /Users/nguyenhoangkhoi/Documents/econ/dashboard && node verify_mode_toggle.js
cd /Users/nguyenhoangkhoi/Documents/econ/dashboard && node verify_e2e_controls.js
```
Verify production build integrity:
```bash
cd /Users/nguyenhoangkhoi/Documents/econ/dashboard && npm run build
```

### 3.4 Local AI Model Standalone CLI Verification
Execute live inference via standalone Python runner:
- **LSTM Peak Load Regressor**:
  ```bash
  PYTHONPATH=/Users/nguyenhoangkhoi/Documents/econ/backend/forecasting PYTHONNOUSERSITE=1 \
  python3 /Users/nguyenhoangkhoi/Documents/econ/backend/forecasting/infer.py \
    --model lstm \
    --input '{"sensor_sequence": [[24.0, 300.0], [24.1, 310.0], [24.2, 320.0], [24.3, 330.0], [24.4, 340.0], [24.5, 350.0], [24.6, 360.0], [24.7, 370.0], [24.8, 380.0], [24.9, 390.0], [25.0, 400.0], [25.1, 410.0]], "outdoor_temp": 32.0, "outdoor_humidity": 65.0}'
  ```
- **TimesFM Autoregressive Foundation Model**:
  ```bash
  PYTHONPATH=/Users/nguyenhoangkhoi/Documents/econ/backend/forecasting PYTHONNOUSERSITE=1 \
  python3 /Users/nguyenhoangkhoi/Documents/econ/backend/forecasting/infer.py \
    --model timesfm \
    --input '{"history": [1.5, 1.6, 1.7, 1.8, 1.9, 2.0, 2.1, 2.2], "horizon": 12}'
  ```

---

## 4. Feature Inventory & Test Mapping Matrix

| Feature # | Feature Description | Requirement | Tier 1 (Feature Coverage) | Tier 2 (Boundary & Corner) | Tier 3 (Cross-Feature) | Tier 4 (Real-World) |
|---|---|:---:|:---:|:---:|:---:|:---:|
| **F1** | **Hardware Inspector & IR Blaster** | R1 | `TestTier1_F1_HardwareInspectorManualControls` | `TestTier2_F1_CommandBoundaries` | `TestTier3_ManualOverrideDuringModeSwitch` | `TestTier4_FullBuildingOperationsDayInLife` |
| **F2** | **Simulation vs. Real Mode Toggle** | R2 | `TestTier1_F2_OperationModeEngineAPI` | `TestTier2_F2_OperationModeBoundaries` | `TestTier3_ManualOverrideDuringModeSwitch` | `TestTier4_FullBuildingOperationsDayInLife` |
| **F3** | **Sustainability Recommendations Panel** | R3 | `TestTier1_F3_SustainabilityRecommendations` | `TestTier2_F3_SustainabilityBoundaries` | `TestTier3_SustainabilityReactingToOverrides` | `TestTier4_FullBuildingOperationsDayInLife` |
| **F4** | **Backend MQTT Command Routing** | R1 | `TestTier1_F4_MQTTCommandDispatching` | `TestTier2_F1_CommandBoundaries` | `TestTier3_SustainabilityReactingToOverrides` | `TestTier4_FullBuildingOperationsDayInLife` |
| **F5** | **Local Python AI Live Inference** | R4 | `TestTier1_F5_LocalAIModelLiveInference` | `TestTier2_F4_InferenceBoundaries` | `TestTier3_OfflineAIInferenceDuringRealMode` | `TestTier4_FullBuildingOperationsDayInLife` |

---

## 5. Acceptance Criteria & Quality Gates
1. **Tier 1 (Feature Coverage)**: Must execute $\ge 5$ distinct test cases per feature across all 5 features ($\ge 25$ tests total). All must pass 100%.
2. **Tier 2 (Boundary & Corner Cases)**: Must execute $\ge 5$ distinct boundary cases per feature ($\ge 20$ tests total), including extreme setpoints, invalid hex codes, malformed JSON, out-of-range dampers, invalid mode strings, and cold-start histories. All must pass 100%.
3. **Tier 3 (Cross-Feature Combinations)**: Must verify multi-system state interaction: command overrides persisting across mode switches, sustainability metrics reacting to manual overrides, and offline AI inference during real telemetry ingestion.
4. **Tier 4 (Real-World Application Scenarios)**: Complete end-to-end diurnal simulation with hardware actuation, real mode telemetry, carbon credit offset quote, and AI peak load pre-cool triggering.
5. **Zero Regressions**: Zero breaking changes across existing server tests, edge host tests, and frontend build.
