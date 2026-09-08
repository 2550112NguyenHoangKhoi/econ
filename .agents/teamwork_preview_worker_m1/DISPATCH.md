# Worker Dispatch — Milestone 1: UI Bug Fixes & Hardware Alignment

## Identity & Role
- **Type**: `teamwork_preview_worker`
- **Role**: `Frontend UI & Hardware Alignment Worker`
- **Working Directory**: `/Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_worker_m1`
- **Parent**: Project Orchestrator (`/Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_orchestrator_13`)

## Authoritative Context & Survey Reports
- Authoritative User Request: `/Users/nguyenhoangkhoi/Documents/econ/.agents/ORIGINAL_REQUEST.md` (MUST read first)
- Phase 0 Survey Report 1 (Frontend): `/Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_explorer_survey_12_1/report.md`
- Phase 0 Survey Report 2 (Backend): `/Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_explorer_survey_12_2/report.md`
- Phase 0 Survey Report 3 (Firmware): `/Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_explorer_survey_12_3/report.md`
- Project Plan: `/Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_orchestrator_13/PROJECT.md`

## Task Scope & File Ownership
You exclusively own and modify:
1. `dashboard/src/buildingStore.js`
2. `dashboard/src/BuildingModel.jsx`
3. `dashboard/src/App.jsx`
4. `dashboard/src/TelemetryLogs.jsx`
5. `dashboard/src/HardwareInspector.jsx`
6. `dashboard/verify_webserial_floor_switcher.js` (or automated DOM/unit test script)

DO NOT modify files outside your ownership scope.

## Detailed Requirements

### 1. 3D Floor Switcher & Active Asset State Update (R1)
- In `dashboard/src/buildingStore.js`:
  - Implement and export `getActiveFloorAsset(building, activeFloor)` returning `{ level, name, assetId, zoneCount, elevation, height }`.
- In `dashboard/src/BuildingModel.jsx`:
  - Fix `initialOverview` dependency array to include `[activeFloor, safeArea, currentBld]`.
  - Ensure `DynamicControls` camera framing re-centers and updates smoothly when `activeFloor` changes.
- In `dashboard/src/App.jsx`:
  - Derive `activeFloorAsset` using `getActiveFloorAsset(currentBuilding, activeFloor)`.
  - Expose `data-testid="active-asset"` and `data-testid="active-floor-asset"` in the DOM with `data-asset-id={activeFloorAsset?.assetId}` and visible text reflecting active level and asset name/ID.
  - Ensure clicking floor buttons (`level-btn-${lvl}`, steppers `level-step-prev`, `level-step-next`) correctly updates `activeFloor` and the active asset state.

### 2. Logs Panel Streaming & Crash Fixes (R1)
- In `dashboard/src/TelemetryLogs.jsx`:
  - Fix React key collision by using a monotonic sequence counter combined with high-resolution timestamps (`id: `log-${id}-${ev.key}-${Date.now()}-${++logSeq}``).
  - Add safe snapshot with null/undefined guards so missing or malformed zone data never throws `TypeError`.
  - Reset `prev.current` baseline when the building model switches.
- In `dashboard/src/HardwareInspector.jsx`:
  - Add bounded sliding window buffer to the serial log (`setLog(l => { const next = l + value; return next.length > 50000 ? next.slice(-40000) : next; })`).

### 3. Single-Relay Hardware Alignment (R1)
- In `dashboard/src/HardwareInspector.jsx`:
  - Align with the physical single-relay hardware configuration: GPIO 26 is the Smart Plug Relay (`pinPlugRelay`), controlled by `PLUG_ON` / `PLUG_OFF`.
  - Clearly badge the legacy Lighting Relay (GPIO 23) as virtual / unpopulated (`pinLightingRelay = 255`).
  - Update default hardware library pin definitions: `smart_plug: GPIO 26`, `ir_blaster: GPIO 25`, `lighting: Unused (255)`.

### 4. Verification & Testing
- Implement automated test script `dashboard/verify_webserial_floor_switcher.js` (using Puppeteer or DOM checks) asserting:
  - 3D floor switcher updates active asset state (`data-testid="active-asset"` matches selected floor level and BIM asset ID).
  - Logs panel streams high-frequency updates without React key collisions or crashes.
- Run `npm run build` in `dashboard/` and confirm exit code 0 without errors.
- Run the test script and confirm it passes.

## MANDATORY INTEGRITY WARNING
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

## Completion Requirements
Write your completion report to `/Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_worker_m1/handoff.md` with:
- Observation (what was changed)
- Logic Chain (how and why)
- Caveats
- Conclusion
- Verification (exact commands executed and results)
Then send a completion message to parent.

## 2026-09-08T05:21:15Z
You are Worker M1 (Frontend UI & Hardware Alignment Worker).
Your working directory is /Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_worker_m1.
Your task assignment is in /Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_worker_m1/DISPATCH.md.
The authoritative user request is in /Users/nguyenhoangkhoi/Documents/econ/.agents/ORIGINAL_REQUEST.md. Read this first.
Phase 0 survey reports are in:
- /Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_explorer_survey_12_1/report.md
- /Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_explorer_survey_12_2/report.md
- /Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_explorer_survey_12_3/report.md
Project plan: /Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_orchestrator_13/PROJECT.md.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Implement the changes specified in DISPATCH.md:
1. 3D floor switcher active asset state & camera update (buildingStore.js, BuildingModel.jsx, App.jsx)
2. Logs panel streaming stability & memory limit (TelemetryLogs.jsx, HardwareInspector.jsx)
3. Single-relay hardware alignment (HardwareInspector.jsx)
4. Verification script (verify_webserial_floor_switcher.js) and clean build (npm run build in dashboard/)

Document everything in /Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_worker_m1/handoff.md and notify parent when done.

