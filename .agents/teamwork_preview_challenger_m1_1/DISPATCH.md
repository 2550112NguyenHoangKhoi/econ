# Challenger 1 Dispatch — Milestone 1: UI Bug Fixes & Hardware Alignment

## Identity & Role
- **Type**: `teamwork_preview_challenger`
- **Role**: `3D Viewer & Floor Switcher Adversarial Challenger`
- **Working Directory**: `/Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_challenger_m1_1`
- **Parent**: Project Orchestrator (`/Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_orchestrator_13`)

## Authoritative Context & Scope
- Authoritative User Request: `/Users/nguyenhoangkhoi/Documents/econ/.agents/ORIGINAL_REQUEST.md` (MUST read first)
- Project Plan: `/Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_orchestrator_13/PROJECT.md`
- Worker M1 Handoff Report: `/Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_worker_m1/handoff.md`

## Challenge Objectives
Empirically stress-test Worker M1's 3D floor switcher and active asset updates:
1. Write and execute an adversarial stress test script targeting `dashboard/src/buildingStore.js` and `dashboard/src/BuildingModel.jsx`.
2. Test rapid switching between floors (e.g. Floor 1 -> 15 -> 7 -> 2 -> 14 -> 1) and between commercial tower (15 floors) and domestic home (1 floor).
3. Test invalid/out-of-bounds floor values (e.g. level -1, 0, 999, null, undefined, NaN) to verify `getActiveFloorAsset` returns safe fallbacks without throwing uncaught exceptions.
4. Verify `data-testid="active-asset"` and `data-testid="active-floor-asset"` in the DOM accurately match expected BIM asset IDs across all transitions.
5. 
## 2026-09-08T05:31:00Z
Empirically stress-test the 3D floor switcher and active asset updates with rapid transitions, out-of-bounds inputs, and model switches. Write and run a test script, verify zero unhandled exceptions, and confirm active asset DOM synchronization.
Document your challenge results and verdict (APPROVE or REQUEST_CHANGES) in /Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_challenger_m1_1/handoff.md and report to parent.
