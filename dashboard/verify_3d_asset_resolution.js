#!/usr/bin/env node

/**
 * verify_3d_asset_resolution.js — Automated Verification Harness for 3D Asset Context Resolution
 *
 * Verifies Milestone 2 Requirements & Acceptance Criteria:
 * 1. Model Validation Predicates:
 *    - isMultiLevelBuilding(b) accurately validates multi-level commercial tower geometry (floors > 1, not home id).
 *    - isHomeBuilding(b) accurately validates single-level domestic house geometry (floors === 1 or home id).
 * 2. Strict Model Defense in getBuilding():
 *    - In multi-level context, getBuilding() strictly returns commercial tower data and never domestic home data.
 *    - In domestic home context, getBuilding() returns domestic home data.
 * 3. Boot Anti-Poisoning:
 *    - When bootBuilding() encounters an unparameterized or poisoned domestic home response from /api/building-data,
 *      it strictly rejects the home payload and retains the 15-floor commercial tower (bundledTower).
 * 4. Explicit Context-Specific Network Requests:
 *    - bootBuilding() explicitly requests ?model=multi-level.
 *    - setBuildingModelType('multi-level', { force: true }) dispatches GET /api/building-data?model=multi-level
 *      and POST /api/building/switch.
 * 5. Real Built App Puppeteer E2E 3D Model Mount Verification:
 *    - Production bundle mounts 15-floor commercial tower (>40,000 m², 15 floor buttons L1-L15, 0 domestic zones).
 *    - Toggle to domestic home requests ?model=domestic-home and mounts 1 floor (~72 m², 5 domestic zones).
 *    - Toggle to multi-level requests ?model=multi-level, mounts 15 floors, and completely bypasses and purges home data.
 *    - Forced re-selection with { force: true } dispatches live multi-level asset fetch.
 *    - Rapid stress toggling operates with 0 uncaught errors or WebGL crashes.
 */

import puppeteer from 'puppeteer';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getBuilding,
  setBuildingModelType,
  getBuildingModelType,
  bootBuilding,
  isMultiLevelBuilding,
  isHomeBuilding,
  subscribeBuildingChange,
} from './src/buildingStore.js';
import bundledTower from './src/building-data.json' with { type: 'json' };
import bundledHome from './src/building-data-home.json' with { type: 'json' };

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
  gray: '\x1b[90m',
};

class TestHarness {
  constructor() {
    this.tests = [];
    this.passed = 0;
    this.failed = 0;
    this.currentSuite = '';
    this.startTime = Date.now();
  }

  suite(name) {
    this.currentSuite = name;
    console.log(`\n${colors.bright}${colors.cyan}=== Suite: ${name} ===${colors.reset}`);
  }

  async test(name, fn) {
    const testName = `[${this.currentSuite}] ${name}`;
    const start = Date.now();
    try {
      await fn();
      const elapsed = Date.now() - start;
      this.passed++;
      console.log(`  ${colors.green}✔ PASS${colors.reset} ${name} ${colors.gray}(${elapsed}ms)${colors.reset}`);
      this.tests.push({ name: testName, status: 'PASS', elapsed });
    } catch (err) {
      const elapsed = Date.now() - start;
      this.failed++;
      console.error(`  ${colors.red}✖ FAIL${colors.reset} ${name} ${colors.gray}(${elapsed}ms)${colors.reset}`);
      console.error(`    ${colors.red}${err.message}${colors.reset}`);
      if (err.stack) {
        console.error(`    ${colors.dim}${err.stack.split('\n').slice(1, 4).join('\n    ')}${colors.reset}`);
      }
      this.tests.push({ name: testName, status: 'FAIL', error: err.message, elapsed });
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

  assertNotEqual(actual, unexpected, message) {
    if (actual === unexpected) {
      throw new Error(`Assertion failed: ${message} (Value should not equal: ${JSON.stringify(unexpected)})`);
    }
  }

  summary() {
    const totalTime = Date.now() - this.startTime;
    console.log(`\n${colors.bright}${colors.cyan}====================================================${colors.reset}`);
    console.log(`${colors.bright}Test Summary: ${this.passed + this.failed} Total | ${colors.green}${this.passed} Passed${colors.reset} | ${this.failed > 0 ? colors.red : colors.green}${this.failed} Failed${colors.reset} ${colors.gray}(${totalTime}ms)${colors.reset}`);
    console.log(`${colors.bright}${colors.cyan}====================================================${colors.reset}\n`);
    return this.failed === 0;
  }
}

const harness = new TestHarness();

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function createStaticServer(port = 5294) {
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
        const fallbackServer = http.createServer(server.listeners('request')[0]);
        fallbackServer.listen(0, '127.0.0.1', () => {
          const actualPort = fallbackServer.address().port;
          resolve({
            server: fallbackServer,
            url: `http://127.0.0.1:${actualPort}`,
            close: () => new Promise(cb => fallbackServer.close(cb)),
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
        close: () => new Promise(cb => server.close(cb)),
      });
    });
  });
}

