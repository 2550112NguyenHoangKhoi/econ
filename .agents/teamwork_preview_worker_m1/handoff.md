# Handoff Report: Milestone M1 (UI Bug Fixes & Hardware Alignment)

**Agent**: `teamwork_preview_worker_m1`  
**Working Directory**: `/Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_worker_m1`  
**Handoff Type**: Hard (Milestone M1 complete)  
**Date**: 2026-09-08T05:30:00Z  
**Parent Agent**: `94b1bad7-43b4-4ef2-a84c-6c5e8cbf0b7f` (Project Orchestrator)

---

## 1. Observation

### 1.1 Requirements & Assigned Files
As specified in `DISPATCH.md` and `PROJECT.md` for Milestone 1 (Feature 1, Feature 2, Feature 3):
1. **3D floor switcher active asset state & camera update**:
   - In `dashboard/src/buildingStore.js`: Implement and export `getActiveFloorAsset(building, activeFloor)` returning `{ level, name, assetId, zoneCount, elevation, height }`.
   - In `dashboard/src/BuildingModel.jsx`: Fix `initialOverview` dependency array to include `[activeFloor, safeArea, currentBld]`; ensure `DynamicControls` camera framing re-centers and updates smoothly when `activeFloor` changes.
   - In `dashboard/src/App.jsx`: Derive `activeFloorAsset` using `getActiveFloorAsset(currentBuilding, activeFloor)`; expose `data-testid="active-asset"` and `data-testid="active-floor-asset"` in the DOM with `data-asset-id={activeFloorAsset?.assetId}` and visible text reflecting active level and asset name/ID; ensure clicking floor buttons (`level-btn-${lvl}`, steppers `level-step-prev`, `level-step-next`) correctly updates `activeFloor` and the active asset state.
2. **Logs panel streaming stability & memory limit**:
   - In `dashboard/src/TelemetryLogs.jsx`: Fix React key collision by using a monotonic sequence counter combined with high-resolution timestamps (`id: `log-${id}-${ev.key}-${Date.now()}-${++logSeq}``); add safe snapshot with null/undefined guards so missing or malformed zone data never throws `TypeError`; reset `prev.current` baseline when the building model switches.
   - In `dashboard/src/HardwareInspector.jsx`: Add bounded sliding window buffer to the serial log (`setLog(l => { const next = l + value; return next.length > 50000 ? next.slice(-40000) : next; })`).
3. **Single-relay hardware alignment**:
   - In `dashboard/src/HardwareInspector.jsx`: Align with the physical single-relay hardware configuration: GPIO 26 is the Smart Plug Relay (`pinPlugRelay`), controlled by `PLUG_ON` / `PLUG_OFF`; clearly badge the legacy Lighting Relay (GPIO 23) as virtual / unpopulated (`pinLightingRelay = 255`); update default hardware library pin definitions: `smart_plug: GPIO 26`, `ir_blaster: GPIO 25`, `lighting: Unused (255)`.
4. **Verification & Testing**:
   - Implement automated test script `dashboard/verify_webserial_floor_switcher.js` asserting:
     - 3D floor switcher updates active asset state (`data-testid="active-asset"` matches selected floor level and BIM asset ID).
     - Logs panel streams high-frequency updates without React key collisions or crashes.
   - Run `npm run build` in `dashboard/` and confirm exit code 0 without errors.
   - Run test scripts and confirm 100% pass.

### 1.2 Direct Code Observations & Changes

#### 1.2.1 `dashboard/src/buildingStore.js`
- **Lines 50–64**: Implemented and exported pure function `getActiveFloorAsset`:
  ```javascript
  export function getActiveFloorAsset(building, activeFloor) {
    const floors = building?.floors || [];
    const targetLevel = Number(activeFloor) || 1;
    const floor = floors.find((f) => f.level === targetLevel) || floors[0];
    if (!floor) return null;
    const primaryZone = floor.zones?.[0];
    return {
      level: floor.level,
      name: floor.name || `Level ${floor.level}`,
      assetId: primaryZone?.bim_asset_id || `floor-asset-${floor.level}`,
      zoneCount: floor.zones?.length || 0,
      elevation: typeof floor.elevation === 'number' ? floor.elevation : 0,
      height: typeof floor.height === 'number' ? floor.height : 4.0,
    };
  }
  ```

#### 1.2.2 `dashboard/src/BuildingModel.jsx`
- **Lines 615–644**: Enhanced `DynamicControls`:
  - When `overview` or `camera` changes, if `!isZoomed`, smoothly updates `targetCameraPos` and `targetLookAt` and triggers `animating = true`.
  - Added `activeFloor` to the target position calculation dependencies `[isZoomed, targetX, targetY, targetZ, overview, building, activeFloor]`.
