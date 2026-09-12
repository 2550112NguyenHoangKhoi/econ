import React, { useState, useEffect } from 'react';
import { API_BASE } from '../api';
import { useLocalModel } from '../useLocalModel';
import { Download, Cpu } from 'lucide-react';

// ModelDownloadMobile is the phone-sized "take the intelligence with you" surface: it
// downloads the learned baseline model, the LSTM forecaster, and a dependency-free
// recommender as one zip (GET /api/model/export) so the operator can run the same σ-scored
// recommendations and alerts offline. Reads /api/model for the model's live maturity.
export default function ModelDownloadMobile() {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE}/api/model`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setInfo(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const { rec, tier, exportUrl } = useLocalModel();
  const est = info?.baseline?.established ?? 0;
  const learning = info?.baseline?.learning ?? 0;
  const roomsId = info?.rooms?.identified ?? 0;
  const fc = info?.forecaster;
  const fcLabel = fc ? (fc.ready ? 'LSTM included' : fc.reachable ? 'LSTM not yet trained' : 'LSTM offline') : '';

  return (
    <div style={{ marginTop: '22px', padding: '18px', borderRadius: '16px', background: 'rgba(74,144,226,0.08)', border: '1px solid rgba(74,144,226,0.35)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
        <Cpu size={20} color="#4A90E2" />
        <span style={{ fontSize: '15px', fontWeight: 700, color: '#4A90E2' }}>Local Models</span>
      </div>
      <p style={{ margin: '0 0 12px 0', fontSize: '13px', color: 'rgba(255,255,255,0.72)', lineHeight: 1.45 }}>
        Download the learned baselines, every room’s identified physical model, and a runtime that reproduces the same predictions offline — sized to this device.
        {info && (
          <span style={{ display: 'block', marginTop: '6px', fontSize: '11px', color: 'rgba(255,255,255,0.45)' }}>
            {est} signal{est === 1 ? '' : 's'} established · {roomsId} room model{roomsId === 1 ? '' : 's'} identified{fcLabel ? ` · ${fcLabel}` : ''}
          </span>
        )}
        {tier && (
          <span style={{ display: 'block', marginTop: '6px', fontSize: '11px', color: 'rgba(255,255,255,0.55)' }}>
            Matched to this device: <strong style={{ color: '#4A90E2' }}>{tier.name}</strong>
            {' '}({tier.approxSizeMb >= 1024 ? `${(tier.approxSizeMb / 1024).toFixed(1)} GB` : `${tier.approxSizeMb} MB`}) — {rec?.profile?.cores || '?'} cores
            {rec?.gpu?.capable ? `, ${rec.gpu.kind} GPU` : ''}.
          </span>
        )}
      </p>
      <a
        href={exportUrl}
        download
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
          width: '100%', boxSizing: 'border-box', padding: '13px', borderRadius: '10px', textDecoration: 'none',
          background: '#4A90E2', color: '#000', fontSize: '14px', fontWeight: 700, letterSpacing: '0.02em',
        }}
      >
        <Download size={16} /> DOWNLOAD {tier ? tier.name.toUpperCase() : 'MODEL BUNDLE'}
      </a>
    </div>
  );
}
