import React, { useState } from 'react';
import {
  Leaf,
  Coins,
  AlertTriangle,
  Users,
  Zap,
  RotateCcw,
  Wind,
  CheckCircle2,
  ExternalLink,
  ShieldAlert,
  ArrowUpRight,
  TrendingDown,
  RefreshCw,
} from 'lucide-react';
import { useSustainability } from './useSustainability';
import { API_BASE, getAdminToken } from './api';

const S = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: 'var(--text-primary, #f1f5f9)',
  },
  card: {
    background: 'rgba(15, 23, 42, 0.65)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: '10px',
    padding: '16px',
    boxShadow: '0 4px 20px rgba(0, 0, 0, 0.25)',
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '12px',
    borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
    paddingBottom: '8px',
  },
  cardTitle: {
    fontSize: '13px',
    fontWeight: '700',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    margin: 0,
  },
  dimLabel: {
    fontSize: '10px',
    color: 'var(--text-secondary, #94a3b8)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: '2px',
  },
  metricValue: {
    fontFamily: 'JetBrains Mono, ui-monospace, monospace',
    fontSize: '18px',
    fontWeight: '700',
    color: '#ffffff',
  },
  badge: {
    fontSize: '10px',
    fontWeight: '700',
    padding: '3px 8px',
    borderRadius: '999px',
    letterSpacing: '0.03em',
    textTransform: 'uppercase',
  },
  btnAction: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    padding: '8px 12px',
    borderRadius: '6px',
    border: '1px solid rgba(255, 255, 255, 0.12)',
    background: 'rgba(30, 41, 59, 0.7)',
    color: '#f8fafc',
    fontSize: '11px',
    fontWeight: '600',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
  },
};