- **Lines 731–735**: Fixed `initialOverview` dependency array from `[currentBld]` to `[activeFloor, safeArea, currentBld]`:
  ```javascript
  const initialOverview = useMemo(() => {
    const aspect = (typeof window !== 'undefined' ? window.innerWidth / Math.max(1, window.innerHeight) : 1.6);
    return towerFraming(activeFloor, aspect, safeArea, currentBld);
  }, [activeFloor, safeArea, currentBld]);
  ```

#### 1.2.3 `dashboard/src/App.jsx`
- **Line 6**: Imported `getActiveFloorAsset` from `./buildingStore`.
- **Lines 336–339**: Derived `activeFloorAsset`:
  ```javascript
  const activeFloorAsset = useMemo(
    () => getActiveFloorAsset(currentBuilding, activeFloor),
    [currentBuilding, activeFloor]
  );
  ```
- **Lines 1494–1522**: Exposed `data-testid="active-asset"` and `data-testid="active-floor-asset"` in DOM:
  ```jsx
  {/* Active Floor Asset Badge */}
  <div
    data-testid="active-asset"
    data-asset-id={activeFloorAsset?.assetId || ''}
    style={{
      position: 'absolute',
      bottom: '7.6rem',
      right: rightPanelWidth + 24 + 12,
      zIndex: 14,
      display: 'flex',
      alignItems: 'center',
      gap: '4px',
      background: 'rgba(10, 16, 28, 0.85)',
      padding: '4px 8px',
      borderRadius: '8px',
      border: '1px solid var(--border-glass)',
      backdropFilter: 'blur(12px)',
      boxShadow: '0 4px 20px rgba(0, 0, 0, 0.4)',
      fontSize: '11px',
      color: 'var(--accent-blue)',
      fontFamily: 'monospace',
      pointerEvents: 'none',
    }}
  >
    <span data-testid="active-floor-asset" data-asset-id={activeFloorAsset?.assetId || ''}>
      {activeFloorAsset?.name || `Level ${activeFloor}`} ({activeFloorAsset?.assetId || ''})
    </span>
  </div>
  ```
  - Positioned above `desktop-level-toggle` with `pointerEvents: 'none'` so it does not overlap or block mouse click hit tests to `building-model-toggle` or floor stepper buttons.

#### 1.2.4 `dashboard/src/TelemetryLogs.jsx`
- **Line 20**: Declared monotonic sequence counter `let logSeq = 0;`.
- **Lines 26–36**: Replaced fragile `snapshot(z)` with `safeSnapshot(z)` featuring comprehensive guards:
  ```javascript
  function safeSnapshot(z) {
    if (!z || typeof z !== 'object') return null;
    return {
      alert: z.alert === true ? 'ALARM' : z.alert === 'REMEDIATING' ? 'REMEDIATING' : 'ok',
      lightsOn: z.lightsOn !== false,
      plugShed: Boolean(z.plugShed),
      setpoint: round1(typeof z.setpoint === 'number' ? z.setpoint : 24.0),
      occupied: Boolean(z.occupancy && Number(z.occupancy) > 0),
    };
  }
  ```
- **Lines 57–65**: Added baseline re-baselining upon building model switch:
  ```javascript
  const buildingId = simData?.buildingId || (simData?.zones ? Object.keys(simData.zones).length : 0);
  const prevBuildingRef = useRef(buildingId);

  useEffect(() => {
    if (buildingId && prevBuildingRef.current !== buildingId) {
      prev.current = null;
      prevBuildingRef.current = buildingId;
    }
  }, [buildingId]);
  ```
- **Line 89**: Constructed monotonic unique event keys:
  ```javascript
  id: `log-${id}-${ev.key}-${Date.now()}-${++logSeq}`,
  ```

#### 1.2.5 `dashboard/src/HardwareInspector.jsx`
- **Lines 120–126**: Updated `DEFAULT_HARDWARE_LIBRARY` default pin definitions:
  ```javascript
  { id: 'ir_blaster', device: 'HVAC IR Blaster', pin: 'GPIO 25', bus: 'PWM / IRremoteESP8266', flag: 'USE_IR_AC', desc: 'Commands split-unit ACs (Coolix, Electra, Daikin, etc.) via 940nm IR emitter' },
  { id: 'smart_plug', device: 'Smart Plug Relay', pin: 'GPIO 26', bus: 'Digital Output', flag: 'USE_PLUG', desc: 'Sheds non-critical socket circuits after-hours (APLC automated plug load control)' },
  { id: 'lighting', device: 'Lighting Relay', pin: 'Unused (255)', bus: 'Digital Output', flag: 'RELAY_PIN', desc: 'Legacy/unpopulated lighting relay (virtual, pinLightingRelay = 255)' },
  ```
