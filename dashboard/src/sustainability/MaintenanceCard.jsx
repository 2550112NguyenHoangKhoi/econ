import React from 'react';
import { CheckCircle2, ShieldAlert } from 'lucide-react';
import { S } from './styles';

// Predictive-maintenance findings: equipment whose measured behaviour has drifted from
// the baseline it established for itself.
export default function MaintenanceCard({
  activeAlertsCount,
  warnings,
}) {
  return (
    <>
  {/* CARD 3: Predictive Maintenance Alerts */}
  <div data-testid="card-predictive-maintenance" style={S.card}>
    <div style={S.cardHeader}>
      <h3 style={{ ...S.cardTitle, color: '#fbbf24' }}>
        <ShieldAlert size={15} />
        Predictive Maintenance Alerts
      </h3>
      <span
        data-testid="maintenance-alert-count"
        style={{
          ...S.badge,
          background: activeAlertsCount > 0 ? 'rgba(239, 68, 68, 0.2)' : 'rgba(16, 185, 129, 0.2)',
          color: activeAlertsCount > 0 ? '#ef4444' : '#10b981',
          border: `1px solid ${activeAlertsCount > 0 ? 'rgba(239, 68, 68, 0.4)' : 'rgba(16, 185, 129, 0.4)'}`,
        }}
      >
        {activeAlertsCount} ACTIVE
      </span>
    </div>

    {activeAlertsCount === 0 ? (
      <div
        data-testid="maintenance-healthy-status"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '12px',
          background: 'rgba(16, 185, 129, 0.08)',
          border: '1px solid rgba(16, 185, 129, 0.2)',
          borderRadius: '6px',
          color: '#34d399',
          fontSize: '11px',
        }}
      >
        <CheckCircle2 size={16} />
        <span>All monitored electrical strips and HVAC compressors operating within nominal thermal/electrical thresholds.</span>
      </div>
    ) : (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {warnings.map((w, idx) => (
          <div
            key={idx}
            data-testid="maintenance-alert-item"
            style={{
              background: 'rgba(127, 29, 29, 0.2)',
              border: '1px solid rgba(239, 68, 68, 0.35)',
              borderRadius: '6px',
              padding: '10px 12px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
              <span style={{ fontSize: '11px', fontWeight: 'bold', color: '#f87171' }}>
                [{(w?.type || '').toUpperCase()}] {w?.equipmentId || 'Unknown'}
              </span>
              <span
                style={{
                  fontSize: '9px',
                  textTransform: 'uppercase',
                  padding: '1px 5px',
                  borderRadius: '3px',
                  background: w?.severity === 'critical' ? '#ef4444' : '#f59e0b',
                  color: '#ffffff',
                  fontWeight: 'bold',
                }}
              >
                {w?.severity || 'warning'}
              </span>
            </div>
            <div style={{ fontSize: '11px', color: '#fecaca', marginBottom: '6px' }}>{w?.message || 'Alert'}</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#94a3b8' }}>
              <span>Zone: <b>{w?.zoneId || '—'}</b></span>
              <span>Metric: <b>{(Number(w?.metricValue) || 0).toFixed(1)}</b> / Limit: <b>{(Number(w?.threshold) || 0).toFixed(1)}</b></span>
              <span>Health: <b>{w?.healthScore !== undefined ? `${w.healthScore}%` : 'N/A'}</b></span>
            </div>
            {w?.troubleshooting && w.troubleshooting.length > 0 && (
              <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid rgba(239, 68, 68, 0.2)' }}>
                <div style={{ fontSize: '10px', color: '#fca5a5', fontWeight: 'bold', marginBottom: '4px' }}>Recommended Troubleshooting:</div>
                <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '10px', color: '#fecaca' }}>
                  {w.troubleshooting.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))}
      </div>
    )}
  </div>
    </>
  );
}
