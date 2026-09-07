# Dispatch: Worker M1 (Hardware Inspector Expansion & Manual Actuation)

## Mission
Implement Milestone 1:
1. Expose the IR Blaster in the Hardware Inspector dashboard (`dashboard/src/HardwareInspector.jsx`).
2. Add full library support for all devices currently present in edge node firmware (`edge/esp32/src/main.cpp`).
3. Implement comprehensive manual controls in the Hardware Inspector so the user can manually actuate every capability (trigger IR blaster with protocol/hex/bits, toggle plugs/relays, override VAV dampers, simulate CPU strain).
4. Update Go backend command validation and execution in `server/main.go` and `server/simulation/engine.go` to accept `IR_SEND:`, `PLUG_ON`, `PLUG_OFF`, `DAMPER=`, `VAV_SET:`, `CPU_STRAIN:`, update the digital twin state immediately, and dispatch to edge nodes via MQTT (`econ/commands/<topic>`).
5. Write and verify unit tests confirming command routing and UI tests for manual controls.

## Required Reading
- /Users/nguyenhoangkhoi/Documents/econ/.agents/ORIGINAL_REQUEST.md
- /Users/nguyenhoangkhoi/Documents/econ/PROJECT.md
- /Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_explorer_survey_1/handoff.md

## Mandatory Integrity Warning
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

## Write Ownership
- `dashboard/src/HardwareInspector.jsx`
- `dashboard/src/__tests__/HardwareInspector.test.jsx` (or verification test script)
- `server/main.go` (specifically `isSupportedCommand` or helper in `server/commandapi.go`)
- `server/simulation/engine.go` (twin state handling in `applyCommandToZone`)
- `server/command_override_test.go`
- `edge/esp32/src/main.cpp` (if any command alignment is needed)

## Deliverable
Write handoff report to:
`/Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_worker_m1/handoff.md`
Report all files modified, build/test commands executed, and verification results.

## 2026-09-06T15:01:50Z
Mission (Milestone 1):
Implement Hardware Section expansion & manual controls:
1. Expose IR Blaster in Hardware Inspector (dashboard/src/HardwareInspector.jsx) with protocol selector, frequency/bits, hex code input, and manual send button.
2. Add comprehensive manual controls for all edge devices (trigger IR blaster, toggle plugs/relays, override VAV dampers, simulate CPU strain).
3. Update Go backend command validation (server/main.go) to accept IR_SEND:, PLUG_ON, PLUG_OFF, DAMPER=, VAV_SET:, CPU_STRAIN:, update twin state in applyCommandToZone (server/simulation/engine.go), and route to edge nodes via MQTT.
4. Run tests and verify functionality.
Write your handoff report to /Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_worker_m1/handoff.md.

Update your progress.md regularly. When finished, send a message to parent reporting your completion.

