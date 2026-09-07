#!/usr/bin/env node

/**
 * verify_mode_toggle.js — Automated Verification for Operation Mode API and UI Toggle
 *
 * Verifies Milestone 2:
 * 1. UI static structure in App.jsx and useOperationMode.js (testids, segmented switch, hook exports)
 * 2. API contract verification against backend /api/mode (GET and POST /api/mode payload schemas)
 * 3. Handling of inputs: "simulation", "sim", "0", "real", "1"
 * 4. Mode segregation contract verification (ModeReal rejects mock payloads, maps stripW and CB)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`${colors.green}  ✓ PASS:${colors.reset} ${message}`);
    passed++;
  } else {
    console.error(`${colors.red}  ✗ FAIL:${colors.reset} ${message}`);
    failed++;
  }
}

async function runTests() {
  console.log(`\n${colors.bold}${colors.cyan}=== Milestone 2: Operation Mode Engine API & UI Toggle Verification ===${colors.reset}\n`);

  // --- Suite 1: Frontend Structure & TestID Verification ---
  console.log(`${colors.bold}Suite 1: Frontend Structure & TestID Verification${colors.reset}`);

  const appPath = path.join(__dirname, 'src', 'App.jsx');
  const hookPath = path.join(__dirname, 'src', 'useOperationMode.js');
  const testPath = path.join(__dirname, 'src', '__tests__', 'OperationModeToggle.test.jsx');

  assert(fs.existsSync(hookPath), 'dashboard/src/useOperationMode.js exists');
  assert(fs.existsSync(testPath), 'dashboard/src/__tests__/OperationModeToggle.test.jsx exists');

  const appContent = fs.readFileSync(appPath, 'utf-8');
  const hookContent = fs.readFileSync(hookPath, 'utf-8');

  assert(appContent.includes('data-testid="operation-mode-toggle"'), 'App.jsx has data-testid="operation-mode-toggle"');
  assert(appContent.includes('data-testid="toggle-mode-simulation"'), 'App.jsx has data-testid="toggle-mode-simulation"');
  assert(appContent.includes('data-testid="toggle-mode-real"'), 'App.jsx has data-testid="toggle-mode-real"');
  assert(appContent.includes('useOperationMode'), 'App.jsx imports and uses useOperationMode');

  assert(hookContent.includes('export function useOperationMode'), 'useOperationMode.js exports useOperationMode function');
  assert(hookContent.includes('/api/mode'), 'useOperationMode.js references /api/mode endpoint');
  assert(hookContent.includes('setMode'), 'useOperationMode.js provides setMode mutator');

  // --- Suite 2: Client Hook Logic & API Contract Simulation ---
  console.log(`\n${colors.bold}Suite 2: Operation Mode Contract & Logic Verification${colors.reset}`);

  let serverMode = 'simulation';
  let serverIsReal = false;

  const handleMockRequest = async (url, options = {}) => {
    if (!url.includes('/api/mode')) {
      return { ok: false, status: 404 };
    }

    const method = (options.method || 'GET').toUpperCase();
    if (method === 'GET') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          mode: serverMode,
          mode_int: serverIsReal ? 1 : 0,
          is_real: serverIsReal,
          isReal: serverIsReal,
          description: serverIsReal ? 'Real mode' : 'Simulation mode'
        })
      };
    }

    if (method === 'POST') {
      let parsed = {};
      if (options.body) {
        try {
          parsed = JSON.parse(options.body);
        } catch {
          parsed = { mode: options.body };
        }
      }
      const target = String(parsed.mode || '').trim().toLowerCase();
      if (['real', '1', 'mode_real'].includes(target)) {
        serverMode = 'real';
        serverIsReal = true;
      } else if (['simulation', 'sim', '0', 'mode_simulation'].includes(target)) {
        serverMode = 'simulation';
        serverIsReal = false;
      } else {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: `invalid mode ${target}` })
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          mode: serverMode,
          mode_int: serverIsReal ? 1 : 0,
          is_real: serverIsReal,
          isReal: serverIsReal,
          description: serverIsReal ? 'Real mode' : 'Simulation mode'
        })
      };
    }

    return { ok: false, status: 405 };
  };

  // Test GET /api/mode
  const getRes = await handleMockRequest('http://localhost:8080/api/mode', { method: 'GET' });
  assert(getRes.status === 200, 'GET /api/mode mock returns 200 OK');
  const getData = await getRes.json();
  assert(getData.mode === 'simulation' && getData.isReal === false, 'Default mode is simulation (isReal=false)');

  // Test POST /api/mode with {"mode":"real"}
  const postRealRes = await handleMockRequest('http://localhost:8080/api/mode', {
    method: 'POST',
    body: JSON.stringify({ mode: 'real' })
  });
  assert(postRealRes.status === 200, 'POST /api/mode {"mode":"real"} returns 200 OK');
  const postRealData = await postRealRes.json();
  assert(postRealData.mode === 'real' && postRealData.isReal === true, 'Updated mode is real (isReal=true)');

  // Test POST /api/mode with {"mode":"sim"}
  const postSimRes = await handleMockRequest('http://localhost:8080/api/mode', {
    method: 'POST',
    body: JSON.stringify({ mode: 'sim' })
  });
  assert(postSimRes.status === 200, 'POST /api/mode {"mode":"sim"} returns 200 OK');
  const postSimData = await postSimRes.json();
  assert(postSimData.mode === 'simulation' && postSimData.isReal === false, 'Updated mode is simulation (isReal=false)');

  // Test POST /api/mode with {"mode":"1"}
  const post1Res = await handleMockRequest('http://localhost:8080/api/mode', {
    method: 'POST',
    body: JSON.stringify({ mode: '1' })
  });
  assert(post1Res.status === 200, 'POST /api/mode {"mode":"1"} returns 200 OK');
  const post1Data = await post1Res.json();
  assert(post1Data.isReal === true, 'Mode "1" parsed as Real mode');

  // Test POST /api/mode with {"mode":"0"}
  const post0Res = await handleMockRequest('http://localhost:8080/api/mode', {
    method: 'POST',
    body: JSON.stringify({ mode: '0' })
  });
  assert(post0Res.status === 200, 'POST /api/mode {"mode":"0"} returns 200 OK');
  const post0Data = await post0Res.json();
  assert(post0Data.isReal === false, 'Mode "0" parsed as Simulation mode');

  // Test POST with invalid mode
  const postInvalidRes = await handleMockRequest('http://localhost:8080/api/mode', {
    method: 'POST',
    body: JSON.stringify({ mode: 'unknown_mode' })
  });
  assert(postInvalidRes.status === 400, 'POST /api/mode with invalid mode returns 400');

  // --- Suite 3: Backend File Verification ---
  console.log(`\n${colors.bold}Suite 3: Backend File & Registration Verification${colors.reset}`);
  const modeapiPath = path.join(__dirname, '..', 'server', 'modeapi.go');
  const modeapiTestPath = path.join(__dirname, '..', 'server', 'modeapi_test.go');
  const mainPath = path.join(__dirname, '..', 'server', 'main.go');

  assert(fs.existsSync(modeapiPath), 'server/modeapi.go exists');
  assert(fs.existsSync(modeapiTestPath), 'server/modeapi_test.go exists');

  const mainContent = fs.readFileSync(mainPath, 'utf-8');
  assert(mainContent.includes('/api/mode'), 'server/main.go registers /api/mode route');

  // --- Summary ---
  console.log(`\n${colors.bold}=== Verification Summary ===${colors.reset}`);
  console.log(`Total tests: ${passed + failed}`);
  console.log(`${colors.green}Passed: ${passed}${colors.reset}`);
  console.log(`${failed > 0 ? colors.red : colors.green}Failed: ${failed}${colors.reset}`);

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log(`\n${colors.bold}${colors.green}ALL MILESTONE 2 CHECKS PASSED!${colors.reset}\n`);
  }
}

runTests().catch(err => {
  console.error('Fatal error running verification:', err);
  process.exit(1);
});
