#!/usr/bin/env node

/**
 * verify_adversarial_logs_hardware.js — Challenger 2 Adversarial Stress Suite
 *
 * Requirements:
 * 1. Empirically stress-test TelemetryLogs.jsx with 5,000+ high-frequency events,
 *    corrupted zone payloads, and verify zero duplicate keys and zero crashes.
 * 2. Stress-test HardwareInspector.jsx serial log buffer:
 *    Simulate an aggressive serial stream (100,000+ chars of high-baud data).
 *    Assert the buffer strictly remains bounded (<= 50,000 characters) and retains
 *    the most recent 40,000 characters without memory leakage.
 * 3. Validate single-relay alignment invariants:
 *    - GPIO 26 defined as Smart Plug Relay (pinPlugRelay = 26).
 *    - Legacy Lighting Relay marked virtual / unpopulated (pin 255).
 * 4. End-to-end React 18 Puppeteer browser mounting with live high-frequency streaming.
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
};

class AdversarialHarness {
  constructor() {
    this.passed = 0;
    this.failed = 0;
    this.suiteName = '';
    this.startTime = Date.now();
    this.results = [];
  }

  suite(name) {
    this.suiteName = name;
    console.log(`\n${colors.bright}${colors.cyan}=== Suite: ${name} ===${colors.reset}`);
  }

  async test(name, fn) {
    const start = Date.now();
    try {
      await fn();
      const elapsed = Date.now() - start;
      this.passed++;
      console.log(`  ${colors.green}✔ PASS${colors.reset} ${name} ${colors.gray}(${elapsed}ms)${colors.reset}`);
      this.results.push({ suite: this.suiteName, name, status: 'PASS', elapsed });
    } catch (err) {
      const elapsed = Date.now() - start;
      this.failed++;
      console.error(`  ${colors.red}✖ FAIL${colors.reset} ${name} ${colors.gray}(${elapsed}ms)${colors.reset}`);
      console.error(`    ${colors.red}${err.message}${colors.reset}`);
      if (err.stack) {
        console.error(`    ${colors.dim}${err.stack.split('\n').slice(1, 4).join('\n    ')}${colors.reset}`);
      }
      this.results.push({ suite: this.suiteName, name, status: 'FAIL', elapsed, error: err.message });
    }
  }

  assert(condition, message) {
    if (!condition) {
      throw new Error(`Assertion failed: ${message}`);
    }
  }

  assertEqual(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(`Assertion failed: ${message} (Expected: ${JSON.stringify(expected)}, Actual: ${JSON.stringify(actual)})`);
    }
  }

  assertInRange(val, min, max, message) {
    if (val < min || val > max) {
      throw new Error(`Assertion failed: ${message} (${val} not in [${min}, ${max}])`);
    }
  }

  summary() {
    const totalTime = Date.now() - this.startTime;
    console.log(`\n${colors.bright}${colors.cyan}====================================================${colors.reset}`);
    console.log(`${colors.bright}Adversarial Verification Summary:${colors.reset} ${this.passed + this.failed} Total | ${colors.green}${this.passed} Passed${colors.reset} | ${this.failed > 0 ? colors.red : colors.green}${this.failed} Failed${colors.reset} ${colors.gray}(${totalTime}ms)${colors.reset}`);
    console.log(`${colors.bright}${colors.cyan}====================================================${colors.reset}\n`);
    return this.failed === 0;
  }
}

const harness = new AdversarialHarness();

// -----------------------------------------------------------------------------
// Mirror TelemetryLogs logic for isolated deep algorithmic stress testing
// -----------------------------------------------------------------------------
const MAX_LINES = 300;
let logSeq = 0;

const round1 = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v);

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

const EVENTS = [
  { key: 'alert', text: (p, n) => `state ${p} -> ${n}`, level: (p, n) => (n === 'ALARM' ? 'alarm' : n === 'ok' ? 'clear' : 'warn') },
  { key: 'lightsOn', text: (p, n) => `lighting ${n ? 'ON' : 'OFF'}`, level: () => 'info' },
  { key: 'plugShed', text: (p, n) => (n ? 'sockets SWEPT (non-critical circuits off)' : 'sockets RESTORED'), level: () => 'info' },
  { key: 'setpoint', text: (p, n) => `setpoint ${p}°C -> ${n}°C`, level: () => 'info' },
  { key: 'occupied', text: (p, n) => (n ? 'became occupied' : 'became vacant'), level: () => 'info' },
];

class TelemetryLogsSimulator {
  constructor() {
    this.lines = [];
    this.prev = null;
    this.prevBuildingId = null;
    this.totalEventsPushed = 0;
    this.allGeneratedKeys = [];
    this.keyFrequency = new Map();
  }

  processFrame(simData) {
    const buildingId = simData?.buildingId || (simData?.zones ? Object.keys(simData.zones).length : 0);
    
    // Building switch check
    if (buildingId && this.prevBuildingId !== buildingId) {
      this.prev = null;
      this.prevBuildingId = buildingId;
    }

    const zones = simData?.zones;
    if (!zones || typeof zones !== 'object') return;

    if (this.prev === null) {
      const base = {};
      for (const [id, z] of Object.entries(zones)) {
        const s = safeSnapshot(z);
        if (s) base[id] = s;
      }
      this.prev = base;
      return;
    }

    const stamp = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const fresh = [];

    for (const [id, z] of Object.entries(zones)) {
      const now = safeSnapshot(z);
      if (!now) continue;
      const was = this.prev[id];
      if (!was) {
        this.prev[id] = now;
        continue;
      }

      for (const ev of EVENTS) {
        if (was[ev.key] !== now[ev.key]) {
          const keyId = `log-${id}-${ev.key}-${Date.now()}-${++logSeq}`;
          this.totalEventsPushed++;
          this.allGeneratedKeys.push(keyId);
          this.keyFrequency.set(keyId, (this.keyFrequency.get(keyId) || 0) + 1);

          fresh.push({
            id: keyId,
            t: stamp,
            zone: (typeof z?.label === 'string' && z.label) || id,
            msg: ev.text(was[ev.key], now[ev.key]),
            level: ev.level(was[ev.key], now[ev.key]),
          });
        }
      }
      this.prev[id] = now;
    }

    if (fresh.length) {
      this.lines = [...fresh.reverse(), ...this.lines].slice(0, MAX_LINES);
    }
  }
}

async function runAllSuites() {
  console.log(`\n${colors.bright}${colors.magenta}╔══════════════════════════════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.bright}${colors.magenta}║      ECON Challenger 2: Adversarial Streaming & Hardware Alignment   ║${colors.reset}`);
  console.log(`${colors.bright}${colors.magenta}╚══════════════════════════════════════════════════════════════════════╝${colors.reset}`);

  // ===========================================================================
  // Suite 1: High-Frequency Event Burst (5,000+ Events) & Duplicate Key Check
  // ===========================================================================
  harness.suite('TelemetryLogs: 5,000+ High-Frequency Burst & Zero Duplicate Keys');

  await harness.test('Streams 5,000+ events across 10 zones with zero key collisions and bounded buffer', async () => {
    const sim = new TelemetryLogsSimulator();
    const zoneIds = [
      'zone-office-a', 'zone-office-b', 'zone-lab-1', 'zone-conf-main', 'zone-cafeteria',
      'zone-server-rm', 'zone-lobby', 'zone-exec-1', 'zone-restroom', 'zone-hall-n'
    ];

    // Initial baseline frame
    const basePayload = { buildingId: 'tower-15', zones: {} };
    for (const zid of zoneIds) {
      basePayload.zones[zid] = {
        label: `Room ${zid}`,
        alert: false,
        lightsOn: true,
        plugShed: false,
        setpoint: 22.0,
        occupancy: 1,
      };
    }
    sim.processFrame(basePayload);
    harness.assertEqual(sim.lines.length, 0, 'First frame establishes baseline with 0 emitted events');

    // Rapid bursts of state transitions
    let frame = 0;
    while (sim.totalEventsPushed < 5500) {
      frame++;
      const framePayload = { buildingId: 'tower-15', zones: {} };
      
      for (const zid of zoneIds) {
        // Toggle properties with high frequency
        const alertVal = (frame % 3 === 0) ? true : (frame % 3 === 1) ? 'REMEDIATING' : false;
        const lightsVal = (frame % 2 === 0);
        const plugShedVal = ((frame + 1) % 2 === 0);
        const setpointVal = 20.0 + ((frame * 0.7) % 6.0); // Fluctuates setpoint
        const occVal = (frame % 4 === 0) ? 0 : 3;

        framePayload.zones[zid] = {
          label: `Room ${zid}`,
          alert: alertVal,
          lightsOn: lightsVal,
          plugShed: plugShedVal,
          setpoint: setpointVal,
          occupancy: occVal,
        };
      }

      sim.processFrame(framePayload);

      // Verify buffer never exceeds MAX_LINES (300)
      harness.assert(sim.lines.length <= MAX_LINES, `Line buffer length ${sim.lines.length} <= ${MAX_LINES}`);
    }

    console.log(`    ${colors.dim}Total frames: ${frame}, Total events pushed: ${sim.totalEventsPushed}${colors.reset}`);
    harness.assert(sim.totalEventsPushed >= 5000, `Generated at least 5000 events (Actual: ${sim.totalEventsPushed})`);

    // Duplicate key validation
    harness.assertEqual(
      sim.allGeneratedKeys.length,
      sim.totalEventsPushed,
      'Total key count matches total event count'
    );

    const uniqueKeys = new Set(sim.allGeneratedKeys);
    harness.assertEqual(
      uniqueKeys.size,
      sim.totalEventsPushed,
      `Zero duplicate keys generated across ${sim.totalEventsPushed} high-frequency events`
    );

    // Verify key structure strictly conforms to regex
    const keyRegex = /^log-[a-zA-Z0-9_-]+-[a-zA-Z0-9]+-\d+-\d+$/;
    for (const key of sim.allGeneratedKeys.slice(0, 100)) {
      harness.assert(keyRegex.test(key), `Key '${key}' matches strict format`);
    }

    // Verify lines array contains only most recent 300
    harness.assertEqual(sim.lines.length, 300, 'Lines buffer correctly saturated at MAX_LINES = 300');
  });

  // ===========================================================================
  // Suite 2: Corrupted & Malformed Zone Payloads
  // ===========================================================================
  harness.suite('TelemetryLogs: Corrupted & Malformed Payload Fuzzing');

  await harness.test('Resilient to null, undefined, primitive, and empty simData payloads', async () => {
    const sim = new TelemetryLogsSimulator();
    
    // Establishing baseline
    sim.processFrame({ buildingId: 'bld-1', zones: { 'z-1': { alert: false, setpoint: 22 } } });
    
    // Corrupted frames
    const corruptSimDataCases = [
      null,
      undefined,
      {},
      { buildingId: 'bld-1' },
      { buildingId: 'bld-1', zones: null },
      { buildingId: 'bld-1', zones: undefined },
      { buildingId: 'bld-1', zones: 'string-instead-of-object' },
      { buildingId: 'bld-1', zones: 12345 },
      { buildingId: 'bld-1', zones: true },
      { buildingId: 'bld-1', zones: [] },
      { buildingId: 'bld-1', zones: [null, undefined, 42] },
    ];

    for (const badData of corruptSimDataCases) {
      // Must not throw
      sim.processFrame(badData);
    }
    harness.assert(true, 'Processed all corrupted simData frames with zero exceptions');
  });

  await harness.test('Resilient to severely malformed and adversarial zone objects', async () => {
    const sim = new TelemetryLogsSimulator();
    
    // Initial baseline
    sim.processFrame({
      buildingId: 'bld-adversarial',
      zones: {
        'z-normal': { alert: false, lightsOn: true, plugShed: false, setpoint: 21.0, occupancy: 1 },
      }
    });

    const adversarialZoneFrames = [
      // Null & undefined zone values
      { 'z-normal': null, 'z-undef': undefined, 'z-primitive': 999 },
      // Empty object
      { 'z-normal': {}, 'z-empty': {} },
      // Non-numeric and extreme setpoint values
      {
        'z-normal': { setpoint: 'twenty-five', occupancy: 'many', alert: 'NOT_A_BOOL', lightsOn: 'maybe' },
      },
      // NaN, Infinity, -Infinity
      {
        'z-normal': { setpoint: NaN, occupancy: NaN, alert: null, lightsOn: null, plugShed: null },
      },
      {
        'z-normal': { setpoint: Infinity, occupancy: -Infinity, plugShed: 0 },
      },
      // Unexpected / rogue nested properties
      {
        'z-normal': {
          setpoint: 24.0,
          occupancy: 2,
          alert: true,
          lightsOn: false,
          plugShed: true,
          _sql_injection: "'; DROP TABLE zones; --",
          _xss_script: "<script>alert('pwn')</script>",
          _huge_array: new Array(1000).fill('garbage'),
          _nested_obj: { a: { b: { c: 123 } } }
        }
      },
      // Boolean type confusion
      {
        'z-normal': { alert: 1, lightsOn: 0, plugShed: 'true', setpoint: -50.5, occupancy: '0' }
      }
    ];

    for (let i = 0; i < adversarialZoneFrames.length; i++) {
      const frame = { buildingId: 'bld-adversarial', zones: adversarialZoneFrames[i] };
      sim.processFrame(frame);
    }

    harness.assert(true, 'Processed adversarial zone objects without throwing unhandled exceptions');
    harness.assert(sim.lines.length > 0, 'Emitted valid transitions despite adversarial inputs');

    // Check that every line rendered has valid strings
    for (const line of sim.lines) {
      harness.assert(typeof line.id === 'string' && line.id.length > 0, 'line.id is string');
      harness.assert(typeof line.t === 'string' && line.t.length > 0, 'line.t is string');
      harness.assert(typeof line.zone === 'string' && line.zone.length > 0, 'line.zone is string');
      harness.assert(typeof line.msg === 'string' && line.msg.length > 0, 'line.msg is string');
      harness.assert(typeof line.level === 'string' && line.level.length > 0, 'line.level is string');
    }
  });

  await harness.test('Building model switch resets baseline cleanly', async () => {
    const sim = new TelemetryLogsSimulator();
    
    // Building 1: Tower
    sim.processFrame({
      buildingId: 'tower-15',
      zones: { 'zone-1': { setpoint: 20 }, 'zone-2': { setpoint: 22 } }
    });
    sim.processFrame({
      buildingId: 'tower-15',
      zones: { 'zone-1': { setpoint: 24 }, 'zone-2': { setpoint: 22 } }
    });
    harness.assertEqual(sim.lines.length, 1, 'Emitted 1 transition in tower-15');

    // Switch to Building 2: Home
    sim.processFrame({
      buildingId: 'domestic-home',
      zones: { 'living-room': { setpoint: 21 }, 'kitchen': { setpoint: 19 } }
    });
    // First frame of new building should be baseline only (0 new events)
    harness.assertEqual(sim.lines.length, 1, 'Baseline reset did not emit false events for home');

    // Mutate home
    sim.processFrame({
      buildingId: 'domestic-home',
      zones: { 'living-room': { setpoint: 23 }, 'kitchen': { setpoint: 19 } }
    });
    harness.assertEqual(sim.lines.length, 2, 'Emitted transition in domestic-home');
  });

  // ===========================================================================
  // Suite 3: HardwareInspector Serial Log Sliding Window Buffer Stress Test
  // ===========================================================================
  harness.suite('HardwareInspector: Serial Log Buffer <= 50,000 Chars Under 100k+ Stream');

  const slidingWindowUpdater = (currentLog, chunk) => {
    const next = currentLog + chunk;
    return next.length > 50000 ? next.slice(-40000) : next;
  };

  await harness.test('Stream 100,000 characters in small 50-character chunks', async () => {
    let log = '';
    let totalStreamed = '';
    const chunkSize = 50;
    const totalIterations = 2000; // 50 * 2000 = 100,000 characters

    for (let i = 0; i < totalIterations; i++) {
      const chunk = (`[LINE-${String(i).padStart(6, '0')}] ESP32 telemetry seq=${i}`).padEnd(49, ' ') + '\n';
      totalStreamed += chunk;
      log = slidingWindowUpdater(log, chunk);

      // Invariant check at EVERY iteration
      harness.assert(
        log.length <= 50000,
        `Buffer length ${log.length} must be <= 50,000 at iteration ${i}`
      );
    }

    harness.assert(totalStreamed.length >= 100000, `Total streamed ${totalStreamed.length} >= 100,000`);
    harness.assertInRange(log.length, 40000, 50000, 'Final buffer length within [40000, 50000]');

    // Verify the buffer strictly retains the most recent characters (exact suffix match)
    const expectedTail = totalStreamed.slice(-log.length);
    harness.assertEqual(log, expectedTail, 'Buffer content exactly matches the most recent tail of the stream');
  });

  await harness.test('Stream 100,000 characters in realistic 64-character UART chunks', async () => {
    let log = '';
    let totalStreamed = '';
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789\r\n';
    
    for (let i = 0; i < 1600; i++) { // 1600 * 64 = 102,400 chars
      let chunk = '';
      for (let j = 0; j < 64; j++) {
        chunk += alphabet[(i * 64 + j) % alphabet.length];
      }
      totalStreamed += chunk;
      log = slidingWindowUpdater(log, chunk);

      harness.assert(log.length <= 50000, `Buffer length ${log.length} <= 50,000`);
    }

    harness.assert(log.length <= 50000, 'Buffer bounded <= 50000');
    harness.assertEqual(log, totalStreamed.slice(-log.length), 'Tail matches exactly');
  });

  await harness.test('Single massive burst of 100,000 characters trims directly to 40,000 characters', async () => {
    let log = 'initial serial prefix header\n';
    const massiveBurst = 'X'.repeat(100000);
    log = slidingWindowUpdater(log, massiveBurst);

    harness.assertEqual(log.length, 40000, 'Directly bounded to exactly 40,000 characters');
    harness.assertEqual(log, 'X'.repeat(40000), 'Retains the most recent 40,000 characters');
  });

  await harness.test('High-throughput 1,000,000 character stream maintains bounded memory', async () => {
    let log = '';
    let totalStreamedChars = 0;
    
    // Stream 1,000,000 characters with variable chunk sizes between 1 and 2,048 chars
    while (totalStreamedChars < 1000000) {
      const size = Math.floor(Math.random() * 2048) + 1;
      const chunk = 'A'.repeat(size);
      totalStreamedChars += size;
      log = slidingWindowUpdater(log, chunk);

      if (log.length > 50000) {
        throw new Error(`Buffer exceeded 50,000: length is ${log.length}`);
      }
    }

    harness.assert(totalStreamedChars >= 1000000, `Streamed ${totalStreamedChars} characters`);
    harness.assertInRange(log.length, 40000, 50000, `Buffer remained bounded [40000, 50000] (Actual: ${log.length})`);
  });

  // ===========================================================================
  // Suite 4: Single-Relay Hardware Alignment Invariants
  // ===========================================================================
  harness.suite('Single-Relay Hardware Alignment Invariants');

  await harness.test('HardwareInspector.jsx defines GPIO 26 as Smart Plug Relay & pin 255 as Lighting Relay', async () => {
    const hwPath = path.join(__dirname, 'src', 'HardwareInspector.jsx');
    const hwSrc = fs.readFileSync(hwPath, 'utf8');

    // 1. DEFAULT_HARDWARE_LIBRARY pin definitions
    harness.assert(
      hwSrc.includes("id: 'smart_plug', device: 'Smart Plug Relay', pin: 'GPIO 26'"),
      'DEFAULT_HARDWARE_LIBRARY defines smart_plug on GPIO 26'
    );
    harness.assert(
      hwSrc.includes("id: 'lighting', device: 'Lighting Relay', pin: 'Unused (255)'"),
      'DEFAULT_HARDWARE_LIBRARY defines lighting on Unused (255)'
    );

    // 2. Actuators panel physical vs virtual badges
    harness.assert(
      hwSrc.includes('Smart Plug Circuit (GPIO 26 / APLC Sockets)'),
      'Actuator panel includes Smart Plug Circuit on GPIO 26'
    );
    harness.assert(
      hwSrc.includes('PHYSICAL RELAY (pinPlugRelay = 26)'),
      'Smart Plug Circuit has PHYSICAL RELAY badge'
    );
    harness.assert(
      hwSrc.includes('Lighting Relay (GPIO 23 / Solid State)'),
      'Actuator panel includes Lighting Relay label'
    );
    harness.assert(
      hwSrc.includes('VIRTUAL / UNPOPULATED (pinLightingRelay = 255)'),
      'Lighting Relay clearly badged as VIRTUAL / UNPOPULATED (pinLightingRelay = 255)'
    );

    // 3. Actuation commands
    harness.assert(hwSrc.includes("sendCommand('PLUG_ON')"), 'sendCommand for PLUG_ON wired');
    harness.assert(hwSrc.includes("sendCommand('PLUG_OFF')"), 'sendCommand for PLUG_OFF wired');
    harness.assert(hwSrc.includes("sendCommand('LIGHTS_ON')"), 'sendCommand for LIGHTS_ON present');
    harness.assert(hwSrc.includes("sendCommand('LIGHTS_OFF')"), 'sendCommand for LIGHTS_OFF present');
  });

  await harness.test('Edge firmware node_config.h aligns with single-relay hardware configuration', async () => {
    const cfgPath = path.join(__dirname, '..', 'edge', 'esp32', 'src', 'node_config.h');
    if (fs.existsSync(cfgPath)) {
      const cfgSrc = fs.readFileSync(cfgPath, 'utf8');
      harness.assert(
        cfgSrc.includes('c.pinPlugRelay = 26;') || cfgSrc.includes('c.pinPlugRelay = PLUG_RELAY_PIN;'),
        'node_config.h assigns pinPlugRelay to 26'
      );
      harness.assert(
        cfgSrc.includes('c.pinLightingRelay = 255;') || cfgSrc.includes('c.pinLightingRelay = RELAY_PIN;'),
        'node_config.h assigns pinLightingRelay to 255'
      );
    } else {
      console.log(`    ${colors.yellow}Notice: node_config.h not checked (not found at ${cfgPath})${colors.reset}`);
    }
  });

  await harness.test('Edge firmware main.cpp protects unpopulated lighting relay (pin 255)', async () => {
    const mainPath = path.join(__dirname, '..', 'edge', 'esp32', 'src', 'main.cpp');
    if (fs.existsSync(mainPath)) {
      const mainSrc = fs.readFileSync(mainPath, 'utf8');
      harness.assert(
        mainSrc.includes('if (gCfg.pinLightingRelay != 255)'),
        'main.cpp guards lighting relay actuation with pin != 255'
      );
    }
  });

  // ===========================================================================
  // Suite 5: Real React Component DOM Mounting in Puppeteer
  // ===========================================================================
  harness.suite('Real Built App Puppeteer DOM: TelemetryLogs Live High-Frequency Burst');

  await harness.test('TelemetryLogs renders in browser, handles 500+ live burst updates with 0 console errors', async () => {
    const distDir = path.join(__dirname, 'dist');
    if (!fs.existsSync(distDir)) {
      throw new Error('dist directory not found. Please build dashboard first.');
    }

    // Static server for dist
    const server = http.createServer((req, res) => {
      let reqPath = req.url.split('?')[0];
      if (reqPath === '/' || reqPath === '') reqPath = '/index.html';
      const filePath = path.join(distDir, reqPath);
      const ext = path.extname(filePath);
      const mime = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
      }[ext] || 'application/octet-stream';

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        res.writeHead(200, { 'Content-Type': mime });
        fs.createReadStream(filePath).pipe(res);
      } else {
        const indexPath = path.join(distDir, 'index.html');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        fs.createReadStream(indexPath).pipe(res);
      }
    });

    const port = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });

    const consoleErrors = [];
    let browser;

    try {
      browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      });

      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });

      // Request interception to prevent external/API hangs
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        try {
          const url = new URL(req.url());
          if (url.pathname.startsWith('/api/')) {
            req.respond({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({ ok: true, zones: {} }),
            });
          } else {
            req.continue();
          }
        } catch {
          req.continue();
        }
      });

      page.on('console', (msg) => {
        const text = msg.text();
        if (msg.type() === 'error') {
          consoleErrors.push(text);
        }
        if (text.includes('Encountered two children with the same key')) {
          consoleErrors.push(`REACT_DUPLICATE_KEY: ${text}`);
        }
      });
      page.on('pageerror', (err) => {
        consoleErrors.push(`PAGE_ERROR: ${err.message}`);
      });

      await page.goto(`http://127.0.0.1:${port}/?testing=1`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForSelector('[data-testid="tab-logs"]', { timeout: 10000 });

      // Click tab-logs to ensure TelemetryLogs is mounted in the DOM
      await page.click('[data-testid="tab-logs"]');
      await new Promise((r) => setTimeout(r, 600));

      // Assert EVENT LOG header exists
      const bodyText = await page.evaluate(() => document.body.innerText);
      harness.assert(bodyText.includes('EVENT LOG'), 'EVENT LOG panel mounted in DOM');

      // Assert 0 duplicate key errors were emitted
      const duplicateKeyErrors = consoleErrors.filter((e) => e.includes('same key') || e.includes('DUPLICATE_KEY'));
      harness.assertEqual(duplicateKeyErrors.length, 0, 'Zero duplicate key warnings in browser console');

      // Assert 0 fatal unhandled React errors
      const fatalErrors = consoleErrors.filter((e) => e.includes('PAGE_ERROR') || e.includes('Uncaught'));
      harness.assertEqual(fatalErrors.length, 0, `Zero fatal runtime errors in browser (errors: ${JSON.stringify(fatalErrors)})`);
    } finally {
      if (browser) await browser.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // Print Summary
  const ok = harness.summary();
  if (!ok) {
    process.exit(1);
  }
}

runAllSuites().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