- **Lines 420–468**: Updated Actuators panel badging and layout:
  - Smart Plug Circuit: `Smart Plug Circuit (GPIO 26 / APLC Sockets)`, badge: `PHYSICAL RELAY (pinPlugRelay = 26)`.
  - Lighting Relay: `Lighting Relay (GPIO 23 / Solid State)`, badge: `VIRTUAL / UNPOPULATED (pinLightingRelay = 255)`.
- **Lines 1017–1075**: Implemented bounded sliding window buffer for serial logging in `UsbTab`:
  ```javascript
  const appendLog = (chunk) => {
    setLog((l) => {
      const next = l + chunk;
      return next.length > 50000 ? next.slice(-40000) : next;
    });
  };
  ...
  setLog(l => { const next = l + value; return next.length > 50000 ? next.slice(-40000) : next; });
  ```

#### 1.2.6 `dashboard/verify_webserial_floor_switcher.js`
- Authored 360-line automated test suite verifying:
  - `getActiveFloorAsset` resolves correct BIM assets across all 15 tower floors, domestic home, and out-of-range fallbacks.
  - Single-relay hardware alignment (GPIO 26 smart plug, GPIO 25 IR blaster, GPIO 23 unpopulated lighting) and 50,000 char serial log sliding buffer.
  - Telemetry logs monotonic keys and zero collisions across 500 sub-second burst events.
  - Puppeteer DOM interaction testing: `[data-testid="active-asset"]` initial mounting, dynamic mutation on clicking `[data-testid="level-btn-2"]`, `[data-testid="level-btn-4"]`, and stepper controls (`level-step-next` / `level-step-prev`), and stable mounting of `[data-testid="tab-logs"]` EVENT LOG.

---

## 2. Logic Chain

1. **Active Floor Asset Derivation & State Exposure**:
   - *Observation*: Previously, selecting a floor level in `GlobalMetricsPanel` or via `level-step-prev`/`level-step-next` mutated `activeFloor`, but no DOM attribute or component state reflected the floor's BIM asset identity. `BuildingModel.jsx` froze `initialOverview` via stale `[currentBld]` dependencies.
   - *Inference*: By defining `getActiveFloorAsset(building, activeFloor)` returning `{ level, name, assetId, zoneCount, elevation, height }`, binding it into `App.jsx`, and exposing `data-testid="active-asset"` and `data-testid="active-floor-asset"` with `data-asset-id={activeFloorAsset?.assetId}`, tests and operators can deterministically observe active asset synchronization.
   - *Inference*: By adding `[activeFloor, safeArea, currentBld]` to `initialOverview` and ensuring `DynamicControls` triggers smooth camera lerping when `activeFloor` changes, the 3D perspective updates smoothly whenever a floor is selected.

2. **Telemetry Logs Panel Stabilization**:
   - *Observation*: `TelemetryLogs.jsx` created keys using `${id}:${ev.key}:${stamp}:${now[ev.key]}` where `stamp` was formatted with `toLocaleTimeString` (1-second granularity). Under 10–30 Hz WebSocket telemetry bursts, duplicate keys were generated, crashing React's reconciliation engine. Furthermore, raw property access `snapshot(z)` threw `TypeError` if `simData.zones` had null or missing keys.
   - *Inference*: Adding a monotonic counter `++logSeq` combined with `Date.now()` guarantees that every event ID is mathematically unique across any burst rate. Implementing `safeSnapshot(z)` with null/undefined checking prevents runtime crashes on malformed frames, and clearing `prev.current` upon building switch discards stale zone baselines.

3. **Memory Leak Prevention in WebSerial Logs**:
   - *Observation*: In `HardwareInspector.jsx:UsbTab`, `setLog(l => l + value)` appended chunks to an unbounded string at 115200 baud, causing browser memory usage to climb indefinitely.
   - *Inference*: Enforcing `next.length > 50000 ? next.slice(-40000) : next` creates a strict sliding window ring buffer, bounding memory consumption while keeping the most recent 40,000 characters of serial logs visible.

4. **Hardware Configuration Alignment**:
   - *Observation*: Physical ESP32 firmware (`edge/esp32/platformio.ini`, `edge/esp32/src/node_config.h`) defines `PLUG_RELAY_PIN=26` as the only physical relay, `IR_PIN=25` for HVAC IR, and `pinLightingRelay=255` (unconnected). The dashboard previously displayed GPIO 23 as an active lighting relay.
   - *Inference*: Updating `DEFAULT_HARDWARE_LIBRARY` to `smart_plug: GPIO 26`, `ir_blaster: GPIO 25`, `lighting: Unused (255)`, and badging GPIO 23 as `VIRTUAL / UNPOPULATED (pinLightingRelay = 255)` ensures operator commands and UI telemetry strictly align with physical edge hardware.

---

## 3. Caveats

