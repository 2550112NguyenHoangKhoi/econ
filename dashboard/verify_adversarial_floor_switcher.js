#!/usr/bin/env node

/**
 * verify_adversarial_floor_switcher.js — Adversarial Stress Test & Edge-Case Oracle
 *
 * Authored by: Challenger 1 (EMPIRICAL CHALLENGER)
 * Role: 3D Viewer & Floor Switcher Adversarial Challenger
 *
 * Scope:
 * 1. Mathematical & Invariant Stress Tests for `getActiveFloorAsset`:
 *    - Boundary and out-of-bounds floor levels (-9999, -1, 16, 999, NaN, Infinity, MAX_SAFE_INTEGER).
 *    - Level 0 Falsy Resolution Test (Basement / Ground Floor 0).
 *    - Malformed types (null, undefined, '', 'abc', {}, [], decimals).
 *    - Malformed building objects (null, undefined, empty array, non-array truthy floors).
 *    - 10,000 rapid fuzzing iterations asserting execution throughput and crash resistance.
 * 2. 3D Camera Framing Math Stability (`towerFraming` invariants):
 *    - Aspect ratio extremes (0.01 to 100.0).
 *    - Out-of-bounds and degenerate floor levels.
 *    - Assertion of finite real numbers for 3D camera position, target vector, and framing distance.
 * 3. Puppeteer Real-App E2E Adversarial Stress Testing:
 *    - Rapid floor hopping sequence (1 -> 15 -> 7 -> 2 -> 14 -> 1).
 *    - Stepper boundary clamping stress (10x prev at L1, 15x next past L15).
 *    - Commercial tower (15 floors) <-> Domestic home (1 floor) rapid switching and oscillation.
 *    - DOM synchronization of `data-testid="active-asset"` and `data-testid="active-floor-asset"`.
 *    - Hit-test transparency check (`pointer-events: none`).
 */

import puppeteer from 'puppeteer';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as THREE from 'three';
import {
  getBuilding,
  getAllKnownBuildings,
  getActiveFloorAsset,
  setBuildingModelType,
} from './src/buildingStore.js';

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
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

class ChallengerHarness {
  constructor() {
    this.passed = 0;
    this.failed = 0;
    this.tests = [];
    this.currentSuite = '';
    this.startTime = Date.now();
  }

  suite(name) {
    this.currentSuite = name;
    console.log(`\n${colors.bright}${colors.cyan}=== Suite: ${name} ===${colors.reset}`);
  }

  async test(name, fn) {
    const start = Date.now();
    try {
      await fn();
      const elapsed = Date.now() - start;
      this.passed++;
      console.log(`  ${colors.green}✔ PASS${colors.reset} ${name} ${colors.gray}(${elapsed}ms)${colors.reset}`);
      this.tests.push({ suite: this.currentSuite, name, status: 'PASS', elapsed });
    } catch (err) {
      const elapsed = Date.now() - start;
      this.failed++;
      console.error(`  ${colors.red}✖ FAIL${colors.reset} ${name} ${colors.gray}(${elapsed}ms)${colors.reset}`);
      console.error(`    ${colors.red}${err.message}${colors.reset}`);
      if (err.stack) {
        console.error(`    ${colors.dim}${err.stack.split('\n').slice(1, 4).join('\n    ')}${colors.reset}`);
      }
      this.tests.push({ suite: this.currentSuite, name, status: 'FAIL', error: err.message, elapsed });
    }
  }

  assert(cond, msg) {
    if (!cond) throw new Error(`Assertion failed: ${msg}`);
  }

  assertEqual(actual, expected, msg) {
    if (actual !== expected) {
      throw new Error(`Assertion failed: ${msg} (Expected: ${JSON.stringify(expected)}, Actual: ${JSON.stringify(actual)})`);
    }
  }

  assertNotEqual(actual, unexpected, msg) {
    if (actual === unexpected) {
      throw new Error(`Assertion failed: ${msg} (Value should not equal: ${JSON.stringify(unexpected)})`);
    }
  }

