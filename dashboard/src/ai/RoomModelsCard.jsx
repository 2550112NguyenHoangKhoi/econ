import React, { useState } from 'react';
import { Activity } from 'lucide-react';

// Per-room identification status: which rooms have a mature fit, which are still learning,
// and the coefficients each identified room taught the twin about itself.
export default function RoomModelsCard({ rooms = [], identified = 0, matureAfter, learning = 0, setSelectedZone }) {
  const [open, setOpen] = useState(false);

  // Nothing identified yet is a real state with a real explanation, not an empty card:
  // identification needs a room to MOVE, so a cold start legitimately shows zero.
  if (!rooms.length) {
    return (
      <div style={{ marginTop: '4px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-glass)', borderRadius: '10px', padding: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
          <Activity size={16} color="var(--text-muted)" />
          <span style={{ fontSize: '12px', fontWeight: 'bold', color: 'var(--text-secondary)' }}>Room Models</span>
        </div>
        <p style={{ margin: 0, fontSize: '10px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
          No room identified yet{learning > 0 ? ` — ${learning} still learning` : ''}. Identification needs a room to actually move: the engine samples every 5 minutes of simulated time and a fit matures at {matureAfter || 36} accepted samples, so a freshly-started twin has nothing here for roughly the first three hours. That is the model being honest, not a fault.
        </p>
      </div>
    );
  }

  const shown = open ? rooms : rooms.slice(0, 4);

  return (
    <div style={{ marginTop: '4px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-glass)', borderRadius: '10px', padding: '14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
        <Activity size={16} color="var(--accent-green)" />
        <span style={{ fontSize: '12px', fontWeight: 'bold', color: 'var(--accent-green)' }}>Room Models</span>
        <span style={{ marginLeft: 'auto', fontSize: '9px', fontFamily: 'monospace', color: 'var(--text-muted)' }}>
          {identified} identified{learning > 0 ? ` · ${learning} learning` : ''}
        </span>
      </div>
      <p style={{ margin: '0 0 10px 0', fontSize: '10px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        Recovered from each room's own history by recursive least squares — not configured, not assumed. Every prediction above is this model integrated forward.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {shown.map((m) => (
          <div
            key={m.zone}
            onClick={() => setSelectedZone && setSelectedZone(m.zone)}
            title="Click to fly the 3D view to this room"
            style={{ background: 'rgba(255,255,255,0.03)', borderRadius: '6px', padding: '8px', cursor: setSelectedZone ? 'pointer' : 'default' }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginBottom: '4px' }}>
              <span style={{ fontSize: '10px', fontWeight: 'bold', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.label}</span>
              <span style={{ marginLeft: 'auto', fontSize: '8px', fontWeight: 'bold', padding: '1px 4px', borderRadius: '3px', flexShrink: 0,
                color: m.thermalReady ? 'var(--accent-green)' : 'var(--text-muted)',
                border: `1px solid ${m.thermalReady ? 'var(--accent-green)' : 'rgba(127,139,150,0.3)'}` }}>
                {m.thermalReady ? 'THERMAL' : `THERMAL ${m.thermalSamples}/${matureAfter || 36}`}
              </span>
              <span style={{ fontSize: '8px', fontWeight: 'bold', padding: '1px 4px', borderRadius: '3px', flexShrink: 0,
                color: m.co2Ready ? 'var(--accent-green)' : 'var(--text-muted)',
                border: `1px solid ${m.co2Ready ? 'var(--accent-green)' : 'rgba(127,139,150,0.3)'}` }}>
                {m.co2Ready ? 'CO₂' : 'CO₂ —'}
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', rowGap: '2px', columnGap: '8px' }}>
              {m.thermalReady && (
                <>
                  <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>Time constant</span>
                  <span style={{ fontSize: '9px', fontFamily: 'monospace', color: 'var(--text-primary)', textAlign: 'right' }}>{m.timeConstantMin.toFixed(0)} min</span>
                  <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>Fit residual</span>
                  <span style={{ fontSize: '9px', fontFamily: 'monospace', color: 'var(--text-primary)', textAlign: 'right' }}>{m.thermalResidual.toFixed(2)} °C/h</span>
                  <span style={{ fontSize: '9px', color: 'var(--text-muted)' }} title="Share of the cooling fit referenced to a MEASURED discharge-air probe rather than the library's design supply temperature">Supply-air basis</span>
                  <span style={{ fontSize: '9px', fontFamily: 'monospace', textAlign: 'right', color: (m.supplyMeasuredFrac || 0) > 0 ? 'var(--accent-green)' : 'var(--accent-yellow)' }}>
                    {(m.supplyMeasuredFrac || 0) > 0 ? `${((m.supplyMeasuredFrac) * 100).toFixed(0)}% measured` : 'design value'}
                  </span>
                </>
              )}
              {m.co2Ready && (
                <>
                  <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>Measured air change</span>
                  <span style={{ fontSize: '9px', fontFamily: 'monospace', color: 'var(--text-primary)', textAlign: 'right' }}>{m.achPerHour.toFixed(1)} ACH</span>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {rooms.length > 4 && (
        <button
          onClick={() => setOpen((v) => !v)}
          style={{ marginTop: '8px', background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: '10px', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
        >
          {open ? '▴ show fewer' : `▾ show all ${rooms.length} identified rooms`}
        </button>
      )}
    </div>
  );
}
