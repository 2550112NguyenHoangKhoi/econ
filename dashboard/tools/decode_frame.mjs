// Decode one real engine broadcast frame with the DASHBOARD's FlatBuffers reader.
//
// Why this exists. flatc is not installed on this machine, so the generated Go and
// TypeScript readers in schema/Telemetry and dashboard/src/telemetry have been extended by
// hand whenever a field was appended. Two hand-edits of the same schema can disagree, and
// when they do the symptom is not an error: the reader returns the type's zero value, and a
// dashboard shows 0% ventilation on a zone the engine is purging. Nobody investigates a
// number.
//
// The only check that catches that is feeding ONE frame to BOTH decoders. The Go side does
// its half in server/simulation/broadcast_dcv_test.go; this is the other half.
//
// Usage:
//   cd server && ECON_DCV_FRAME_OUT=/tmp/econ-frame.bin \
//     go test ./simulation/ -run TestBroadcastRoundTrip_DcvFields
//   cd dashboard && node tools/decode_frame.mjs /tmp/econ-frame.bin
//
// The Go test logs the values it wrote; this prints what the TypeScript reader sees. They
// must match. A field reading 0 here while the Go test asserted non-zero means this side's
// vtable offset is wrong — the offset is 4 + 2*slot, and every appended field takes the next
// slot in declaration order.

import fs from 'node:fs';
import * as flatbuffers from 'flatbuffers';
import { SimState } from '../src/telemetry/sim-state.ts';

const path = process.argv[2];
if (!path) {
  console.error('usage: node tools/decode_frame.mjs <frame.bin>');
  process.exit(2);
}

const bytes = new Uint8Array(fs.readFileSync(path));
const state = SimState.getRootAsSimState(new flatbuffers.ByteBuffer(bytes));

const g = state.global();
console.log('--- GlobalData ---');
console.log('  totalOccupants :', g.totalOccupants());
console.log('  plantCop       :', g.plantCop().toFixed(3));
console.log('  ahuPressurePa  :', g.ahuPressurePa().toFixed(1));
console.log('  dcvZones       :', g.dcvZones());
console.log('  dcvAvoidedKw   :', g.dcvAvoidedKw().toFixed(3));

// Report every zone the loop is actually driving. On a fixture with one seeded sensor this
// is one row; that row is the whole point.
const measured = [];
for (let i = 0; i < state.zonesLength(); i++) {
  const z = state.zones(i);
  if (z.ventMeasured()) {
    measured.push({ id: z.id(), co2: z.co2(), ventFloor: z.ventFloor() });
  }
}
console.log(`--- demand-controlled zones (${measured.length} of ${state.zonesLength()}) ---`);
for (const z of measured) {
  console.log(`  ${z.id}  co2=${z.co2.toFixed(0)} ppm  ventFloor=${z.ventFloor.toFixed(4)}`);
}

// Exit non-zero when the frame claims demand-controlled zones but no zone decodes as one:
// that is precisely the writer/reader disagreement this script is for.
if (g.dcvZones() > 0 && measured.length === 0) {
  console.error('\nMISMATCH: GlobalData.dcvZones > 0 but no ZoneData decoded ventMeasured=true.');
  console.error('The per-zone slots (ventFloor 12 -> offset 28, ventMeasured 13 -> offset 30) disagree with the writer.');
  process.exit(1);
}
if (measured.length > 0 && measured.every((z) => z.ventFloor === 0)) {
  console.error('\nMISMATCH: ventMeasured decoded true but every ventFloor is 0.');
  console.error('The loop never returns below MinVentDamperFloor (0.15), so 0 means the float slot is wrong.');
  process.exit(1);
}
console.log('\nOK: the TypeScript reader agrees with the frame the Go engine wrote.');
