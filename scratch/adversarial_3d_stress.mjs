/**
 * scratch/adversarial_3d_stress.mjs
 * Adversarial Challenger Stress Harness for 3D Asset Context Resolution & Frontend BIM Model Loading
 */

import { createRequire } from 'module';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(path.join(__dirname, '../dashboard/package.json'));
const puppeteer = require('puppeteer');

import {
  getBuilding,
  setBuildingModelType,
  getBuildingModelType,
  bootBuilding,
  isMultiLevelBuilding,
  isHomeBuilding,
  subscribeBuildingChange,
} from '../dashboard/src/buildingStore.js';
import bundledTower from '../dashboard/src/building-data.json' with { type: 'json' };
import bundledHome from '../dashboard/src/building-data-home.json' with { type: 'json' };

const distDir = path.join(__dirname, '../dashboard/dist');

const results = [];
function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  const icon = pass ? '✔ PASS' : '✖ FAIL';
  console.log(`  ${icon}: ${name} ${detail ? '(' + detail + ')' : ''}`);
  if (!pass) {
    console.error(`    ERROR: ${detail}`);
  }
}

console.log('\n======================================================');
console.log('--- STARTING ADVERSARIAL STRESS TESTING FOR M3 ---');
console.log('======================================================\n');

// --------------------------------------------------------------------------
// TEST SUITE 1: Malicious & Corrupted Payload Resistance
// --------------------------------------------------------------------------
console.log('>>> Suite 1: Adversarial Payload & Poisoning Defense');

// 1.1 Spoofed tower with home buildingId
const spoofed1 = { buildingId: 'bldg-econ-house-hcmc', floors: [ { level: 1 }, { level: 2 }, { level: 3 } ] };
record('Reject spoofed tower with home buildingId', !isMultiLevelBuilding(spoofed1), 'home id with 3 floors rejected');

// 1.2 Commercial tower with only 1 floor
const spoofed2 = { buildingId: 'bldg-econ-digitized', floors: [ { level: 1 } ] };
record('Reject single-floor commercial tower from isMultiLevelBuilding', !isMultiLevelBuilding(spoofed2), 'single floor rejected');

// 1.3 Corrupted types (arrays, primitives, null, undefined)
record('Reject null as multi-level', !isMultiLevelBuilding(null));
record('Reject undefined as multi-level', !isMultiLevelBuilding(undefined));
record('Reject number as multi-level', !isMultiLevelBuilding(42));
record('Reject string as multi-level', !isMultiLevelBuilding("tower"));
record('Reject array as multi-level', !isMultiLevelBuilding([1, 2, 3]));
record('Reject empty object as multi-level', !isMultiLevelBuilding({}));

// 1.4 Test home building validation against adversarial inputs
record('Reject null as home', !isHomeBuilding(null));
record('Reject multi-level tower as home', !isHomeBuilding(bundledTower));
record('Accept valid home', isHomeBuilding(bundledHome));

// --------------------------------------------------------------------------
// TEST SUITE 2: Out-Of-Order Network Race Condition Simulation (In-Memory)
// --------------------------------------------------------------------------
console.log('\n>>> Suite 2: Out-Of-Order Network Race Condition Simulation');

// We test what happens when fetch responses return in inverted order.
// We can mock globalThis.fetch to simulate arbitrary network delay profiles.
const originalFetch = globalThis.fetch;