  summary() {
    const total = this.passed + this.failed;
    const duration = Date.now() - this.startTime;
    console.log(`\n${colors.bright}${colors.cyan}================================================================${colors.reset}`);
    console.log(
      `${colors.bright}CHALLENGER RESULTS: ${total} Total | ${colors.green}${this.passed} Passed${colors.reset} | ${
        this.failed > 0 ? colors.red : colors.green
      }${this.failed} Failed${colors.reset} ${colors.gray}(${duration}ms)${colors.reset}`
    );
    console.log(`${colors.bright}${colors.cyan}================================================================${colors.reset}\n`);
    return this.failed === 0;
  }
}

const harness = new ChallengerHarness();

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function createStaticServer(port = 5399) {
  const distDir = path.join(__dirname, 'dist');
  const server = http.createServer((req, res) => {
    let reqPath = req.url.split('?')[0];
    if (reqPath === '/') reqPath = '/index.html';
    const filePath = path.join(distDir, reqPath);
    const ext = path.extname(filePath);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    } else {
      const indexPath = path.join(distDir, 'index.html');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      fs.createReadStream(indexPath).pipe(res);
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        const fallback = http.createServer(server.listeners('request')[0]);
        fallback.listen(0, '127.0.0.1', () => {
          const actualPort = fallback.address().port;
          resolve({
            server: fallback,
            url: `http://127.0.0.1:${actualPort}`,
            close: () => new Promise((cb) => fallback.close(cb)),
          });
        });
      } else {
        reject(err);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      resolve({
        server,
        url: `http://127.0.0.1:${actualPort}`,
        close: () => new Promise((cb) => server.close(cb)),
      });
    });
  });
}

function setupRequestInterception(page) {
  return page.setRequestInterception(true).then(() => {
    const distDir = path.join(__dirname, 'dist');
    page.on('request', (req) => {
      try {
        const url = new URL(req.url());
        let pathname = url.pathname;
        if (pathname === '/' || pathname === '') pathname = '/index.html';
        const filePath = path.join(distDir, pathname.replace(/^\//, ''));
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const ext = path.extname(filePath);
          req.respond({
            status: 200,
            contentType: mimeTypes[ext] || 'application/octet-stream',
            body: fs.readFileSync(filePath),
          });
        } else {
          req.respond({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({}),
          });
        }
      } catch {
        req.continue();
      }
    });
  });
}

// Standalone validator for towerFraming mathematical logic
function validateTowerFramingMath(activeFloor, aspect = 1.6, safeArea = null, customBuilding = null) {
  const VIEW_DIR = new THREE.Vector3(1, 0.85, 1).normalize();
  const building = customBuilding || getBuilding();
  const floors = building?.floors || [];
  const dispElev = (f) => f.elevation + (f.level > activeFloor ? 30 : f.level === activeFloor ? 5 : 0);
  let topY = -Infinity;
  let botY = Infinity;
  let activeY = 0;

  floors.forEach((f) => {
    const e = dispElev(f);
    topY = Math.max(topY, e + (f.height || 4));
    botY = Math.min(botY, e);
    if (f.level === activeFloor) activeY = e + (f.height || 4) / 2;
  });

  const span = Math.max(topY - botY, 0.5);
  const R = Math.hypot(60 / 2, span / 2, 40 / 2);
  const vFov = (45 * Math.PI) / 180;
  const vw = safeArea?.viewportW || 0;
  const vh = safeArea?.viewportH || 0;
  const freeW = safeArea ? Math.max(200, vw - safeArea.left - safeArea.right) : 0;
  const freeH = safeArea ? Math.max(200, vh - safeArea.top - safeArea.bottom) : 0;
  const fitAspect = safeArea && freeH > 0 ? freeW / freeH : aspect;

  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(0.3, fitAspect));
  const fitFov = Math.min(vFov, hFov);
  const portrait = aspect < 1;
  const margin = portrait ? 1.2 : safeArea ? 1.15 : 1.45;
  const dist = Math.max((R / Math.sin(fitFov / 2)) * margin, 14);
  const aimBias = portrait ? span * 0.16 : 0;

  const target = new THREE.Vector3(0, (topY + botY) / 2 + aimBias, 0);
  const position = target.clone().add(VIEW_DIR.clone().multiplyScalar(dist));

  return { position, target, span, topY, botY, activeY, dist };
}

