import React, { useState, useEffect } from 'react';
import { ResponsiveContainer, LineChart, XAxis, YAxis, Tooltip, ReferenceLine, Line } from 'recharts';
import { API_BASE } from '../api';

// Expands one fault-detection finding into the drift evidence behind it -- the baseline
// the zone is being scored against, and by how many sigma it has moved.
export default function AfddDriftDetail({ zoneId }) {
  const [series, setSeries] = useState(null); // null = loading, [] = no history yet
  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE}/api/series?zone=${encodeURIComponent(zoneId)}&metric=afddResidual&minutes=120`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => { if (alive) setSeries(Array.isArray(d) ? d : []); })
      .catch(() => { if (alive) setSeries([]); });
    return () => { alive = false; };
  }, [zoneId]);

  if (series === null) {
    return <div style={{ marginTop: '6px', fontSize: '10px', color: 'var(--text-muted)' }}>Loading residual history…</div>;
  }
  if (series.length === 0) {
    return (
      <div style={{ marginTop: '6px', fontSize: '10px', color: 'var(--text-muted)' }}>
        No persisted residual yet — history begins once TimescaleDB has logged this sensor-bound zone (≈1 Hz). The live residual is on the node badge above.
      </div>
    );
  }
  const data = series.map((p) => ({ t: p.t.slice(11, 16), r: +p.v.toFixed(2) }));
  const peak = data.reduce((m, d) => Math.max(m, d.r), 0);
  return (
    <div style={{ marginTop: '6px' }}>
      <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginBottom: '4px', letterSpacing: '0.04em' }}>
        AFDD RESIDUAL · |MEASURED − 2R1C MODEL| · LAST 2H · PEAK {peak.toFixed(1)}°C
      </div>
      <div style={{ width: '100%', height: 120 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -22 }}>
            <XAxis dataKey="t" tick={{ fontSize: 8, fill: 'var(--text-muted)' }} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.1)' }} interval="preserveStartEnd" minTickGap={40} />
            <YAxis tick={{ fontSize: 8, fill: 'var(--text-muted)' }} tickLine={false} axisLine={false} domain={[0, 'auto']} />
            <Tooltip contentStyle={{ background: 'rgba(10,10,10,0.95)', border: '1px solid var(--border-glass)', borderRadius: 6, fontSize: 10 }} labelStyle={{ color: 'var(--text-secondary)' }} formatter={(v) => [`${v}°C`, 'residual']} />
            <ReferenceLine y={2.0} stroke="var(--accent-red)" strokeDasharray="4 4" label={{ value: 'FAULT', fontSize: 8, fill: 'var(--accent-red)', position: 'insideTopRight' }} />
            <Line type="monotone" dataKey="r" stroke="var(--accent-red)" strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}


// RoomModelsCard renders the identified physics behind every prediction this panel makes.
//
// /api/rooms/models has shipped complete and correct with no consumer at all, which meant
// the twin's genuine differentiator — that it recovers each room's own thermal and
// ventilation constants from that room's own history — was invisible in the product built
// on top of it. The panel could say "this room breaches in 14 minutes" but could not show
// the time constant that produced the number, how many samples backed it, or how closely
// the fit reproduces what the room then did.
//
// The provenance column is the point. A cooling authority identified entirely against the
// library's DESIGN supply temperature is still a real fit, but it inherits that
// assumption's error; one identified against a measured discharge probe does not. An
// engineer deciding whether to dispatch someone on a capability finding needs to know
// which of the two they are reading, and until this card there was nowhere to find out.
// HardwareReachCard — what the AI is actually wired to.
//
// The engine's recommendation pass now refuses, in real mode, to ask for an actuation that
// no hardware could carry out (server/simulation/capability.go). That is the right
// behaviour and it creates a reporting problem: the cards it withholds leave no trace, so a
// panel that has gone quiet because the building is fine and one that has gone quiet
// because it is connected to nothing read exactly the same.
//
// This card is the denominator. Every figure is a count the engine sent; nothing is
// derived, defaulted or inferred here, and a payload that has not arrived renders nothing
// at all rather than a row of zeros — a fabricated zero would assert the very thing that
// has not been established.
