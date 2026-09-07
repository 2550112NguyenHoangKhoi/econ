## 2026-09-06T15:01:50Z

# Dispatch: Worker M2 (Simulation vs. Real Mode Engine API & UI Toggle)

## Mission
Implement Milestone 2:
1. Implement the REST API for operation mode in the Go backend:
   - Create `server/modeapi.go` exposing `GET /api/mode` and `POST /api/mode` (with CORS preflight handling).
   - Register endpoints in `server/main.go`.
   - Ensure `POST /api/mode` accepts `"simulation"`, `"sim"`, `"0"`, `"real"`, `"1"`, safely updates `engine.SetMode()`, and returns standard JSON payload.
2. Verify mode segregation behavior:
   - In `ModeReal` (`ModeReal = 1`), verify mock telemetry is rejected, and real telemetry properly maps `stripW` to plugs and CB to `plugW`.
   - Write comprehensive Go unit tests in `server/modeapi_test.go` and run existing `operation_modes_test.go`.
3. Implement the global React toggle UI:
   - Create `dashboard/src/useOperationMode.js` custom hook for querying and mutating operation mode.
   - Integrate a global glassmorphic segmented switch `[🧪 Simulation | ⚡ Real]` in the top bar of `dashboard/src/App.jsx` (with `data-testid="operation-mode-toggle"`).
   - Ensure the toggle seamlessly calls `POST /api/mode` and updates UI state dynamically.
   - Write automated frontend tests (e.g. `dashboard/src/__tests__/OperationModeToggle.test.jsx` or verification test script) confirming toggle calls backend API and updates global state.

## Required Reading
- /Users/nguyenhoangkhoi/Documents/econ/.agents/ORIGINAL_REQUEST.md
- /Users/nguyenhoangkhoi/Documents/econ/PROJECT.md
- /Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_explorer_survey_2/handoff.md

## Mandatory Integrity Warning
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

## Write Ownership
- `server/modeapi.go`
- `server/modeapi_test.go`
- `server/main.go` (registering `/api/mode`)
- `dashboard/src/useOperationMode.js`
- `dashboard/src/App.jsx` (top bar mode toggle integration)
- `dashboard/src/__tests__/OperationModeToggle.test.jsx`

## Deliverable
Write handoff report to:
`/Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_worker_m2/handoff.md`
Report all files modified, build/test commands executed, and verification results.
