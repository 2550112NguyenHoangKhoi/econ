import React from 'react';
import { Zap } from 'lucide-react';
import { S } from './styles';

// Scope 2: the building's measured electrical draw, split by end use, and the emissions it
// implies at the grid's live carbon intensity. Each end use states how many zones are
// actually metered for it, so a modelled watt is never read as a measured one.
export default function Scope2Card({
  carbon,
  breakdown,
  plugW,
  stripW,
  acW,
  endUse,
  dcvZones,
  dcvAvoidedKw,
  acMeteredZones,
  stripMeteredZones,
  plugMeteredZones,
  plugModelledZones,
  instantaneousPowerW,
  instantaneousEmissionRateKgPerHour,
  gridEmissionFactorKgPerKwh,
  cumulativeEmissionsKgCO2e,
  treesEquivalent,
  carKmEquivalent,
}) {
  return (
    <>
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

    {/* Demand-controlled ventilation.
        Rendered only when at least one zone is actually being ventilated from a live CO2
        reading. A row reading "0 zones · 0 kW avoided" would look like a result -- as if the
        loop ran and found nothing -- when the truth is that no zone has an NDIR sensor and
        the loop is not running at all. That absence belongs in the sensor-coverage story,
        not here, so this row simply does not appear.

        Outdoor air is the largest single cooling term in a tropical office and it is mostly
        latent, which is why trimming it is worth showing beside the end-use split rather
        than buried in the AI panel. */}
    {dcvZones > 0 && (
      <div
        data-testid="dcv-summary"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: 'rgba(16, 185, 129, 0.10)',
          border: '1px solid rgba(16, 185, 129, 0.35)',
          padding: '8px 10px',
          borderRadius: '6px',
          fontSize: '11px',
          marginBottom: '8px',
          color: 'var(--text-secondary, #cbd5e1)',
        }}
      >
        <span title="Zones whose damper is positioned from a live NDIR reading rather than a fixed rate. Zones without a CO2 sensor are unaffected and still ventilate for their rated occupancy.">
          💨 <b>{dcvZones}</b> zone{dcvZones === 1 ? '' : 's'} demand-controlled
        </span>
        <span
          title="Fresh-air cooling avoided by ventilating for the people actually present instead of the occupancy each zone is rated for. Computed only over zones with a live sensor — an unmeasured zone cannot have earned this."
          style={{ color: '#34d399', fontWeight: 700 }}
        >
          {dcvAvoidedKw >= 1
            ? `${dcvAvoidedKw.toFixed(1)} kW`
            : `${(dcvAvoidedKw * 1000).toFixed(0)} W`} fresh-air load avoided
        </span>
      </div>
    )}

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
    </>
  );
}
