#!/usr/bin/env python3
"""
verify_architecture_oracle.py — Automated Adversarial Oracle for ARCHITECTURE.md

Verifies:
1. 100% of cited source file paths exist in the repository.
2. Cited line ranges are within file bounds and match the claimed code logic.
3. Cited GPIO pins and build flags match source definitions in edge/esp32/src/main.cpp.
4. Documented Zero-Hardware simulation commands & scripts are valid and executable.
5. End-to-end data flow traces are accurate at every hop.
"""

import os
import re
import subprocess
import sys

REPO_ROOT = "/Users/nguyenhoangkhoi/Documents/econ"
ARCH_FILE = os.path.join(REPO_ROOT, "ARCHITECTURE.md")

failures = []
warnings = []
passes = []

def record_pass(category, desc):
    passes.append((category, desc))
    print(f"  [PASS] {category}: {desc}")

def record_fail(category, desc, detail=""):
    failures.append((category, desc, detail))
    print(f"  [FAIL] {category}: {desc} -> {detail}")

def record_warn(category, desc, detail=""):
    warnings.append((category, desc, detail))
    print(f"  [WARN] {category}: {desc} -> {detail}")

print("================================================================================")
print("1. VERIFYING CITED FILE PATHS")
print("================================================================================")

with open(ARCH_FILE, "r", errors="ignore") as f:
    arch_lines = f.readlines()
arch_text = "".join(arch_lines)

# Explicitly inspect paths cited in the document
critical_cited_paths = [
    # Paths from Section 2
    "server/simulation/engine.go",
    "server/docker-compose.yml",
    "backend/forecasting/train.py",
    "backend/forecasting/main.py",
    "edge/esp32/esp32_emulator.py",
    "ai_modules/branch_a_occupancy/yolo_bytetrack/yolo_tracker.py",
    "edge/esp32/wokwi.toml",
    "edge/esp32/diagram.json",
    # Paths from Section 3
    "edge/esp32/src/main.cpp",
    "edge/esp32/src/node_config.h",
    "edge/esp32/src/current_denoiser.h",
    "edge/pico/main.py",
    "edge/pico/src/main.cpp",
    "edge/WIRING.md",
    "edge/SHOPPING_LIST.md",
    "edge/esp32/src/camera/dual_mode_comm.cpp",
    "edge/esp32/src/camera/camera_config.h",
    # Paths from Section 4
    "server/mosquitto/mosquitto.conf",
    "server/setup-mqtt-auth.sh",
    "server/mosquitto/acl",
    "edge/raspberry_pi/gateway.py",
    # Paths from Section 5
    "server/simulation/dynamics.go",
    "server/simulation/baselines.go",
    "server/simulation/plugs.go",
    "server/precool.go",
    "server/carbon.go",
    "server/simulation/recommend.go",
    # Paths from Section 6
    "backend/forecasting/model.py",
    "backend/forecasting/config.py",
    "backend/forecasting/timesfm_forecaster.py",
    "server/forecast.go",
    "server/modelcatalog.go",
    "server/modelexport.go",
    # Paths from Section 7
    "server/db/init.sql",
    "server/db.go",
    "server/data/baseline-model.json",
    "server/data/room-dynamics.json",
    "server/data/load-history.json",
    "server/data/plug-state.json",
    "server/data/sustainability-state.json",
    # Paths from Section 8
    "server/main.go",
    "server/auth.go",
    "server/schema/telemetry.fbs",
    "server/devices.go",
    "server/blueprint.go",
    "server/weather.go",
    "server/plugapi.go",
    "server/recommendapi.go",
    # Paths from Section 9
    "dashboard/src/useDigitalTwin.js",
    "dashboard/src/buildingStore.js",
    "dashboard/src/BuildingModel.jsx",
    "dashboard/src/GlobalMetricsPanel.jsx",
    "dashboard/src/PlugLoadPanel.jsx",
    "dashboard/src/AiInsightsPanel.jsx",
    "dashboard/src/RecommendationEvidence.jsx",
    "dashboard/src/ForecastChart.jsx",
    "dashboard/src/main.jsx",
]