async function runAdversarialChallenges() {
  console.log(`\n${colors.bright}${colors.magenta}╔══════════════════════════════════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.bright}${colors.magenta}║  CHALLENGER 1: 3D FLOOR SWITCHER & ACTIVE ASSET EMPIRICAL STRESS HARNESS ║${colors.reset}`);
  console.log(`${colors.bright}${colors.magenta}╚══════════════════════════════════════════════════════════════════════════╝${colors.reset}`);

  // ===========================================================================
  // SECTION 1: Adversarial & Boundary Inputs for getActiveFloorAsset
  // ===========================================================================
  harness.suite('Adversarial Boundary & Degenerate Inputs: getActiveFloorAsset');

  setBuildingModelType('multi-level', { force: true });
  const building = getBuilding();
  const [towerBld, homeBld] = getAllKnownBuildings();

  await harness.test('Out-of-bounds floor levels (-1, 16, 999, -9999, MAX_SAFE_INTEGER)', async () => {
    const outOfBoundsLevels = [-9999, -5, -1, 16, 99, 999, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER];
    for (const lvl of outOfBoundsLevels) {
      const asset = getActiveFloorAsset(building, lvl);
      harness.assert(asset !== null, `Out of bounds level ${lvl} returns non-null fallback`);
      harness.assertEqual(asset.level, 1, `Out of bounds level ${lvl} safely falls back to Level 1`);
      harness.assert(typeof asset.assetId === 'string' && asset.assetId.length > 0, `Valid assetId for level ${lvl}`);
      harness.assertEqual(asset.name, 'Level 1', `Fallback name is Level 1`);
    }
  });

  await harness.test('Non-numeric and malformed primitive floor inputs (null, undefined, NaN, Infinity, strings)', async () => {
    const malformedInputs = [
      null,
      undefined,
      NaN,
      Infinity,
      -Infinity,
      '',
      '   ',
      'floor-9',
      'abc',
      '1.5',
      3.14159,
      true,
      false,
      {},
      [],
      [2],
    ];

    for (const input of malformedInputs) {
      let asset;
      try {
        asset = getActiveFloorAsset(building, input);
      } catch (err) {
        throw new Error(`getActiveFloorAsset threw uncaught exception on input: ${String(input)}: ${err.message}`);
      }
      harness.assert(asset !== null, `Input ${String(input)} returns non-null fallback asset`);
      harness.assert(typeof asset.level === 'number', `Asset level is number for input ${String(input)}`);
      harness.assert(typeof asset.assetId === 'string', `Asset ID is string for input ${String(input)}`);
    }
  });

  await harness.test('Null, undefined, empty object, and empty array building inputs', async () => {
    const safeMalformed = [
      null,
      undefined,
      {},
      { floors: null },
      { floors: undefined },
      { floors: [] },
    ];

    for (const malformed of safeMalformed) {
      let res;
      try {
        res = getActiveFloorAsset(malformed, 1);
      } catch (err) {
        throw new Error(`getActiveFloorAsset threw uncaught exception on malformed building: ${err.message}`);
      }
      harness.assertEqual(res, null, 'Safe malformed building evaluates to null without throwing');
    }
  });

  await harness.test('Degenerate floor structures (missing zones, null zone elements, missing heights/elevations)', async () => {
    const degenerateBuildings = [
      { floors: [{ level: 1 }] },
      { floors: [{ level: 1, name: null, zones: null, elevation: null, height: null }] },
      { floors: [{ level: 2, zones: [] }] },
      { floors: [{ level: 3, zones: [{}] }] },
      { floors: [{ level: 4, zones: [{ bim_asset_id: null }] }] },
      { floors: [{ level: 5, elevation: 'high', height: 'tall' }] },
    ];

    for (const degBld of degenerateBuildings) {
      const lvl = degBld.floors[0].level;
      let asset;
      try {
        asset = getActiveFloorAsset(degBld, lvl);
      } catch (err) {
        throw new Error(`Degenerate floor threw exception: ${err.message}`);
      }
      harness.assert(asset !== null, `Degenerate floor ${lvl} returns valid asset object`);
      harness.assertEqual(asset.level, lvl, `Asset level matches degenerate floor ${lvl}`);
      harness.assert(typeof asset.assetId === 'string', `Asset ID is string for degenerate floor ${lvl}`);
      harness.assert(typeof asset.elevation === 'number', `Asset elevation coerced to number for floor ${lvl}`);
      harness.assert(typeof asset.height === 'number', `Asset height coerced to number for floor ${lvl}`);
    }
  });

  await harness.test('Adversarial Challenge: Non-array truthy floors payload ({ floors: "loading" }) crash audit', async () => {
    // If backend or API response passes a non-array truthy value (e.g. { floors: "loading" }, { floors: {} }, { floors: 123 })
    // getActiveFloorAsset will execute `floors.find(...)` which throws `TypeError: floors.find is not a function`.
    let threw = false;
    let errorMsg = '';
    try {
      getActiveFloorAsset({ floors: 'loading' }, 1);
    } catch (err) {
      threw = true;
      errorMsg = err.message;
    }
    // We document whether this unhandled TypeError occurs
    if (threw) {
      console.log(`    ${colors.yellow}[Vulnerability Detected] getActiveFloorAsset crashes with "${errorMsg}" when floors is non-array truthy${colors.reset}`);
      throw new Error(`VULNERABILITY: getActiveFloorAsset crashes on non-array floors ({ floors: "loading" }): ${errorMsg}`);
    }
  });

  await harness.test('Adversarial Challenge: Level 0 resolution on building with ground floor level 0', async () => {
    // If a building model contains Level 0 (e.g. Basement or Ground Floor 0) and Level 1 (Lobby):
    const bldWithLevel0 = {
      buildingId: 'bldg-with-basement',
      floors: [
        { level: 0, name: 'Basement Level 0', zones: [{ bim_asset_id: 'asset-lvl-0' }] },
        { level: 1, name: 'Lobby Level 1', zones: [{ bim_asset_id: 'asset-lvl-1' }] },
      ],
    };

    const asset = getActiveFloorAsset(bldWithLevel0, 0);
    // targetLevel = Number(activeFloor) || 1 coerces 0 || 1 to 1!
    if (asset?.level !== 0) {
      console.log(`    ${colors.yellow}[Vulnerability Detected] getActiveFloorAsset(bld, 0) returned Level ${asset?.level} instead of Level 0 due to falsy (0 || 1) coercion${colors.reset}`);
      throw new Error(`VULNERABILITY: getActiveFloorAsset fails to resolve Level 0 (returned Level ${asset?.level}) due to "Number(activeFloor) || 1" falsy coercion`);
    }
    harness.assertEqual(asset.level, 0, 'Level 0 correctly resolves to Level 0');
  });

  await harness.test('10,000 rapid randomized fuzzy calls throughput and crash resistance', async () => {
    const fuzzValues = [
      -100, -1, 1, 2, 7, 14, 15, 16, 999, NaN, Infinity, -Infinity,
      null, undefined, '', 'lvl-1', {}, [], true, false, 2.5,
    ];
    const buildings = [towerBld, homeBld, null, {}, { floors: [] }];

    const start = Date.now();
    for (let i = 0; i < 10000; i++) {
      const bld = buildings[i % buildings.length];
      const val = fuzzValues[i % fuzzValues.length];
      const res = getActiveFloorAsset(bld, val);
      if (bld && bld.floors && bld.floors.length > 0) {
        harness.assert(res !== null, `Call ${i}: non-empty building should resolve an asset`);
      } else {
        harness.assertEqual(res, null, `Call ${i}: empty building should resolve null`);
      }
    }
    const duration = Date.now() - start;
    harness.assert(duration < 500, `10,000 fuzzy calls completed in ${duration}ms (< 500ms required)`);
  });

  // ===========================================================================
  // SECTION 2: 3D Camera Framing Math Stability (towerFraming)
  // ===========================================================================
  harness.suite('3D Camera Framing Math Stability: towerFraming Invariants');

  await harness.test('Extreme aspect ratios (0.01 to 100.0) maintain finite 3D coordinates', async () => {
    const extremeAspects = [0.01, 0.2, 0.5, 0.9, 1.0, 1.6, 2.35, 4.0, 10.0, 100.0];
    for (const aspect of extremeAspects) {
      const framing = validateTowerFramingMath(1, aspect, null, towerBld);
      harness.assert(Number.isFinite(framing.position.x), `position.x finite at aspect ${aspect}`);
      harness.assert(Number.isFinite(framing.position.y), `position.y finite at aspect ${aspect}`);
      harness.assert(Number.isFinite(framing.position.z), `position.z finite at aspect ${aspect}`);
      harness.assert(Number.isFinite(framing.target.x), `target.x finite at aspect ${aspect}`);
      harness.assert(Number.isFinite(framing.target.y), `target.y finite at aspect ${aspect}`);
      harness.assert(Number.isFinite(framing.target.z), `target.z finite at aspect ${aspect}`);
      harness.assert(framing.dist >= 14, `Camera distance >= 14 at aspect ${aspect}`);
    }
  });

  await harness.test('Out-of-bounds floor levels maintain valid framing geometry', async () => {
    const testLevels = [-99, -1, 0, 1, 8, 15, 16, 999, NaN, null, undefined];
    for (const lvl of testLevels) {
      const framing = validateTowerFramingMath(lvl, 1.6, null, towerBld);
      harness.assert(Number.isFinite(framing.span) && framing.span > 0, `Valid span for level ${lvl}`);
      harness.assert(Number.isFinite(framing.topY), `Finite topY for level ${lvl}`);
      harness.assert(Number.isFinite(framing.botY), `Finite botY for level ${lvl}`);
      harness.assert(framing.topY >= framing.botY, `topY >= botY for level ${lvl}`);
    }
  });

  // ===========================================================================
  // SECTION 3: Real App Puppeteer E2E Adversarial Stress Testing
  // ===========================================================================
  harness.suite('Real App Puppeteer E2E: Rapid Transitions & DOM Sync');

  let staticServer = null;
  let browser = null;

  try {
    staticServer = await createStaticServer(5399);
    console.log(`  ${colors.dim}Challenger test server running at ${staticServer.url}${colors.reset}`);

    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--use-gl=angle',
        '--use-angle=swiftshader',
      ],
    });

    const page = await browser.newPage();
    await setupRequestInterception(page);
    await page.setViewport({ width: 1440, height: 900 });

    const pageErrors = [];
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
      console.error(`  ${colors.red}[Browser PageError]${colors.reset} ${err.message}`);
    });

    await page.goto(staticServer.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="active-asset"]', { timeout: 15000 });
    await page.waitForSelector('[data-testid="desktop-active-level"]', { timeout: 15000 });

    await harness.test('Challenge 1: Rapid floor hopping sequence (1 -> 15 -> 7 -> 2 -> 14 -> 1)', async () => {
      const hopSequence = [1, 15, 7, 2, 14, 1];

      for (const targetLevel of hopSequence) {
        const btnSelector = `[data-testid="level-btn-${targetLevel}"]`;
        await page.waitForSelector(btnSelector, { timeout: 5000 });
        await page.click(btnSelector);

        await new Promise((r) => setTimeout(r, 80));

        const activeLevelText = await page.$eval('[data-testid="desktop-active-level"]', (el) => el.innerText.trim());
        const activeAssetId = await page.$eval('[data-testid="active-asset"]', (el) => el.getAttribute('data-asset-id'));
        const activeFloorText = await page.$eval('[data-testid="active-floor-asset"]', (el) => el.innerText.trim());

        const expectedAsset = getActiveFloorAsset(towerBld, targetLevel);
        harness.assertEqual(activeLevelText, `L${targetLevel}`, `Desktop level display matches L${targetLevel}`);
        harness.assertEqual(activeAssetId, expectedAsset.assetId, `Active asset ID matches BIM asset ID on floor ${targetLevel}`);
        harness.assert(
          activeFloorText.includes(`Level ${targetLevel}`) || activeFloorText.includes(`L${targetLevel}`),
          `Visible text reflects Level ${targetLevel} (got "${activeFloorText}")`
        );
      }

      harness.assertEqual(pageErrors.length, 0, 'Zero uncaught page errors during rapid floor hopping sequence');
    });

    await harness.test('Challenge 2: Stepper boundary clamping stress (10x prev at L1, 15x next past L15)', async () => {
      // Ensure starting at Level 1
      await page.click('[data-testid="level-btn-1"]');
      await new Promise((r) => setTimeout(r, 100));

      // 10 rapid clicks on level-step-prev (underflow stress)
      for (let i = 0; i < 10; i++) {
        await page.click('[data-testid="level-step-prev"]');
        await new Promise((r) => setTimeout(r, 30));
      }

      let activeLevel = await page.$eval('[data-testid="desktop-active-level"]', (el) => el.innerText.trim());
      let activeAssetId = await page.$eval('[data-testid="active-asset"]', (el) => el.getAttribute('data-asset-id'));
      const lvl1Asset = getActiveFloorAsset(towerBld, 1);
      harness.assertEqual(activeLevel, 'L1', 'Floor stays clamped at L1 after 10 prev clicks');
      harness.assertEqual(activeAssetId, lvl1Asset.assetId, 'Active asset remains Level 1 BIM asset ID');

      // 15 rapid clicks on level-step-next (overflow stress past L15)
      for (let i = 0; i < 15; i++) {
        await page.click('[data-testid="level-step-next"]');
        await new Promise((r) => setTimeout(r, 30));
      }

      activeLevel = await page.$eval('[data-testid="desktop-active-level"]', (el) => el.innerText.trim());
      activeAssetId = await page.$eval('[data-testid="active-asset"]', (el) => el.getAttribute('data-asset-id'));
      const lvl15Asset = getActiveFloorAsset(towerBld, 15);
      harness.assertEqual(activeLevel, 'L15', 'Floor stays clamped at L15 after 15 next clicks');
      harness.assertEqual(activeAssetId, lvl15Asset.assetId, 'Active asset remains Level 15 BIM asset ID');

      harness.assertEqual(pageErrors.length, 0, 'Zero page errors during stepper boundary stress');
    });

    await harness.test('Challenge 3: Commercial Tower (15 floors) <-> Domestic Home (1 floor) model switching', async () => {
      // Start at Level 15 on Tower
      await page.click('[data-testid="level-btn-15"]');
      await new Promise((r) => setTimeout(r, 100));

      // Switch to 1-Level Domestic Home
      await page.waitForSelector('[data-testid="toggle-domestic-home"]', { timeout: 5000 });
      await page.click('[data-testid="toggle-domestic-home"]');
      await new Promise((r) => setTimeout(r, 300));

      // Assert clamped to Level 1
      let homeLevel = await page.$eval('[data-testid="desktop-active-level"]', (el) => el.innerText.trim());
      let homeAssetId = await page.$eval('[data-testid="active-asset"]', (el) => el.getAttribute('data-asset-id'));
      let homeText = await page.$eval('[data-testid="active-floor-asset"]', (el) => el.innerText.trim());

      const expectedHomeAsset = getActiveFloorAsset(homeBld, 1);
      harness.assertEqual(homeLevel, 'L1', 'Domestic home active floor clamped to L1');
      harness.assertEqual(homeAssetId, expectedHomeAsset.assetId, 'Domestic home asset ID matches home BIM asset');
      harness.assert(homeText.includes(expectedHomeAsset.assetId), `DOM text contains home asset ID ${expectedHomeAsset.assetId}`);

      // Attempt 5 step-next clicks on Domestic Home (must NOT advance past L1)
      for (let i = 0; i < 5; i++) {
        await page.click('[data-testid="level-step-next"]');
        await new Promise((r) => setTimeout(r, 30));
      }
      homeLevel = await page.$eval('[data-testid="desktop-active-level"]', (el) => el.innerText.trim());
      harness.assertEqual(homeLevel, 'L1', 'Domestic home stays clamped to L1 after 5 next clicks');

      // Switch back to Multi-Level Building
      await page.waitForSelector('[data-testid="toggle-multilevel"]', { timeout: 5000 });
      await page.click('[data-testid="toggle-multilevel"]');
      await new Promise((r) => setTimeout(r, 300));

      let towerLevel = await page.$eval('[data-testid="desktop-active-level"]', (el) => el.innerText.trim());
      let towerAssetId = await page.$eval('[data-testid="active-asset"]', (el) => el.getAttribute('data-asset-id'));
      harness.assert(towerLevel.startsWith('L'), `Multi-level active floor is valid: ${towerLevel}`);
      const towerLvlNum = Number(towerLevel.replace('L', ''));
      const expTowerAsset = getActiveFloorAsset(towerBld, towerLvlNum);
      harness.assertEqual(towerAssetId, expTowerAsset.assetId, `Active asset ID matches tower BIM asset for ${towerLevel}`);

      // Rapid back-and-forth toggle oscillation (6 iterations)
      for (let i = 0; i < 6; i++) {
        const toggleSelector = i % 2 === 0 ? '[data-testid="toggle-domestic-home"]' : '[data-testid="toggle-multilevel"]';
        await page.click(toggleSelector);
        await new Promise((r) => setTimeout(r, 80));
      }
      await new Promise((r) => setTimeout(r, 200));

      // Check stability after rapid oscillation
      const finalLevel = await page.$eval('[data-testid="desktop-active-level"]', (el) => el.innerText.trim());
      const finalAssetId = await page.$eval('[data-testid="active-asset"]', (el) => el.getAttribute('data-asset-id'));
      harness.assert(typeof finalAssetId === 'string' && finalAssetId.length > 0, `Valid active asset ID after oscillation: ${finalAssetId}`);
      harness.assert(finalLevel.startsWith('L'), `Valid active level display after oscillation: ${finalLevel}`);

      harness.assertEqual(pageErrors.length, 0, 'Zero uncaught page errors during rapid model toggle oscillation');
    });

    await harness.test('Challenge 4: Active asset badge hit-test transparency (pointer-events: none)', async () => {
      await page.click('[data-testid="toggle-multilevel"]');
      await new Promise((r) => setTimeout(r, 200));

      const pointerEvents = await page.$eval('[data-testid="active-asset"]', (el) => window.getComputedStyle(el).pointerEvents);
      harness.assertEqual(pointerEvents, 'none', 'active-asset badge has pointerEvents === "none"');

      // Click on level-step-next right below or near it and verify stepper functions normally
      const initialLevel = await page.$eval('[data-testid="desktop-active-level"]', (el) => el.innerText.trim());
      await page.click('[data-testid="level-step-next"]');
      await new Promise((r) => setTimeout(r, 150));
      const nextLevel = await page.$eval('[data-testid="desktop-active-level"]', (el) => el.innerText.trim());
      harness.assertNotEqual(initialLevel, nextLevel, 'Stepper successfully clicked without hit-test obstruction');
    });

    await harness.test('Challenge 5: DOM synchronization accuracy across key tower floors (L1, L2, L4, L8, L12, L15)', async () => {
      const sampleFloors = [1, 2, 4, 8, 12, 15];
      for (const lvl of sampleFloors) {
        await page.click(`[data-testid="level-btn-${lvl}"]`);
        await new Promise((r) => setTimeout(r, 100));

        const domAssetId = await page.$eval('[data-testid="active-asset"]', (el) => el.getAttribute('data-asset-id'));
        const spanAssetId = await page.$eval('[data-testid="active-floor-asset"]', (el) => el.getAttribute('data-asset-id'));
        const spanText = await page.$eval('[data-testid="active-floor-asset"]', (el) => el.innerText.trim());

        const expected = getActiveFloorAsset(towerBld, lvl);
        harness.assertEqual(domAssetId, expected.assetId, `Floor ${lvl} badge data-asset-id matches expected`);
        harness.assertEqual(spanAssetId, expected.assetId, `Floor ${lvl} span data-asset-id matches expected`);
        harness.assert(spanText.includes(expected.name), `Floor ${lvl} span text contains name "${expected.name}"`);
        harness.assert(spanText.includes(expected.assetId), `Floor ${lvl} span text contains assetId "${expected.assetId}"`);
      }

      harness.assertEqual(pageErrors.length, 0, 'Zero uncaught page errors across key floor DOM verifications');
    });

    await page.close();
  } finally {
    if (browser) await browser.close();
    if (staticServer) await staticServer.close();
  }

  const ok = harness.summary();
  if (!ok) {
    process.exit(1);
  }
}

runAdversarialChallenges().catch((err) => {
  console.error('Fatal error in adversarial test harness:', err);
  process.exit(1);
});
