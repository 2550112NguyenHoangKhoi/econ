#!/usr/bin/env node

/**
 * verify_hardware_inspector.js — Automated E2E Verification Harness for Milestone 1
 *
 * Verifies:
 * 1. Hardware Inspector exposes the IR Blaster with protocol selector, frequency/bits,
 *    hex code input, and manual send button.
 * 2. Comprehensive manual controls for all edge devices (IR blaster, plug relays,
 *    lighting relays, VAV damper modulation, and CPU strain offload test).
 * 3. Command dispatch to /api/command with correct payload format.
 * 4. Controls tab with target zone selector and custom device targeting.
 * 5. Compiled hardware library with GPIO pin assignments and firmware build flags.
 */

import puppeteer from 'puppeteer';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

  summary() {
    const totalTime = Date.now() - this.startTime;
    console.log(`\n${colors.bright}${colors.cyan}====================================================${colors.reset}`);
    console.log(`${colors.bright}Hardware Inspector Verification Summary: ${this.passed + this.failed} Total | ${colors.green}${this.passed} Passed${colors.reset} | ${this.failed > 0 ? colors.red : colors.green}${this.failed} Failed${colors.reset} ${colors.gray}(${totalTime}ms)${colors.reset}`);
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

// Dispatched commands history collected by mock API
const dispatchedCommands = [];
const distDir = path.join(__dirname, 'dist');

const mockDevices = {
  devices: [
    {
      id: 'esp32-zone-01',
      zone: 'zone-office-a',
      source: 'esp32',
      online: true,
      bound: true,
      tempReal: true,
      acReal: true,
      acKnown: true,
      ageSec: 1.2,
      rateHz: 1.0,
      messages: 450,
      malformed: 0,
      fields: {
        temperature: { count: 450, last: 23.8, min: 21.0, max: 25.0, at: new Date().toISOString() },
        humidity: { count: 450, last: 52.1, min: 45.0, max: 60.0, at: new Date().toISOString() },
        plugW: { count: 450, last: 180.5, min: 0.0, max: 350.0, at: new Date().toISOString() },
        stripW: { count: 450, last: 45.2, min: 0.0, max: 120.0, at: new Date().toISOString() },
        acW: { count: 450, last: 850.0, min: 0.0, max: 1200.0, at: new Date().toISOString() },
      },
      lastJson: '{"zone":"zone-office-a","temperature":23.8,"humidity":52.1,"plugW":180.5,"stripW":45.2,"acW":850.0}',
    },
  ],
  staleAfter: 20,
};

function createStaticAndMockServer(port = 5210) {

  const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url, `http://127.0.0.1:${port}`);
    const pathname = parsedUrl.pathname;

    // Mock API endpoints
    if (pathname === '/api/devices') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mockDevices));
      return;
    }

    if (pathname === '/api/hardware') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', zones: {} }));
      return;
    }

    if (pathname === '/api/devices/events') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ events: [] }));
      return;
    }

    if (pathname === '/api/command' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          dispatchedCommands.push(parsed);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', message: 'command dispatched' }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // Static files
    let reqPath = pathname;
    if (reqPath === '/' || reqPath === '') reqPath = '/index.html';
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

  return new Promise((resolve) => {
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

function setupRequestInterception(page) {
  return page.setRequestInterception(true).then(() => {
    page.on('request', req => {
      try {
        const url = new URL(req.url());
        const pathname = url.pathname;

        const corsHeaders = {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Content-Type': 'application/json',
        };

        if (req.method() === 'OPTIONS') {
          req.respond({
            status: 200,
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
              'Access-Control-Allow-Headers': '*',
            },
            body: '',
          });
          return;
        }

        if (pathname === '/api/devices') {
          req.respond({
            status: 200,
            headers: corsHeaders,
            body: JSON.stringify(mockDevices),
          });
          return;
        }

        if (pathname === '/api/hardware') {
          req.respond({
            status: 200,
            headers: corsHeaders,
            body: JSON.stringify({ status: 'ok', zones: {} }),
          });
          return;
        }

        if (pathname === '/api/devices/events') {
          req.respond({
            status: 200,
            headers: corsHeaders,
            body: JSON.stringify({ events: [] }),
          });
          return;
        }

        if (pathname === '/api/command' && req.method() === 'POST') {
          const postData = req.postData();
          try {
            const parsed = JSON.parse(postData || '{}');
            dispatchedCommands.push(parsed);
            req.respond({
              status: 200,
              headers: corsHeaders,
              body: JSON.stringify({ status: 'ok', message: 'command dispatched' }),
            });
          } catch (e) {
            req.respond({
              status: 400,
              headers: corsHeaders,
              body: JSON.stringify({ error: e.message }),
            });
          }
          return;
        }

        if (pathname.startsWith('/api/')) {
          req.respond({
            status: 200,
            headers: corsHeaders,
            body: JSON.stringify({ ok: true }),
          });
          return;
        }

        let reqPath = pathname;
        if (reqPath === '/' || reqPath === '') reqPath = '/index.html';
        const filePath = path.join(distDir, reqPath.replace(/^\//, ''));
        const ext = path.extname(filePath);

        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          req.respond({
            status: 200,
            contentType: mimeTypes[ext] || 'application/octet-stream',
            body: fs.readFileSync(filePath),
          });
        } else {
          const indexPath = path.join(distDir, 'index.html');
          req.respond({
            status: 200,
            contentType: 'text/html',
            body: fs.readFileSync(indexPath),
          });
        }
      } catch {
        req.continue();
      }
    });
  });
}

async function run() {
  console.log(`${colors.bright}Starting Milestone 1 Hardware Inspector Verification...${colors.reset}`);

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
        '--disable-features=Crashpad'
      ],
    });

    const page = await browser.newPage();
    page.on('console', msg => {
      if (msg.type() === 'error') {
        console.log(`${colors.red}[Browser Error]${colors.reset} ${msg.text()}`);
      }
    });

    await setupRequestInterception(page);
    await page.goto('http://dashboard.local/?inspector', { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 1500));

    // Suite 1: Layout & Core Elements
    harness.suite('Page Layout & Tab Navigation');

    await harness.test('Hardware Inspector mounts with header and tab list', async () => {
      const h1 = await page.$eval('h1', el => el.textContent);
      harness.assert(h1.includes('Hardware Inspector'), `Expected h1 to include 'Hardware Inspector', got ${h1}`);

      const tabs = await page.$$eval('button', btns => btns.map(b => b.textContent.trim()));
      harness.assert(tabs.includes('devices'), 'Expected devices tab');
      harness.assert(tabs.includes('controls'), 'Expected controls tab');
      harness.assert(tabs.includes('events'), 'Expected events tab');
      harness.assert(tabs.includes('config'), 'Expected config tab');
    });

    await harness.test('DeviceCard renders with Manual Controls section', async () => {
      await page.waitForSelector('[data-testid="ir-protocol-select"]', { timeout: 4000 });
      const selectExists = await page.$('[data-testid="ir-protocol-select"]');
      harness.assert(selectExists !== null, 'Expected IR protocol select to exist in DeviceCard');
    });

    // Suite 2: IR Blaster Controls Verification
    harness.suite('IR Blaster Exposure & Transmission');

    await harness.test('IR Blaster protocol selector offers full protocol catalog', async () => {
      const options = await page.$$eval('[data-testid="ir-protocol-select"] option', opts =>
        opts.map(o => o.value)
      );
      harness.assert(options.includes('COOLIX'), 'Expected COOLIX protocol');
      harness.assert(options.includes('ELECTRA_AC'), 'Expected ELECTRA_AC protocol');
      harness.assert(options.includes('DAIKIN'), 'Expected DAIKIN protocol');
      // PANASONIC_AC, not PANASONIC. IRac::isProtocolSupported() does not accept the bare
      // vendor names -- the AC variants are the ones with a frame. Offering PANASONIC set a
      // protocol the node then refused while the HVAC buttons silently kept the previous
      // one, which is the defect this list was regenerated to fix. Asserting the bare name
      // here was asserting the bug.
      harness.assert(options.includes('PANASONIC_AC'), 'Expected PANASONIC_AC protocol');
      // ...and the guard that keeps it fixed: none of the names the node cannot resolve.
      for (const bogus of ['PANASONIC', 'MITSUBISHI', 'SAMSUNG', 'TOSHIBA', 'NEC', 'SONY', 'RC5', 'RC6']) {
        harness.assert(!options.includes(bogus), `Protocol list must not offer "${bogus}" — IRac cannot drive an AC with it`);
      }
      // The AC variants of the vendors above. NEC/SONY/RC5/RC6 are TV-remote protocols with
      // no AC frame at all and are asserted ABSENT in the loop above, not present here.
      for (const proto of ['MITSUBISHI_AC', 'LG', 'SAMSUNG_AC', 'TOSHIBA_AC', 'GREE', 'HITACHI_AC']) {
        harness.assert(options.includes(proto), `Expected ${proto} protocol`);
      }
      // HITACHI_AC specifically: it is what the pilot node is built with
      // (-DIR_AC_PROTOCOL=HITACHI_AC), confirmed by sweeping the six send-supported Hitachi
      // variants against the real unit. If it ever leaves this list the node's own protocol
      // becomes unselectable from the UI.
    });

    const clearAndType = async (el, text) => {
      await el.evaluate((node, val) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(node, val);
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
      }, text);
    };

    await harness.test('Transmitting IR Code dispatches IR_SEND:<proto>:<hex>:<bits> to backend', async () => {
      dispatchedCommands.length = 0;

      // Set protocol to DAIKIN
      // COOLIX, not DAIKIN.
      //
      // Raw transmit sends IR_SEND:<proto>:<hex>:<bits>, which can only express a protocol
      // whose frame IS a value. DAIKIN carries a byte array, so the node would refuse the
      // frame — and the UI now DISABLES the button for those protocols rather than sending
      // something that cannot work. Driving this test with DAIKIN was driving it with a
      // disabled button; the click did nothing and the assertion read the protocol command
      // as if it were the frame.
      //
      // The DAIKIN case is worth keeping as its own guard, so it is asserted below.
      await page.select('[data-testid="ir-protocol-select"]', 'COOLIX');

      // Set hex code
      const hexInput = await page.$('[data-testid="ir-hex-input"]');
      await clearAndType(hexInput, '0x11223344');

      // Set bits to 32
      const bitsInput = await page.$('[data-testid="ir-bits-input"]');
      await clearAndType(bitsInput, '32');

      // Click Send
      await page.click('[data-testid="ir-send-btn"]');

      // Wait for feedback banner
      await page.waitForSelector('[data-testid="command-feedback-banner"]', { timeout: 3000 });
      const bannerText = await page.$eval('[data-testid="command-feedback-banner"]', el => el.textContent);
      harness.assert(bannerText.includes('SUCCESS'), 'Expected feedback banner to indicate success');

      // Two commands, not one. Choosing a protocol in the dropdown now dispatches
      // PROTOCOL=<name> immediately, so the node is told which protocol to resolve BEFORE
      // the frame arrives; the IR_SEND follows on the button press. The old assertion
      // predates that and was reading the protocol command as if it were the frame.
      const irSends = dispatchedCommands.filter(c => c.command.startsWith('IR_SEND:'));
      const protoSets = dispatchedCommands.filter(c => c.command.startsWith('PROTOCOL='));
      harness.assertEqual(protoSets.length, 1, 'Expected the protocol to be set once, on selection');
      harness.assertEqual(protoSets[0].command, 'PROTOCOL=COOLIX', 'Expected PROTOCOL=COOLIX on selection');
      harness.assertEqual(irSends.length, 1, 'Expected 1 dispatched IR_SEND');
      harness.assertEqual(irSends[0].command, 'IR_SEND:COOLIX:0x11223344:32', 'Expected IR_SEND command payload');

      // ...and the guard: a byte-array protocol must disable raw transmit rather than send a
      // frame the node will refuse. This is one of the IR control defects fixed in d5117da1.
      await page.select('[data-testid="ir-protocol-select"]', 'DAIKIN');
      await new Promise(r => setTimeout(r, 150));
      const daikinDisabled = await page.$eval('[data-testid="ir-send-btn"]', el => el.disabled);
      harness.assert(daikinDisabled, 'Raw transmit must be disabled for DAIKIN — its frame is a byte array, not a value');
      harness.assert(
        dispatchedCommands[0].zone === 'zone-office-a' || dispatchedCommands[0].device_id === 'esp32-zone-01',
        'Expected targeted zone or device_id'
      );
    });

    await harness.test('HVAC Setpoint and Power controls dispatch valid commands', async () => {
      dispatchedCommands.length = 0;

      // Set HVAC temp
      const tempInput = await page.$('[data-testid="hvac-setpoint-input"]');
      await clearAndType(tempInput, '21.5');
      await page.click('[data-testid="hvac-set-btn"]');

      await new Promise(r => setTimeout(r, 200));

      // Turn Off AC
      await page.click('[data-testid="hvac-off-btn"]');

      await new Promise(r => setTimeout(r, 200));

      harness.assertEqual(dispatchedCommands.length, 2, 'Expected 2 HVAC commands');
      harness.assertEqual(dispatchedCommands[0].command, 'SETPOINT=21.5', 'Expected SETPOINT command');
      harness.assertEqual(dispatchedCommands[1].command, 'HVAC_SET:OFF', 'Expected HVAC_SET:OFF command');
    });

    // Suite 3: Relay & Actuator Controls
    harness.suite('Relay & Smart Plug Actuation');

    await harness.test('Smart plug buttons trigger PLUG_ON and PLUG_OFF', async () => {
      dispatchedCommands.length = 0;

      await page.click('[data-testid="plug-off-btn"]');
      await new Promise(r => setTimeout(r, 200));

      await page.click('[data-testid="plug-on-btn"]');
      await new Promise(r => setTimeout(r, 200));

      harness.assertEqual(dispatchedCommands.length, 2, 'Expected 2 plug commands');
      harness.assertEqual(dispatchedCommands[0].command, 'PLUG_OFF', 'Expected PLUG_OFF');
      harness.assertEqual(dispatchedCommands[1].command, 'PLUG_ON', 'Expected PLUG_ON');
    });

    await harness.test('Lighting relay buttons trigger LIGHTS_ON and LIGHTS_OFF', async () => {
      dispatchedCommands.length = 0;

      await page.click('[data-testid="lights-off-btn"]');
      await new Promise(r => setTimeout(r, 200));

      await page.click('[data-testid="lights-on-btn"]');
      await new Promise(r => setTimeout(r, 200));

      harness.assertEqual(dispatchedCommands.length, 2, 'Expected 2 lights commands');
      harness.assertEqual(dispatchedCommands[0].command, 'LIGHTS_OFF', 'Expected LIGHTS_OFF');
      harness.assertEqual(dispatchedCommands[1].command, 'LIGHTS_ON', 'Expected LIGHTS_ON');
    });

    // Suite 4: VAV Damper Modulation
    harness.suite('VAV Damper Overrides');

    await harness.test('Damper position input dispatches DAMPER= command', async () => {
      dispatchedCommands.length = 0;

      const damperInput = await page.$('[data-testid="damper-input"]');
      await clearAndType(damperInput, '65');

      await page.click('[data-testid="damper-send-btn"]');
      await new Promise(r => setTimeout(r, 200));

      harness.assertEqual(dispatchedCommands.length, 1, 'Expected 1 damper command');
      harness.assertEqual(dispatchedCommands[0].command, 'DAMPER=65', 'Expected DAMPER=65');
    });

    // Suite 5: CPU Strain Offload Simulation
    harness.suite('CPU Strain Offload Simulation');

    await harness.test('CPU Strain buttons trigger CPU_STRAIN:HIGH and CPU_STRAIN:NORMAL', async () => {
      dispatchedCommands.length = 0;

      await page.click('[data-testid="cpu-strain-high-btn"]');
      await new Promise(r => setTimeout(r, 200));

      await page.click('[data-testid="cpu-strain-normal-btn"]');
      await new Promise(r => setTimeout(r, 200));

      harness.assertEqual(dispatchedCommands.length, 2, 'Expected 2 strain commands');
      harness.assertEqual(dispatchedCommands[0].command, 'CPU_STRAIN:HIGH', 'Expected CPU_STRAIN:HIGH');
      harness.assertEqual(dispatchedCommands[1].command, 'CPU_STRAIN:NORMAL', 'Expected CPU_STRAIN:NORMAL');
    });

    // Suite 6: Controls Tab & Target Customization
    harness.suite('Controls Tab & Multi-Zone Target Selection');

    await harness.test('Switching to Controls tab allows custom zone targeting', async () => {
      dispatchedCommands.length = 0;

      // Click controls tab in header
      const tabs = await page.$$('div button');
      let controlsBtn = null;
      for (const btn of tabs) {
        const text = await page.evaluate(el => el.textContent, btn);
        if (text.trim() === 'controls') {
          controlsBtn = btn;
          break;
        }
      }
      harness.assert(controlsBtn !== null, 'Expected controls tab button in header');
      await controlsBtn.click();

      await page.waitForSelector('[data-testid="target-zone-select"]', { timeout: 3000 });

      // Change target to zone-office-b
      await page.select('[data-testid="target-zone-select"]', 'zone-office-b');

      // Click Sockets OFF
      await page.click('[data-testid="plug-off-btn"]');
      await new Promise(r => setTimeout(r, 200));

      harness.assertEqual(dispatchedCommands.length, 1, 'Expected 1 command from Controls tab');
      harness.assertEqual(dispatchedCommands[0].command, 'PLUG_OFF', 'Expected PLUG_OFF');
      harness.assertEqual(dispatchedCommands[0].zone, 'zone-office-b', 'Expected target zone-office-b');

      // Test custom target input
      const customInput = await page.$('[data-testid="custom-target-input"]');
      await customInput.type('zone-custom-lvl5');

      await page.click('[data-testid="lights-on-btn"]');
      await new Promise(r => setTimeout(r, 200));

      harness.assertEqual(dispatchedCommands.length, 2, 'Expected second command with custom target');
      harness.assertEqual(dispatchedCommands[1].zone, 'zone-custom-lvl5', 'Expected target zone-custom-lvl5');
    });

    // Suite 7: Hardware Library Specification
    harness.suite('Device Library & Pin Map Specification');

    await harness.test('Expanding device library lists GPIO pin specifications', async () => {
      // Click Show Device Library button
      const buttons = await page.$$('button');
      let libBtn = null;
      for (const b of buttons) {
        const txt = await page.evaluate(el => el.textContent, b);
        if (txt.includes('Device Library') || txt.includes('Device Specs')) {
          libBtn = b;
          break;
        }
      }
      harness.assert(libBtn !== null, 'Expected Show Device Library button');
      await libBtn.click();

      // The pins the pilot node actually uses, per edge/esp32/platformio.ini.
      //
      // This list used to assert GPIO 19 and GPIO 23. Neither is wired: 19 is free, and the
      // lighting relay on 23 is unpopulated (pinLightingRelay = 255), which the table itself
      // reports as "Unused (255)". Asserting pins that are not in the build meant this check
      // could only ever fail, so it stopped being read.
      await page.waitForSelector('table code', { timeout: 2000 });
      const pinCodes = await page.$$eval('table code', els => els.map(el => el.textContent));
      for (const pin of ['GPIO 25', 'GPIO 26', 'GPIO 32', 'GPIO 33', 'GPIO 21', 'GPIO 22', 'GPIO 13', 'GPIO 16']) {
        harness.assert(pinCodes.some(p => p.includes(pin)), `Expected ${pin} in library pin map`);
      }
    });

  } finally {
    if (browser) await browser.close();
  }

  const success = harness.summary();
  if (!success) {
    process.exit(1);
  }
}

run().catch(err => {
  console.error(`${colors.red}Fatal Error:${colors.reset}`, err);
  process.exit(1);
});
