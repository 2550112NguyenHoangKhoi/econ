import React, { useState, useEffect, useCallback } from 'react';
import { API_BASE } from '../api';
import { DeviceControls } from './DeviceControls';
import { RadarEnvelope } from './Radar';
import { Spark } from './Spark';
import { FIELDS, S, ago, fmt } from './shared';


export function DeviceCard({ dev, staleAfter }) {
  if (!dev) return null;
  const [metric, setMetric] = useState(null);
  const [series, setSeries] = useState(null);
  const [minutes, setMinutes] = useState(60);
  const [showRaw, setShowRaw] = useState(false);

  const loadSeries = useCallback(async (m, mins) => {
    setSeries(null);
    try {
      const devId = dev?.id || '';
      const r = await fetch(`${API_BASE}/api/devices/series?device=${encodeURIComponent(devId)}&metric=${m}&minutes=${mins}`);
      const j = await r.json();
      setSeries(j.points || []);
    } catch { setSeries([]); }
  }, [dev?.id]);

  useEffect(() => { if (metric) loadSeries(metric, minutes); }, [metric, minutes, loadSeries]);

  const live = !!dev?.online;
  const reporting = Object.entries(dev?.fields || {}).filter(([, f]) => f && f.count > 0);
  const silent = Object.entries(dev?.fields || {}).filter(([, f]) => f && f.count === 0 && f.omitted > 0);

  return (
    <div style={{ ...S.card, borderLeft: `3px solid ${live ? '#4ade80' : '#ef4444'}` }}>
      <div style={S.cardHead}>
        <div>
          <span style={S.devId}>{dev.id}</span>
          <span style={S.badge(live ? '#4ade80' : '#ef4444')}>{live ? 'ONLINE' : 'OFFLINE'}</span>
          {!dev.bound && <span style={S.badge('#f59e0b')}>UNBOUND</span>}
          {dev.tempReal === false && <span style={S.badge('#f59e0b')}>tempReal:false</span>}
          {dev.acKnown && !dev.acReal && <span style={S.badge('#f59e0b')}>acReal:false</span>}
        </div>
        <div style={S.dim}>
          {dev.source || '?'} · {dev.zone || 'no label'} · last {ago(dev.ageSec)} · {typeof dev.rateHz === 'number' ? dev.rateHz.toFixed(2) : (Number(dev.rateHz) || 0).toFixed(2)} Hz · {dev.messages ?? 0} msgs
          {(dev.malformed ?? 0) > 0 && <span style={{ color: '#ef4444' }}> · {dev.malformed} malformed</span>}
        </div>
      </div>

      {!dev.bound && (
        <div style={S.warn}>
          Publishing, but the engine has not bound it to a zone. Usually the topic suffix does
          not match any zone id and no <code>zone</code> label in the payload matches either.
        </div>
      )}
      {!live && (
        <div style={S.warn}>
          Silent for more than {staleAfter}s. Check power and USB first, then WiFi, then whether
          the broker is reachable from the node.
        </div>
      )}

      {dev?.fields?.occupancy && (dev.fields.occupancy.count ?? 0) > 0 && (
        <div style={{ background: '#0d1117', border: '1px solid #1f2937', borderRadius: 4,
                      padding: 12, marginBottom: 12 }}>
          <div style={{ ...S.dim, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '.08em', fontSize: 11 }}>
            presence radar
          </div>
          <RadarEnvelope fields={dev.fields} online={live} dev={dev} />
        </div>
      )}

      <table style={S.table}>
        <thead>
          <tr><th style={S.th}>field</th><th style={S.th}>last</th><th style={S.th}>age</th>
              <th style={S.th}>n</th><th style={S.th}>omitted</th><th style={S.th}>range</th><th style={S.th}></th></tr>
        </thead>
        <tbody>
          {reporting.map(([name, f]) => {
            const meta = FIELDS[name] || {};
            const fage = f.at ? (Date.now() - new Date(f.at).getTime()) / 1000 : null;
            const stale = fage != null && fage > staleAfter;
            return (
              <tr key={name}>
                <td style={S.td}>{name}</td>
                <td style={{ ...S.td, color: stale ? '#f59e0b' : '#e5e7eb', fontWeight: 600 }}>{fmt(f.last, meta.unit)}</td>
                <td style={{ ...S.td, color: stale ? '#f59e0b' : '#9ca3af' }}>{ago(fage)}</td>
                <td style={S.td}>{f.count ?? 0}</td>
                <td style={{ ...S.td, color: (f.omitted ?? 0) > 0 ? '#f59e0b' : '#4b5563' }}>{f.omitted ?? 0}</td>
                <td style={S.td}>{f.min != null ? Number(f.min).toFixed(1) : '—'} … {f.max != null ? Number(f.max).toFixed(1) : '—'}</td>
                <td style={S.td}>
                  <button style={S.btn(metric === name)} onClick={() => setMetric(metric === name ? null : name)}>
                    {metric === name ? 'hide' : 'history'}
                  </button>
                </td>
              </tr>
            );
          })}
          {silent.map(([name, f]) => (
            <tr key={name}>
              <td style={{ ...S.td, color: '#6b7280' }}>{name}</td>
              <td colSpan={5} style={{ ...S.td, color: '#6b7280' }}>
                never reported — {f?.omitted ?? 0} messages without it
                {FIELDS[name]?.flag && <> · needs <code>{FIELDS[name].flag}</code></>}
              </td>
              <td style={S.td}></td>
            </tr>
          ))}
        </tbody>
      </table>

      {metric && (
        <div style={S.chartBox}>
          <div style={S.chartHead}>
            <strong>{metric}</strong>
            <span>
              {[15, 60, 360, 1440].map((m) => (
                <button key={m} style={S.btn(minutes === m)} onClick={() => setMinutes(m)}>
                  {m < 60 ? `${m}m` : `${m / 60}h`}
                </button>
              ))}
            </span>
          </div>
          {series === null ? <div style={S.empty}>loading…</div> : <Spark points={series} />}
        </div>
      )}

      <button style={S.linkBtn} onClick={() => setShowRaw(!showRaw)}>
        {showRaw ? 'hide' : 'show'} last raw payload
      </button>
      {showRaw && <pre style={S.pre}>{dev.lastJson || '(none)'}</pre>}

      <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #1f2937' }}>
        <DeviceControls targetZone={dev.zone || dev.id} targetDevice={dev.id} />
      </div>
    </div>
  );
}
