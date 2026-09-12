import React, { useState, useEffect } from 'react';
import { Download, Cpu } from 'lucide-react';
import { useLocalModel } from '../useLocalModel';
import { API_BASE } from '../api';

// Packages the twin's learned models into a downloadable bundle, and reports which
// hardware tier the browser probe says this machine can run them on.
export default function ModelExportCard() {
  const [info, setInfo] = useState(null);
  const { profile, rec, tier, selected, setOverride, exportUrl, error } = useLocalModel();
  const [showTiers, setShowTiers] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE}/api/model`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setInfo(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const est = info?.baseline?.established ?? 0;
  const learning = info?.baseline?.learning ?? 0;
  const roomsId = info?.rooms?.identified ?? 0;
  const roomsLearning = info?.rooms?.learning ?? 0;
  const forecaster = info?.forecaster;

  // What this machine looks like, in the browser's own (limited) terms. Reported exactly
  // as measured — an unavailable value says so rather than showing a plausible guess.
  //
  // `rec &&` is not enough to dereference rec.profile. /api/model/recommend can answer 200
  // with a body this code does not expect -- a version mismatch, a proxy's JSON error
  // envelope -- and `rec.profile.cores` then throws inside render, taking the whole panel
  // down through the error boundary. Optional-chain every hop and fall back to the same
  // "measuring…" state an absent response produces: an unexpected shape is not a reason to
  // show a blank dashboard.
  const machine = rec?.profile
    ? [
        `${rec.profile.cores || '?'} cores`,
        rec.memoryBasis === 'reported' ? `${rec.effectiveMemoryGb ?? '?'} GB` : `~${rec.effectiveMemoryGb ?? '?'} GB est.`,
        // gpu.name is the product on its own ("Apple M4"); gpu.label is the raw WebGL
        // renderer string, which browsers wrap in ANGLE boilerplate and which reads as
        // noise in a summary line.
        rec.gpu?.name || rec.gpu?.label || 'no GPU detected',
      ].join(' · ')
    : 'measuring…';

  const rows = [
    ['Learned baselines', `${est} signal${est === 1 ? '' : 's'} established · ${learning} learning`],
    ['Room models', `${roomsId} identified · ${roomsLearning} learning`],
    ['LSTM forecaster', forecaster ? (forecaster.ready ? 'trained · included' : forecaster.reachable ? 'reachable · not yet trained' : 'offline · omitted') : '—'],
    ['This machine', machine],
  ];

  return (
    <div style={{ marginTop: '4px', background: 'rgba(0,163,224,0.05)', border: '1px solid rgba(0,163,224,0.3)', borderRadius: '10px', padding: '14px', position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '4px', background: 'var(--accent-blue)' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
        <div style={{ padding: '6px', background: 'rgba(255,255,255,0.05)', borderRadius: '6px', display: 'flex' }}>
          <Cpu size={18} color="var(--accent-blue)" />
        </div>
        <span style={{ fontSize: '12px', fontWeight: 'bold', color: 'var(--accent-blue)' }}>Local Models</span>
        {tier && (
          <span style={{ marginLeft: 'auto', fontSize: '8px', fontWeight: 'bold', letterSpacing: '0.05em', padding: '1px 5px', borderRadius: '3px', color: 'var(--accent-green)', border: '1px solid var(--accent-green)' }}>
            MATCHED TO THIS MACHINE
          </span>
        )}
      </div>

      <p style={{ margin: '0 0 8px 0', fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        Take the intelligence offline: the learned baselines, every room’s identified physical model, and a runtime that reproduces the same predictions on your own machine — no server, no network.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', rowGap: '3px', columnGap: '10px', marginBottom: '10px' }}>
        {rows.map(([k, v]) => (
          <React.Fragment key={k}>
            <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{k}</span>
            <span style={{ fontSize: '10px', fontFamily: 'monospace', color: 'var(--text-primary)', textAlign: 'right' }}>{v}</span>
          </React.Fragment>
        ))}
      </div>

      {/* The recommendation, with its reasoning — a pick the operator can overrule. */}
      {tier && (
        <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-glass)', borderRadius: '6px', padding: '10px', marginBottom: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', marginBottom: '4px' }}>
            <span style={{ fontSize: '11px', fontWeight: 'bold', color: 'var(--text-primary)' }}>{tier.name}</span>
            <span style={{ fontSize: '9px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
              {tier.approxSizeMb >= 1024 ? `${(tier.approxSizeMb / 1024).toFixed(1)} GB` : `${tier.approxSizeMb} MB`} · {tier.runtime}
            </span>
          </div>
          <p style={{ margin: '0 0 6px 0', fontSize: '10px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{tier.summary}</p>
          {rec?.rationale && selected === rec.recommended && (
            <p style={{ margin: '0 0 6px 0', fontSize: '10px', color: 'var(--accent-green)', lineHeight: 1.45 }}>
              ✓ {rec.rationale}
            </p>
          )}
          {!tier.fits && (tier.blockers || []).map((b) => (
            <p key={b} style={{ margin: '0 0 3px 0', fontSize: '10px', color: 'var(--accent-yellow)', lineHeight: 1.45 }}>⚠ {b}</p>
          ))}
          <ul style={{ margin: '4px 0 0 0', paddingLeft: '14px' }}>
            {(tier.capabilities || []).map((c) => (
              <li key={c} style={{ fontSize: '10px', color: 'var(--text-muted)', lineHeight: 1.5 }}>{c}</li>
            ))}
          </ul>
          {(rec?.notes || []).map((n) => (
            <p key={n} style={{ margin: '6px 0 0 0', fontSize: '9px', color: 'var(--text-muted)', lineHeight: 1.45, fontStyle: 'italic' }}>{n}</p>
          ))}
        </div>
      )}

      {error && (
        <p style={{ margin: '0 0 8px 0', fontSize: '10px', color: 'var(--accent-yellow)' }}>
          Could not size the bundle to this machine ({error}) — the default package is still available.
        </p>
      )}

      {/* Overrule the pick: the server reasons from what the browser admits to, and a
          machine that reports nothing is exactly the one whose owner knows better. */}
      {rec?.tiers?.length > 0 && (
        <div style={{ marginBottom: '10px' }}>
          <button
            onClick={() => setShowTiers((v) => !v)}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: '10px', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
          >
            {showTiers ? '▴ hide other tiers' : '▾ choose a different tier'}
          </button>
          {showTiers && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px' }}>
              {rec.tiers.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setOverride(t.id)}
                  style={{
                    textAlign: 'left', cursor: 'pointer', borderRadius: '4px', padding: '6px 8px',
                    background: t.id === selected ? 'rgba(0,163,224,0.15)' : 'transparent',
                    border: `1px solid ${t.id === selected ? 'var(--accent-blue)' : 'var(--border-glass)'}`,
                    color: t.fits ? 'var(--text-primary)' : 'var(--text-muted)', fontSize: '10px',
                  }}
                >
                  {t.recommended ? '★ ' : ''}{t.name}
                  <span style={{ color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                    {' '}· {t.approxSizeMb >= 1024 ? `${(t.approxSizeMb / 1024).toFixed(1)} GB` : `${t.approxSizeMb} MB`}
                    {!t.fits ? ' · exceeds this machine' : ''}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <a
        href={exportUrl}
        download
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
          padding: '10px', borderRadius: '6px', textDecoration: 'none',
          background: 'var(--accent-blue)', color: '#000', fontSize: '11px', fontWeight: 'bold', letterSpacing: '0.02em',
        }}
      >
        <Download size={14} /> DOWNLOAD {tier ? tier.name.toUpperCase() : 'MODEL BUNDLE'} (.zip)
      </a>
      {rec?.workers > 1 && (
        <p style={{ margin: '6px 0 0 0', fontSize: '9px', color: 'var(--text-muted)', textAlign: 'center' }}>
          Bundle is configured for {rec.workers} parallel workers on this machine.
        </p>
      )}
    </div>
  );
}

// AfddDriftDetail pulls the zone's persisted AFDD residual from TimescaleDB
// (/api/series) and charts it — the maintenance evidence behind a physics-divergence
// alert. A residual that has been climbing for an hour is a developing fault; a spike
// that just appeared is worth a second look before dispatching anyone. The 2.0 °C
// reference line is the engine's own afddThreshold (the level that raised this card).