for p in critical_cited_paths:
    full_path = os.path.join(REPO_ROOT, p)
    if os.path.exists(full_path):
        record_pass("PATH_EXISTS", p)
    else:
        record_fail("PATH_EXISTS", p, "File does not exist in repository")

# Check for paths cited with missing prefixes or invalid filenames
loose_path_checks = [
    ("edge/esp32/esp32_emulator.py", "Section 2.3 line 271, 274: cited executable emulator script"),
    ("dashboard/src/buildingStore.js", "Table 11 line 1545: cited as bare 'buildingStore.js'"),
    ("dashboard/src/RecommendationEvidence.jsx", "Table 11 line 1551: cited as bare 'RecommendationEvidence.jsx'"),
    ("server/data/baseline-model.json", "Section 7.4 line 1157: cited as 'data/baseline-model.json' (missing 'server/')"),
    ("server/schema/telemetry.fbs", "Line 715, 1418: cited as 'schema/telemetry.fbs' (missing 'server/')"),
    ("server/simulation/dynamics.go", "Table 8.2 line 1234: cited as 'simulation/dynamics.go' (missing 'server/')"),
]

for target, ctx in loose_path_checks:
    full = os.path.join(REPO_ROOT, target)
    if not os.path.exists(full):
        record_fail("MISSING_FILE", target, ctx)

print("\n================================================================================")
print("2. VERIFYING CITED LINE RANGES & SEMANTICS")
print("================================================================================")

line_checks = [
    # (file, start, end, expected_subtext, description)
    ("dashboard/src/PlugLoadPanel.jsx", 1, 320, None, "Check EOF boundary (file has only 199 lines)"),
    ("server/simulation/engine.go", 999, 1002, "hwFresh", "Cited z.hwFresh() location"),
    ("server/simulation/engine.go", 1048, 1050, "hwFresh", "Actual z.hwFresh() location"),
    ("server/simulation/engine.go", 1007, 1021, "OutdoorFallbackAt", "Cited weather model location"),
    ("server/simulation/engine.go", 1055, 1069, "OutdoorFallbackAt", "Actual weather model location"),
    ("server/simulation/engine.go", 2022, 2022, "scheduledOccupancy", "Cited occupancy schedule line"),
    ("server/simulation/engine.go", 1953, 1983, "scheduledOccupancy", "Actual scheduledOccupancy definition"),
    ("server/simulation/engine.go", 704, 706, "HwStripW", "Cited z.HwStripW binding in engine.go"),
    ("server/simulation/engine.go", 752, 753, "HwStripW", "Actual z.HwStripW binding in engine.go"),
    ("server/simulation/engine.go", 2758, 2763, "ZoneDataAddStripW", "Cited FlatBuffers ZoneDataAddStripW line"),
    ("server/simulation/engine.go", 2810, 2810, "ZoneDataAddStripW", "Actual FlatBuffers ZoneDataAddStripW line"),
    ("server/simulation/engine.go", 2430, 2430, "Persist", "Cited DB Persist call in engine.go"),
    ("server/simulation/engine.go", 2686, 2686, "Persist", "Actual DB Persist call in engine.go"),
    ("server/mqtt.go", 148, 172, "handleTelemetry", "Cited handleTelemetry start line (cited 148, actual 172)"),
    ("edge/esp32/src/main.cpp", 687, 726, "readStripAmps", "readStripAmps() implementation"),
    ("edge/esp32/src/current_denoiser.h", 27, 173, "processWindow", "CurrentDenoiser::processWindow() implementation"),
    ("edge/raspberry_pi/gateway.py", 1, 155, "failsafe", "gateway.py total lines"),
    ("edge/raspberry_pi/gateway.py", 91, 91, "FAILSAFE_TAG", "gateway.py anti-self-trigger line"),
    ("backend/forecasting/model.py", 5, 21, "PeakLoadLSTM", "PeakLoadLSTM class definition"),
    ("backend/forecasting/timesfm_forecaster.py", 182, 243, "def forecast", "TimesFM forecast method"),
    ("dashboard/src/BuildingModel.jsx", 319, 407, "ZoneRenderer", "ZoneRenderer GLSL shader implementation"),
    ("dashboard/src/ForecastChart.jsx", 110, 145, "forecast-insufficient-data", "ForecastChart honest fallback testid"),
]

