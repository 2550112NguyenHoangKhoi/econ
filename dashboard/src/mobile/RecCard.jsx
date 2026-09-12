import React, { useState } from 'react';
import RecommendationEvidence from '../RecommendationEvidence';
import { powerMw } from '../units';
import { badgeTone } from './badgeTone';

// RecCard is one recommendation as a phone-sized card: what the twin found, what it would
// do about it, and the evidence behind both.
export default function RecCard({ rec, done, onEngage, model, matureAfter, limit, forecast }) {
  const actionable = !!rec.onAction;
  const [showWhy, setShowWhy] = useState(false);
  const fc = rec.forecast || (rec.id === 'forecast' ? forecast : null);

  return (
    <div style={{ position: 'relative', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '14px', padding: '16px 16px 16px 20px', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '4px', background: rec.accent }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
        <div style={{ padding: '6px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px', display: 'flex' }}>{rec.icon}</div>
        <span style={{ fontSize: '15px', fontWeight: 700, color: rec.accent, flex: 1 }}>{rec.title}</span>
        {rec.badge && (
          <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '0.05em', padding: '2px 6px', borderRadius: '4px', flexShrink: 0, color: badgeTone(rec.badge), border: `1px solid ${badgeTone(rec.badge)}` }}>
            {rec.badge}
          </span>
        )}
      </div>
      <p style={{ margin: '0 0 6px 0', fontSize: '13px', color: 'rgba(255,255,255,0.72)', lineHeight: 1.45 }}>{rec.message}</p>

      {/* Model diagnostics for the forecast recommendation on mobile (avoiding duplicate chart) */}
      {rec.id === 'forecast' && fc && (
        <div style={{ marginTop: '8px', padding: '8px 10px', background: 'rgba(74, 144, 226, 0.08)', borderRadius: '8px', border: '1px solid rgba(74, 144, 226, 0.2)', fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'rgba(255,255,255,0.6)' }}>Engine:</span>
            <span style={{ fontWeight: 700, color: '#4A90E2', fontFamily: 'monospace' }}>{fc.engine === 'timesfm' ? 'Google TimesFM 200M' : 'Supervised LSTM'}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'rgba(255,255,255,0.6)' }}>Horizon:</span>
            <span style={{ fontFamily: 'monospace', color: 'rgba(255,255,255,0.9)' }}>{(fc.seriesData?.length || 12) * (fc.stepMinutes || 5)} min</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'rgba(255,255,255,0.6)' }}>Peak Load:</span>
            <span style={{ fontWeight: 700, color: '#4A90E2', fontFamily: 'monospace' }}>{fc.peakUpperMw ? powerMw(fc.peakUpperMw) : (fc.lstmPeakMw ? powerMw(fc.lstmPeakMw) : '—')}</span>
          </div>
        </div>
      )}

      {/* A state the engine is already in, rather than something to press. Without this
          the pre-cool card went silent exactly when a window was open. */}
      {rec.status && (
        <div style={{ marginTop: '4px', fontSize: '12px', fontWeight: 700, color: '#3DDC84' }}>{rec.status}</div>
      )}

      {/* The same evidence the desktop shows — the learned band, the σ position, the
          identified response — rather than a conclusion the operator cannot check. */}
      {rec.rec && (
        <>
          <button
            onClick={() => setShowWhy((v) => !v)}
            style={{ marginTop: '4px', background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.45)', fontSize: '12px', cursor: 'pointer', padding: '4px 0', textDecoration: 'underline' }}
          >
            {showWhy ? '▴ hide the evidence' : '▾ why this fired'}
          </button>
          {showWhy && (
            <RecommendationEvidence rec={rec.rec} model={model} matureAfter={matureAfter} limit={limit} forecast={fc || forecast} />
          )}
        </>
      )}

      {actionable && (
        <button
          onClick={() => { rec.onAction(); onEngage(); }}
          disabled={done}
          style={{
            marginTop: '8px', width: '100%', padding: '12px', borderRadius: '10px', cursor: done ? 'default' : 'pointer',
            background: done ? 'rgba(52,199,89,0.15)' : rec.accent, color: done ? '#34C759' : '#000',
            border: 'none', fontSize: '14px', fontWeight: 700, letterSpacing: '0.02em',
          }}
        >
          {done ? '✓ ENGAGED' : rec.actionLabel}
        </button>
      )}
    </div>
  );
}
