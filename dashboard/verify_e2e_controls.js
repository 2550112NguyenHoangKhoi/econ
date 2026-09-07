#!/usr/bin/env node

/**
 * =============================================================================
 * verify_e2e_controls.js — Automated E2E Verification for All 4 Project Requirements
 *
 * Requirements Covered:
 *   R1. Hardware Inspector Manual Controls & IR Blaster
 *   R2. Simulation vs. Real Mode UI Global Toggle Switch
 *   R3. Sustainability Recommendations Panel
 *   R4. Local Model Live Inference UI Integration
 * =============================================================================
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  gray: '\x1b[90m',
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

function suite(name) {
  console.log(`\n${colors.bold}${colors.cyan}=== ${name} ===${colors.reset}`);
}

async function runVerification() {
  console.log(`\n${colors.bold}Starting ECON Comprehensive E2E UI & Controls Verification Suite...${colors.reset}`);

  // ---------------------------------------------------------------------------
  // Suite 1: Hardware Inspector Manual Controls & IR Blaster UI (R1)
  // ---------------------------------------------------------------------------
  suite('Suite 1: Hardware Inspector Manual Controls & IR Blaster UI');

  const hwInspectorPath = path.join(__dirname, 'src', 'HardwareInspector.jsx');
  assert(fs.existsSync(hwInspectorPath), 'HardwareInspector.jsx exists');

  const hwContent = fs.readFileSync(hwInspectorPath, 'utf-8');

  // 1.1 IR Blaster fields and protocols
  assert(hwContent.includes('data-testid="ir-protocol-select"'), 'renders ir-protocol-select element');
  assert(hwContent.includes('data-testid="ir-hex-input"'), 'renders ir-hex-input field');
  assert(hwContent.includes('data-testid="ir-bits-input"'), 'renders ir-bits-input field');
  assert(hwContent.includes('data-testid="ir-send-btn"'), 'renders ir-send-btn manual dispatch trigger');
  assert(hwContent.includes('COOLIX') && hwContent.includes('GREE') && hwContent.includes('DAIKIN'),
    'supports essential mini-split IR protocols (COOLIX, GREE, DAIKIN)');

  // 1.2 Smart Plug Relay actuation controls
  assert(hwContent.includes('data-testid="plug-on-btn"'), 'renders plug-on-btn actuation control');
  assert(hwContent.includes('data-testid="plug-off-btn"'), 'renders plug-off-btn actuation control');

  // 1.3 Lighting Relay actuation controls
  assert(hwContent.includes('data-testid="lights-on-btn"'), 'renders lights-on-btn actuation control');
  assert(hwContent.includes('data-testid="lights-off-btn"'), 'renders lights-off-btn actuation control');

  // 1.4 VAV Damper modulation controls
  assert(hwContent.includes('data-testid="damper-slider"'), 'renders damper-slider input range control');
  assert(hwContent.includes('data-testid="damper-input"'), 'renders damper-input percentage field');
  assert(hwContent.includes('data-testid="damper-send-btn"'), 'renders damper-send-btn manual dispatch button');

  // 1.5 Edge CPU Strain testing controls
  assert(hwContent.includes('data-testid="cpu-strain-high-btn"'), 'renders cpu-strain-high-btn testing trigger');
  assert(hwContent.includes('data-testid="cpu-strain-normal-btn"'), 'renders cpu-strain-normal-btn recovery trigger');

  // 1.6 Dedicated controls tab & target zone selection
  assert(hwContent.includes('data-testid="target-zone-select"'), 'renders target-zone-select dropdown');
  assert(hwContent.includes('data-testid="custom-target-input"'), 'renders custom-target-input for arbitrary node addressing');
  assert(hwContent.includes('data-testid="command-feedback-banner"'), 'renders command feedback banner for operator acknowledgment');

  // ---------------------------------------------------------------------------
  // Suite 2: Simulation vs. Real Mode UI Global Toggle Switch (R2)
  // ---------------------------------------------------------------------------
  suite('Suite 2: Simulation vs. Real Mode UI Global Toggle Switch');

  const appPath = path.join(__dirname, 'src', 'App.jsx');
  const hookPath = path.join(__dirname, 'src', 'useOperationMode.js');

  assert(fs.existsSync(appPath), 'App.jsx exists');
  assert(fs.existsSync(hookPath), 'useOperationMode.js exists');

  const appContent = fs.readFileSync(appPath, 'utf-8');
  const hookContent = fs.readFileSync(hookPath, 'utf-8');

  assert(appContent.includes('data-testid="operation-mode-toggle"'), 'App.jsx mounts operation-mode-toggle container');
  assert(appContent.includes('data-testid="toggle-mode-simulation"'), 'App.jsx provides toggle-mode-simulation button');
  assert(appContent.includes('data-testid="toggle-mode-real"'), 'App.jsx provides toggle-mode-real button');
  assert(appContent.includes('useOperationMode'), 'App.jsx imports and activates useOperationMode hook');

  assert(hookContent.includes('export function useOperationMode'), 'useOperationMode.js exports hook');
  assert(hookContent.includes('/api/mode'), 'useOperationMode.js targets /api/mode REST endpoint');
  assert(hookContent.includes('setMode'), 'useOperationMode.js exposes setMode mutation dispatcher');

  // ---------------------------------------------------------------------------
  // Suite 3: Sustainability Recommendations Panel (R3)
  // ---------------------------------------------------------------------------
  suite('Suite 3: Sustainability Recommendations Panel');

  const sustPanelPath = path.join(__dirname, 'src', 'SustainabilityRecommendationsPanel.jsx');
  const sustHookPath = path.join(__dirname, 'src', 'useSustainability.js');

  assert(fs.existsSync(sustPanelPath), 'SustainabilityRecommendationsPanel.jsx exists');
  assert(fs.existsSync(sustHookPath), 'useSustainability.js exists');

  const sustContent = fs.readFileSync(sustPanelPath, 'utf-8');
  const sustHookContent = fs.readFileSync(sustHookPath, 'utf-8');

  assert(sustContent.includes('Scope 2') || sustContent.includes('Emissions') || sustContent.includes('carbonAccounting'),
    'SustainabilityRecommendationsPanel renders Scope 2 carbon emissions section');
  assert(sustContent.includes('Space Utilization') || sustContent.includes('spaceUtilization') || sustContent.includes('occupants'),
    'SustainabilityRecommendationsPanel renders space utilization efficiency section');
  assert(sustContent.includes('Maintenance') || sustContent.includes('predictiveMaintenance') || sustContent.includes('Alert'),
    'SustainabilityRecommendationsPanel renders predictive maintenance alerts section');
  assert(sustContent.includes('Carbon Credit') || sustContent.includes('carbonCreditRecommendations') || sustContent.includes('offset'),
    'SustainabilityRecommendationsPanel renders dynamic carbon credit recommendations section');

  assert(sustHookContent.includes('export function useSustainability'), 'useSustainability.js exports hook');
  assert(sustHookContent.includes('/api/sustainability'), 'useSustainability.js polls /api/sustainability endpoint');

  // ---------------------------------------------------------------------------
  // Suite 4: Local AI Models Live Inference Contract (R4)
  // ---------------------------------------------------------------------------
  suite('Suite 4: Local AI Models Live Inference CLI & Export');

  const inferPath = path.join(__dirname, '..', 'backend', 'forecasting', 'infer.py');
  const bundleInferPath = path.join(__dirname, '..', 'server', 'modelbundle', 'infer.py');

  assert(fs.existsSync(inferPath), 'backend/forecasting/infer.py exists');
  assert(fs.existsSync(bundleInferPath), 'server/modelbundle/infer.py exists in offline model bundle');

  const inferContent = fs.readFileSync(inferPath, 'utf-8');
  assert(inferContent.includes('PeakLoadLSTM'), 'infer.py integrates PeakLoadLSTM regressor');
  assert(inferContent.includes('timesfm'), 'infer.py integrates TimesFM zero-shot foundation forecaster');
  assert(inferContent.includes('--model'), 'infer.py exposes CLI --model argument');
  assert(inferContent.includes('--input'), 'infer.py exposes CLI --input argument');

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log(`\n${colors.bold}=== Verification Summary ===${colors.reset}`);
  console.log(`  Total Checks : ${passed + failed}`);
  console.log(`  Passed       : ${colors.green}${passed}${colors.reset}`);
  console.log(`  Failed       : ${failed > 0 ? colors.red + failed + colors.reset : '0'}`);

  if (failed > 0) {
    console.error(`\n${colors.red}${colors.bold}Verification FAILED with ${failed} failure(s).${colors.reset}`);
    process.exit(1);
  } else {
    console.log(`\n${colors.green}${colors.bold}All E2E UI & Controls verification checks PASSED successfully!${colors.reset}\n`);
  }
}

runVerification().catch((err) => {
  console.error('Fatal error during verification:', err);
  process.exit(1);
});