try {
  // Scenario A: User switches from multi-level -> home -> multi-level rapidly.
  // Home fetch is slow (150ms). Multi-level fetch is fast (20ms).
  // Multi-level resolves first. Then late home fetch arrives.
  let fetchCount = 0;
  globalThis.fetch = async (url, opts) => {
    fetchCount++;
    const urlStr = String(url);
    if (urlStr.includes('model=domestic-home')) {
      await new Promise(r => setTimeout(r, 150));
      return {
        ok: true,
        json: async () => JSON.parse(JSON.stringify(bundledHome)),
      };
    }
    if (urlStr.includes('model=multi-level')) {
      await new Promise(r => setTimeout(r, 20));
      return {
        ok: true,
        json: async () => JSON.parse(JSON.stringify(bundledTower)),
      };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };

  let modelTypeObservedBySubscribers = [];
  const unsub1 = subscribeBuildingChange((b, type) => {
    modelTypeObservedBySubscribers.push({ type, buildingId: b.buildingId, floors: b.floors.length });
  });

  // Rapid sequence: toggle home, then immediately toggle multi-level
  setBuildingModelType('domestic-home', { force: true });
  setBuildingModelType('multi-level', { force: true });

  // Wait 300ms for all pending promises to settle
  await new Promise(r => setTimeout(r, 300));
  unsub1();

  const finalBld = getBuilding();
  const finalType = getBuildingModelType();

  const noHomeLeak = finalType === 'multi-level' && finalBld.buildingId === 'bldg-econ-digitized' && finalBld.floors.length === 15;
  record('Inverted race condition A: Late domestic-home response does not poison active multi-level context', noHomeLeak, `type=${finalType}, floors=${finalBld.floors.length}`);

  // Check last subscriber event
  const lastEvent = modelTypeObservedBySubscribers[modelTypeObservedBySubscribers.length - 1];
  const subscriberConsistent = lastEvent && lastEvent.type === 'multi-level' && lastEvent.floors === 15;
  record('Subscriber state consistent after inverted race condition A', subscriberConsistent, `lastEvent=${JSON.stringify(lastEvent)}`);

  // Scenario B: User switches from home -> multi-level -> home.
  // Multi-level fetch is slow (150ms). Home fetch is fast (20ms).
  globalThis.fetch = async (url, opts) => {
    const urlStr = String(url);
    if (urlStr.includes('model=multi-level')) {
      await new Promise(r => setTimeout(r, 150));
      return {
        ok: true,
        json: async () => JSON.parse(JSON.stringify(bundledTower)),
      };
    }
    if (urlStr.includes('model=domestic-home')) {
      await new Promise(r => setTimeout(r, 20));
      return {
        ok: true,
        json: async () => JSON.parse(JSON.stringify(bundledHome)),
      };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };

  modelTypeObservedBySubscribers = [];
  const unsub2 = subscribeBuildingChange((b, type) => {
    modelTypeObservedBySubscribers.push({ type, buildingId: b.buildingId, floors: b.floors.length });
  });

  setBuildingModelType('multi-level', { force: true });
  setBuildingModelType('domestic-home', { force: true });

  await new Promise(r => setTimeout(r, 300));
  unsub2();

  const finalBldB = getBuilding();
  const finalTypeB = getBuildingModelType();
  const noTowerLeak = finalTypeB === 'domestic-home' && finalBldB.buildingId === 'bldg-econ-house-hcmc' && finalBldB.floors.length === 1;
  record('Inverted race condition B: Late multi-level response does not poison active domestic-home context', noTowerLeak, `type=${finalTypeB}, floors=${finalBldB.floors.length}`);

} finally {
  globalThis.fetch = originalFetch;
}

// --------------------------------------------------------------------------
// TEST SUITE 3: Rapid Hammering & Fuzzing (100 Random Toggles)
// --------------------------------------------------------------------------
console.log('\n>>> Suite 3: High-Frequency Re-entrancy Hammering (100 Toggles)');

const originalFetch2 = globalThis.fetch;
try {
  let simulatedInFlight = 0;
  globalThis.fetch = async (url, opts) => {
    simulatedInFlight++;
    const delay = Math.floor(Math.random() * 30) + 5; // 5ms - 35ms jitter
    await new Promise(r => setTimeout(r, delay));
    simulatedInFlight--;
    const urlStr = String(url);
    if (urlStr.includes('model=domestic-home')) {
      return { ok: true, json: async () => bundledHome };
    }
    if (urlStr.includes('model=multi-level')) {
      return { ok: true, json: async () => bundledTower };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };

  let targetModel = 'multi-level';
  for (let i = 0; i < 100; i++) {
    targetModel = Math.random() > 0.5 ? 'multi-level' : 'domestic-home';
    setBuildingModelType(targetModel, { force: true });
  }

  // Set explicit final target to multi-level
  targetModel = 'multi-level';
  setBuildingModelType(targetModel, { force: true });

  // Wait for all in-flight network promises to settle
  await new Promise(r => setTimeout(r, 400));

  const hammerBld = getBuilding();
  const hammerType = getBuildingModelType();
  const hammerPass = hammerType === 'multi-level' && hammerBld.buildingId === 'bldg-econ-digitized' && hammerBld.floors.length === 15;
  record('100 high-frequency toggles with random network jitter settle cleanly on multi-level tower', hammerPass, `floors=${hammerBld.floors.length}`);

} finally {
  globalThis.fetch = originalFetch2;
}

// --------------------------------------------------------------------------
// TEST SUITE 4: Real Browser (Puppeteer) Adversarial UI & WebGL Verification
// --------------------------------------------------------------------------
console.log('\n>>> Suite 4: Puppeteer Browser Adversarial Stress & Floor Clamping');

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

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

let serverPort;
await new Promise(resolve => {
  server.listen(0, '127.0.0.1', () => {
    serverPort = server.address().port;
    resolve();
  });
});

let browser;
try {
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

  const page = await browser.newPage();
  const pageErrors = [];
  const consoleMsgs = [];
  page.on('pageerror', err => pageErrors.push(err.message));
  page.on('console', msg => {
    consoleMsgs.push({ type: msg.type(), text: msg.text() });
    if (msg.type() === 'warning' || msg.type() === 'error' || msg.text().includes('CanvasErrorBoundary')) {
      console.log('    [BROWSER CONSOLE]', msg.type(), msg.text());
    }
  });

  await page.setRequestInterception(true);
  page.on('request', req => {
    try {
      const url = new URL(req.url());
      if (url.pathname === '/api/building-data') {
        const model = url.searchParams.get('model');
        if (model === 'domestic-home') {
          req.respond({
            status: 200,
            headers: { 'Access-Control-Allow-Origin': '*' },
            contentType: 'application/json',
            body: JSON.stringify(bundledHome),
          });
        } else {
          req.respond({
            status: 200,
            headers: { 'Access-Control-Allow-Origin': '*' },
            contentType: 'application/json',
            body: JSON.stringify(bundledTower),
          });
        }
        return;
      }
      if (url.pathname === '/api/model/recommend') {
        req.respond({
          status: 200,
          headers: { 'Access-Control-Allow-Origin': '*' },
          contentType: 'application/json',
          body: JSON.stringify({
            recommended: 'standard',
            profile: { cores: 8 },
            memoryBasis: 'reported',
            effectiveMemoryGb: 16,
            gpu: { name: 'Apple M4' },
          }),
        });
        return;
      }
      if (url.pathname === '/api/weather') {
        req.respond({
          status: 200,
          headers: { 'Access-Control-Allow-Origin': '*' },
          contentType: 'application/json',
          body: JSON.stringify({ outdoorC: 30.0, humidity: 70, live: true, ageSec: 10, lat: 10.8231, lon: 106.6297 }),
        });
        return;
      }
      if (url.pathname === '/api/precool') {
        req.respond({
          status: 200,
          headers: { 'Access-Control-Allow-Origin': '*' },
          contentType: 'application/json',
          body: JSON.stringify({ active: false, until: null }),
        });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        req.respond({
          status: 200,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
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

  await page.setViewport({ width: 1440, height: 900 });
  await page.goto('http://dashboard.local/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="building-model-toggle"]', { timeout: 10000 });
  await new Promise(r => setTimeout(r, 600));

  // Test 4.1: Navigate to Level 15 in multi-level tower, then switch to domestic home
  await page.click('[data-testid="level-btn-15"]');
  await new Promise(r => setTimeout(r, 200));

  const lvlBeforeSwitch = await page.$eval('[data-testid="selected-level-display"]', el => el.innerText.trim());
  record('Navigate to Level 15 before switch', lvlBeforeSwitch === 'L15', `selectedLevel=${lvlBeforeSwitch}`);

  // Now switch to domestic-home
  await page.click('[data-testid="toggle-domestic-home"]');
  await new Promise(r => setTimeout(r, 600));

  // Active floor MUST be clamped to L1
  const lvlAfterSwitch = await page.$eval('[data-testid="selected-level-display"]', el => el.innerText.trim());
  record('Active level safely clamped to L1 on transition from L15 to domestic-home', lvlAfterSwitch === 'L1', `level=${lvlAfterSwitch}`);

  // Only 1 floor button visible
  const floorButtonsHome = await page.$$('[data-testid^="level-btn-"]');
  record('Domestic home displays exactly 1 floor button', floorButtonsHome.length === 1, `count=${floorButtonsHome.length}`);

  // Test 4.2: Rapid multi-toggle stress with concurrent level clicking
  for (let i = 0; i < 10; i++) {
    const btn = i % 2 === 0 ? '[data-testid="toggle-multilevel"]' : '[data-testid="toggle-domestic-home"]';
    await page.click(btn);
    // Click stepper during transition
    const stepBtn = await page.$('[data-testid="level-step-next"]');
    if (stepBtn) await stepBtn.click().catch(() => {});
    await new Promise(r => setTimeout(r, 60));
  }

  // Conclude on multi-level
  await page.click('[data-testid="toggle-multilevel"]');
  await new Promise(r => setTimeout(r, 800));

  const finalFloorButtons = await page.$$('[data-testid^="level-btn-"]');
  record('Restores all 15 floor buttons after concurrent UI stress', finalFloorButtons.length === 15, `count=${finalFloorButtons.length}`);

  // Check WebGL canvas status / CanvasErrorBoundary graceful recovery
  const canvasInfo = await page.evaluate(() => {
    const wrapper = document.querySelector('.three-d-canvas-wrapper');
    const canvases = Array.from(document.querySelectorAll('canvas')).map(c => ({
      width: c.width,
      height: c.height,
      className: c.className,
    }));
    const hasVisualizerOffline = wrapper ? wrapper.innerText.includes('Visualizer Offline') : false;
    return {
      wrapperExists: wrapper != null,
      wrapperHtml: wrapper ? wrapper.innerHTML.slice(0, 300) : null,
      hasVisualizerOffline,
      canvases,
    };
  });
  console.log('  [DEBUG CANVAS INFO]:', JSON.stringify(canvasInfo));
  const canvasOrGracefulFallback = canvasInfo.canvases.length > 0 || canvasInfo.hasVisualizerOffline;
  record('3D Visualizer container mounted with canvas or graceful CanvasErrorBoundary fallback', canvasOrGracefulFallback, `canvases=${canvasInfo.canvases.length}, offlineFallback=${canvasInfo.hasVisualizerOffline}`);

  // Check page errors
  record('Zero unhandled exceptions or crashes during adversarial test', pageErrors.length === 0, `errors=${pageErrors.length} (${pageErrors.join(', ')})`);

} finally {
  if (browser) await browser.close();
  await new Promise(r => server.close(r));
}

console.log('\n======================================================');
const allPassed = results.every(r => r.pass);
console.log(`TOTAL ADVERSARIAL CHECKS: ${results.length} | PASSED: ${results.filter(r => r.pass).length} | FAILED: ${results.filter(r => !r.pass).length}`);
console.log(`OVERALL STATUS: ${allPassed ? 'ALL PASS' : 'FAILURES DETECTED'}`);
console.log('======================================================\n');

process.exit(allPassed ? 0 : 1);
