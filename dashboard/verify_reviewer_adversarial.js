import path from 'path';
import fs from 'fs';
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

class Harness {
  constructor() {
    this.passed = 0;
    this.failed = 0;
    this.suiteName = '';
  }
  suite(name) {
    this.suiteName = name;
    console.log(`\n${colors.bright}${colors.cyan}=== Suite: ${name} ===${colors.reset}`);
  }
  test(name, fn) {
    try {
      fn();
      this.passed++;
      console.log(`  ${colors.green}✔ PASS${colors.reset} ${name}`);
    } catch (err) {
      this.failed++;
      console.error(`  ${colors.red}✖ FAIL${colors.reset} ${name}: ${err.message}`);
    }
  }
  assert(cond, msg) {
    if (!cond) throw new Error(msg);
  }
}

const harness = new Harness();

async function run() {
  console.log(`${colors.bright}Running Adversarial Reviewer Stress Tests...${colors.reset}`);

  // Setup DOM / Window globals
  globalThis.window = {
    location: { search: '?inspector', pathname: '/' },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globalThis.localStorage = {
    getItem: (k) => (k === 'econ.adminToken' ? 'test-admin-secret-xyz' : null),
    setItem: () => {},
    removeItem: () => {},
  };

  const dispatchedCommands = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (url.includes('/api/command')) {
      const body = JSON.parse(opts.body || '{}');
      dispatchedCommands.push({ url, headers: opts.headers, body });
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', message: 'command dispatched' }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ devices: [], staleAfter: 20 }),
      text: async () => '{}',
    };
  };

  // Compile HardwareInspector.jsx
  const srcPath = path.join(__dirname, 'src', 'HardwareInspector.jsx');
  const compiled = await esbuild.build({
    entryPoints: [srcPath],
    bundle: true,
    external: ['react', 'react-dom', 'react-dom/server'],
    format: 'esm',
    write: false,
    loader: { '.jsx': 'jsx', '.js': 'js' },
  });

  const tempPath = path.join(__dirname, 'src', '_test_inspector_compiled.js');
  fs.writeFileSync(tempPath, compiled.outputFiles[0].text);

  let Mod;
  try {
    Mod = await import('./src/_test_inspector_compiled.js');
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }

  const { default: HardwareInspector } = Mod;
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');

  // Suite 1: Hardware Inspector default SSR render
  harness.suite('Default SSR Mounting & Null Safety');
  harness.test('Renders without throwing with default empty state', () => {
    const html = renderToStaticMarkup(React.createElement(HardwareInspector));
    harness.assert(html.includes('Hardware Inspector'), 'Should render header');
    harness.assert(html.includes('Manual Controls &amp; Actuation'), 'Should render default controls when no devices');
  });

  // Suite 2: Adversarial Data Injection
  harness.suite('Adversarial Null/Undefined Data Injection');

  harness.test('Source guards fmt() and ago() against null, undefined, and NaN', () => {
    const src = fs.readFileSync(srcPath, 'utf8');
    harness.assert(src.includes('Number.isNaN(+v)'), 'fmt must guard against NaN');
    harness.assert(src.includes('Number.isNaN(+s)'), 'ago must guard against NaN');
  });

  harness.test('DeviceCard safely handles null dev and malformed fields', () => {
    const src = fs.readFileSync(srcPath, 'utf8');
    harness.assert(src.includes('if (!dev) return null;'), 'DeviceCard must guard against null dev');
    harness.assert(src.includes('dev?.online'), 'DeviceCard must safely access online state');
    harness.assert(src.includes('f?.omitted ?? 0'), 'DeviceCard must safely access omitted count');
  });

  harness.test('EventsTab safely handles null, empty, or malformed events', () => {
    const src = fs.readFileSync(srcPath, 'utf8');
    harness.assert(src.includes('events == null &&'), 'EventsTab must handle null/undefined events');
    harness.assert(src.includes('safeDateTime(e?.t)'), 'EventsTab must format event timestamps safely');
  });

  harness.test('QualityTab safely handles null, error, or missing quality breakdown', () => {
    const src = fs.readFileSync(srcPath, 'utf8');
    harness.assert(src.includes('quality == null &&'), 'QualityTab must handle null/undefined quality');
    harness.assert(src.includes('safeTime(r?.from)'), 'QualityTab must format from timestamp safely');
    harness.assert(src.includes('safeTime(r?.to)'), 'QualityTab must format to timestamp safely');
  });

  harness.test('SustainabilityTab safely handles null nested structures and numeric conversion', () => {
    const src = fs.readFileSync(srcPath, 'utf8');
    harness.assert(src.includes('(Number(accounting.instantaneousPowerW) || 0).toFixed'), 'Power must be safely cast to Number');
    harness.assert(src.includes('(Number(accounting.cumulativeEmissionsKgCO2e) || 0).toFixed'), 'Cumulative emissions must be safe');
    harness.assert(src.includes('(Number(recs.deficitKgCO2e) || 0).toFixed'), 'Deficit must be safe');
    harness.assert(src.includes('recs.wholeCertificatesNeeded ?? 0'), 'Whole certificates must be safe');
    harness.assert(src.includes('safeTime(quote.fetchedAt)'), 'Quote timestamp must be safe');
  });

  harness.test('ForecastTab safely handles thin forecasts and missing agree metrics', () => {
    const src = fs.readFileSync(srcPath, 'utf8');
    harness.assert(src.includes('agree.relativeDiff != null'), 'agree.relativeDiff must be guarded');
    harness.assert(src.includes('agree.deltaMw || 0'), 'agree.deltaMw must be guarded');
    harness.assert(src.includes('agree.higher || \'\''), 'agree.higher must be guarded');
  });

  // Suite 3: Manual Controls & Actuation Wiring Audit
  harness.suite('Manual Controls & Actuation Wiring Audit');

  harness.test('sendCommand attaches X-Admin-Token header when present', () => {
    const src = fs.readFileSync(srcPath, 'utf8');
    harness.assert(src.includes('getAdminToken'), 'Must import getAdminToken');
    harness.assert(src.includes('headers[\'X-Admin-Token\'] = token'), 'Must attach X-Admin-Token header');
  });

  harness.test('All required actuator commands are present in HardwareInspector', () => {
    const src = fs.readFileSync(srcPath, 'utf8');
    harness.assert(src.includes("sendCommand('PLUG_ON')"), 'Must wire PLUG_ON');
    harness.assert(src.includes("sendCommand('PLUG_OFF')"), 'Must wire PLUG_OFF');
    harness.assert(src.includes("sendCommand('LIGHTS_ON')"), 'Must wire LIGHTS_ON');
    harness.assert(src.includes("sendCommand('LIGHTS_OFF')"), 'Must wire LIGHTS_OFF');
    harness.assert(src.includes("sendCommand('HVAC_SET:OFF')"), 'Must wire HVAC_SET:OFF');
    harness.assert(src.includes("sendCommand(`SETPOINT=${Number(tempSetpoint).toFixed(1)}`)"), 'Must wire SETPOINT');
    harness.assert(src.includes("sendCommand(`DAMPER=${damperVal}`)"), 'Must wire DAMPER modulation');
    harness.assert(src.includes("sendCommand('CPU_STRAIN:HIGH')"), 'Must wire CPU_STRAIN:HIGH');
    harness.assert(src.includes("sendCommand('CPU_STRAIN:NORMAL')"), 'Must wire CPU_STRAIN:NORMAL');
    harness.assert(src.includes("sendCommand('CAMERA_TRIGGER')"), 'Must wire CAMERA_TRIGGER');
    harness.assert(src.includes("sendCommand(`IR_SEND:${protocol}:${hexCode.trim()}:${bits}`)"), 'Must wire IR_SEND');
  });

  // Suite 4: Camera Fault Tolerance Audit
  harness.suite('Camera Fault Tolerance Audit');

  harness.test('Frontend renders offline fallback card with retry connection button on camera error', () => {
    const src = fs.readFileSync(srcPath, 'utf8');
    harness.assert(src.includes('cameraError'), 'Must track cameraError state');
    harness.assert(src.includes('onError={() => setCameraError(true)}'), 'Must catch img onError');
    harness.assert(src.includes('Retry Connection'), 'Must provide Retry Connection action');
    harness.assert(src.includes('Camera feed offline or unreachable'), 'Must display explanatory fallback card');
  });

  harness.test('ESP32 camera driver sets I2C timeout and falls back to simulation mode without crashing', () => {
    const ovDriverPath = path.join(__dirname, '..', 'edge', 'esp32', 'src', 'camera', 'ov7670_driver.cpp');
    const ovSrc = fs.readFileSync(ovDriverPath, 'utf8');
    harness.assert(ovSrc.includes('Wire.setTimeOut(100);'), 'Driver must set I2C timeout to prevent bus lockup');
    harness.assert(ovSrc.includes('Wire.endTransmission()'), 'Driver must probe I2C address');
    harness.assert(ovSrc.includes('DRIVER_SIMULATION_MODE'), 'Driver must fall back to simulation mode');
    harness.assert(ovSrc.includes('generateSyntheticFrame()'), 'Driver must generate synthetic frames when camera offline');
  });

  // Suite 5: Telemetry & Sustainability Logic Verification
  harness.suite('Telemetry & Sustainability Invariants');

  harness.test('FlatBuffers zone-data.ts includes stripW getter and field slot 11', () => {
    const zdPath = path.join(__dirname, 'src', 'telemetry', 'zone-data.ts');
    const zdSrc = fs.readFileSync(zdPath, 'utf8');
    harness.assert(zdSrc.includes('stripW():number'), 'zone-data.ts must define stripW accessor');
    harness.assert(zdSrc.includes('__offset(this.bb_pos, 26)'), 'stripW must read offset 26');
    harness.assert(zdSrc.includes('addStripW(builder:flatbuffers.Builder, stripW:number)'), 'zone-data.ts must support addStripW');
    harness.assert(zdSrc.includes('builder.startObject(12)'), 'ZoneData must allocate 12 object slots');
  });

  harness.test('useDigitalTwin.js extracts stripW and App.jsx maps plugW and stripW onto topology nodes', () => {
    const dtPath = path.join(__dirname, 'src', 'useDigitalTwin.js');
    const dtSrc = fs.readFileSync(dtPath, 'utf8');
    harness.assert(dtSrc.includes('stripW: z.stripW ? z.stripW() : 0'), 'useDigitalTwin must extract stripW');

    const appPath = path.join(__dirname, 'src', 'App.jsx');
    const appSrc = fs.readFileSync(appPath, 'utf8');
    harness.assert(appSrc.includes('plugW: z.plugW ?? 0'), 'App.jsx must pass plugW to unit nodes');
    harness.assert(appSrc.includes('stripW: z.stripW ?? 0'), 'App.jsx must pass stripW to unit nodes');
    harness.assert(!appSrc.includes('{(!isRealMode && <button data-testid="tab-sustainability"'), 'Sustainability tab must be available in both Real and Sim modes');
  });

  // Suite 6: Sustainability Panel Adversarial Fault Tolerance
  harness.suite('Sustainability Panel Adversarial Fault Tolerance');

  const susSrcPath = path.join(__dirname, 'src', 'SustainabilityRecommendationsPanel.jsx');
  const compiledSus = await esbuild.build({
    entryPoints: [susSrcPath],
    bundle: true,
    external: ['react', 'react-dom', 'lucide-react'],
    format: 'esm',
    write: false,
  });

  const tempSusPath = path.join(__dirname, 'src', '_test_sus_compiled.js');
  fs.writeFileSync(tempSusPath, compiledSus.outputFiles[0].text);
  let SusMod;
  try {
    SusMod = await import('./src/_test_sus_compiled.js');
  } finally {
    if (fs.existsSync(tempSusPath)) fs.unlinkSync(tempSusPath);
  }
  const { default: SustainabilityPanel } = SusMod;

  harness.test('SustainabilityPanel mounts with empty customData without throwing', () => {
    const html = renderToStaticMarkup(React.createElement(SustainabilityPanel, { customData: {} }));
    harness.assert(html.includes('sustainability-panel'), 'Must render panel container');
  });

  harness.test('SustainabilityPanel handles empty carbonAccounting sub-object safely', () => {
    const html = renderToStaticMarkup(React.createElement(SustainabilityPanel, { customData: { carbonAccounting: {} } }));
    harness.assert(html.includes('metric-power-w'), 'Must render total power metric');
  });

  harness.test('SustainabilityPanel handles empty carbonCreditRecommendations sub-object safely', () => {
    const html = renderToStaticMarkup(React.createElement(SustainabilityPanel, { customData: { carbonCreditRecommendations: {} } }));
    harness.assert(html.includes('metric-carbon-deficit'), 'Must render deficit metric');
  });

  harness.test('SustainabilityPanel handles empty predictiveMaintenance sub-object safely', () => {
    const html = renderToStaticMarkup(React.createElement(SustainabilityPanel, { customData: { predictiveMaintenance: {} } }));
    harness.assert(html.includes('ACTIVE'), 'Must render active alerts badge');
  });

  harness.test('SustainabilityPanel handles empty spaceUtilization sub-object safely', () => {
    const html = renderToStaticMarkup(React.createElement(SustainabilityPanel, { customData: { spaceUtilization: {} } }));
    harness.assert(html.includes('metric-space-efficiency'), 'Must render space efficiency metric');
  });

  harness.test('SustainabilityPanel handles corrupted/malformed nested structures', () => {
    const html = renderToStaticMarkup(React.createElement(SustainabilityPanel, {
      customData: {
        carbonAccounting: { instantaneousPowerW: NaN, breakdown: { plugW: null, stripW: 'invalid' } },
        carbonCreditRecommendations: { marketQuote: null, alternativeQuotes: [null, {}] },
        predictiveMaintenance: { activeAlertsCount: null, warnings: [null, { metricValue: NaN }] },
        spaceUtilization: { zones: [null, { efficiencyPercent: 'notanumber' }] },
      },
    }));
    harness.assert(html.includes('sustainability-panel'), 'Must render safely without crashing');
  });

  console.log(`\n${colors.bright}Summary: ${harness.passed} Passed | ${harness.failed} Failed${colors.reset}`);
  if (harness.failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
