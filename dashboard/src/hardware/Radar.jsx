import React from 'react';



// Presence envelope for the 24GHz radar heads.
//
// DELIBERATELY SHOWS NO TARGET POSITION. An Rd-03_V2 reports presence on one digital pin
// (OT2 high when sensing) and nothing else -- no bearing, no range. Drawing a blip somewhere
// in the cone would invent a measurement the sensor never made, which is the one thing this
// codebase does not do. So each cone is datasheet geometry, labelled as such, and the only
// live quantity is whether it is lit.
export function RadarHead({ label, pin, state, rangeM }) {
  const R = 104;                 // px for the 10 m outer arc (wall-mount, Table 3)
  const cx = 116, cy = 118;
  const HALF = 60;               // +/-60 degrees, per spec
  const rad = (d) => (d - 90) * Math.PI / 180;
  const pt = (deg, r) => [cx + r * Math.cos(rad(deg)), cy + r * Math.sin(rad(deg))];
  const [lx, ly] = pt(-HALF, R);
  const [rx, ry] = pt(HALF, R);
  const cone = `M ${cx} ${cy} L ${lx} ${ly} A ${R} ${R} 0 0 1 ${rx} ${ry} Z`;

  // state: 'sensing' | 'clear' | 'absent' (head not fitted, or node offline)
  const stroke = state === 'sensing' ? '#4ade80' : state === 'clear' ? '#374151' : '#4b5563';
  const fill = state === 'sensing' ? 'rgba(74,222,128,0.16)'
             : state === 'clear'   ? 'rgba(55,65,81,0.14)'
                                   : 'rgba(75,85,99,0.07)';
  const word = state === 'sensing' ? 'PRESENCE' : state === 'clear' ? 'CLEAR' : 'NO DATA';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <strong style={{ fontSize: 12, color: '#e5e7eb' }}>{label}</strong>
        <span style={{ color: '#6b7280', fontSize: 11 }}>{pin}</span>
      </div>
      <svg width="232" height="132" viewBox="0 0 232 132" role="img"
           aria-label={`${label} on ${pin}: ${word.toLowerCase()}`}>
        <path d={cone} fill={fill} stroke={stroke} strokeWidth="1" />
        {/* Micro-motion reach is shorter than motion reach (manual Fig. 14: ~8 m vs ~9-10 m
            wall-mounted). A still occupant is only detectable inside the inner arc, so the
            two are drawn separately rather than implying one uniform envelope. */}
        {(() => {
          const r = 0.8 * R;
          const [ax, ay] = pt(-HALF, r);
          const [bx, by] = pt(HALF, r);
          return <path d={`M ${ax} ${ay} A ${r} ${r} 0 0 1 ${bx} ${by}`} fill="none"
                       stroke={stroke} strokeWidth="1" strokeDasharray="3 3" opacity="0.7" />;
        })()}
        {[2, 4, 6, 8, 10].map((m) => {
          const r = (m / 10) * R;
          const [ax, ay] = pt(-HALF, r);
          const [bx, by] = pt(HALF, r);
          return (
            <g key={m}>
              <path d={`M ${ax} ${ay} A ${r} ${r} 0 0 1 ${bx} ${by}`} fill="none" stroke="#1f2937" strokeWidth="1" />
              <text x={cx + r - 2} y={cy - 4} fill="#4b5563" fontSize="8" textAnchor="end">{m}m</text>
            </g>
          );
        })}
        {/* Range arc. Retained but never fed on the Rd-03_V2: its distance field tracks the
            configured gate, not a target (see the caption). A module that reports a real range
            can drive this by supplying rangeM -- still as an arc, never a dot, because no
            bearing is measured. */}
        {typeof rangeM === 'number' && rangeM > 0 && (() => {
          const r = Math.min(rangeM / 10, 1) * R;
          const [ax, ay] = pt(-HALF, r);
          const [bx, by] = pt(HALF, r);
          return (
            <g>
              <path d={`M ${ax} ${ay} A ${r} ${r} 0 0 1 ${bx} ${by}`} fill="none"
                    stroke="#f59e0b" strokeWidth="2.5" strokeLinecap="round" />
              <text x={cx} y={cy - r - 5} fill="#f59e0b" fontSize="9" textAnchor="middle"
                    style={{ fontWeight: 700 }}>{rangeM.toFixed(2)} m</text>
            </g>
          );
        })()}
        <line x1={cx} y1={cy} x2={cx} y2={cy - R} stroke="#1f2937" strokeWidth="1" strokeDasharray="2 3" />
        <circle cx={cx} cy={cy} r="4" fill={stroke} />
        <text x={lx + 1} y={ly - 4} fill="#4b5563" fontSize="8" textAnchor="start">-60&#176;</text>
        <text x={rx - 1} y={ry - 4} fill="#4b5563" fontSize="8" textAnchor="end">+60&#176;</text>
      </svg>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: stroke,
                       boxShadow: state === 'sensing' ? `0 0 8px ${stroke}` : 'none' }} />
        <span style={{ color: stroke, fontSize: 12, fontWeight: 700, letterSpacing: '.04em' }}>{word}</span>
      </div>
    </div>
  );
}


