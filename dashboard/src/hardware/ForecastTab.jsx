import React, { useState, useEffect } from 'react';
import { API_BASE } from '../api';
import { powerMw } from '../units';
import { S } from './shared';



export function ForecastSpark({ values, width = 200, height = 40, colour = '#60a5fa' }) {
  if (!values || !Array.isArray(values) || values.length < 2) return null;
  const nums = values.map((v) => Number(v) || 0);
  const lo = Math.min(...nums), hi = Math.max(...nums);
  const span = hi - lo || 1;
  const d = nums
    .map((v, i) => {
      const x = (i / (nums.length - 1)) * width;
      const y = height - ((v - lo) / span) * (height - 8) - 4;
      return `${i ? 'L' : 'M'}${Number.isFinite(x) ? x.toFixed(1) : '0'},${Number.isFinite(y) ? y.toFixed(1) : '0'}`;
    })
    .join(' ');
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height, display: 'block' }}
    >
      <path d={d} fill="none" stroke={colour} strokeWidth="1.5" strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}


/**
 * Both forecasters, live, over the same instant.
 *
 * The LSTM is supervised and only knows this building once train.py has had real history
 * to learn from; TimesFM is a pretrained foundation model that forecasts a series it has
 * never seen. They answer the same question with opposite trade-offs, and until this panel
 * nothing in the system ever put their answers next to each other.
 *
 * The number that matters most here is not the forecast — it is `realSamples`. The LSTM's
 * 12-step window is left-padded while the engine warms up, so a confident-looking MW figure
 * can be standing on one real sample. Showing the peak without showing what backs it is how
 * a forecast gets trusted more than it has earned.
 */
export function ForecastTab() {
  const [data, setData] = useState(null);
  const [pending, setPending] = useState(true);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`${API_BASE}/api/forecast/compare?horizon=12`);
        const j = await r.json();
        if (alive) { setData(j); setPending(false); }
      } catch (e) {
        if (alive) { setData({ fetchError: e.message }); setPending(false); }
      }
    };
    tick();
    // Slower than the device poll: each call runs two model inferences, and the first
    // TimesFM call may be downloading a multi-gigabyte checkpoint.
    const id = setInterval(tick, 30000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const engines = [
    { key: 'lstm', name: 'LSTM', kind: 'supervised · trained on this building', colour: '#60a5fa' },
    { key: 'timesfm', name: 'TimesFM', kind: 'zero-shot · pretrained foundation model', colour: '#a78bfa' },
  ];

  if (pending) return <div style={S.card}><div style={S.empty}>asking both forecasters…</div></div>;
  if (data?.fetchError) {
    return <div style={S.card}><div style={S.warn}>could not reach the engine: {data.fetchError}</div></div>;
  }

  const agree = data?.agreement || {};

  return (
    <div style={S.card}>
      <p style={{ ...S.dim, margin: '0 0 14px', maxWidth: 700, lineHeight: 1.6 }}>
        Both engines, same instant, predicted <strong>peak building load</strong>. Neither is ground
        truth until it is compared against measured outturn — what to weigh them by is
        <strong> real samples</strong>, below.
      </p>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
        {engines.map(({ key, name, kind, colour }) => {
          const e = data?.[key] || {};
          const thin = e.available && e.windowLen && e.realSamples < e.windowLen;
          return (
            <div key={key} style={{ ...S.chartBox, flex: '1 1 300px', marginTop: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: colour }}>{name}</span>
                {/* Three states, not two. A degraded result is one infer.py produced with
                    no model behind it -- torch absent, or the checkpoint missing -- and it
                    still arrives with available:true because the endpoint did answer. Badging
                    that LIVE is how a placeholder gets read as a measurement. */}
                <span style={S.badge(e.degraded ? '#f59e0b' : e.available ? '#4ade80' : '#ef4444')}>
                  {e.degraded ? 'PLACEHOLDER' : e.available ? 'LIVE' : 'UNAVAILABLE'}
                </span>
              </div>
              <div style={{ ...S.dim, fontSize: 11, marginTop: 2 }}>{kind}</div>

              {e.available ? (
                <>
                  <div style={{
                    fontSize: 30, fontWeight: 700, margin: '10px 0 2px',
                    color: e.degraded ? '#f59e0b' : undefined,
                  }}>
                    {(Number(e.peakMw) || 0).toFixed(3)} <span style={{ fontSize: 14, color: '#9ca3af' }}>MW</span>
                  </div>
                  {e.degraded && (
                    <div style={{ fontSize: 11, color: '#f59e0b', lineHeight: 1.5, marginBottom: 4 }}>
                      not a model output — {e.basis || 'the forecaster answered without its model'}
                    </div>
                  )}
                  <div style={{ ...S.dim, fontSize: 11 }}>
                    backed by <strong style={{ color: thin ? '#f59e0b' : '#4ade80' }}>
                      {e.realSamples ?? 0}{e.windowLen ? ` / ${e.windowLen}` : ''}
                    </strong> real sample{e.realSamples === 1 ? '' : 's'}
                    {thin && ' — the rest of the window is padding'}
                  </div>
                  {e.series?.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <ForecastSpark values={e.series} colour={colour} />
                      <div style={S.sparkMeta}>
                        <span>horizon {data?.horizonMinutes ?? 12} min</span>
                        <span>step {data?.stepMinutes ?? 5} min</span>
                        <span>dashed = forecast, not history</span>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div style={{ ...S.dim, marginTop: 10, lineHeight: 1.6, fontSize: 12 }}>{e.error}</div>
              )}
            </div>
          );
        })}
      </div>

      {agree.comparable ? (
        <div style={agree.relativeDiff > 0.2 ? S.warn : { ...S.dim, lineHeight: 1.6 }}>
          The two disagree by <strong>{agree.relativeDiff != null ? (agree.relativeDiff * 100).toFixed(1) : '0.0'}%</strong>
          {' '}({powerMw(Math.abs(+(agree.deltaMw || 0)), { digits: 3 })}), {(agree.higher || '').toUpperCase()} higher.
          {agree.relativeDiff > 0.2 &&
            ' A gap this wide usually means one of them is forecasting from far less real history than the other — compare the sample counts above before believing either.'}
        </div>
      ) : (
        <div style={S.dim}>{agree.note}</div>
      )}
    </div>
  );
}
