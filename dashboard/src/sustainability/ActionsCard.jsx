import React from 'react';
import { Zap, RotateCcw, Wind, ArrowUpRight, TrendingDown } from 'lucide-react';
import { S } from './styles';

// The decarbonization controls, and the banner reporting what the engine did with them.
// Labels say what the command does: SETPOINT= is absolute, so a relative label would lie.
export default function ActionsCard({
  carbon,
  dispatchAction,
  actionLoading,
  actionStatus,
}) {
  return (
    <>
  {/* CARD 5: Actionable Decarbonization Controls */}
  <div data-testid="card-decarbonization-controls" style={S.card}>
    <div style={S.cardHeader}>
      <h3 style={{ ...S.cardTitle, color: '#f43f5e' }}>
        <TrendingDown size={15} />
        Actionable Decarbonization Controls
      </h3>
      <span
        style={{
          ...S.badge,
          background: 'rgba(244, 63, 94, 0.15)',
          color: '#fb7185',
          border: '1px solid rgba(244, 63, 94, 0.3)',
        }}
      >
        Peak Shave Veto
      </span>
    </div>

    <p style={{ fontSize: '11px', color: '#94a3b8', margin: '0 0 12px 0', lineHeight: 1.4 }}>
      Immediate operator overrides to curtail carbon intensity and shave equipment peak demand:
    </p>

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px', marginBottom: '12px' }}>
      <button
        data-testid="btn-action-shed-plugs"
        disabled={actionLoading}
        onClick={() => dispatchAction('PLUG_OFF', 'Shed Idle Plugs')}
        style={{
          ...S.btnAction,
          borderColor: '#f59e0b',
          color: '#fbbf24',
        }}
      >
        <Zap size={13} />
        <span>Shed Idle Plugs</span>
      </button>

      {/* Labelled by what it does. SETPOINT= is absolute, so the old "+2°C" was only
          true while the building's base setpoint happened to be 24. */}
      <button
        data-testid="btn-action-eco-setback"
        disabled={actionLoading}
        onClick={() => dispatchAction('SETPOINT=26.0', 'Eco Setback (26°C)')}
        style={{
          ...S.btnAction,
          borderColor: '#10b981',
          color: '#34d399',
        }}
      >
        <ArrowUpRight size={13} />
        <span>Eco Setback (26°C)</span>
      </button>

      <button
        data-testid="btn-action-precool"
        disabled={actionLoading}
        onClick={() => dispatchAction('precool', 'Pre-cool Peak Shave')}
        style={{
          ...S.btnAction,
          borderColor: '#38bdf8',
          color: '#38bdf8',
        }}
      >
        <Wind size={13} />
        <span>Pre-cool Peak Shave</span>
      </button>

      <button
        data-testid="btn-action-purge"
        disabled={actionLoading}
        onClick={() => dispatchAction('purge', 'Purge Free-Cooling')}
        style={{
          ...S.btnAction,
          borderColor: '#a78bfa',
          color: '#c4b5fd',
        }}
      >
        <Wind size={13} />
        <span>Purge Free-Cooling</span>
      </button>
    </div>

    <button
      data-testid="btn-action-reset"
      disabled={actionLoading}
      onClick={() => dispatchAction('reset', 'Reset to Baseline')}
      style={{
        ...S.btnAction,
        width: '100%',
        borderColor: 'rgba(255,255,255,0.15)',
        color: '#94a3b8',
      }}
    >
      <RotateCcw size={12} />
      <span>Reset All Overrides to Baseline</span>
    </button>

    {/* Action execution feedback banner */}
    {actionStatus && (
      <div
        data-testid="status-action-feedback"
        style={{
          marginTop: '10px',
          padding: '8px 10px',
          borderRadius: '6px',
          fontSize: '11px',
          background:
            actionStatus.type === 'success'
              ? 'rgba(16, 185, 129, 0.15)'
              : actionStatus.type === 'error'
              ? 'rgba(239, 68, 68, 0.15)'
              : 'rgba(56, 189, 248, 0.15)',
          border: `1px solid ${
            actionStatus.type === 'success'
              ? 'rgba(16, 185, 129, 0.3)'
              : actionStatus.type === 'error'
              ? 'rgba(239, 68, 68, 0.3)'
              : 'rgba(56, 189, 248, 0.3)'
          }`,
          color:
            actionStatus.type === 'success'
              ? '#34d399'
              : actionStatus.type === 'error'
              ? '#f87171'
              : '#38bdf8',
        }}
      >
        {actionStatus.message} {actionStatus.timestamp && `(${actionStatus.timestamp})`}
      </div>
    )}
  </div>
    </>
  );
}
