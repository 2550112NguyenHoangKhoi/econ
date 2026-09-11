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
import { useLibrary } from './useLibrary';
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

  const carbon = data?.carbonAccounting || {};
  const breakdown = carbon?.breakdown || {};
  const plugW = Number(breakdown?.plugW) || 0;
  const stripW = Number(breakdown?.stripW) || 0;
  const acW = Number(breakdown?.acW) || 0;
  // Provenance for each end use. The engine sums AC only from real clamps, while plug load
  // falls back to the standby MODEL -- so a building with no AC clamp showed "HVAC: 0W" and
  // 100% plugs, which reads as "the compressor is off" rather than "nothing is measuring
  // it". These counts let the legend say which it is. See PowerBreakdownData.
  const acMeteredZones = Number(breakdown?.acMeteredZones) || 0;
  const stripMeteredZones = Number(breakdown?.stripMeteredZones) || 0;
  const plugMeteredZones = Number(breakdown?.plugMeteredZones) || 0;
  const plugModelledZones = Number(breakdown?.plugModelledZones) || 0;
  // A figure nothing is measuring is rendered as absent, never as a zero reading.
  const endUse = (watts, meteredZones, what) => meteredZones > 0
    ? { text: `${watts.toFixed(0)}W`, dim: false, title: `${what}: measured by ${meteredZones} clamp${meteredZones === 1 ? '' : 's'}` }
    : { text: 'not metered', dim: true, title: `${what}: no current clamp is reporting, so this end use is not measured. It is not a reading of zero.` };
  const instantaneousPowerW = Number(carbon?.instantaneousPowerW) || 0;
  const instantaneousEmissionRateKgPerHour = Number(carbon?.instantaneousEmissionRateKgPerHour) || 0;
  const gridEmissionFactorKgPerKwh = Number(carbon?.gridEmissionFactorKgPerKwh) || 0.5;
  const cumulativeEmissionsKgCO2e = Number(carbon?.cumulativeEmissionsKgCO2e) || 0;

  const offset = data?.carbonCreditRecommendations || {};
  const carbonBudgetKgCO2e = Number(offset?.carbonBudgetKgCO2e) || 50.0;
  const currentEmissionsKgCO2e = Number(offset?.currentEmissionsKgCO2e) || cumulativeEmissionsKgCO2e;
  const overBudget = Boolean(offset?.overBudget);
  const deficitKgCO2e = Number(offset?.deficitKgCO2e) || 0;
  const creditsNeededMetricTons = Number(offset?.creditsNeededMetricTons) || 0;
  const wholeCertificatesNeeded = Number(offset?.wholeCertificatesNeeded) || 0;
  const estimatedCostUSD = Number(offset?.estimatedCostUSD) || 0;
  const defaultMarketQuote = {
    source: 'Toucan Protocol BCT (CoinGecko)',
    spotPricePerMetricTonUSD: 12.5,
    currency: 'USD',
    isLive: true,
    fetchedAt: new Date().toISOString(),
  };
  const marketQuote = offset?.marketQuote || defaultMarketQuote;
  const alternativeQuotes = Array.isArray(offset?.alternativeQuotes) ? offset.alternativeQuotes : [];
  const recommendation = offset?.recommendation || (overBudget ? 'Emissions exceed target budget.' : 'Emissions are within target budget.');

  const maintenance = data?.predictiveMaintenance || {};
  const activeAlertsCount = Number(maintenance?.activeAlertsCount) || 0;
  const warnings = Array.isArray(maintenance?.warnings) ? maintenance.warnings : [];

  const space = data?.spaceUtilization || {};
  const totalLiveOccupants = Number(space?.totalLiveOccupants) || 0;
  const totalBuildingCapacity = Number(space?.totalBuildingCapacity) || 1;
  const overallEfficiencyPercent = Number(space?.overallEfficiencyPercent) || 0;
  const zones = Array.isArray(space?.zones) ? space.zones : [];

  // Environmental equivalents.
  //
  // These two used to be computed on DIFFERENT bases and printed side by side: trees from
  // the instantaneous draw extrapolated over a full year (x8760), km from cumulative
  // emissions since boot. After a restart the panel therefore read "Cumulative 0.000
  // kgCO2e" next to "Offset equivalent: 11696 trees/year" and "Vehicle footprint: 0 km" --
  // three numbers about the same building that cannot all be describing the same thing.
  //
  // Both are now derived from the SAME quantity, and the label says which. A projection and
  // a measurement are still both useful, but the reader has to be told which one they are
  // looking at, so the projected figure carries "at this draw" and the measured one carries
  // "so far".
  //
  // The coefficients come from the programme library rather than from literals here (they
  // were 21.77 and 5.88), and are null until it answers -- in which case the equivalence is
  // withheld rather than computed against a number this file made up.
  const { treeKgCo2PerYear, vehicleKgCo2PerKm } = useLibrary();
  const annualKgCO2e = (instantaneousPowerW / 1000.0) * 8760 * gridEmissionFactorKgPerKwh;
  const treesEquivalent = treeKgCo2PerYear > 0
    ? Math.max(0, Math.round(annualKgCO2e / treeKgCo2PerYear))
    : null;
  // Same basis as the trees figure: what a year at the current draw would emit.
  const carKmEquivalent = vehicleKgCo2PerKm > 0
    ? Math.max(0, Math.round(annualKgCO2e / vehicleKgCo2PerKm))
    : null;

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
              {instantaneousPowerW.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}{' '}
              <span style={{ fontSize: '12px', fontWeight: 'normal', color: 'var(--text-secondary)' }}>W</span>
            </div>
          </div>
          <div>
            <div style={S.dimLabel}>Emission Rate</div>
            <div data-testid="metric-emission-rate" style={{ ...S.metricValue, color: '#38bdf8' }}>
              {instantaneousEmissionRateKgPerHour.toFixed(3)}{' '}
              <span style={{ fontSize: '12px', fontWeight: 'normal', color: 'var(--text-secondary)' }}>kgCO2e/h</span>
            </div>
          </div>
          <div>
            <div style={S.dimLabel}>Grid Emission Factor</div>
            <div data-testid="metric-grid-factor" style={S.metricValue}>
              {gridEmissionFactorKgPerKwh.toFixed(2)}{' '}
              <span style={{ fontSize: '12px', fontWeight: 'normal', color: 'var(--text-secondary)' }}>kg/kWh</span>
            </div>
          </div>
          <div>
            <div style={S.dimLabel}>Cumulative Operational</div>
            <div data-testid="metric-cumulative-emissions" style={{ ...S.metricValue, color: '#f59e0b' }}>
              {cumulativeEmissionsKgCO2e.toFixed(3)}{' '}
              <span style={{ fontSize: '12px', fontWeight: 'normal', color: 'var(--text-secondary)' }}>kgCO2e</span>
            </div>
          </div>
        </div>

        {/* Power Breakdown Bar */}
        <div style={{ marginBottom: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
            <span style={S.dimLabel}>End-Use Power Disaggregation</span>
            <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>
              Total: {instantaneousPowerW.toFixed(0)}W
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
                width: `${instantaneousPowerW > 0 ? (plugW / instantaneousPowerW) * 100 : 0}%`,
                background: '#38bdf8',
                transition: 'width 0.3s ease',
              }}
              title={`Plug Load: ${plugW}W`}
            />
            <div
              data-testid="breakdown-strip-bar"
              style={{
                width: `${instantaneousPowerW > 0 ? (stripW / instantaneousPowerW) * 100 : 0}%`,
                background: '#fbbf24',
                transition: 'width 0.3s ease',
              }}
              title={`Power Strip: ${stripW}W`}
            />
            <div
              data-testid="breakdown-ac-bar"
              style={{
                width: `${instantaneousPowerW > 0 ? (acW / instantaneousPowerW) * 100 : 0}%`,
                background: '#f43f5e',
                transition: 'width 0.3s ease',
              }}
              title={`HVAC Compressor: ${acW}W`}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '6px', fontSize: '10px' }}>
            {(() => {
              // Plug load is the one end use with a model behind it, so it is labelled
              // "modelled" rather than silently passing as a measurement.
              const plugMeasured = plugMeteredZones > 0;
              const plugTitle = plugMeasured
                ? `Plug load: measured by ${plugMeteredZones} clamp${plugMeteredZones === 1 ? '' : 's'}`
                  + (plugModelledZones > 0 ? `, plus ${plugModelledZones} zone${plugModelledZones === 1 ? '' : 's'} from the standby model` : '')
                : `Plug load: no clamp is reporting — this is the standby MODEL for ${plugModelledZones} zone${plugModelledZones === 1 ? '' : 's'}, not a measurement.`;
              const strip = endUse(stripW, stripMeteredZones, 'Power strips');
              const ac = endUse(acW, acMeteredZones, 'HVAC compressor');
              return (
                <>
                  <span data-testid="breakdown-plug-w" title={plugTitle} style={{ color: '#38bdf8', opacity: plugMeasured ? 1 : 0.65 }}>
                    ● Plugs: {plugW.toFixed(0)}W{plugMeasured ? '' : ' (modelled)'}
                  </span>
                  <span data-testid="breakdown-strip-w" title={strip.title} style={{ color: '#fbbf24', opacity: strip.dim ? 0.55 : 1 }}>
                    ● Strips: {strip.text}
                  </span>
                  <span data-testid="breakdown-ac-w" title={ac.title} style={{ color: '#f43f5e', opacity: ac.dim ? 0.55 : 1 }}>
                    ● HVAC: {ac.text}
                  </span>
                </>
              );
            })()}
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
          <span title="A projection: what a full year at the current draw would emit, expressed as the number of trees that would sequester it. Not a measurement of what this building has emitted.">
            🌲 At this draw, a year needs <b>{treesEquivalent == null ? '—' : treesEquivalent.toLocaleString()} trees</b> to sequester
          </span>
          <span title="The same projected annual emissions, expressed as distance driven by an average car. Same basis as the tree figure beside it.">
            🚗 equivalent to <b>{carKmEquivalent == null ? '—' : carKmEquivalent.toLocaleString()} km</b> driven
          </span>
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
              background: overBudget ? 'rgba(239, 68, 68, 0.2)' : 'rgba(16, 185, 129, 0.2)',
              color: overBudget ? '#ef4444' : '#10b981',
              border: `1px solid ${overBudget ? 'rgba(239, 68, 68, 0.4)' : 'rgba(16, 185, 129, 0.4)'}`,
            }}
          >
            {overBudget ? 'OVER BUDGET' : 'ON TRACK'}
          </span>
        </div>

        {/* Budget comparison */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px', marginBottom: '12px' }}>
          <div>
            <div style={S.dimLabel}>Target Carbon Budget</div>
            <div data-testid="metric-carbon-budget" style={S.metricValue}>
              {carbonBudgetKgCO2e.toFixed(1)}{' '}
              <span style={{ fontSize: '12px', fontWeight: 'normal', color: 'var(--text-secondary)' }}>kgCO2e</span>
            </div>
          </div>
          <div>
            <div style={S.dimLabel}>Carbon Deficit</div>
            <div
              data-testid="metric-carbon-deficit"
              style={{
                ...S.metricValue,
                color: overBudget ? '#ef4444' : '#10b981',
              }}
            >
              {deficitKgCO2e.toFixed(2)}{' '}
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
            {[marketQuote, ...alternativeQuotes].filter(Boolean).map((quote, idx) => (
              <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.03)', padding: '10px', borderRadius: '6px', border: idx === 0 ? '1px solid rgba(52, 211, 153, 0.3)' : '1px solid transparent' }}>
                <div>
                  <div style={{ color: '#60a5fa', fontWeight: '600', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {idx === 0 ? (
                      <a href="https://www.coingecko.com/en/coins/toucan-protocol-base-carbon-tonne" target="_blank" rel="noreferrer" style={{color: '#60a5fa', textDecoration: 'none'}}>{quote.source || 'Toucan Protocol BCT'} <ExternalLink size={10} /></a>
                    ) : quote.url ? (
                      <a href={quote.url} target="_blank" rel="noreferrer" style={{color: '#60a5fa', textDecoration: 'none'}}>{quote.source || 'Market Quote'} <ExternalLink size={10} /></a>
                    ) : (
                      (quote.source || 'Market Quote')
                    )}
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
                  <div
                    data-testid="metric-market-spot-price"
                    style={{ fontSize: '14px', fontWeight: 'bold', color: '#34d399', fontFamily: 'monospace' }}
                  >
                    ${(Number(quote.spotPricePerMetricTonUSD) || 0).toFixed(2)}
                  </div>
                  <div style={{ fontSize: '9px', color: '#94a3b8' }}>{quote.currency || 'USD'} / tCO2e</div>
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
                {wholeCertificatesNeeded}{' '}
                <span style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 'normal' }}>
                  (~{creditsNeededMetricTons.toFixed(4)} MT)
                </span>
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={S.dimLabel}>Estimated Offset Cost (Best Price)</div>
              <div
                data-testid="metric-total-offset-cost"
                style={{ fontSize: '16px', fontWeight: 'bold', color: '#fbbf24', fontFamily: 'monospace' }}
              >
                ${estimatedCostUSD.toFixed(2)}{' '}
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
            borderLeft: `3px solid ${overBudget ? '#ef4444' : '#10b981'}`,
            padding: '8px 12px',
            borderRadius: '0 6px 6px 0',
            fontSize: '11px',
            color: '#e2e8f0',
            lineHeight: 1.4,
          }}
        >
          {recommendation}
        </div>

        {overBudget && (
          <div style={{ marginTop: '12px' }}>
            <a
              href="https://carboncredits.com/"
              target="_blank"
              rel="noreferrer"
              style={{
                ...S.btnAction,
                textDecoration: 'none',
                background: 'rgba(52, 211, 153, 0.1)',
                borderColor: 'rgba(52, 211, 153, 0.3)',
                color: '#34d399',
                display: 'flex',
                justifyContent: 'center',
                width: '100%',
              }}
            >
              <Coins size={13} style={{ marginRight: '4px' }} />
              View Carbon Credit Quotes & Alternatives <ExternalLink size={11} style={{ marginLeft: '2px' }} />
            </a>
          </div>
        )}
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
    </div>
  );
}
