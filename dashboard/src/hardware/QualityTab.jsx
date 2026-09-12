import React from 'react';
import { S, safeTime } from './shared';


export function QualityTab({ quality, setQMinutes, qMinutes }) {
  return (
    <div style={S.card}>
      <div style={S.chartHead}>
        <p style={{ ...S.dim, margin: 0, maxWidth: 620, lineHeight: 1.6 }}>
          How much of stored history is evidence rather than simulation. A chart drawn over
          mostly <strong>modelled</strong> rows describes the twin, not the building.
        </p>
        <span>
          {[15, 60, 360, 1440].map((m) => (
            <button key={m} style={S.btn(qMinutes === m)} onClick={() => setQMinutes?.(m)}>
              {m < 60 ? `${m}m` : `${(m / 60).toFixed(0)}h`}
            </button>
          ))}
        </span>
      </div>
      {quality == null && (
        <div style={S.empty}>
          counting rows over the last {qMinutes < 60 ? `${qMinutes}m` : `${(qMinutes / 60).toFixed(0)}h`}…
          <br /><span style={{ fontSize: 11 }}>the engine writes ~1500 rows/s, so a wide window takes a while</span>
        </div>
      )}
      {quality?.error && <div style={S.warn}>query failed — is the database up?</div>}
      {quality?.totals && (
        <div style={S.totals}>
          {Object.entries(quality.totals).map(([k, v]) => (
            <div key={k} style={S.total}>
              <div
                style={{
                  fontSize: 22,
                  fontWeight: 700,
                  color: k === 'measured' ? '#4ade80' : k === 'modelled' ? '#f59e0b' : '#60a5fa',
                }}
              >
                {(v ?? 0).toLocaleString()}
              </div>
              <div style={S.dim}>{k} rows</div>
            </div>
          ))}
        </div>
      )}
      <table style={S.table}>
        <thead>
          <tr>
            <th style={S.th}>quality</th>
            <th style={S.th}>device</th>
            <th style={S.th}>metric</th>
            <th style={S.th}>rows</th>
            <th style={S.th}>span</th>
          </tr>
        </thead>
        <tbody>
          {(quality?.breakdown || []).map((r, i) => (
            <tr key={i}>
              <td
                style={{
                  ...S.td,
                  color: r?.quality === 'measured' ? '#4ade80' : r?.quality === 'modelled' ? '#f59e0b' : '#9ca3af',
                }}
              >
                {r?.quality ?? '—'}
              </td>
              <td style={S.td}>{r?.device ?? '—'}</td>
              <td style={S.td}>{r?.metric ?? '—'}</td>
              <td style={S.td}>{(r?.rows ?? 0).toLocaleString()}</td>
              <td style={S.td}>
                {safeTime(r?.from)} → {safeTime(r?.to)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