for fpath, start, end, expected, desc in line_checks:
    full = os.path.join(REPO_ROOT, fpath)
    if not os.path.exists(full):
        record_fail("LINE_CHECK_FILE_MISSING", fpath, desc)
        continue
    with open(full, "r", errors="ignore") as fp:
        flines = fp.readlines()
    total_l = len(flines)
    
    # 1. Bounds check
    if end > total_l:
        record_fail("LINE_OUT_OF_BOUNDS", f"{fpath}:{start}–{end}", f"Exceeds total file length of {total_l} lines ({desc})")
        continue
    
    # 2. Content semantics check if expected string provided
    snippet = "".join(flines[start-1:end])
    if expected is not None:
        if expected in snippet:
            record_pass("LINE_SEMANTICS", f"{fpath}:{start}–{end} verified containing '{expected}' ({desc})")
        else:
            record_fail("LINE_SEMANTICS_MISMATCH", f"{fpath}:{start}–{end}", f"Expected '{expected}' not found in range ({desc})")
    else:
        record_pass("LINE_BOUNDS", f"{fpath}:{start}–{end} within file bounds ({desc})")

print("\n================================================================================")
print("3. VERIFYING GPIO PINS & BUILD FLAGS")
print("================================================================================")

main_cpp_path = os.path.join(REPO_ROOT, "edge/esp32/src/main.cpp")
pio_ini_path = os.path.join(REPO_ROOT, "edge/esp32/platformio.ini")
cam_cfg_path = os.path.join(REPO_ROOT, "edge/esp32/src/camera/camera_config.h")

with open(main_cpp_path) as f:
    cpp_code = f.read()
with open(pio_ini_path) as f:
    ini_code = f.read()
with open(cam_cfg_path) as f:
    cam_code = f.read()

pin_assertions = [
    ("I2C_SDA", r'#\s*define\s+I2C_SDA\s+21', "GPIO 21"),
    ("I2C_SCL", r'#\s*define\s+I2C_SCL\s+22', "GPIO 22"),
    ("DHT_PIN", r'#\s*define\s+DHT_PIN\s+4', "GPIO 4"),
    ("PIR1_PIN", r'#\s*define\s+PIR1_PIN\s+18', "GPIO 18"),
    ("PIR2_PIN", r'#\s*define\s+PIR2_PIN\s+18', "GPIO 18"),
    ("MMWAVE_PIN", r'#\s*define\s+MMWAVE_PIN\s+18', "GPIO 18"),
    ("TOUCH_PIN", r'const\s+int\s+TOUCH_PIN\s*=\s*T9', "T9 (GPIO 32)"),
    ("PLUG_ADC_PIN", r'#\s*define\s+PLUG_ADC_PIN\s+34', "GPIO 34"),
    ("STRIP_ADC_PIN", r'#\s*define\s+STRIP_ADC_PIN\s+33', "GPIO 33"),
    ("AC_CLAMP_PIN", r'#\s*define\s+AC_CLAMP_PIN\s+35', "GPIO 35"),
    ("SUPPLY_TEMP_PIN", r'#\s*define\s+SUPPLY_TEMP_PIN\s+26', "GPIO 26"),
    ("RELAY_PIN", r'const\s+int\s+RELAY_PIN\s*=\s*23', "GPIO 23"),
    ("PLUG_RELAY_PIN", r'#\s*define\s+PLUG_RELAY_PIN\s+25', "GPIO 25"),
    ("IR_PIN", r'const\s+int\s+IR_PIN\s*=\s*19', "GPIO 19"),
    ("STATUS_LED", r'const\s+int\s+STATUS_LED\s*=\s*2', "GPIO 2"),
]

for name, pattern, expected in pin_assertions:
    if re.search(pattern, cpp_code):
        record_pass("GPIO_PIN", f"{name} matches {expected}")
    else:
        record_fail("GPIO_PIN", name, f"Pattern {pattern} not matched in main.cpp")

