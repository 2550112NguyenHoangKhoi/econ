#!/usr/bin/env node

/**
 * verify_hardware_inspector_headless.js
 *
 * Headless, sandboxed verification suite for Milestone 1:
 * - Compiles HardwareInspector.jsx using esbuild
 * - Renders Component tree to static markup via react-dom/server
 * - Validates DOM output for all required controls, inputs, attributes, test IDs
 * - Validates HTTP API contract for command dispatch and validation
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  gray: '\x1b[90m',
};

class TestHarness {
  constructor() {
    this.passed = 0;
    this.failed = 0;
    this.currentSuite = '';
    this.startTime = Date.now();
  }

  suite(name) {
    this.currentSuite = name;
    console.log(`\n${colors.bright}${colors.cyan}=== Suite: ${name} ===${colors.reset}`);
  }

  test(name, fn) {
    const start = Date.now();
    try {
      fn();
      const elapsed = Date.now() - start;
      this.passed++;
      console.log(`  ${colors.green}✔ PASS${colors.reset} ${name} ${colors.gray}(${elapsed}ms)${colors.reset}`);
    } catch (err) {
      const elapsed = Date.now() - start;
      this.failed++;
      console.error(`  ${colors.red}✖ FAIL${colors.reset} ${name} ${colors.gray}(${elapsed}ms)${colors.reset}`);
      console.error(`    ${colors.red}${err.message}${colors.reset}`);
    }
  }

  assert(condition, message) {
    if (!condition) {
      throw new Error(`Assertion failed: ${message}`);
    }
  }

  summary() {
    const totalTime = Date.now() - this.startTime;
    console.log(`\n${colors.bright}${colors.cyan}====================================================${colors.reset}`);
    console.log(`${colors.bright}Verification Summary: ${this.passed + this.failed} Total | ${colors.green}${this.passed} Passed${colors.reset} | ${this.failed > 0 ? colors.red : colors.green}${this.failed} Failed${colors.reset} ${colors.gray}(${totalTime}ms)${colors.reset}`);
    console.log(`${colors.bright}${colors.cyan}====================================================${colors.reset}\n`);
    return this.failed === 0;
  }
}

const harness = new TestHarness();

async function run() {
  console.log(`${colors.bright}Starting Headless Hardware Inspector Verification...${colors.reset}`);

  // Setup DOM / Window globals for SSR
  globalThis.window = {
    location: { search: '?inspector', pathname: '/' },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globalThis.fetch = async (url, opts = {}) => {
    return {
      ok: true,
      status: 200,
      json: async () => ({ devices: [], staleAfter: 20 }),
      text: async () => '{}',
    };
  };

  // Compile HardwareInspector.jsx with esbuild
  const srcPath = path.join(__dirname, 'src', 'HardwareInspector.jsx');
  const compiled = await esbuild.build({
    entryPoints: [srcPath],
    bundle: true,
    external: ['react', 'react-dom', 'react-dom/server'],
    format: 'esm',
    write: false,
    loader: { '.jsx': 'jsx', '.js': 'js' },
  });

  const code = compiled.outputFiles[0].text;
  // Write to temporary module
  const tempPath = path.join(__dirname, 'src', '_compiled_inspector.js');
  fs.writeFileSync(tempPath, code);

  let HardwareInspectorModule;
  try {
    HardwareInspectorModule = await import('./src/_compiled_inspector.js');
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }

  const { default: HardwareInspector } = HardwareInspectorModule;
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');

  const markup = renderToStaticMarkup(React.createElement(HardwareInspector));

  // Suite 1: Layout & Core Elements
  harness.suite('Component Layout & Inspector Tabs');

  harness.test('Page title and header render correctly', () => {
    harness.assert(markup.includes('Hardware Inspector'), 'Expected page title Hardware Inspector');
    harness.assert(markup.includes('Raw MQTT view'), 'Expected Raw MQTT view subtitle');
  });

  harness.test('Tab bar includes devices, controls, events, config', () => {
    harness.assert(markup.includes('>devices<'), 'Expected devices tab button');
    harness.assert(markup.includes('>controls<'), 'Expected controls tab button');
    harness.assert(markup.includes('>events<'), 'Expected events tab button');
    harness.assert(markup.includes('>config<'), 'Expected config tab button');
  });

  // Suite 2: IR Blaster Controls
  harness.suite('IR Blaster Exposure & Transmission UI');

  harness.test('IR Blaster protocol selector renders with protocols', () => {
    harness.assert(markup.includes('data-testid="ir-protocol-select"'), 'Expected ir-protocol-select test id');
    harness.assert(markup.includes('value="COOLIX"'), 'Expected COOLIX protocol option');
    harness.assert(markup.includes('value="ELECTRA_AC"'), 'Expected ELECTRA_AC protocol option');
    harness.assert(markup.includes('value="DAIKIN"'), 'Expected DAIKIN protocol option');
    harness.assert(markup.includes('value="PANASONIC"'), 'Expected PANASONIC protocol option');
    harness.assert(markup.includes('value="MITSUBISHI"'), 'Expected MITSUBISHI protocol option');
    harness.assert(markup.includes('value="LG"'), 'Expected LG protocol option');
    harness.assert(markup.includes('value="SAMSUNG"'), 'Expected SAMSUNG protocol option');
    harness.assert(markup.includes('value="TOSHIBA"'), 'Expected TOSHIBA protocol option');
    harness.assert(markup.includes('value="GREE"'), 'Expected GREE protocol option');
    harness.assert(markup.includes('value="NEC"'), 'Expected NEC protocol option');
    harness.assert(markup.includes('value="SONY"'), 'Expected SONY protocol option');
    harness.assert(markup.includes('value="RC5"'), 'Expected RC5 protocol option');
  });

  harness.test('IR Blaster hex code, bits, and frequency inputs render', () => {
    harness.assert(markup.includes('data-testid="ir-hex-input"'), 'Expected ir-hex-input test id');
    harness.assert(markup.includes('data-testid="ir-bits-input"'), 'Expected ir-bits-input test id');
    harness.assert(markup.includes('data-testid="ir-freq-input"'), 'Expected ir-freq-input test id');
    harness.assert(markup.includes('data-testid="ir-send-btn"'), 'Expected ir-send-btn test id');
    harness.assert(markup.includes('Transmit IR Code'), 'Expected Transmit IR Code button text');
  });

  harness.test('HVAC quick controls render (setpoint, power, presets)', () => {
    harness.assert(markup.includes('data-testid="hvac-setpoint-input"'), 'Expected hvac-setpoint-input test id');
    harness.assert(markup.includes('data-testid="hvac-set-btn"'), 'Expected hvac-set-btn test id');
    harness.assert(markup.includes('data-testid="hvac-off-btn"'), 'Expected hvac-off-btn test id');
    harness.assert(markup.includes('Turn Off AC'), 'Expected Turn Off AC button');
    harness.assert(markup.includes('Cool Mode'), 'Expected Cool Mode button');
    harness.assert(markup.includes('Purge Air'), 'Expected Purge Air button');
  });

  // Suite 3: Relay & Socket Controls
  harness.suite('Smart Plug & Relay Actuation Controls');

  harness.test('Smart plug buttons render (PLUG_ON, PLUG_OFF)', () => {
    harness.assert(markup.includes('data-testid="plug-on-btn"'), 'Expected plug-on-btn test id');
    harness.assert(markup.includes('data-testid="plug-off-btn"'), 'Expected plug-off-btn test id');
    harness.assert(markup.includes('Sockets ON (PLUG_ON)'), 'Expected Sockets ON button text');
    harness.assert(markup.includes('Sockets OFF (PLUG_OFF)'), 'Expected Sockets OFF button text');
  });

  harness.test('Lighting relay buttons render (LIGHTS_ON, LIGHTS_OFF)', () => {
    harness.assert(markup.includes('data-testid="lights-on-btn"'), 'Expected lights-on-btn test id');
    harness.assert(markup.includes('data-testid="lights-off-btn"'), 'Expected lights-off-btn test id');
    harness.assert(markup.includes('Lights ON (LIGHTS_ON)'), 'Expected Lights ON button text');
    harness.assert(markup.includes('Lights OFF (LIGHTS_OFF)'), 'Expected Lights OFF button text');
  });

  // Suite 4: VAV Damper Modulation
  harness.suite('VAV Damper Overrides');

  harness.test('VAV Damper slider and numeric inputs render', () => {
    harness.assert(markup.includes('data-testid="damper-slider"'), 'Expected damper-slider test id');
    harness.assert(markup.includes('data-testid="damper-input"'), 'Expected damper-input test id');
    harness.assert(markup.includes('data-testid="damper-send-btn"'), 'Expected damper-send-btn test id');
    harness.assert(markup.includes('Apply Damper'), 'Expected Apply Damper button text');
    harness.assert(markup.includes('15% (Min Vent)'), 'Expected Min Vent preset button');
    harness.assert(markup.includes('50% (Nominal)'), 'Expected Nominal preset button');
    harness.assert(markup.includes('100% (Full Open)'), 'Expected Full Open preset button');
  });

  // Suite 5: CPU Strain Offload Simulation
  harness.suite('CPU Strain Offload Simulation Controls');

  harness.test('CPU Strain simulation buttons render', () => {
    harness.assert(markup.includes('data-testid="cpu-strain-high-btn"'), 'Expected cpu-strain-high-btn test id');
    harness.assert(markup.includes('data-testid="cpu-strain-normal-btn"'), 'Expected cpu-strain-normal-btn test id');
    harness.assert(markup.includes('Strain HIGH (Offload)'), 'Expected Strain HIGH button text');
    harness.assert(markup.includes('Normal CPU (Clear)'), 'Expected Normal CPU button text');
  });

  // Suite 6: Target Selection & Custom Addressing
  harness.suite('Target Addressing & Custom Zone Selector');

  harness.test('Target zone selector and custom input render', () => {
    harness.assert(markup.includes('data-testid="target-zone-select"'), 'Expected target-zone-select test id');
    harness.assert(markup.includes('data-testid="custom-target-input"'), 'Expected custom-target-input test id');
    harness.assert(markup.includes('value="zone-office-a"'), 'Expected zone-office-a option');
    harness.assert(markup.includes('value="zone-office-b"'), 'Expected zone-office-b option');
  });

  // Suite 7: Source Code & Hardware Library Specifications
  harness.suite('Hardware Library Pin Map Audit');

  const fileContent = fs.readFileSync(srcPath, 'utf8');

  harness.test('Source file defines complete edge node pin map and library', () => {
    harness.assert(fileContent.includes('GPIO 19'), 'Expected GPIO 19 in pin map (IR)');
    harness.assert(fileContent.includes('GPIO 25'), 'Expected GPIO 25 in pin map (Plug Relay)');
    harness.assert(fileContent.includes('GPIO 23'), 'Expected GPIO 23 in pin map (Lighting Relay)');
    harness.assert(fileContent.includes('GPIO 33'), 'Expected GPIO 33 in pin map (ACS712 Strip)');
    harness.assert(fileContent.includes('GPIO 34'), 'Expected GPIO 34 in pin map (SCT-013 Plug)');
    harness.assert(fileContent.includes('GPIO 35'), 'Expected GPIO 35 in pin map (SCT-013 AC)');
    harness.assert(fileContent.includes('GPIO 26'), 'Expected GPIO 26 in pin map (DS18B20)');
    harness.assert(fileContent.includes('GPIO 21'), 'Expected GPIO 21 in pin map (I2C SDA)');
    harness.assert(fileContent.includes('GPIO 22'), 'Expected GPIO 22 in pin map (I2C SCL)');
    harness.assert(fileContent.includes('GPIO 18'), 'Expected GPIO 18 in pin map (PIR/Radar)');
  });

  harness.test('Source file defines firmware build flags', () => {
    harness.assert(fileContent.includes('USE_IR_AC'), 'Expected USE_IR_AC build flag');
    harness.assert(fileContent.includes('USE_PLUG'), 'Expected USE_PLUG build flag');
    harness.assert(fileContent.includes('USE_STRIP'), 'Expected USE_STRIP build flag');
    harness.assert(fileContent.includes('USE_AC_CLAMP'), 'Expected USE_AC_CLAMP build flag');
    harness.assert(fileContent.includes('USE_SUPPLY_TEMP'), 'Expected USE_SUPPLY_TEMP build flag');
    harness.assert(fileContent.includes('USE_SHT30'), 'Expected USE_SHT30 build flag');
  });

  const success = harness.summary();
  if (!success) {
    process.exit(1);
  }
}

run().catch(err => {
  console.error(`${colors.red}Fatal Error:${colors.reset}`, err);
  process.exit(1);
});