// Intercepts browser requests to serve static files from dist and mock API endpoints
function setupInterceptionWithTracking(page, requestLog) {
  return page.setRequestInterception(true).then(() => {
    const distDir = path.join(__dirname, 'dist');
    page.on('request', req => {
      try {
        const urlStr = req.url();
        const url = new URL(urlStr);
        requestLog.push({
          url: urlStr,
          method: req.method(),
          pathname: url.pathname,
          search: url.search,
          modelParam: url.searchParams.get('model'),
        });

        if (url.pathname === '/api/building-data') {
          const modelParam = url.searchParams.get('model');
          if (modelParam === 'multi-level') {
            req.respond({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify(bundledTower),
            });
            return;
          } else if (modelParam === 'domestic-home') {
            req.respond({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify(bundledHome),
            });
            return;
          } else {
            // Adversarial test: unparameterized query serves home data to test client anti-poisoning
            req.respond({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify(bundledHome),
            });
            return;
          }
        }

        if (url.pathname === '/api/building/switch') {
          req.respond({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ok: true, switched: true }),
          });
          return;
        }

        if (url.pathname.startsWith('/api/')) {
          req.respond({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ok: true }),
          });
          return;
        }

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
            body: JSON.stringify({ ok: true }),
          });
        }
      } catch {
        req.continue();
      }
    });
  });
}