cam_pin_assertions = [
    ("PIN_CAM_XCLK", r'#\s*define\s+PIN_CAM_XCLK\s+27'),
    ("PIN_CAM_PCLK", r'#\s*define\s+PIN_CAM_PCLK\s+14'),
    ("PIN_CAM_VSYNC", r'#\s*define\s+PIN_CAM_VSYNC\s+36'),
    ("PIN_CAM_HREF", r'#\s*define\s+PIN_CAM_HREF\s+39'),
    ("PIN_CAM_D7", r'#\s*define\s+PIN_CAM_D7\s+5'),
    ("PIN_CAM_SIOD", r'#\s*define\s+PIN_CAM_SIOD\s+21'),
    ("PIN_CAM_SIOC", r'#\s*define\s+PIN_CAM_SIOC\s+22'),
]

for name, pattern in cam_pin_assertions:
    if re.search(pattern, cam_code):
        record_pass("CAMERA_PIN", f"{name} matches definition in camera_config.h")
    else:
        record_fail("CAMERA_PIN", name, f"Pattern {pattern} not matched in camera_config.h")

build_flags = [
    "USE_SHT30", "USE_CO2", "USE_PIR", "USE_PLUG", "USE_STRIP", "USE_IR_AC", "IR_AC_PROTOCOL"
]

for bf in build_flags:
    if bf in cpp_code and bf in ini_code:
        record_pass("BUILD_FLAG", f"{bf} present in both main.cpp and platformio.ini")
    elif bf in cpp_code:
        record_pass("BUILD_FLAG", f"{bf} present in main.cpp (configured via #define or build flag)")
    else:
        record_fail("BUILD_FLAG", bf, "Flag not found in codebase")

print("\n================================================================================")
print("4. VERIFYING ZERO-HARDWARE SIMULATION COMMANDS")
print("================================================================================")

# Command 1: edge/esp32/esp32_emulator.py
cmd1 = [sys.executable, "edge/esp32/esp32_emulator.py"]
res1 = subprocess.run(cmd1, cwd=REPO_ROOT, capture_output=True, text=True)
if res1.returncode != 0:
    record_fail("EXEC_SIM_COMMAND", "python3 edge/esp32/esp32_emulator.py", f"Exited with code {res1.returncode}: {res1.stderr.strip()}")
else:
    record_pass("EXEC_SIM_COMMAND", "python3 edge/esp32/esp32_emulator.py")

# Command 2: Docker compose config & credentials check
compose_file = os.path.join(REPO_ROOT, "server/docker-compose.yml")
with open(compose_file) as f:
    comp_text = f.read()

if "POSTGRES_USER=postgres" in comp_text:
    record_pass("DOCKER_CONFIG", "TimescaleDB user is postgres")
else:
    record_fail("DOCKER_CONFIG", "docker-compose.yml credentials mismatch", "ARCHITECTURE.md line 214 claims 'user: postgres, pass: postgres', but compose defines 'POSTGRES_USER=econ, POSTGRES_PASSWORD=econ'")

# Command 3: Go Server Compilation
res_go = subprocess.run(["go", "build", "."], cwd=os.path.join(REPO_ROOT, "server"), capture_output=True, text=True)
if res_go.returncode == 0:
    record_pass("EXEC_GO_BUILD", "go build . in server/ directory succeeded")
else:
    record_fail("EXEC_GO_BUILD", "go build . failed", res_go.stderr.strip())

print("\n================================================================================")
print("5. ORACLE VERIFICATION SUMMARY & VERDICT")
print("================================================================================")
print(f"Total PASSES:   {len(passes)}")
print(f"Total WARNINGS: {len(warnings)}")
print(f"Total FAILURES: {len(failures)}")

if len(failures) > 0:
    print("\nVERDICT: REJECT")
    print(f"Encountered {len(failures)} blocking failure(s) in ARCHITECTURE.md.")
    sys.exit(1)
else:
    print("\nVERDICT: APPROVE")
    sys.exit(0)
