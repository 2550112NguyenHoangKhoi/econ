# Handoff Report: Milestone M1 Frontend Review & Adversarial Audit

**Reviewer Agent**: `teamwork_preview_reviewer_m1_1`  
**Working Directory**: `/Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_reviewer_m1_1`  
**Handoff Type**: Hard (Review complete)  
**Date**: 2026-09-08T05:37:00Z  
**Parent Agent**: `94b1bad7-43b4-4ef2-a84c-6c5e8cbf0b7f` (Project Orchestrator)  
**Verdict**: **APPROVE**  

---

## Review Summary

**Verdict**: **APPROVE**

Worker M1's changes across `dashboard/src/buildingStore.js`, `dashboard/src/BuildingModel.jsx`, `dashboard/src/App.jsx`, `dashboard/src/TelemetryLogs.jsx`, and `dashboard/src/HardwareInspector.jsx` cleanly, correctly, and robustly fulfill all Milestone 1 requirements:
1. Single-relay physical hardware alignment (GPIO 26 smart plug relay, legacy GPIO 23 lighting marked virtual/unpopulated).
2. 3D floor switcher active asset state exposure (`data-testid="active-asset"`, `data-testid="active-floor-asset"`) and dynamic camera overview re-centering.
3. Telemetry logs panel streaming stability (monotonic unique sequence keys, safe snapshot guards, building model switch baseline reset) and bounded WebSerial buffer (<= 50,000 chars sliding window).
4. Automated verification suite passing 100% (11/11 tests in `verify_webserial_floor_switcher.js`) and full regression suite passing 100% (47/47 tests in `npm test`).
5. Production Vite build compiles cleanly (`npm run build`, exit code 0).

---

## 1. Observation

Direct observations from source code inspections, static analysis, and command executions:

### 1.1 Source Code Observations

1. **`dashboard/src/buildingStore.js` (lines 50–64)**:
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
   - Pure function returning `{ level, name, assetId, zoneCount, elevation, height }`.
   - Handles `null` / `undefined` building input, non-numeric or string `activeFloor`, missing `zones`, and non-existent floor levels with clean fallbacks.

2. **`dashboard/src/BuildingModel.jsx` (lines 615–644, 731–735)**:
   - Updated `initialOverview` dependency array from `[currentBld]` to `[activeFloor, safeArea, currentBld]`:
     ```javascript
     const initialOverview = useMemo(() => {
       const aspect = (typeof window !== 'undefined' ? window.innerWidth / Math.max(1, window.innerHeight) : 1.6);
       return towerFraming(activeFloor, aspect, safeArea, currentBld);
     }, [activeFloor, safeArea, currentBld]);
     ```
   - In `DynamicControls`, when `overview` or `camera` changes while `!isZoomed`, smoothly updates `targetCameraPos`, `targetLookAt`, and sets `animating = true`.
   - Included `activeFloor` in the target position calculation dependencies: `[isZoomed, targetX, targetY, targetZ, overview, building, activeFloor]`.
   - Terminal snapping condition in `useFrame` (`distanceTo < 0.05`) safely completes camera lerping without endless animation frames.

3. **`dashboard/src/App.jsx` (lines 6, 336–339, 1494–1522)**:
   - Imported `getActiveFloorAsset` and derived `activeFloorAsset = useMemo(() => getActiveFloorAsset(currentBuilding, activeFloor), [currentBuilding, activeFloor])`.
   - Exposed `data-testid="active-asset"` and `data-testid="active-floor-asset"` in the DOM with `data-asset-id={activeFloorAsset?.assetId || ''}`.
   - Styled with `position: 'absolute'`, `bottom: '7.6rem'` (sitting directly above `desktop-level-toggle` at `5.2rem`), and `pointerEvents: 'none'` so clicks to the 3D canvas or level buttons are never obstructed.

4. **`dashboard/src/TelemetryLogs.jsx` (lines 20, 26–36, 57–65, 89)**:
   - Introduced monotonic counter `let logSeq = 0;`.
   - Replaced fragile `snapshot(z)` with `safeSnapshot(z)` featuring comprehensive guards:
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
   - Baseline reset upon building switch: clears `prev.current = null` when `buildingId` changes.
   - Event key minted via: `id: `log-${id}-${ev.key}-${Date.now()}-${++logSeq}``.

5. **`dashboard/src/HardwareInspector.jsx` (lines 120–126, 420–468, 1017–1021, 1048)**:
   - `DEFAULT_HARDWARE_LIBRARY` default pin definitions:
     `smart_plug`: GPIO 26 (`pinPlugRelay`), `ir_blaster`: GPIO 25, `lighting`: Unused (255) (`pinLightingRelay = 255`).
   - Actuators panel badging: Smart Plug Circuit clearly badged as `PHYSICAL RELAY (pinPlugRelay = 26)` with `PLUG_ON` / `PLUG_OFF` buttons; Lighting Relay clearly badged as `VIRTUAL / UNPOPULATED (pinLightingRelay = 255)`.
   - Serial log sliding window: `setLog(l => { const next = l + value; return next.length > 50000 ? next.slice(-40000) : next; })` enforces a strict 50 KB ceiling.

