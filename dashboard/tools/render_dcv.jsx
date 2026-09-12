// Server-render the two DCV surfaces and assert what they say.
//
// Why server-render rather than drive the browser: the presence path needs a zone with a
// LIVE CO2 reading, and the engine only gets one from a real NDIR sensor over MQTT. Seeding
// one into the running engine to make a screenshot look right would be fabricating a
// measurement to demonstrate a measurement — exactly what rule 1 forbids, and the kind of
// demo that hides a broken sensor path. Rendering the components against explicit props
// tests the rendering, and the Go tests test the physics, and neither pretends to be the
// other.
//
// The absence path IS verified in a real browser against a real engine, because there the
// absence is genuine: no sensors are fitted, dcvZones is 0, and these rows must not appear.
//
// Usage: npm run check:dcv-ui

import React from 'react';
import { renderToString } from 'react-dom/server';
import Scope2Card from '../src/sustainability/Scope2Card.jsx';
import ZoneDrilldownHUD from '../src/ZoneDrilldownHUD.jsx';

// React's server renderer separates adjacent text nodes with an empty HTML comment, so
// `{pct}%` renders as `15<!-- -->%` and a naive includes('15%') misses it. Strip the markers
// before asserting. (This bit me in the other direction too: includes('100%') passed against
// a `width: 100%` style rather than the value under test, which is why the checks below match
// the value together with its label instead of the bare number.)
const text = (html) => html.replace(/<!--\s*-->/g, '');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
    failures++;
  }
};

// ---------------------------------------------------------------------------------------
// Scope2Card: the building-level DCV row.
// ---------------------------------------------------------------------------------------
const scope2Props = {
  carbon: {}, breakdown: {}, plugW: 0, stripW: 0, acW: 0,
  endUse: () => ({}), acMeteredZones: 0, stripMeteredZones: 0,
  plugMeteredZones: 0, plugModelledZones: 0,
  instantaneousPowerW: 1000, instantaneousEmissionRateKgPerHour: 0.6,
  gridEmissionFactorKgPerKwh: 0.6, cumulativeEmissionsKgCO2e: 10,
  treesEquivalent: 1, carKmEquivalent: 1,
};

console.log('Scope2Card');
{
  const html = renderToString(
    <Scope2Card {...scope2Props} dcvZones={3} dcvAvoidedKw={42.9} />
  );
  check('shows the zone count when zones are demand-controlled', html.includes('3</b> zone'));
  check('shows the avoided fresh-air load', html.includes('42.9 kW'));
  check('labels it as avoided load, not as a generic saving',
    html.includes('fresh-air load avoided'));
}
{
  // The honesty case: no sensors fitted. The row must be absent entirely rather than
  // rendering "0 zones / 0 kW", which reads as a result rather than an absence.
  const html = renderToString(
    <Scope2Card {...scope2Props} dcvZones={0} dcvAvoidedKw={0} />
  );
  check('hides the row entirely when no zone is demand-controlled',
    !html.includes('demand-controlled'),
    'a "0 zones / 0 kW" row would present an absent loop as a loop that found nothing');
}
{
  // Sub-kilowatt loads must not collapse to "0.0 kW".
  const html = renderToString(
    <Scope2Card {...scope2Props} dcvZones={1} dcvAvoidedKw={0.42} />
  );
  check('renders a sub-kilowatt load in watts rather than as 0.0 kW',
    html.includes('420 W'), 'got the kW branch for a 420 W figure');
}

// ---------------------------------------------------------------------------------------
// ZoneDrilldownHUD: the per-zone fresh-air row.
// ---------------------------------------------------------------------------------------
const zoneBase = {
  label: 'office-34-lvl7',
  temp: 24, setpoint: 24, load: 1, occupancy: 2, lightsOn: true, humidity: 50,
  supplyC: 12, supplyReal: false, plugW: 0, plugShed: false, stripW: 0,
};
const hudProps = (zone) => ({
  selectedZone: 'z1',
  setSelectedZone: () => {},
  simData: { zones: { z1: zone }, plantCop: 3, vavs: {} },
  hardwareNodes: {},
  modelledCo2: () => 600,
  sendManualOverride: () => {},
});

console.log('ZoneDrilldownHUD');
{
  const html = renderToString(
    <ZoneDrilldownHUD {...hudProps({ ...zoneBase, co2: 1150, ventFloor: 1.0, ventMeasured: true })} />
  );
  check('shows the fresh-air row for a measured zone', html.includes('Fresh air (demand-controlled)'));
  check('reads 100% at full open', /100%\s*<span[^>]*>PURGE/.test(text(html)),
    'the percentage must sit next to its reason label, not merely appear somewhere in the markup');
  check('labels a fully-open damper PURGE', html.includes('PURGE'));
}
{
  const html = renderToString(
    <ZoneDrilldownHUD {...hudProps({ ...zoneBase, co2: 450, ventFloor: 0.15, ventMeasured: true })} />
  );
  check('labels a zone at the area minimum FLOOR', html.includes('FLOOR'));
  check('reads 15% at the area minimum', /15%\s*<span[^>]*>FLOOR/.test(text(html)));
}
{
  // The honesty case again, per zone: with no NDIR sensor the damper sits at the fixed
  // ASHRAE minimum, and printing "15%" under a "demand-controlled" heading would present a
  // constant as a control decision.
  const html = renderToString(
    <ZoneDrilldownHUD {...hudProps({ ...zoneBase, co2: 0, ventFloor: 0.15, ventMeasured: false })} />
  );
  check('hides the fresh-air row when no sensor drives it',
    !html.includes('Fresh air (demand-controlled)'),
    'showing the fixed minimum under a demand-controlled heading presents a constant as a measurement');
}

console.log(failures === 0 ? '\nOK: all DCV UI checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
