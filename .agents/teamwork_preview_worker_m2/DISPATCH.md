# Worker Dispatch — Milestone 2: Backend State Persistence & Multi-Device Sync

## Identity & Role
- **Type**: `teamwork_preview_worker`
- **Role**: `Backend State Persistence Worker`
- **Working Directory**: `/Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_worker_m2`
- **Parent**: Project Orchestrator (`/Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_orchestrator_13`)

## Authoritative Context & Input Reports
- Authoritative User Request: `/Users/nguyenhoangkhoi/Documents/econ/.agents/ORIGINAL_REQUEST.md` (MUST read first)
- Phase 0 Survey Report 2 (Backend State Persistence & Architecture): `/Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_explorer_survey_12_2/report.md`
- Project Plan: `/Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_orchestrator_13/PROJECT.md`

## Critical Environment Constraint
DO NOT use `go get` or pull new external third-party Go dependencies (external proxy fetches fail with x509 cert errors). Use only existing modules in `go.mod` (`github.com/lib/pq`, `github.com/gorilla/websocket`, `github.com/google/flatbuffers`) and Go standard library (`os`, `sync`, `encoding/json`, `net/http`, `database/sql`, `path/filepath`).

## Scope & File Ownership
You exclusively own and modify:
1. `server/state_store.go` (new storage engine)
2. `server/stateapi.go` (new API handlers & WS broadcast)
3. `server/main.go` (register routes, initialize StateStore, cold-boot restore, WS sync)
4. `server/db.go` (table schema migration for `dashboard_state`)
5. `server/state_persistence_test.go` (new unit test suite)
6. `dashboard/src/useStatePersistence.js` & wiring in `dashboard/src/App.jsx`

## Detailed Requirements

### 1. Dual-Layer Storage Engine (`server/state_store.go`)
- Create `StateStore` struct with `sync.RWMutex`, `filePath string` (defaults to `./data/dashboard-state.json`), and `db *sql.DB`.
- When `db != nil`, load and persist to PostgreSQL table `dashboard_state (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL, updated_by TEXT)`.
- When `db == nil` (or on fallback), load from and write atomically to `./data/dashboard-state.json` (temp file + rename).
- Thread-safe methods: `Get(key string)`, `GetAll()`, `Set(key string, val interface{})`, `SetAll(toggles map[string]interface{})`, `Save()`.

### 2. Schema Migration (`server/db.go`)
- In `migrateSchema()`, add idempotent table creation:
  ```sql
  CREATE TABLE IF NOT EXISTS dashboard_state (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      updated_by TEXT
  );
  ```

### 3. REST & WebSocket API Layer (`server/stateapi.go`, `server/main.go`)
- Implement `stateHandler(engine *simulation.Engine, store *StateStore)`:
  - `GET /api/state`: Returns `{ "ok": true, "buildingId": "...", "updatedAt": "...", "toggles": { ... } }`.
  - `POST /api/state`: Accepts `{ "toggles": { "autoPilot": false, ... } }`, persists to `StateStore`, applies known toggles to `engine` (e.g. `engine.SetAutoPilot`, `engine.SetMode`), and broadcasts `state_update` frame to all connected WebSocket clients.
- In WebSocket connection handler (`/ws` in `server/main.go`):
  - On client connect, send initial `{"type": "state_sync", "toggles": { ... }}` frame.
  - On incoming `{"action": "set_state", "key": "...", "value": ...}`, persist and broadcast to other clients.

### 4. Cold-Boot Restoration
- In `server/main.go`, during startup initialization:
  - Initialize `NewStateStore("./data/dashboard-state.json", DB)`.
  - Call `applyPersistentStateToEngine(engine, stateStore)` so cold boots immediately adopt saved preferences (AutoPilot, OperationMode, etc.).

### 5. Frontend Synchronization Hook (`dashboard/src/useStatePersistence.js`)
- Fetch initial state from `GET /api/state` on boot and merge into dashboard state.
- Debounced save to `POST /api/state` when toggles (e.g. AutoPilot, Mode, active floor, UI panels) change.
- Listen for WebSocket `state_sync` and `state_update` frames to synchronize live across multiple open browser tabs/devices.

### 6. Verification & Go Unit Tests (`server/state_persistence_test.go`)
Implement unit tests covering:
- `TestStatePersistence_WriteAndRead`: Saves toggles and verifies atomic write to disk.
- `TestStatePersistence_ColdBootInitialization`: Pre-populates JSON file, boots fresh engine, asserts engine restores toggles.
- `TestStatePersistence_RESTEndpoints`: Tests `POST /api/state` and `GET /api/state` via `httptest`.
- `TestStatePersistence_ConcurrentAccess`: Tests concurrent read/write safety.
- Run `go test -v -run TestStatePersistence .` in `server/` (MUST pass 100%).
- Run `go test ./...` in `server/` (all existing tests must pass).
- Run `npm run build` in `dashboard/` (MUST pass cleanly).

## MANDATORY INTEGRITY WARNING
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

## Completion Requirements
Write handoff report to `/Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_worker_m2/handoff.md`.
Notify parent when done.

## 2026-09-08T05:55:27Z
You are Worker M2 (Backend State Persistence Worker).
Your working directory is /Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_worker_m2.
Your task instructions are in /Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_worker_m2/DISPATCH.md.
Authoritative user request: /Users/nguyenhoangkhoi/Documents/econ/.agents/ORIGINAL_REQUEST.md. Read this first.
Phase 0 survey reports:
- /Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_explorer_survey_12_2/report.md (Backend persistence architecture & schema)
Project plan: /Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_orchestrator_13/PROJECT.md.

CRITICAL ENVIRONMENT CONSTRAINT:
DO NOT use go get or pull new third-party Go dependencies. Use existing modules and Go standard library.

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Implement:
1. Dual-layer StateStore (server/state_store.go)
2. Schema migration (server/db.go)
3. REST & WebSocket handlers (server/stateapi.go, server/main.go)
4. Cold boot engine restoration
5. Frontend sync hook (dashboard/src/useStatePersistence.js & App.jsx)
6. Go unit tests (server/state_persistence_test.go) and run go test -v -run TestStatePersistence . and npm run build.

Document everything in /Users/nguyenhoangkhoi/Documents/econ/.agents/teamwork_preview_worker_m2/handoff.md and notify parent when done.