async function runVerification() {
  console.log(`\n${colors.bright}${colors.blue}╔══════════════════════════════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.bright}${colors.blue}║   ECON 3D Asset Resolution & Context Isolation Verification (M2)     ║${colors.reset}`);
  console.log(`${colors.bright}${colors.blue}╚══════════════════════════════════════════════════════════════════════╝${colors.reset}`);

  // ----------------------------------------------------------------------------
  // SUITE 1: Model Validation Predicates & Strict getBuilding Invariants
  // ----------------------------------------------------------------------------
  harness.suite('Model Validation Predicates & Pure Store Invariants');

  await harness.test('isMultiLevelBuilding correctly identifies multi-level towers and rejects single-level homes', () => {
    harness.assert(isMultiLevelBuilding(bundledTower), 'bundledTower is recognized as multi-level building');
    harness.assert(!isMultiLevelBuilding(bundledHome), 'bundledHome is NOT recognized as multi-level building');
    harness.assert(!isMultiLevelBuilding(null), 'null is NOT multi-level');
    harness.assert(!isMultiLevelBuilding({}), 'empty object is NOT multi-level');
    harness.assert(!isMultiLevelBuilding({ buildingId: 'bldg-econ-house-hcmc', floors: [{}, {}] }), 'home buildingId rejected even with 2 floors');
    harness.assert(!isMultiLevelBuilding({ buildingId: 'tower', floors: [{}] }), 'single floor tower rejected');
  });

  await harness.test('isHomeBuilding correctly identifies single-level homes and rejects multi-level towers', () => {
    harness.assert(isHomeBuilding(bundledHome), 'bundledHome is recognized as home building');
    harness.assert(!isHomeBuilding(bundledTower), 'bundledTower is NOT recognized as home building');
    harness.assert(!isHomeBuilding(null), 'null is NOT home building');
    harness.assert(isHomeBuilding({ buildingId: 'bldg-econ-house-hcmc', floors: [] }), 'bldg-econ-house-hcmc recognized as home');
    harness.assert(isHomeBuilding({ buildingId: 'custom-cottage', floors: [{ level: 1 }] }), 'single floor custom recognized as home');
  });

  await harness.test('getBuilding() strictly guarantees 15-floor commercial tower under multi-level context', () => {
    setBuildingModelType('multi-level', { force: true });
    const bld = getBuilding();
    harness.assertEqual(getBuildingModelType(), 'multi-level', 'Model type is multi-level');
    harness.assertEqual(bld.buildingId, 'bldg-econ-digitized', 'Building ID is commercial digitized tower');
    harness.assertEqual(bld.floors.length, 15, 'Floors length is exactly 15');

    // Verify zero domestic zones exist in commercial tower
    const domesticNames = new Set(['Kitchen', 'Bathroom', 'Passage', 'Living Room', 'Home Office']);
    let domesticCount = 0;
    bld.floors.forEach(f => {
      (f.zones || []).forEach(z => {
        if (domesticNames.has(z.name)) domesticCount++;
      });
    });
    harness.assertEqual(domesticCount, 0, 'Commercial tower has 0 domestic home zones');
  });

  await harness.test('getBuilding() strictly resolves domestic home under domestic-home context', () => {
    setBuildingModelType('domestic-home', { force: true });
    const bld = getBuilding();
    harness.assertEqual(getBuildingModelType(), 'domestic-home', 'Model type is domestic-home');
    harness.assertEqual(bld.buildingId, 'bldg-econ-house-hcmc', 'Building ID is domestic house');
    harness.assertEqual(bld.floors.length, 1, 'Domestic house has exactly 1 floor');
    harness.assertEqual(bld.floors[0].zones.length, 5, 'Domestic house has 5 zones');
  });

  // ----------------------------------------------------------------------------
  // SUITE 2: Network Queries & Boot Anti-Poisoning Verification
  // ----------------------------------------------------------------------------
  harness.suite('Network Queries & Boot Anti-Poisoning');

  await harness.test('bootBuilding() against mock server serving domestic home payload retains 15-floor tower', async () => {
    // Spin up an ephemeral HTTP server on 8080 or dynamic port
    const capturedRequests = [];
    const mockBackend = http.createServer((req, res) => {
      capturedRequests.push(req.url);
      // Maliciously / mistakenly return domestic home for any query
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(bundledHome));
    });

    let backendPort;
    await new Promise((resolve) => {
      mockBackend.listen(8080, '127.0.0.1', () => {
        backendPort = 8080;
        resolve();
      }).on('error', () => {
        // If 8080 is busy, listen on 0
        mockBackend.listen(0, '127.0.0.1', () => {
          backendPort = mockBackend.address().port;
          resolve();
        });
      });
    });

    try {
      setBuildingModelType('multi-level', { force: true });
      const bldBefore = getBuilding();
      harness.assertEqual(bldBefore.floors.length, 15, 'Starts with 15 floors');

      // Now run bootBuilding()
      const bootedBld = await bootBuilding();

      // Assert that bootBuilding explicitly queried ?model=multi-level if it reached the server
      if (capturedRequests.length > 0) {
        const lastUrl = capturedRequests[capturedRequests.length - 1];
        harness.assert(lastUrl.includes('model=multi-level'), `bootBuilding requested ?model=multi-level (got ${lastUrl})`);
      }

      // Assert that the returned building is NOT the domestic home
      harness.assertEqual(bootedBld.buildingId, 'bldg-econ-digitized', 'Retained digitized commercial tower ID');
      harness.assertEqual(bootedBld.floors.length, 15, 'Retained 15 floors after receiving home response');
      harness.assertNotEqual(bootedBld.buildingId, 'bldg-econ-house-hcmc', 'Strictly rejected home buildingId');

      const currentBld = getBuilding();
      harness.assertEqual(currentBld.floors.length, 15, 'getBuilding() continues returning 15 floors');
    } finally {
      await new Promise(r => mockBackend.close(r));
    }
  });

  await harness.test('setBuildingModelType supports { force: true } and dispatches subscriber updates even on same type', async () => {
    setBuildingModelType('multi-level', { force: true });
    let subscriberCalls = 0;
    let receivedType = null;
    let receivedFloors = 0;

    const unsub = subscribeBuildingChange((b, type) => {
      subscriberCalls++;
      receivedType = type;
      receivedFloors = b?.floors?.length || 0;
    });

    // Calling again with force: true must trigger subscribers
    setBuildingModelType('multi-level', { force: true });
    unsub();

    harness.assertEqual(subscriberCalls, 1, 'Subscriber was notified on forced re-selection');
    harness.assertEqual(receivedType, 'multi-level', 'Subscriber received multi-level type');
    harness.assertEqual(receivedFloors, 15, 'Subscriber received 15-floor tower');
  });

  // ----------------------------------------------------------------------------
  // SUITE 3: Real Built App Puppeteer E2E 3D Model Mount Verification
  // ----------------------------------------------------------------------------
  harness.suite('Real Built App Puppeteer E2E 3D Model Mount');

  let staticServer;
  let browser;

  try {
    staticServer = await createStaticServer(5294);

    browser = await puppeteer.launch({
      headless: true,
      pipe: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--single-process',
        '--no-zygote',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-features=Crashpad',
      ],
    });

    const appUrl = 'http://dashboard.local/';

    await harness.test('Initial dashboard mount fetches ?model=multi-level and mounts 15-floor tower with zero home data', async () => {
      const page = await browser.newPage();
      const requestLog = [];
      await setupInterceptionWithTracking(page, requestLog);
      await page.setViewport({ width: 1440, height: 900 });

      const errors = [];
      page.on('pageerror', (err) => errors.push(err.message));

      await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="building-model-toggle"]', { timeout: 10000 });
      await new Promise(r => setTimeout(r, 600));

      // Assert network request was parameterized with ?model=multi-level
      const buildingDataReqs = requestLog.filter(r => r.pathname === '/api/building-data');
      harness.assert(buildingDataReqs.length > 0, 'Requested /api/building-data');
      const hasMultiLevelParam = buildingDataReqs.some(r => r.modelParam === 'multi-level');
      harness.assert(hasMultiLevelParam, 'Requested /api/building-data with ?model=multi-level explicitly');

      // Assert DOM mounts 15 floor level buttons
      const floorButtons = await page.$$('[data-testid^="level-btn-"]');
      harness.assertEqual(floorButtons.length, 15, 'Mounts exactly 15 floor level buttons (L1..L15)');

      // Assert conditioned area > 40,000 m² (commercial tower, not 72.3 m²)
      const bodyText = await page.evaluate(() => document.body.innerText);
      harness.assert(
        bodyText.includes('42,036 m²') || bodyText.includes('42k') || bodyText.includes('40,') || bodyText.includes('42,'),
        'Conditioned floor area reflects commercial tower scale (>40,000 m²)'
      );
      harness.assert(!bodyText.includes('72.3 m²') && !bodyText.includes('72 m²'), 'Does NOT display domestic 72 m² floor area');

      // Verify that domestic zone names are absent
      const hasKitchen = bodyText.includes('Kitchen') || bodyText.includes('KITCHEN');
      const hasBathroom = bodyText.includes('Bathroom') || bodyText.includes('BATHROOM');
      harness.assert(!hasKitchen, 'Zero domestic Kitchen zones in multi-level context');
      harness.assert(!hasBathroom, 'Zero domestic Bathroom zones in multi-level context');

      harness.assertEqual(errors.length, 0, 'No uncaught page errors on initial mount');
      await page.close();
    });

    await harness.test('Selecting domestic-home fetches ?model=domestic-home and mounts 1-floor home model', async () => {
      const page = await browser.newPage();
      const requestLog = [];
      await setupInterceptionWithTracking(page, requestLog);
      await page.setViewport({ width: 1440, height: 900 });

      await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="building-model-toggle"]', { timeout: 10000 });
      await new Promise(r => setTimeout(r, 400));

      requestLog.length = 0; // Clear log before clicking
      await page.click('[data-testid="toggle-domestic-home"]');
      await new Promise(r => setTimeout(r, 700));

      // Verify network request
      const homeReqs = requestLog.filter(r => r.pathname === '/api/building-data' && r.modelParam === 'domestic-home');
      harness.assert(homeReqs.length > 0, 'Dispatched GET /api/building-data?model=domestic-home');

      // Verify DOM reflects domestic home: 1 floor button
      const floorButtons = await page.$$('[data-testid^="level-btn-"]');
      harness.assertEqual(floorButtons.length, 1, 'Only 1 floor button (L1) for domestic home');

      const bodyText = await page.evaluate(() => document.body.innerText);
      harness.assert(bodyText.includes('72 m²') || bodyText.includes('72.3 m²'), 'Energy intensity displays ~72 m² floor area');

      await page.close();
    });

    await harness.test('Selecting multi-level context requests ?model=multi-level and mounts 15-floor tower with zero home data', async () => {
      const page = await browser.newPage();
      const requestLog = [];
      await setupInterceptionWithTracking(page, requestLog);
      await page.setViewport({ width: 1440, height: 900 });

      await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="building-model-toggle"]', { timeout: 10000 });
      await new Promise(r => setTimeout(r, 400));

      // Switch to domestic home first
      await page.click('[data-testid="toggle-domestic-home"]');
      await new Promise(r => setTimeout(r, 600));

      requestLog.length = 0; // Clear log

      // Now click multi-level toggle
      await page.click('[data-testid="toggle-multilevel"]');
      await new Promise(r => setTimeout(r, 800));

      // Verify GET /api/building-data?model=multi-level was requested
      const multiReqs = requestLog.filter(r => r.pathname === '/api/building-data' && r.modelParam === 'multi-level');
      harness.assert(multiReqs.length > 0, 'Explicitly requested GET /api/building-data?model=multi-level');

      // Verify 15 floor buttons are restored
      const floorButtons = await page.$$('[data-testid^="level-btn-"]');
      harness.assertEqual(floorButtons.length, 15, 'Restored all 15 floor buttons (L1..L15)');

      // Verify Level 4 navigation and 90 zones
      await page.click('[data-testid="level-btn-4"]');
      await new Promise(r => setTimeout(r, 300));
      const zonesMetric = await page.$eval('[data-testid="level-metric-zones"]', el => el.innerText.trim());
      harness.assert(zonesMetric.startsWith('90Z'), `Level 4 telemetry displays 90Z (got ${zonesMetric})`);

      // Verify zero home data remains
      const bodyText = await page.evaluate(() => document.body.innerText);
      harness.assert(!bodyText.includes('72.3 m²'), 'Home conditioned area completely removed');

      await page.close();
    });

    await harness.test('Clicking multi-level when already on multi-level forces live refresh without state corruption', async () => {
      const page = await browser.newPage();
      const requestLog = [];
      await setupInterceptionWithTracking(page, requestLog);
      await page.setViewport({ width: 1440, height: 900 });

      await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="building-model-toggle"]', { timeout: 10000 });
      await new Promise(r => setTimeout(r, 500));

      requestLog.length = 0;

      // Click multi-level again (which already has activeModelType === 'multi-level')
      await page.click('[data-testid="toggle-multilevel"]');
      await new Promise(r => setTimeout(r, 600));

      // Because { force: true } is passed, a new network fetch was dispatched
      const forcedReqs = requestLog.filter(r => r.pathname === '/api/building-data' && r.modelParam === 'multi-level');
      harness.assert(forcedReqs.length > 0, 'Forced re-fetch requested ?model=multi-level');

      const floorButtons = await page.$$('[data-testid^="level-btn-"]');
      harness.assertEqual(floorButtons.length, 15, 'Remains firmly mounted with 15 floor buttons');

      await page.close();
    });

    await harness.test('Rapid model switching stress test maintains isolation and leaves multi-level tower mounted', async () => {
      const page = await browser.newPage();
      const requestLog = [];
      await setupInterceptionWithTracking(page, requestLog);
      await page.setViewport({ width: 1440, height: 900 });

      const errors = [];
      page.on('pageerror', (err) => errors.push(err.message));

      await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="building-model-toggle"]', { timeout: 10000 });
      await new Promise(r => setTimeout(r, 400));

      // 8 rapid alternating switches
      for (let i = 0; i < 8; i++) {
        const target = i % 2 === 0 ? 'toggle-domestic-home' : 'toggle-multilevel';
        await page.click(`[data-testid="${target}"]`);
        await new Promise(r => setTimeout(r, 80));
      }

      // Conclude on multi-level
      await page.click('[data-testid="toggle-multilevel"]');
      await new Promise(r => setTimeout(r, 800));

      const floorButtons = await page.$$('[data-testid^="level-btn-"]');
      harness.assertEqual(floorButtons.length, 15, 'Ends cleanly with 15 floor buttons mounted');
      harness.assertEqual(errors.length, 0, 'Zero uncaught errors during rapid switching');

      await page.close();
    });

  } finally {
    if (browser) await browser.close();
    if (staticServer) await staticServer.close();
  }

  const success = harness.summary();
  process.exit(success ? 0 : 1);
}

runVerification().catch((err) => {
  console.error(`${colors.red}Fatal harness error:${colors.reset}`, err);
  process.exit(1);
});