// Live per-range-gate energy. Each bar is one 0.7 m range bin of reflected energy, straight
// off the head's reporting stream — the one part of that stream that actually measures the
// room. Gates the module blanks in its near field arrive as -1 and are drawn as hatched
// "blanked", not as a bar, because plotting a 0xFFFF sentinel as a value is how this bring-up
// spent hours chasing an obstruction that did not exist.
export function GateProfile({ gates, at, label }) {
  if (!Array.isArray(gates) || gates.length === 0) return null;
  const stale = at ? (Date.now() - new Date(at).getTime() > 20000) : true;
  const real = gates.filter((v) => v >= 0);
  const peak = Math.max(1, ...real);
  // 8px labels in an 18px column collide into an unreadable smear. Wider columns plus
  // labelling every other gate gives each number room to be read; the peak gate is always
  // labelled regardless of parity, since that is the one being pointed at.
  const W = 20, GAP = 5, H = 72;

  // Gate index -> distance. Each gate spans 0.7 m, so gate g covers [g*0.7, (g+1)*0.7) and
  // its midpoint is the best single-number distance for that bin.
  const GATE_M = 0.7;
  const mid = (g) => (g + 0.5) * GATE_M;

  // Strongest return, skipping the gates the module blanks. This is a real derived quantity:
  // the range bin carrying the most reflected energy. It is NOT "where the person is" --
  // the radar reports no bearing, energy falls off with range, and a wall reflects harder
  // than a person. Labelled as what it is.
  let peakGate = -1;
  gates.forEach((v, g) => { if (v >= 0 && (peakGate < 0 || v > gates[peakGate])) peakGate = g; });

  // The lowest bin the module is willing to report. Everything below it is blanked, so a
  // target nearer than that has nowhere to land except this bin -- point the head at
  // something 30cm away and the peak still shows up here.
  //
  // When the peak IS that floor bin, its midpoint is NOT a measurement: the target is
  // somewhere between zero and the TOP of the bin. Printing "1.75 m" in that case reports a
  // limit of the display as though it were a distance, which is how this readout misled us.
  const floorGate = gates.findIndex((v) => v >= 0);
  const atFloor = peakGate >= 0 && peakGate === floorGate && floorGate > 0;
  const peakM = peakGate >= 0 ? mid(peakGate) : null;
  const floorTopM = floorGate >= 0 ? (floorGate + 1) * GATE_M : null;

  return (
    <div style={{ opacity: stale ? 0.4 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 5 }}>
        <span style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '.07em' }}>
          {label} range-gate energy
        </span>
        <span style={{ fontSize: 10, color: '#4b5563' }}>
          {stale ? 'stale' : `peak ${peak.toLocaleString()}`}
        </span>
        {!stale && peakM !== null && (
          atFloor ? (
            <span style={{ fontSize: 11, color: '#f59e0b', fontWeight: 700 }}>
              strongest return &le; {floorTopM.toFixed(1)} m
              <span style={{ color: '#6b7280', fontWeight: 400 }}>
                {' '}(gate {peakGate} is the nearest reportable bin &mdash; anything closer is
                blanked, so this is a floor, not a distance)
              </span>
            </span>
          ) : (
            <span style={{ fontSize: 11, color: '#f59e0b', fontWeight: 700 }}>
              strongest return @ {peakM.toFixed(2)} m
              <span style={{ color: '#6b7280', fontWeight: 400 }}> (gate {peakGate})</span>
            </span>
          )
        )}
      </div>
      <svg width={gates.length * (W + GAP)} height={H + 20}
           role="img" aria-label={`${label} per-gate energy, peak ${peak}`}>
        <defs>
          <pattern id={`hatch-${label}`} width="4" height="4" patternTransform="rotate(45)"
                   patternUnits="userSpaceOnUse">
            <line x1="0" y1="0" x2="0" y2="4" stroke="#374151" strokeWidth="2" />
          </pattern>
        </defs>
        {gates.map((v, g) => {
          const x = g * (W + GAP);
          const blanked = v < 0;
          const h = blanked ? H : Math.max(1, (v / peak) * H);
          return (
            <g key={g}>
              <rect x={x} y={H - h} width={W} height={h}
                    fill={blanked ? `url(#hatch-${label})` : (g === peakGate ? '#f59e0b' : '#4ade80')}
                    opacity={blanked ? 1 : 0.35 + 0.65 * (v / peak)} />
              {(g % 2 === 0 || g === peakGate) && (
                <text x={x + W / 2} y={H + 14}
                      fill={g === peakGate ? '#f59e0b' : '#6b7280'}
                      fontSize="11" fontWeight={g === peakGate ? 700 : 400}
                      textAnchor="middle">
                  {mid(g).toFixed(1)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4, maxWidth: 380, lineHeight: 1.55 }}>
        Bar = reflected energy in one 0.7&nbsp;m range bin; the label is that bin&rsquo;s midpoint
        distance. Hatched = blanked by the module in its near field, not a reading.
        The <span style={{ color: '#f59e0b' }}>amber</span> bin holds the most energy &mdash; that is
        the strongest <em>reflector</em>, not necessarily a person: a wall returns more than a body,
        and energy falls off steeply with range.
        {floorGate > 0 && (
          <> The module is blanking everything below{' '}
            <strong>{(floorGate * 0.7).toFixed(1)}&nbsp;m</strong>, so this head cannot report a
            target nearer than that at all &mdash; near objects pile into the first live bin.
          </>
        )}
      </div>
    </div>
  );
}


export function RadarEnvelope({ fields, online, dev }) {
  const read = (name) => {
    const f = fields?.[name];
    if (!online || !f || !(f.count > 0)) return 'absent';
    // A stale value is worse than none. When the firmware stops sending a channel, its last
    // reading keeps sitting in `last` forever -- which showed a green PRESENCE cone from a
    // value nine minutes old while the channel was actually being omitted.
    if (f.at && Date.now() - new Date(f.at).getTime() > 30000) return 'absent';
    return Number(f.last) > 0 ? 'sensing' : 'clear';
  };
  const range = (name) => {
    const f = fields?.[name];
    // Stale ranges are worse than none: the firmware omits the field when there is no target,
    // so an old value would keep drawing an arc where nobody is.
    if (!online || !f || !(f.count > 0) || !f.at) return null;
    if (Date.now() - new Date(f.at).getTime() > 15000) return null;
    const v = Number(f.last);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const h1 = read('radar1');
  const h2 = read('radar2');
  const fused = read('occupancy');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        <RadarHead label="RD03-1" pin="GPIO 13" state={h1} rangeM={range('radar1_m')} />
        <RadarHead label="RD03-2" pin="GPIO 14" state={h2} rangeM={range('radar2_m')} />
      </div>

      <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap',
                    borderTop: '1px solid #1f2937', paddingTop: 12 }}>
        {[['RD03-1', dev?.radar1Gates], ['RD03-2', dev?.radar2Gates]].map(([name, g]) => (
          g?.length > 0
            ? <GateProfile key={name} gates={g} at={dev.radarGatesAt} label={name} />
            : (
              <div key={name} style={{ minWidth: 240 }}>
                <div style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase',
                              letterSpacing: '.07em', marginBottom: 5 }}>
                  {name} range-gate energy
                </div>
                <div style={{ fontSize: 11, color: '#6b7280', lineHeight: 1.55,
                              border: '1px dashed #1f2937', borderRadius: 4, padding: 10 }}>
                  No energy stream from this head. It answers UART configuration commands but
                  emits no reporting frames on <em>either</em> ESP32 serial port &mdash; tested by
                  swapping the two heads between ports. That is a firmware difference between the
                  two modules, not wiring. Its presence pin (OT2) is unaffected and works.
                </div>
              </div>
            )
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                    borderTop: '1px solid #1f2937', paddingTop: 10 }}>
        <span style={{ color: '#9ca3af', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.08em' }}>
          occupancy
        </span>
        <span style={{ color: fused === 'sensing' ? '#4ade80' : fused === 'clear' ? '#9ca3af' : '#4b5563',
                       fontSize: 13, fontWeight: 700 }}>
          {fused === 'sensing' ? 'OCCUPIED' : fused === 'clear' ? 'EMPTY' : 'NO DATA'}
        </span>
        <span style={{ color: '#4b5563', fontSize: 11 }}>
          = RD03-1 OR RD03-2 &mdash; the value the engine acts on
        </span>
      </div>

      <div style={{ color: '#4b5563', fontSize: 11, lineHeight: 1.55 }}>
        The cone is the datasheet envelope (Rd-03 V1 wall-mount, &plusmn;60&#176;, ~10&nbsp;m for
        motion); the dashed arc is the shorter micro-motion reach, inside which a
        <em> still</em> occupant is detectable. Neither is a measurement.
        <strong> No target position is shown, and that is deliberate.</strong> The Rd-03_V2 sends a
        target-distance field, but on this firmware it does not measure the room &mdash; it tracks
        the configured minimum range gate (min gate 1 &rarr; 0.35&nbsp;m, min gate 3 &rarr; 1.75&nbsp;m,
        with nothing in the room changing). Drawing it would invent a position. Presence comes from
        the OT2 pin, which does follow the room.
      </div>
    </div>
  );
}
