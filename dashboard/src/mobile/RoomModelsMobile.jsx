import React, { useState } from 'react';

// RoomModelsMobile is the phone-sized view of what the twin has identified. Same data and
// same honesty as the desktop card: a room that has not been identified does not appear,
// and a cooling authority fitted against the library's design supply temperature says so
// rather than passing as a measured one.
export default function RoomModelsMobile({ rooms = [], identified = 0, matureAfter, learning = 0, onFocusZone }) {
  const [open, setOpen] = useState(false);
  if (!rooms.length) {
    return (
      <div style={{ marginTop: '22px', padding: '16px', borderRadius: '14px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
        <div style={{ fontSize: '15px', fontWeight: 700, marginBottom: '6px' }}>Room Models</div>
        <p style={{ margin: 0, fontSize: '12px', color: 'rgba(255,255,255,0.55)', lineHeight: 1.5 }}>
          None identified yet{learning > 0 ? ` — ${learning} still learning` : ''}. A room has to move before its physics is visible: samples are taken every 5 simulated minutes and a fit matures at {matureAfter || 36} of them.
        </p>
      </div>
    );
  }
  const shown = open ? rooms : rooms.slice(0, 3);
  return (
    <div style={{ marginTop: '22px', padding: '16px', borderRadius: '14px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: '6px' }}>
        <span style={{ fontSize: '15px', fontWeight: 700 }}>Room Models</span>
        <span style={{ marginLeft: 'auto', fontSize: '11px', fontFamily: 'ui-monospace, monospace', color: 'rgba(255,255,255,0.45)' }}>
          {identified} identified{learning > 0 ? ` · ${learning} learning` : ''}
        </span>
      </div>
      <p style={{ margin: '0 0 10px 0', fontSize: '12px', color: 'rgba(255,255,255,0.55)', lineHeight: 1.45 }}>
        Recovered from each room's own history, not configured. Every prediction above is one of these integrated forward.
      </p>
      {shown.map((m) => (
        <div
          key={m.zone}
          onClick={() => onFocusZone && onFocusZone(m.zone)}
          style={{ padding: '10px 0', borderTop: '1px solid rgba(255,255,255,0.06)', cursor: onFocusZone ? 'pointer' : 'default' }}
        >
          <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '4px' }}>{m.label}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', fontSize: '11px', fontFamily: 'ui-monospace, monospace', color: 'rgba(255,255,255,0.6)' }}>
            {m.thermalReady && <span>τ {m.timeConstantMin.toFixed(0)} min</span>}
            {m.thermalReady && <span>±{m.thermalResidual.toFixed(2)} °C/h</span>}
            {m.co2Ready && <span>{m.achPerHour.toFixed(1)} ACH</span>}
            {m.thermalReady && (
              <span style={{ color: (m.supplyMeasuredFrac || 0) > 0 ? '#3DDC84' : '#F5C242' }}>
                {(m.supplyMeasuredFrac || 0) > 0 ? `${((m.supplyMeasuredFrac) * 100).toFixed(0)}% measured supply` : 'design supply'}
              </span>
            )}
          </div>
        </div>
      ))}
      {rooms.length > 3 && (
        <button
          onClick={() => setOpen((v) => !v)}
          style={{ marginTop: '8px', background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.45)', fontSize: '12px', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
        >
          {open ? '▴ show fewer' : `▾ show all ${rooms.length}`}
        </button>
      )}
    </div>
  );
}