### 1.2 Command Execution Observations

1. **Vite Production Build**:
   - Command: `npm run build` in `dashboard/`
   - Result: Exit code 0.
   - Output: `✓ 2744 modules transformed. built in 11.51s.` All bundle chunks generated without errors.

2. **Milestone 1 Test Suite**:
   - Command: `node verify_webserial_floor_switcher.js` in `dashboard/` (with sandbox bypass for headless Chrome)
   - Result: Exit code 0.
   - Output:
     - `Pure Invariants: getActiveFloorAsset & Asset Resolution`: 3 passed, 0 failed.
     - `Single-Relay Hardware Alignment & Sliding Buffer Invariants`: 2 passed, 0 failed.
     - `Telemetry Logs Panel: Monotonic Keys & Safe Snapshot`: 2 passed, 0 failed.
     - `Real Built App Puppeteer DOM: 3D Floor Switcher & Active Asset`: 4 passed, 0 failed.
     - Total: 11 passed, 0 failed (120288ms).

3. **Regression Test Suite**:
   - Command: `npm test` in `dashboard/`
   - Result: Exit code 0.
   - Output:
     - `verify_bim_switching.js`: 11 passed, 0 failed (16102ms).
     - `verify_level_toggle.js`: 13 passed, 0 failed (19124ms).
     - `verify_ai_actions.js`: 23 passed, 0 failed (9138ms).
     - Total: 47 passed, 0 failed.

---

## 2. Logic Chain

1. **Active Floor Asset Derivation & Synchronous DOM Binding**:
   - *Observation*: Requirements dictate that selecting floor levels must update the active 3D model, re-center the camera, and expose `data-testid="active-asset"` and `data-testid="active-floor-asset"`.
   - *Logic Step 1*: `getActiveFloorAsset(building, activeFloor)` looks up the selected floor, extracts the primary zone's `bim_asset_id` (or generates `floor-asset-${floor.level}`), and returns full floor metadata.
   - *Logic Step 2*: In `App.jsx`, `activeFloorAsset` is memoized on `[currentBuilding, activeFloor]` and bound to `data-testid="active-asset"` and `data-testid="active-floor-asset"`. Both DOM elements expose `data-asset-id={activeFloorAsset?.assetId}` and display the active level and asset ID.
   - *Logic Step 3*: Adding `pointerEvents: 'none'` ensures that this HUD element does not absorb mouse pointer clicks meant for the underlying 3D canvas or level buttons.
   - *Conclusion*: 3D asset state is accurately tracked and deterministically observable without UI degradation.

2. **Camera Re-Centering & Exploded View Framing**:
   - *Observation*: In `towerFraming`, floors above `activeFloor` are displaced upward by +30 units, and the active floor is lifted by +5 units. This shifts the vertical center of mass `(topY + botY) / 2`.
   - *Logic Step 1*: Previously, `initialOverview` had a stale dependency `[currentBld]`, ignoring floor changes. Updating dependencies to `[activeFloor, safeArea, currentBld]` recalculates the camera target whenever `activeFloor` changes.
   - *Logic Step 2*: In `DynamicControls`, adding `activeFloor` to dependencies and triggering `setAnimating(true)` when `!isZoomed` ensures that switching floors initiates a smooth Three.js camera lerp to the newly framed center of mass.
   - *Logic Step 3*: The 0.05-unit distance threshold in `useFrame` ensures the camera snaps cleanly to its target and disables the animation loop, preventing unnecessary render cycles.
   - *Conclusion*: Camera framing correctly re-centers on active floor changes while respecting zone-level zoom states.

3. **Telemetry Logs Panel Streaming Stability**:
   - *Observation*: High-frequency WebSocket telemetry bursts (10–30 Hz) caused duplicate React keys (`id:key:time:val`), triggering React reconciliation errors and UI crashes. Missing or non-object zone entries caused `TypeError` in property accesses.
   - *Logic Step 1*: The addition of `logSeq` ensures strict monotonic ordering (`log-${id}-${ev.key}-${Date.now()}-${++logSeq}`). Because `logSeq` increments per minted event, key uniqueness is mathematically guaranteed even across sub-millisecond bursts.
   - *Logic Step 2*: `safeSnapshot(z)` guards against null or malformed zone entries, returning null and allowing the event loop to continue gracefully.
   - *Logic Step 3*: Resetting `prev.current = null` on building switch flushes stale zone baselines, preventing spurious event floods when toggling between the commercial tower and domestic house models.
   - *Conclusion*: The logs panel streaming pipeline is immune to key collision crashes and malformed payloads.

