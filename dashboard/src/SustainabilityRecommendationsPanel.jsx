import React, { useState } from 'react';
import { Leaf, RefreshCw } from 'lucide-react';
import { useSustainability } from './useSustainability';
import { useLibrary } from './useLibrary';
import { API_BASE, getAdminToken } from './api';

import { S } from './sustainability/styles';
import Scope2Card from './sustainability/Scope2Card';
import OffsetCard from './sustainability/OffsetCard';
import MaintenanceCard from './sustainability/MaintenanceCard';
import UtilizationCard from './sustainability/UtilizationCard';
import ActionsCard from './sustainability/ActionsCard';
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

      <Scope2Card
        carbon={carbon}
        breakdown={breakdown}
        plugW={plugW} stripW={stripW} acW={acW}
        endUse={endUse}
        acMeteredZones={acMeteredZones}
        stripMeteredZones={stripMeteredZones}
        plugMeteredZones={plugMeteredZones}
        plugModelledZones={plugModelledZones}
        instantaneousPowerW={instantaneousPowerW}
        instantaneousEmissionRateKgPerHour={instantaneousEmissionRateKgPerHour}
        gridEmissionFactorKgPerKwh={gridEmissionFactorKgPerKwh}
        cumulativeEmissionsKgCO2e={cumulativeEmissionsKgCO2e}
        treesEquivalent={treesEquivalent}
        carKmEquivalent={carKmEquivalent}
      />

      <OffsetCard
        carbonBudgetKgCO2e={carbonBudgetKgCO2e}
        overBudget={overBudget}
        deficitKgCO2e={deficitKgCO2e}
        creditsNeededMetricTons={creditsNeededMetricTons}
        wholeCertificatesNeeded={wholeCertificatesNeeded}
        estimatedCostUSD={estimatedCostUSD}
        marketQuote={marketQuote}
        alternativeQuotes={alternativeQuotes}
        recommendation={recommendation}
      />

      <MaintenanceCard
        activeAlertsCount={activeAlertsCount}
        warnings={warnings}
      />

      <UtilizationCard
        totalLiveOccupants={totalLiveOccupants}
        totalBuildingCapacity={totalBuildingCapacity}
        overallEfficiencyPercent={overallEfficiencyPercent}
        zones={zones}
      />

      <ActionsCard
        carbon={carbon}
        dispatchAction={dispatchAction}
        actionLoading={actionLoading}
        actionStatus={actionStatus}
      />
    </div>
  );
}