export default function SustainabilityRecommendationsPanel({
  simData,
  sendManualOverride,
  customData,
}) {
  const hookResult = useSustainability(5000);
  const data = customData || hookResult.data;
  const loading = customData ? false : hookResult.loading;
  const error = customData ? null : hookResult.error;
  const refresh = hookResult.refresh;

  const [actionStatus, setActionStatus] = useState(null);
  const [actionLoading, setActionLoading] = useState(false);

  const dispatchAction = async (command, label, targetZone = 'GLOBAL') => {
    setActionLoading(true);
    setActionStatus({ message: `Dispatching ${label}...`, type: 'info' });

    try {
      if (typeof sendManualOverride === 'function') {
        sendManualOverride(command, targetZone);
      } else {
        const token = getAdminToken();
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['X-Admin-Token'] = token;

        await fetch(`${API_BASE}/api/command`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            zone: targetZone,
            command,
            action: command,
          }),
        });
      }

      setActionStatus({
        message: `Successfully executed: ${label}`,
        type: 'success',
        timestamp: new Date().toLocaleTimeString(),
      });
    } catch (err) {
      setActionStatus({
        message: `Failed: ${err.message || 'Error executing action'}`,
        type: 'error',
      });
    } finally {
      setActionLoading(false);
    }
  };

  const carbon = data?.carbonAccounting || {
    instantaneousPowerW: 0,
    instantaneousEmissionRateKgPerHour: 0,
    gridEmissionFactorKgPerKwh: 0.5,
    cumulativeEmissionsKgCO2e: 0,
    breakdown: { plugW: 0, stripW: 0, acW: 0 },
  };

  const offset = data?.carbonCreditRecommendations || {
    carbonBudgetKgCO2e: 50.0,
    currentEmissionsKgCO2e: 0,
    overBudget: false,
    deficitKgCO2e: 0,
    creditsNeededMetricTons: 0,
    wholeCertificatesNeeded: 0,
    marketQuote: {
      source: 'Toucan Protocol BCT (CoinGecko)',
      spotPricePerMetricTonUSD: 12.5,
      currency: 'USD',
      isLive: true,
      fetchedAt: new Date().toISOString(),
    },
    alternativeQuotes: [],
    estimatedCostUSD: 0,
    recommendation: 'Emissions are within target budget.',
  };

  const maintenance = data?.predictiveMaintenance || {
    activeAlertsCount: 0,
    warnings: [],
  };

  const space = data?.spaceUtilization || {
    totalLiveOccupants: 0,
    totalBuildingCapacity: 1,
    overallEfficiencyPercent: 0,
    zones: [],
  };

  // Environmental equivalent metrics
  const annualKgCO2e = (carbon.instantaneousPowerW / 1000.0) * 8760 * carbon.gridEmissionFactorKgPerKwh;
  const treesEquivalent = Math.max(0, Math.round(annualKgCO2e / 21.77)); // ~21.77 kgCO2/year per tree
  const carKmEquivalent = Math.max(0, Math.round(carbon.cumulativeEmissionsKgCO2e * 5.88)); // ~170 g/km for average vehicle

  return (
    <div data-testid="sustainability-panel" style={S.container}>
      {/* Top Controls Bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Leaf size={18} color="#10b981" />
          <span style={{ fontSize: '13px', fontWeight: 'bold', letterSpacing: '0.06em', color: '#10b981' }}>
            SUSTAINABILITY INTELLIGENCE
          </span>
        </div>
        <button
          data-testid="btn-refresh-sustainability"
          onClick={() => refresh && refresh()}
          disabled={loading}
          style={{
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '4px',
            color: 'var(--text-secondary, #94a3b8)',
            padding: '4px 8px',
            fontSize: '11px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
          }}
          title="Refresh Sustainability Telemetry"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          <span>Refresh</span>
        </button>
      </div>

      {error && (
        <div
          data-testid="sustainability-error"
          style={{
            background: 'rgba(239, 68, 68, 0.15)',
            border: '1px solid rgba(239, 68, 68, 0.4)',
            color: '#fca5a5',
            padding: '10px 12px',
            borderRadius: '6px',
            fontSize: '11px',
          }}
        >
          Failed to fetch real-time telemetry: {error}. Showing cached state.
        </div>
      )}

      {/* CARD 1: Scope 2 Carbon Accounting */}
      <div data-testid="card-scope2-carbon" style={S.card}>
        <div style={S.cardHeader}>
          <h3 style={{ ...S.cardTitle, color: '#34d399' }}>
            <Zap size={15} />
            Scope 2 Operational Carbon
          </h3>
          <span
            style={{
              ...S.badge,
              background: 'rgba(16, 185, 129, 0.15)',
              color: '#34d399',
              border: '1px solid rgba(16, 185, 129, 0.3)',
            }}
          >
            Telemetry Model
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px', marginBottom: '14px' }}>
          <div>
            <div style={S.dimLabel}>Total Power Draw</div>
            <div data-testid="metric-power-w" style={S.metricValue}>
              {carbon.instantaneousPowerW.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}{' '}
              <span style={{ fontSize: '12px', fontWeight: 'normal', color: 'var(--text-secondary)' }}>W</span>
            </div>
          </div>
          <div>
            <div style={S.dimLabel}>Emission Rate</div>
            <div data-testid="metric-emission-rate" style={{ ...S.metricValue, color: '#38bdf8' }}>
              {carbon.instantaneousEmissionRateKgPerHour.toFixed(3)}{' '}
              <span style={{ fontSize: '12px', fontWeight: 'normal', color: 'var(--text-secondary)' }}>kgCO2e/h</span>
            </div>
          </div>
          <div>
            <div style={S.dimLabel}>Grid Emission Factor</div>
            <div data-testid="metric-grid-factor" style={S.metricValue}>
              {carbon.gridEmissionFactorKgPerKwh.toFixed(2)}{' '}
              <span style={{ fontSize: '12px', fontWeight: 'normal', color: 'var(--text-secondary)' }}>kg/kWh</span>
            </div>
          </div>
          <div>
            <div style={S.dimLabel}>Cumulative Operational</div>
            <div data-testid="metric-cumulative-emissions" style={{ ...S.metricValue, color: '#f59e0b' }}>
              {carbon.cumulativeEmissionsKgCO2e.toFixed(3)}{' '}
              <span style={{ fontSize: '12px', fontWeight: 'normal', color: 'var(--text-secondary)' }}>kgCO2e</span>
            </div>
          </div>
        </div>

        {/* Power Breakdown Bar */}
        <div style={{ marginBottom: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
            <span style={S.dimLabel}>End-Use Power Disaggregation</span>
            <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
              Total: {carbon.instantaneousPowerW.toFixed(0)}W
            </span>
          </div>
          <div
            style={{
              display: 'flex',
              height: '8px',
              borderRadius: '4px',
              overflow: 'hidden',
              background: 'rgba(255,255,255,0.05)',
            }}
          >
            <div
              data-testid="breakdown-plug-bar"
              style={{
                width: `${carbon.instantaneousPowerW > 0 ? (carbon.breakdown.plugW / carbon.instantaneousPowerW) * 100 : 0}%`,
                background: '#38bdf8',
                transition: 'width 0.3s ease',
              }}
              title={`Plug Load: ${carbon.breakdown.plugW}W`}
            />
            <div
              data-testid="breakdown-strip-bar"
              style={{
                width: `${carbon.instantaneousPowerW > 0 ? (carbon.breakdown.stripW / carbon.instantaneousPowerW) * 100 : 0}%`,
                background: '#fbbf24',
                transition: 'width 0.3s ease',
              }}
              title={`Power Strip: ${carbon.breakdown.stripW}W`}
            />
            <div
              data-testid="breakdown-ac-bar"
              style={{
                width: `${carbon.instantaneousPowerW > 0 ? (carbon.breakdown.acW / carbon.instantaneousPowerW) * 100 : 0}%`,
                background: '#f43f5e',
                transition: 'width 0.3s ease',
              }}
              title={`HVAC Compressor: ${carbon.breakdown.acW}W`}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '6px', fontSize: '10px' }}>
            <span data-testid="breakdown-plug-w" style={{ color: '#38bdf8' }}>
              ● Plugs: {carbon.breakdown.plugW.toFixed(0)}W
            </span>
            <span data-testid="breakdown-strip-w" style={{ color: '#fbbf24' }}>
              ● Strips: {carbon.breakdown.stripW.toFixed(0)}W
            </span>
            <span data-testid="breakdown-ac-w" style={{ color: '#f43f5e' }}>
              ● HVAC: {carbon.breakdown.acW.toFixed(0)}W
            </span>
          </div>
        </div>

        {/* Environmental Equivalents */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            background: 'rgba(0, 0, 0, 0.25)',
            padding: '8px 10px',
            borderRadius: '6px',
            fontSize: '11px',
            color: 'var(--text-secondary, #cbd5e1)',
          }}
        >
          <span>🌲 Offset equivalent: <b>{treesEquivalent} trees</b>/year</span>
          <span>🚗 Vehicle footprint: <b>{carKmEquivalent} km</b> driven</span>
        </div>
      </div>

      {/* CARD 2: Carbon Budget & Live Market Offset Quote */}
      <div data-testid="card-carbon-offset" style={S.card}>
        <div style={S.cardHeader}>
          <h3 style={{ ...S.cardTitle, color: '#60a5fa' }}>
            <Coins size={15} />
            Carbon Budget & Live Market Quote
          </h3>
          <span
            data-testid="badge-budget-status"
            style={{
              ...S.badge,
              background: offset.overBudget ? 'rgba(239, 68, 68, 0.2)' : 'rgba(16, 185, 129, 0.2)',
              color: offset.overBudget ? '#ef4444' : '#10b981',
              border: `1px solid ${offset.overBudget ? 'rgba(239, 68, 68, 0.4)' : 'rgba(16, 185, 129, 0.4)'}`,
            }}
          >
            {offset.overBudget ? 'OVER BUDGET' : 'ON TRACK'}
          </span>
        </div>

        {/* Budget comparison */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px', marginBottom: '12px' }}>
          <div>
            <div style={S.dimLabel}>Target Carbon Budget</div>
            <div data-testid="metric-carbon-budget" style={S.metricValue}>
              {offset.carbonBudgetKgCO2e.toFixed(1)}{' '}
              <span style={{ fontSize: '12px', fontWeight: 'normal', color: 'var(--text-secondary)' }}>kgCO2e</span>
            </div>
          </div>
          <div>
            <div style={S.dimLabel}>Carbon Deficit</div>
            <div
              data-testid="metric-carbon-deficit"
              style={{
                ...S.metricValue,
                color: offset.overBudget ? '#ef4444' : '#10b981',
              }}
            >
              {offset.deficitKgCO2e.toFixed(2)}{' '}
              <span style={{ fontSize: '12px', fontWeight: 'normal', color: 'var(--text-secondary)' }}>kgCO2e</span>
            </div>
          </div>
        </div>

        {/* Live Market Quote Box */}
        <div
          style={{
            background: 'rgba(17, 24, 39, 0.8)',
            border: '1px solid rgba(55, 65, 81, 0.8)',
            borderRadius: '8px',
            padding: '12px',
            marginBottom: '12px',
          }}
        >
          <div style={{ fontSize: '10px', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '8px' }}>
            Available Carbon Credit Sources
          </div>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {[offset.marketQuote, ...(offset.alternativeQuotes || [])].map((quote, idx) => (
              <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.03)', padding: '10px', borderRadius: '6px', border: idx === 0 ? '1px solid rgba(52, 211, 153, 0.3)' : '1px solid transparent' }}>
                <div>
                  <div style={{ color: '#60a5fa', fontWeight: '600', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {idx === 0 ? <a href="https://www.coingecko.com/en/coins/toucan-protocol-base-carbon-tonne" target="_blank" rel="noreferrer" style={{color: '#60a5fa', textDecoration: 'none'}}>{quote.source} <ExternalLink size={10} /></a> : quote.source}
                  </div>
                  <div style={{ fontSize: '10px', color: '#64748b', marginTop: '4px', display: 'flex', gap: '6px' }}>
                    <span
                      style={{
                        fontSize: '9px',
                        fontWeight: 'bold',
                        color: quote.isLive ? '#10b981' : '#f59e0b',
                        background: quote.isLive ? 'rgba(16, 185, 129, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                        padding: '2px 6px',
                        borderRadius: '4px',
                      }}
                    >
                      {quote.isLive ? '● LIVE' : '○ STATIC'}
                    </span>
                    <span>Updated: {quote.fetchedAt ? new Date(quote.fetchedAt).toLocaleTimeString() : 'N/A'}</span>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '14px', fontWeight: 'bold', color: '#34d399', fontFamily: 'monospace' }}>
                    ${quote.spotPricePerMetricTonUSD.toFixed(2)}
                  </div>
                  <div style={{ fontSize: '9px', color: '#94a3b8' }}>{quote.currency} / tCO2e</div>
                </div>
              </div>
            ))}
          </div>

          {/* Certificate purchase requirement */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              paddingTop: '12px',
              marginTop: '12px',
              borderTop: '1px dashed rgba(255,255,255,0.15)',
            }}
          >
            <div>
              <div style={S.dimLabel}>Required Certificates</div>
              <div data-testid="metric-certificates-needed" style={{ fontSize: '14px', fontWeight: 'bold' }}>
                {offset.wholeCertificatesNeeded}{' '}
                <span style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 'normal' }}>
                  (~{offset.creditsNeededMetricTons.toFixed(4)} MT)
                </span>
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={S.dimLabel}>Estimated Offset Cost (Best Price)</div>
              <div
                data-testid="metric-total-offset-cost"
                style={{ fontSize: '16px', fontWeight: 'bold', color: '#fbbf24', fontFamily: 'monospace' }}
              >
                ${offset.estimatedCostUSD.toFixed(2)}{' '}
                <span style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 'normal' }}>USD</span>
              </div>
            </div>
          </div>
        </div>

        {/* Recommendation Text */}
        <div
          data-testid="text-offset-recommendation"
          style={{
            background: 'rgba(30, 41, 59, 0.4)',
            borderLeft: `3px solid ${offset.overBudget ? '#ef4444' : '#10b981'}`,
            padding: '8px 12px',
            borderRadius: '0 6px 6px 0',
            fontSize: '11px',
            color: '#e2e8f0',
            lineHeight: 1.4,
          }}
        >
          {offset.recommendation}
        </div>
      </div>

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
              background: maintenance.activeAlertsCount > 0 ? 'rgba(239, 68, 68, 0.2)' : 'rgba(16, 185, 129, 0.2)',
              color: maintenance.activeAlertsCount > 0 ? '#ef4444' : '#10b981',
              border: `1px solid ${maintenance.activeAlertsCount > 0 ? 'rgba(239, 68, 68, 0.4)' : 'rgba(16, 185, 129, 0.4)'}`,
            }}
          >
            {maintenance.activeAlertsCount} ACTIVE
          </span>
        </div>

        {maintenance.activeAlertsCount === 0 ? (
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
            {maintenance.warnings.map((w, idx) => (
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
                    [{w.type.toUpperCase()}] {w.equipmentId}
                  </span>
                  <span
                    style={{
                      fontSize: '9px',
                      textTransform: 'uppercase',
                      padding: '1px 5px',
                      borderRadius: '3px',
                      background: w.severity === 'critical' ? '#ef4444' : '#f59e0b',
                      color: '#ffffff',
                      fontWeight: 'bold',
                    }}
                  >
                    {w.severity}
                  </span>
                </div>
                <div style={{ fontSize: '11px', color: '#fecaca', marginBottom: '6px' }}>{w.message}</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#94a3b8' }}>
                  <span>Zone: <b>{w.zoneId}</b></span>
                  <span>Metric: <b>{w.metricValue.toFixed(1)}</b> / Limit: <b>{w.threshold.toFixed(1)}</b></span>
                  <span>Health: <b>{w.healthScore !== undefined ? `${w.healthScore}%` : 'N/A'}</b></span>
                </div>
                {w.troubleshooting && w.troubleshooting.length > 0 && (
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
              {space.overallEfficiencyPercent.toFixed(1)}%
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={S.dimLabel}>Occupants vs Capacity</div>
            <div style={{ fontSize: '14px', fontWeight: 'bold' }}>
              <span data-testid="metric-live-occupants">{space.totalLiveOccupants}</span>
              {' / '}
              <span data-testid="metric-building-capacity">{space.totalBuildingCapacity}</span>
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
              width: `${Math.min(100, Math.max(0, space.overallEfficiencyPercent))}%`,
              background: space.overallEfficiencyPercent > 70 ? '#10b981' : space.overallEfficiencyPercent > 30 ? '#38bdf8' : '#f59e0b',
              height: '100%',
              transition: 'width 0.4s ease',
            }}
          />
        </div>

        {/* Zone-by-Zone Table */}
        {space.zones && space.zones.length > 0 && (
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
                {space.zones.map((z, idx) => (
                  <tr
                    key={idx}
                    data-testid="zone-space-item"
                    style={{
                      borderBottom: '1px solid rgba(255,255,255,0.04)',
                      background: idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)',
                    }}
                  >
                    <td style={{ padding: '6px 4px', color: '#e2e8f0', fontWeight: '500' }}>{z.zoneId}</td>
                    <td style={{ padding: '6px 4px', textAlign: 'center', color: '#38bdf8' }}>{z.liveOccupants}</td>
                    <td style={{ padding: '6px 4px', textAlign: 'center', color: '#94a3b8' }}>{z.designCapacity}</td>
                    <td style={{ padding: '6px 4px', textAlign: 'right', fontWeight: 'bold' }}>
                      <span
                        style={{
                          color: z.efficiencyPercent > 75 ? '#34d399' : z.efficiencyPercent < 30 ? '#f87171' : '#fbbf24',
                        }}
                      >
                        {z.efficiencyPercent.toFixed(1)}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

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

          <button
            data-testid="btn-action-eco-setback"
            disabled={actionLoading}
            onClick={() => dispatchAction('SETPOINT=26.0', 'Eco Setback (+2°C)')}
            style={{
              ...S.btnAction,
              borderColor: '#10b981',
              color: '#34d399',
            }}
          >
            <ArrowUpRight size={13} />
            <span>Eco Setback (+2°C)</span>
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
    </div>
  );
}