4. **Single-Relay Hardware Alignment & Bounded Buffer**:
   - *Observation*: Physical firmware in `edge/esp32` has one physical relay on GPIO 26 (`pinPlugRelay = 26`), while lighting on GPIO 23 is unpopulated (`pinLightingRelay = 255`). Unbounded serial logs previously caused memory bloat.
   - *Logic Step 1*: Aligning `DEFAULT_HARDWARE_LIBRARY` to GPIO 26 for `smart_plug` and 255 for `lighting`, and visibly badging them as `PHYSICAL RELAY` and `VIRTUAL / UNPOPULATED`, brings the UI into strict parity with the physical edge hardware.
   - *Logic Step 2*: Enforcing a sliding window buffer (`next.length > 50000 ? next.slice(-40000) : next`) caps memory usage at ~50 KB indefinitely, regardless of baud rate or session duration.
   - *Conclusion*: Hardware configuration is accurately represented and serial console memory leaks are eliminated.

---

## 3. Adversarial Challenges & Integrity Audit

### 3.1 Integrity Audit (Zero Integrity Violations)
- **Hardcoded Test Results**: Evaluated `getActiveFloorAsset`, `TelemetryLogs.jsx`, and `HardwareInspector.jsx`. No hardcoded test strings or dummy mappings found; logic evaluates dynamically against whatever building data or event data is provided.
- **Dummy Implementations**: Full implementations present with real calculations, Three.js vector math, and React hooks.
- **Shortcuts / Bypasses**: Core requirements implemented directly in source files; test suite tests the actual production bundle (`dist/`) via Puppeteer.
- **Fabricated Outputs**: Commands were executed independently with verified exit code 0.

### 3.2 Adversarial Stress Tests
1. **Malicious / Corrupt Input to `getActiveFloorAsset`**:
   - Challenge: Passing `null`, `{ floors: [] }`, `activeFloor = "abc"`, `activeFloor = -10`, `activeFloor = 999`.
   - Behavior: Fallbacks gracefully return `null` or default level 1 asset without throwing exceptions.
2. **High-Frequency Log Event Bursts**:
   - Challenge: Injecting 500 consecutive log events in the exact same millisecond.
   - Behavior: `logSeq` guaranteed 500 distinct keys with zero Set collisions (verified in `test 7`).
3. **Serial Stream Flooding**:
   - Challenge: Ingesting a continuous stream of >100,000 characters at 115200 baud.
   - Behavior: The sliding window strictly bounds the log string to <= 50,000 characters, retaining the most recent 40,000 characters and discarding old data without blocking the UI thread.
4. **Hit-Testing Obstruction on Canvas**:
   - Challenge: Does the new `active-asset` HUD badge block user clicks to the 3D canvas or level stepper buttons?
   - Behavior: Styled with `pointerEvents: 'none'`, allowing all mouse events to pass transparently through to the underlying controls.

---

## 4. Caveats

1. **WebSerial Browser Support**:
   - Physical WebSerial (`navigator.serial`) requires a Chromium-based browser with HTTPS or `localhost` context and an interactive user gesture. In automated headless testing, DOM elements and invariant logic are validated using headless Chrome.
2. **WebGL Software Rasterization**:
   - In headless environments, Three.js relies on SwiftShader. Context loss/restoration handlers ensure stability across execution environments.

---

## 5. Conclusion

**Verdict: APPROVE**

Worker M1's deliverables meet all correctness, stability, architectural, and test requirements for Milestone 1. The code is well-engineered, resilient against edge cases, free of integrity violations, and passes all 11 Milestone 1 tests and 47 regression tests.

Milestone 1 is ready to be marked **COMPLETE**.

---

## 6. Verification Method

To independently verify this work, execute the following commands from `dashboard/`:

1. **Vite Production Build**:
   ```bash
   cd dashboard
   npm run build
   ```
   *Expect*: Exit code 0, 2744 modules transformed, bundle emitted into `dist/`.

2. **Milestone 1 Test Suite**:
   ```bash
   cd dashboard
   node verify_webserial_floor_switcher.js
   ```
   *Expect*: 11 tests executed, 11 passed, 0 failed.

3. **Full Regression Suite**:
   ```bash
   cd dashboard
   npm test
   ```
   *Expect*: 47 tests executed across BIM switching, level toggle, and AI actions; 47 passed, 0 failed.

### Files to Inspect
- `dashboard/src/buildingStore.js`
- `dashboard/src/BuildingModel.jsx`
- `dashboard/src/App.jsx`
- `dashboard/src/TelemetryLogs.jsx`
- `dashboard/src/HardwareInspector.jsx`
- `dashboard/verify_webserial_floor_switcher.js`

