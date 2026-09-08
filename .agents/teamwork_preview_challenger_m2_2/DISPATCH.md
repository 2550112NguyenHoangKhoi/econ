# Challenger 2 Dispatch — Milestone 2: Backend State Persistence

## Identity & Role
- **Type**: `teamwork_preview_challenger`
- **Role**: `Multi-Device WebSocket Synchronization & REST API Challenger`
- **Working Directory**: `/Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_challenger_m2_2`
- **Parent**: Project Orchestrator (`/Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_orchestrator_13`)

## Authoritative Context & Input Reports
- Authoritative User Request: `/Users/nguyenhoangkhoi/Documents/econ/.agents/ORIGINAL_REQUEST.md` (MUST read first)
- Worker M2 Handoff: `/Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_worker_m2/handoff.md`
- Project Plan: `/Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_orchestrator_13/PROJECT.md`

## Challenge Mandate
Empirically stress-test the REST and WebSocket multi-device synchronization:
1. Write and execute an adversarial test verifying:
   - High-concurrency `POST /api/state` and `GET /api/state` bursts via `httptest`.
   - Simulated multi-client WebSocket topology (e.g. 10 clients connected simultaneously to `/ws`, Client 1 updates a toggle, asserts all other 9 clients receive `state_update` within <50ms).
   - Malformed JSON payloads to `POST /api/state` and invalid WS text frames (assert graceful HTTP 400 Bad Request or error handling without server crash or panic).
   - Verify frontend `useStatePersistence.js` echo prevention under rapid simulated broadcast feedback loops.
2. Document your empirical findings and verdict (`APPROVE` or `REQUEST_CHANGES`) in `/Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_challenger_m2_2/handoff.md` and report to parent.

## 2026-09-08T06:04:33Z
You are Challenger 2 (Multi-Device WebSocket Synchronization & REST API Challenger).
Your working directory is /Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_challenger_m2_2.
Your task instructions are in /Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_challenger_m2_2/DISPATCH.md.
Authoritative user request: /Users/nguyenhoangkhoi/Documents/econ/.agents/ORIGINAL_REQUEST.md.
Worker M2 handoff: /Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_worker_m2/handoff.md.
Project plan: /Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_orchestrator_13/PROJECT.md.

Empirically stress-test the REST and WebSocket sync: high-concurrency POST/GET bursts, simulated 10+ concurrent WS client topology asserting real-time broadcast delivery (<50ms), malformed payloads, and echo loop prevention. Write and run an adversarial test script.
Document your findings and verdict (APPROVE or REQUEST_CHANGES) in /Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_challenger_m2_2/handoff.md and report to parent.

