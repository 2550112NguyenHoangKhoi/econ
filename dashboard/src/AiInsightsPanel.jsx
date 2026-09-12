import React, { useMemo, useState, useEffect } from 'react';
import { Brain, Activity, Plug } from 'lucide-react';
import { money, energyCostPerDay, rateStr, touPeriod } from './tariff';
import { useOpsStatus, untilLabel } from './useOpsStatus';
import { usePlugs } from './usePlugs';
import { useRecommendations } from './useRecommendations';
import { useForecastCompare } from './useForecastCompare';
import { useLibrary } from './useLibrary';
import { useRoomModels } from './useRoomModels';
import RecommendationEvidence from './RecommendationEvidence';
import ForecastChart from './ForecastChart';
import { powerMw } from './units';
import { fx, hasReading } from './measured';
import ModelExportCard from './ai/ModelExportCard';
import AfddDriftDetail from './ai/AfddDriftDetail';
import HardwareReachCard from './ai/HardwareReachCard';
import RoomModelsCard from './ai/RoomModelsCard';
import { buildInsights } from './ai/buildInsights';

export default function AiInsightsPanel({ simData, activeScenario, faultTarget, aiForecast, setAutoPilot, hardwareNodes = {}, setSelectedZone, sendManualOverride, onOpenPlugs }) {
  // Every card's action is a real one: an actuation over the websocket (pre-cool window,
  // purge override), a navigation (fly the 3D camera to the zone, open the PLUGS tab),
  // or an inline expansion of live detail. Engaged state marks fire-once actuations.
  const [engaged, setEngaged] = useState({});
  const [expanded, setExpanded] = useState({});
  const toggle = (id) => setExpanded((e) => ({ ...e, [id]: !e[id] }));

  // Live operational signals: pre-cool window, weather feed, plug sweep. Polled from the
  // engine so this panel reasons over what the building is DOING, not over UI state.
  const { precool, weather } = useOpsStatus();
  const { status: plugStatus } = usePlugs();
  // Learned anomaly recommendations from the engine's online baseline model
  // (server/simulation/baselines.go): each scored in σ against this building's own normal
  // for the hour. These replace the old hardcoded threshold cards below.
  // hardware/realMode say what the engine can actually REACH, and whether it applied the
  // real-mode capability gate when it built this list. Without them a short list is
  // ambiguous: see the note in useRecommendations.
  const { recommendations, model: recModel, forecast: recForecast, hardware: recHardware, realMode } = useRecommendations();
  // Building coefficients and the critical-zone list, from the engine's programme library
  // rather than from constants typed into this file. See useLibrary.
  const { isCritical, precoolShift, calibrated: libCalibrated } = useLibrary();
  // What the twin has actually identified about each room — the model behind every
  // prediction, so a card can show its own reasoning instead of asserting a conclusion.
  // matureAfter is deliberately taken from THIS endpoint, not from the baseline model's:
  // the two models mature on different evidence and at different counts (baselines at 20
  // observations, room identification at 36 accepted samples), so borrowing one figure for
  // the other's progress bar would report a room as further along than it is.
  const { byZone: roomModels, identified: roomsIdentified, rooms: roomList, matureAfter: roomsMatureAfter } = useRoomModels();

  const hwList = Object.values(hardwareNodes || {});
  const hwOnline = hwList.filter((n) => n.online).length;

  // Real streamed savings (engine energySavedMw), as a share of what load WOULD be without setbacks.
  const savedMw = simData.energySavedMw || 0;
  const loadMw = simData.buildingLoadMw || 0;
  const savingsPct = savedMw + loadMw > 0 ? (100 * savedMw) / (savedMw + loadMw) : 0;

  // Both load forecasters: live comparison endpoint (/api/forecast/compare) and embedded
  // recommendation forecast (/api/recommendations) with robust fallbacks.
  const { timesfm, lstm: lstmCompare, series: tfmSeries, stepMinutes: compareStepMinutes, agreement,
          upperBand: compareUpperBand, upperQuantile: compareUpperQuantile, peakUpperMw: comparePeakUpperMw } = useForecastCompare();

  // Unified active forecast combining live zero-shot horizon, decile bands, and LSTM peak reference.
  const activeForecast = useMemo(() => {
    const isValidNumericArray = (arr) => Array.isArray(arr) && arr.length > 0 &&
      arr.every(v => v != null && (typeof v === 'number' || (typeof v === 'string' && !Number.isNaN(Number(v)))) && Number.isFinite(Number(v)));

    const rawSeries = isValidNumericArray(tfmSeries)
      ? tfmSeries
      : isValidNumericArray(recForecast?.series)
        ? recForecast.series
        : null;

    const stepMin = compareStepMinutes || recForecast?.stepMinutes || 5;
    const upper = isValidNumericArray(compareUpperBand)
      ? compareUpperBand
      : isValidNumericArray(recForecast?.upperBand)
        ? recForecast.upperBand
        : null;

    const uq = compareUpperQuantile || recForecast?.upperQuantile || 'q9';
    const peakUp = comparePeakUpperMw ?? recForecast?.peakUpperMw ?? null;
    const lstmPeak = lstmCompare?.peakMw ?? recForecast?.lstmPeakMw ?? aiForecast?.predicted_peak_load ?? null;
    const engineName = (timesfm?.available && rawSeries && rawSeries.length > 0)
      ? 'timesfm'
      : (recForecast?.engine || (aiForecast ? 'lstm' : 'fallback'));

    const seriesData = rawSeries && rawSeries.length > 0
      ? rawSeries.map((mw, i) => ({
          t: `+${(i + 1) * stepMin}m`,
          mw: +Number(mw).toFixed(4),
          hi: upper && upper[i] != null && Number.isFinite(Number(upper[i])) ? +Number(upper[i]).toFixed(4) : undefined,
        }))
      : [];

    const isPlausible = recForecast?.plausible ?? (aiForecast ? !aiForecast.implausible : true);
    const plausibilityText = recForecast?.plausibility ?? aiForecast?.plausibility ?? '';

    return {
      seriesData,
      rawSeries,
      stepMinutes: stepMin,
      upperBand: upper,
      upperQuantile: uq,
      peakUpperMw: peakUp,
      lstmPeakMw: lstmPeak,
      engine: engineName,
      plausible: isPlausible,
      plausibility: plausibilityText,
      available: seriesData.length > 0 || lstmPeak != null,
    };
  }, [tfmSeries, compareStepMinutes, compareUpperBand, compareUpperQuantile, comparePeakUpperMw, lstmCompare, timesfm, recForecast, aiForecast]);

  const forecastSeries = activeForecast.seriesData;

  // Insights are generated from what the building is actually doing: the telemetry
  // stream, the edge-node registry, the TOU clock, and the engine's own control loops
  // (pre-cool window, plug sweep, weather feed). Demo scenario toggles only add cards;
  // they never gate a real signal.
  const insights = useMemo(() => buildInsights({
    simData, activeScenario, faultTarget, aiForecast, activeForecast, recForecast,
    hwList, hwOnline, savingsPct, savedMw, loadMw, precool, weather, plugStatus,
    recommendations, sendManualOverride, setSelectedZone, onOpenPlugs, isCritical, precoolShift,
  }), [simData, activeScenario, faultTarget, aiForecast, hwList, hwOnline, savingsPct, savedMw, loadMw, precool, weather, plugStatus, recommendations, sendManualOverride, setSelectedZone, onOpenPlugs, isCritical, precoolShift]);

  // ---- Inline detail sections for the expandable cards ----
  const renderDetail = (id) => {
    if (id === 'forecast') {
      const lstmOod = !activeForecast.plausible;
      const lstmUnjudged = aiForecast != null && aiForecast.plausibility_judged === false;
      const peak = lstmOod || lstmUnjudged ? null : activeForecast.lstmPeakMw;
      const realN = aiForecast?.window_real_samples ?? recForecast?.samples;
      const winLen = aiForecast?.window_len || 12;

      return (
        <div style={{ marginTop: '8px', padding: '10px 12px', background: 'rgba(0, 163, 224, 0.05)', borderRadius: '8px', border: '1px solid rgba(0, 163, 224, 0.2)' }}>
          <div style={{ fontSize: '10px', fontWeight: 'bold', color: 'var(--accent-blue)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>
            Forecaster Architecture & Multi-Model Intelligence
          </div>
          
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', rowGap: '5px', columnGap: '12px', fontSize: '11px' }}>
            <span style={{ color: 'var(--text-secondary)' }}>Active Forecaster</span>
            <span style={{ fontFamily: 'monospace', fontWeight: 'bold', color: 'var(--text-primary)' }}>
              {activeForecast.engine === 'timesfm' ? 'Google TimesFM 200M (Zero-Shot)' : 'Supervised 2-Layer LSTM'}
            </span>

            <span style={{ color: 'var(--text-secondary)' }}>Forecast Horizon</span>
            <span style={{ fontFamily: 'monospace', color: 'var(--text-primary)' }}>
              {(activeForecast.seriesData.length || 12) * (activeForecast.stepMinutes || 5)} min ({(activeForecast.seriesData.length || 12)} steps @ {activeForecast.stepMinutes || 5}m)
            </span>

            <span style={{ color: 'var(--text-secondary)' }}>Projected Peak Load</span>
            <span style={{ fontFamily: 'monospace', fontWeight: 'bold', color: 'var(--accent-blue)' }}>
              {activeForecast.peakUpperMw ? powerMw(activeForecast.peakUpperMw) : (peak ? powerMw(peak) : '—')}
            </span>

            {activeForecast.upperQuantile && (
              <>
                <span style={{ color: 'var(--text-secondary)' }}>Upper Decile Band ({activeForecast.upperQuantile.toUpperCase()})</span>
                <span style={{ fontFamily: 'monospace', color: 'var(--accent-blue)' }}>
                  {activeForecast.peakUpperMw ? powerMw(activeForecast.peakUpperMw) : '—'}
                </span>
              </>
            )}

            {agreement?.comparable && (
              <>
                <span style={{ color: 'var(--text-secondary)' }}>Multi-Model Agreement Delta</span>
                <span style={{
                  fontFamily: 'monospace',
                  color: agreement.relativeDiff > 0.25 ? 'var(--accent-yellow)' : 'var(--text-primary)',
                }}>
                  {powerMw(Math.abs(agreement.deltaMw))} ({(agreement.relativeDiff * 100).toFixed(0)}%) · {agreement.higher.toUpperCase()} higher
                </span>
              </>
            )}

            <span style={{ color: 'var(--text-secondary)' }}>Plausibility & Safety Filter</span>
            <span style={{
              fontFamily: 'monospace',
              color: lstmOod ? 'var(--accent-red)' : lstmUnjudged ? 'var(--accent-yellow)' : 'var(--accent-green, #22c55e)',
            }}>
              {lstmOod ? 'OUT OF DISTRIBUTION' : lstmUnjudged ? 'UNVERIFIED' : 'PASSED PHYSICAL ENVELOPE CHECKS'}
            </span>

            <span style={{ color: 'var(--text-secondary)' }}>Telemetry Warmup</span>
            <span style={{ fontFamily: 'monospace', color: 'var(--text-primary)' }}>
              {realN != null ? `${realN}/${winLen} 5-min steps` : 'Steady-state stream'}
            </span>
          </div>
        </div>
      );
    }
    if (id === 'general') {
      const rows = [
        ['Auto-Pilot', simData.autoPilot !== false ? 'engaged' : 'suspended (manual)'],
        ['Zones in setback', `${simData.zonesInSetback || 0}`],
        ['Live savings', `${powerMw(savedMw)} (${savingsPct.toFixed(1)}%)`],
        ['Utility saving', `${money(energyCostPerDay(savedMw * 1000))}/day`],
        ['Plant COP', (simData.plantCop || 0).toFixed(2)],
        ['Cooling delivered', `${powerMw(simData.coolingOutputMw || 0)} thermal`],
        ['Zones simulated', `${Object.keys(simData.zones || {}).length}`],
        ['Physical nodes', `${hwList.length} (${hwOnline} online)`],
        ['Forecaster', aiForecast ? `LSTM · ${aiForecast.weather_source === 'fallback' ? 'fallback weather' : 'live weather'}` : 'offline'],
        // Live control-loop state, straight from the engine's own endpoints.
        // fx() rather than .toFixed(): /api/ops/status can answer 200 with a body that has
        // no outdoorC (version mismatch, proxy error envelope), and a diagnostics row is the
        // last place that should be able to take the panel down.
        ['Outdoor (envelope)', hasReading(weather?.outdoorC) ? `${fx(weather.outdoorC)} °C · ${weather.live ? 'live Open-Meteo' : 'fallback'}` : '—'],
        ['TOU band now', rateStr(touPeriod()) + '/kWh'],
        ['Pre-cool window', precool?.active ? `open until ${untilLabel(precool.until)}` : 'closed'],
        ['Plug sweep', plugStatus ? (plugStatus.config?.enabled ? (plugStatus.armed ? `armed · ${plugStatus.shedZones} zones swept` : 'disarmed (work hours)') : 'disabled') : '—'],
        ['Plug energy avoided', `${(simData.plugSavedKwh ?? plugStatus?.savedKwh ?? 0).toFixed(1)} kWh`],
      ];
      return (
        <div style={{ marginTop: '6px', display: 'grid', gridTemplateColumns: '1fr auto', rowGap: '4px', columnGap: '10px' }}>
          {rows.map(([k, v]) => (
            <React.Fragment key={k}>
              <span style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>{k}</span>
              <span style={{ fontSize: '10px', fontFamily: 'monospace', fontWeight: 'bold', color: 'var(--text-primary)', textAlign: 'right' }}>{v}</span>
            </React.Fragment>
          ))}
        </div>
      );
    }
    if (id === 'hardware') {
      // Per-sensor coverage: which of the node's intended sensors is DELIVERING right
      // now. These come from /api/hardware, where each field is freshness-gated —
      // 0/false means "not measuring", never "measuring zero". A lit badge is a live
      // sensor; a dim one is absent, failed, or stale — the honest wiring checklist.
      const sensorBadge = (on, label, title) => (
        <span
          title={title}
          style={{
            fontSize: '8px', fontWeight: 'bold', padding: '1px 4px', borderRadius: '3px', flexShrink: 0,
            color: on ? 'var(--accent-green)' : 'var(--text-muted)',
            border: `1px solid ${on ? 'var(--accent-green)' : 'rgba(127,139,150,0.3)'}`,
            opacity: on ? 1 : 0.55,
          }}
        >
          {label}
        </span>
      );
      return (
        <div style={{ marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {hwList.map((n) => (
            <div
              key={n.zoneId}
              onClick={() => setSelectedZone && setSelectedZone(n.zoneId)}
              title="Click to fly the 3D view to this zone"
              style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 6px', borderRadius: '4px', background: 'rgba(255,255,255,0.03)', cursor: setSelectedZone ? 'pointer' : 'default', fontFamily: 'monospace', fontSize: '10px', flexWrap: 'wrap' }}
            >
              <span style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: n.online ? 'var(--accent-green)' : 'var(--text-muted)', boxShadow: n.online ? '0 0 4px var(--accent-green)' : 'none' }} />
              <span style={{ color: 'var(--text-primary)', fontWeight: 'bold' }}>{(n.source || 'edge').toUpperCase()}</span>
              <span style={{ color: 'var(--text-secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: '60px' }}>{(n.zoneId || '').replace('zone-', '')}</span>
              {sensorBadge(n.tempPinned, 'T', n.tempPinned && hasReading(n.hwTemp) ? `temperature ${fx(n.hwTemp, 1)}°C measured` : 'no live temperature sensor')}
              {sensorBadge((n.humidity || 0) > 0, 'H', (n.humidity || 0) > 0 ? `humidity ${(n.humidity).toFixed(0)}%RH measured` : 'no live humidity sensor')}
              {sensorBadge((n.co2 || 0) > 0, 'CO₂', (n.co2 || 0) > 0 ? `${Math.round(n.co2)} ppm measured (NDIR)` : 'no live CO₂ sensor')}
              {sensorBadge((n.plugW || 0) > 0, 'W', (n.plugW || 0) > 0 ? `plug circuit ${(n.plugW).toFixed(0)} W measured (SCT-013)` : 'no live power clamp')}
              {n.shadowTemp > 0 && (
                <span title="AFDD residual: |measured − 2R1C shadow model|" style={{ color: n.afddAlert ? 'var(--accent-red)' : 'var(--text-muted)' }}>
                  Δ{(n.residual || 0).toFixed(1)}°
                </span>
              )}
              <span style={{ color: 'var(--text-secondary)' }}>{n.occupancy ?? 0}P</span>
              <span style={{ color: n.lightsOn ? 'var(--accent-green)' : 'var(--text-muted)' }}>{n.lightsOn ? 'LIT' : 'DARK'}</span>
              {n.plugShed && <span style={{ color: 'var(--accent-green)' }}>SWEPT</span>}
            </div>
          ))}
        </div>
      );
    }
    return null;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', animation: 'fadeIn 0.5s ease-out' }}>

      {/* Header Section */}
      <div style={{ paddingBottom: '16px', borderBottom: '1px solid var(--border-glass)' }}>
        <h3 style={{ margin: '0 0 8px 0', fontSize: '14px', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-primary)' }}>
          <Brain size={18} color="var(--accent-blue)" /> AI Operations Engine
        </h3>
        <p style={{ margin: 0, fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          Two learned models: baselines score each signal against this building’s own normal for the hour, and every room’s identified physics predicts where it is heading. Total building load is currently at <span style={{ color: 'var(--text-primary)', fontWeight: 'bold' }}>{powerMw(simData.buildingLoadMw || 0)}</span>.
          {recModel && (
            <span style={{ display: 'block', marginTop: '4px', color: 'var(--text-muted)', fontSize: '10px' }}>
              Baselines: {recModel.established} signal{recModel.established === 1 ? '' : 's'} established, {recModel.learning} learning (matures after {recModel.matureAfter} samples).
              {typeof recModel.roomsIdentified === 'number' && (
                <> · Room models: {recModel.roomsIdentified} identified, {recModel.roomsLearning} learning — predicting {recModel.horizonMin} min ahead.</>
              )}
            </span>
          )}
        </p>
      </div>

      {/* Visual Forecast & Predictive Load Trajectory Graph */}
      <div
        style={{
          background: 'rgba(0, 163, 224, 0.04)',
          border: '1px solid rgba(0, 163, 224, 0.25)',
          borderRadius: '10px',
          padding: '12px 14px',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '4px', background: 'var(--accent-blue)' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
          <div style={{ padding: '5px', background: 'rgba(255,255,255,0.05)', borderRadius: '6px', display: 'flex' }}>
            <Activity size={16} color="var(--accent-blue)" />
          </div>
          <span style={{ fontSize: '12px', fontWeight: 'bold', color: 'var(--accent-blue)' }}>
            AI Load Forecast Trajectory & Peak Reference
          </span>
          <span
            style={{
              marginLeft: 'auto',
              fontSize: '8px',
              fontWeight: 'bold',
              letterSpacing: '0.05em',
              padding: '1px 5px',
              borderRadius: '3px',
              color: 'var(--accent-blue)',
              border: '1px solid var(--accent-blue)',
            }}
          >
            {activeForecast.engine.toUpperCase()}
          </span>
        </div>
        <p style={{ margin: '0 0 6px 0', fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
          Predictive sequence trajectory and upper uncertainty band ({activeForecast.upperQuantile?.toUpperCase() || 'Q9'}) plotted against live building load ({powerMw(loadMw)}).
        </p>
        <ForecastChart
          series={activeForecast.seriesData}
          upperBand={activeForecast.upperBand}
          upperQuantile={activeForecast.upperQuantile}
          peakUpperMw={activeForecast.peakUpperMw}
          lstmPeakMw={activeForecast.lstmPeakMw}
          stepMinutes={activeForecast.stepMinutes}
          engine={activeForecast.engine}
          liveLoadMw={loadMw}
          plausible={activeForecast.plausible}
          plausibility={activeForecast.plausibility}
          height={125}
          showLegend={true}
        />
      </div>

      {/* Insight Cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {insights.map((insight, idx) => {
          let bg, border, titleColor;
          switch (insight.type) {
            case 'critical':
              bg = 'rgba(239, 68, 68, 0.05)';
              border = 'rgba(239, 68, 68, 0.3)';
              titleColor = 'var(--accent-red)';
              break;
            case 'warning':
              bg = 'rgba(234, 179, 8, 0.05)';
              border = 'rgba(234, 179, 8, 0.3)';
              titleColor = 'var(--accent-yellow)';
              break;
            case 'success':
              bg = 'rgba(34, 197, 94, 0.05)';
              border = 'rgba(34, 197, 94, 0.3)';
              titleColor = 'var(--accent-green)';
              break;
            case 'info':
            default:
              bg = 'rgba(0, 163, 224, 0.05)';
              border = 'rgba(0, 163, 224, 0.3)';
              titleColor = 'var(--accent-blue)';
              break;
          }

          const isExpanded = !!expanded[insight.id];

          return (
            <div
              key={insight.id}
              style={{
                background: bg,
                border: `1px solid ${border}`,
                borderRadius: '10px',
                padding: '14px',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                position: 'relative',
                overflow: 'hidden',
                animation: `slideInRight 0.4s ease-out ${idx * 0.1}s backwards`
              }}
            >
              {/* Decorative side accent */}
              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '4px', background: titleColor }} />

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{ padding: '6px', background: 'rgba(255,255,255,0.05)', borderRadius: '6px', display: 'flex' }}>
                  {insight.icon}
                </div>
                <span style={{ fontSize: '12px', fontWeight: 'bold', color: titleColor }}>
                  {insight.title}
                </span>
                {insight.badge && (
                  <span
                    title={insight.badgeTitle || (insight.badge === 'LEARNED' ? "Scored against this zone's learned normal for the hour" : 'Recognized fixed standard (baseline still learning this zone)')}
                    style={{
                      marginLeft: 'auto', fontSize: '8px', fontWeight: 'bold', letterSpacing: '0.05em',
                      padding: '1px 5px', borderRadius: '3px', flexShrink: 0,
                      color: insight.badgeColor || 'var(--text-muted)',
                      border: `1px solid ${insight.badgeColor || 'var(--text-muted)'}`,
                    }}
                  >
                    {insight.badge}
                  </span>
                )}
              </div>

              <p style={{ margin: '4px 0 0 0', fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                {insight.message}
              </p>

              {insight.expandable && isExpanded && (
                insight.id === 'afdd'
                  ? <AfddDriftDetail zoneId={insight.afddZone} />
                  : renderDetail(insight.id)
              )}

              {/* The learned/predicted cards carry their own evidence: the σ position
                  against the learned band, the identified response curve, the sample
                  counts, and the supply-air provenance behind the fit. */}
              {insight.evidence && isExpanded && (
                <RecommendationEvidence
                  rec={insight.rec}
                  model={roomModels[insight.rec.zone]}
                  matureAfter={recModel?.matureAfter}
                  horizonMin={recModel?.horizonMin ?? 30}
                  forecast={activeForecast}
                  // The engine sends the ceiling it actually evaluated this finding against (rec.limit):
                  // setpoint + its comfort margin for a thermal call, the CO2 guideline for a
                  // ventilation one. This used to be re-derived here — a literal 1000 and a
                  // setpoint+1 typed into the panel — which put a building coefficient outside the
                  // library and let the line on the chart drift from the line the prediction was
                  // made against. Undefined when the engine sent none, so no threshold is drawn
                  // rather than a guessed one.
                  limit={insight.rec.limit > 0 ? insight.rec.limit : undefined}
                />
              )}

              {/* Evidence toggle. A card with a real remediation keeps its action button
                  and gains this beside it, so opening the reasoning is never a choice
                  between reading why and being able to act. */}
              {insight.evidence && (
                <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: '2px' }}>
                  <button
                    onClick={() => toggle(insight.id)}
                    style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: '10px', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
                  >
                    {isExpanded ? '▴ hide the evidence' : '▾ why this fired'}
                  </button>
                </div>
              )}

              {insight.action && (() => {
                // Expandables toggle inline detail; the rest run their REAL action —
                // an override, a window, a navigation. `once` actions latch as engaged;
                // `done` reflects engine state (e.g. a pre-cool window already open).
                const settled = insight.done || (insight.once && !!engaged[insight.id]);
                const label = insight.expandable
                  ? (isExpanded ? '▴ COLLAPSE' : insight.action)
                  : insight.done ? insight.doneLabel
                  : (insight.once && engaged[insight.id]) ? '✓ ENGAGED'
                  : insight.action;
                return (
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '4px' }}>
                    <button
                      onClick={() => {
                        if (insight.expandable) return toggle(insight.id);
                        if (settled) return;
                        insight.onAction && insight.onAction();
                        if (insight.once) setEngaged((e) => ({ ...e, [insight.id]: true }));
                      }}
                      disabled={!insight.expandable && settled}
                      style={{
                        background: !insight.expandable && settled ? titleColor : 'transparent',
                        border: `1px solid ${border}`,
                        color: !insight.expandable && settled ? '#000' : titleColor,
                        padding: '6px 12px',
                        borderRadius: '4px',
                        fontSize: '10px',
                        fontWeight: 'bold',
                        cursor: !insight.expandable && settled ? 'default' : 'pointer',
                        transition: 'all 0.2s ease',
                      }}
                      onMouseOver={(e) => { if (insight.expandable || !settled) { e.currentTarget.style.background = titleColor; e.currentTarget.style.color = '#000'; } }}
                      onMouseOut={(e) => { if (insight.expandable || !settled) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = titleColor; } }}
                    >
                      {label}
                    </button>
                  </div>
                );
              })()}
            </div>
          );
        })}
      </div>

      {/* What the twin can actually REACH. In real mode this is the denominator for
          everything above it: a panel with little to say because the building is behaving
          and a panel with little to say because nothing is wired look identical, and only
          this card tells them apart. */}
      <HardwareReachCard hardware={recHardware} realMode={realMode} recommendationCount={recommendations.length} />

      {/* What the twin has actually identified. This is the reasoning layer the panel was
          asserting conclusions from without ever showing. */}
      <RoomModelsCard rooms={roomList} identified={roomsIdentified} matureAfter={roomsMatureAfter} learning={recModel?.roomsLearning ?? 0} setSelectedZone={setSelectedZone} />

      {/* Take the intelligence offline: download the learned models + recommender. */}
      <ModelExportCard />

      {/* Embedded CSS for animations */}
      <style>{`
        @keyframes slideInRight {
          from { opacity: 0; transform: translateX(20px); }
          to { opacity: 1; transform: translateX(0); }
        }
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>
    </div>
  );
}

// ModelExportCard is the "take the intelligence with you" surface: it downloads the
// learned baseline model, the LSTM forecaster artifacts, and a dependency-free recommender
// as one zip (GET /api/model/export), so an operator can run the SAME σ-scored
// recommendations and alerts offline from the twin's own processed state — no server
// required. It reads /api/model for the model's live maturity so the card is honest about
// what the download will actually be able to do.