1. **No Hardware Loopback in CI**:
   - Physical WebSerial USB communication (`navigator.serial`) requires a real connected USB device and user gesture in Chrome. Automated headless test verification was executed with static server and request interception to validate DOM contracts, component mounting, and state synchronizations.
2. **WebGL Software Fallback in Headless Environments**:
   - In environments without dedicated GPU acceleration, Three.js uses SwiftShader/Mesa software rasterization. The 3D Canvas context loss and restoration handlers (`webglcontextlost`/`webglcontextrestored`) prevent UI crashes.

---

## 4. Conclusion

All Milestone 1 requirements assigned to Worker M1 have been implemented, tested, and verified:
- `getActiveFloorAsset` is implemented and exported from `dashboard/src/buildingStore.js`.
- `BuildingModel.jsx` camera overview dependencies and `DynamicControls` camera framing re-center smoothly upon floor switching.
- `App.jsx` exposes `data-testid="active-asset"` and `data-testid="active-floor-asset"` reflecting active level and BIM asset ID without blocking UI hit tests.
- `TelemetryLogs.jsx` key collisions, unsafe property accesses, and building model switch baselines are resolved.
- `HardwareInspector.jsx` serial log memory leak is prevented via bounded sliding buffer, and relays are aligned to the physical single-relay configuration (GPIO 26).
- All automated test suites (`verify_webserial_floor_switcher.js`, `verify_bim_switching.js`, `verify_level_toggle.js`, `verify_ai_actions.js`) and Vite production build (`npm run build`) pass with 0 failures.

---

## 5. Verification Method

### 5.1 Verification Commands
To independently verify all changes, run the following commands in `dashboard/`:

1. **Production Vite Build**:
   ```bash
   cd dashboard
   npm run build
   ```
   *Expected Output*: Exit code 0, all chunks built without errors.

2. **Milestone 1 Verification Test Suite**:
   ```bash
   cd dashboard
   node verify_webserial_floor_switcher.js
   ```
   *Expected Output*:
   ```
   === Suite: Pure Invariants: getActiveFloorAsset & Asset Resolution ===
     ✔ PASS getActiveFloorAsset resolves correct BIM asset for all 15 tower floors
     ✔ PASS getActiveFloorAsset gracefully handles domestic home single floor
     ✔ PASS getActiveFloorAsset fallback gracefully handles out-of-range level and null building

   === Suite: Single-Relay Hardware Alignment & Sliding Buffer Invariants ===
     ✔ PASS HardwareInspector.jsx defines single-relay (GPIO 26) and unpopulated lighting (255)
     ✔ PASS UsbTab serial log enforces bounded sliding window buffer <= 50000 chars

   === Suite: Telemetry Logs Panel: Monotonic Keys & Safe Snapshot ===
     ✔ PASS TelemetryLogs.jsx uses monotonic sequence counter and safe snapshot
     ✔ PASS Log key generation ensures 100% collision-free keys under sub-second bursts

   === Suite: Real Built App Puppeteer DOM: 3D Floor Switcher & Active Asset ===
     ✔ PASS Initial mount exposes data-testid="active-asset" matching Level 1 and BIM asset ID
     ✔ PASS Clicking floor buttons (level-btn-2, level-btn-4) dynamically updates active asset state
     ✔ PASS Level steppers (level-step-next, level-step-prev) update active asset state synchronously
     ✔ PASS Telemetry logs panel mounts stably and renders event log without crashes

   Test Summary: 11 Total | 11 Passed | 0 Failed
   ```

3. **Full Regression Test Suite**:
   ```bash
   cd dashboard
   npm test
   ```
   *Expected Output*:
   - `verify_bim_switching.js`: 11 Passed, 0 Failed
   - `verify_level_toggle.js`: 13 Passed, 0 Failed
   - `verify_ai_actions.js`: 23 Passed, 0 Failed
   Total: 47 Passed, 0 Failed, Exit code 0.

### 5.2 Files to Inspect
- `dashboard/src/buildingStore.js`
- `dashboard/src/BuildingModel.jsx`
- `dashboard/src/App.jsx`
- `dashboard/src/TelemetryLogs.jsx`
- `dashboard/src/HardwareInspector.jsx`
- `dashboard/verify_webserial_floor_switcher.js`
- `.agents/teamwork_preview_worker_m1/handoff.md`

### 5.3 Invalidation Conditions
- Any removal of `getActiveFloorAsset` from `buildingStore.js`.
- Omission of `activeFloor` from `initialOverview` dependency array in `BuildingModel.jsx`.
- Removing `data-testid="active-asset"` from `App.jsx`.
- Removing monotonic key generation or safe snapshot from `TelemetryLogs.jsx`.
- Reintroducing unbounded string concatenation in `HardwareInspector.jsx:UsbTab`.
