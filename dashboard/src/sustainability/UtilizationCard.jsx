import React from 'react';
import { Users } from 'lucide-react';
import { S } from './styles';

// Space utilization: measured occupancy against the area being conditioned for it, per
// zone. Design area per occupant comes from the programme library, not from constants here.
export default function UtilizationCard({
  totalLiveOccupants,
  totalBuildingCapacity,
  overallEfficiencyPercent,
  zones,
}) {
  return (
    <>
  {/* CARD 4: Space Utilization Breakdown */}
  <div data-testid="card-space-utilization" style={S.card}>
    <div style={S.cardHeader}>
      <h3 style={{ ...S.cardTitle, color: '#a78bfa' }}>
        <Users size={15} />
        Space Utilization Efficiency
      </h3>
      <span
        style={{
          ...S.badge,
          background: 'rgba(167, 139, 250, 0.15)',
          color: '#c4b5fd',
          border: '1px solid rgba(167, 139, 250, 0.3)',
        }}
      >
        Occupancy Analytics
      </span>
    </div>

    {/* Overall Efficiency Overview */}
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
      <div>
        <div style={S.dimLabel}>Building Space Efficiency</div>
        <div data-testid="metric-space-efficiency" style={{ ...S.metricValue, color: '#a78bfa', fontSize: '22px' }}>
          {overallEfficiencyPercent.toFixed(1)}%
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={S.dimLabel}>Occupants vs Capacity</div>
        <div style={{ fontSize: '14px', fontWeight: 'bold' }}>
          <span data-testid="metric-live-occupants">{totalLiveOccupants}</span>
          {' / '}
          <span data-testid="metric-building-capacity">{totalBuildingCapacity}</span>
          <span style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 'normal' }}> PAX</span>
        </div>
      </div>
    </div>

    {/* Efficiency Progress Bar */}
    <div
      style={{
        height: '6px',
        background: 'rgba(255,255,255,0.08)',
        borderRadius: '3px',
        overflow: 'hidden',
        marginBottom: '14px',
      }}
    >
      <div
        style={{
          width: `${Math.min(100, Math.max(0, overallEfficiencyPercent))}%`,
          background: overallEfficiencyPercent > 70 ? '#10b981' : overallEfficiencyPercent > 30 ? '#38bdf8' : '#f59e0b',
          height: '100%',
          transition: 'width 0.4s ease',
        }}
      />
    </div>

    {/* Zone-by-Zone Table */}
    {zones && zones.length > 0 && (
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', color: '#94a3b8', textAlign: 'left' }}>
              <th style={{ padding: '6px 4px', fontWeight: '600' }}>Zone ID</th>
              <th style={{ padding: '6px 4px', textAlign: 'center', fontWeight: '600' }}>Live</th>
              <th style={{ padding: '6px 4px', textAlign: 'center', fontWeight: '600' }}>Cap</th>
              <th style={{ padding: '6px 4px', textAlign: 'right', fontWeight: '600' }}>Efficiency</th>
            </tr>
          </thead>
          <tbody>
            {zones.map((z, idx) => {
              const eff = Number(z?.efficiencyPercent) || 0;
              return (
                <tr
                  key={idx}
                  data-testid="zone-space-item"
                  style={{
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                    background: idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)',
                  }}
                >
                  <td style={{ padding: '6px 4px', color: '#e2e8f0', fontWeight: '500' }}>{z?.zoneId || '—'}</td>
                  <td style={{ padding: '6px 4px', textAlign: 'center', color: '#38bdf8' }}>{z?.liveOccupants ?? 0}</td>
                  <td style={{ padding: '6px 4px', textAlign: 'center', color: '#94a3b8' }}>{z?.designCapacity ?? 0}</td>
                  <td style={{ padding: '6px 4px', textAlign: 'right', fontWeight: 'bold' }}>
                    <span
                      style={{
                        color: eff > 75 ? '#34d399' : eff < 30 ? '#f87171' : '#fbbf24',
                      }}
                    >
                      {eff.toFixed(1)}%
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    )}
  </div>
    </>
  );
}
