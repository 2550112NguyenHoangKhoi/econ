import React, { useMemo, useState, useEffect } from 'react';
import { Brain, Zap, AlertTriangle, TrendingDown, Activity, Radio, ThermometerSnowflake, Power, Plug, CloudOff, Wind, WifiOff } from 'lucide-react';
import { money, energyCostPerDay, peakShiftSavingPerMonth, rateStr, touPeriod, minutesToPeak, TARIFF } from './tariff';
import { useOpsStatus, untilLabel } from './useOpsStatus';
import { usePlugs } from './usePlugs';
import { useRecommendations } from './useRecommendations';
import { useForecastCompare } from './useForecastCompare';
import { useLibrary } from './useLibrary';
import { useRoomModels } from './useRoomModels';
import RecommendationEvidence from './RecommendationEvidence';
import ForecastChart from './ForecastChart';
import { powerMw, powerKw } from './units';
import ModelDownloadMobile from './mobile/ModelDownloadMobile';
import RecCard from './mobile/RecCard';
import RecommendationsEmptyState from './mobile/RecommendationsEmptyState';
import RoomModelsMobile from './mobile/RoomModelsMobile';

// Mobile "AI & Automation" screen — the phone-sized twin of the desktop AI Insights panel.
// Gives the operator the three things the app is meant to offer on the go:
//   1. AUTOMATE  — a master Auto-Pilot switch (the autonomous optimizer intent).
//   2. RECOMMENDATIONS — the same live, data-driven insights the desktop shows, each with a
//      real action (open a pre-cool window, purge a stale-air room, fly to a faulting room).
//   3. MANUAL    — a reminder that tapping any room in the 3D view opens per-zone overrides.
// Every card is generated from real state: the telemetry stream, the edge-node registry,
// the EVN TOU clock, and the engine's own control loops (pre-cool, plug sweep, weather).
export default function MobileAIScreen({
  simData = {}, activeScenario, faultTarget, aiForecast, hardwareNodes = {},
  autoPilot, setAutoPilot, sendManualOverride, onFocusZone, onOpenEnergy,
}) {
  const [engaged, setEngaged] = useState({});
  const mark = (id) => setEngaged((e) => ({ ...e, [id]: true }));

  const loadMw = simData.buildingLoadMw || 0;
  const savedMw = simData.energySavedMw || 0;
  const savingsPct = savedMw + loadMw > 0 ? (100 * savedMw) / (savedMw + loadMw) : 0;
  // The plant's electrical draw is the live thermal cooling divided by the live COP, so the
  // shed estimate tracks the real plant instead of subtracting a hard-coded baseline.
  const plantCop = simData.plantCop || 0;
  const hvacMw = plantCop > 0 ? Math.min(loadMw, (simData.coolingOutputMw || 0) / plantCop) : 0;
  const hwList = Object.values(hardwareNodes || {});

  // Building coefficients and the critical-zone list come from the engine's programme
  // library, not from literals here. The pre-cool shift fraction in particular had been
  // typed into this file as "~5%-per-°C deadband/pre-cool shave" and into the desktop
  // panel as "≈5% coast from a charged thermal mass" — the same number, two incompatible
  // explanations, neither traceable to anything. Null until the library answers.
  const { isCritical, precoolShift } = useLibrary();
  // matureAfter comes from this endpoint, not the baseline model's — the two mature on
  // different evidence and at different sample counts.
  const { byZone: roomModels, rooms: roomList, identified: roomsIdentified, matureAfter: roomsMatureAfter } = useRoomModels();
  const shedKw = precoolShift != null ? precoolShift * hvacMw * 1000 : null;

  // Live control-loop state from the engine (shared hooks with the desktop panel).
  const { precool, weather } = useOpsStatus();
  const { status: plugStatus } = usePlugs();
  // Learned anomaly recommendations — the same σ-scored model the desktop panel shows.
  // hardware/realMode carry what the engine can actually reach and whether it filtered
  // this list against that. See useRecommendations — on a phone, where there is no room
  // for a second panel, an unexplained empty list is the whole screen.
  const { recommendations, model: recModel, forecast: recForecast, hardware: recHardware, realMode } = useRecommendations();

  // Forecast data from live compare endpoint with fallback to embedded recommendations payload
  const { timesfm, lstm: lstmCompare, series: tfmSeries, stepMinutes: compareStepMinutes,
          upperBand: compareUpperBand, upperQuantile: compareUpperQuantile, peakUpperMw: comparePeakUpperMw } = useForecastCompare();

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

  const recs = useMemo(() => {
    const out = [];
    const zones = Object.values(simData.zones || {});

    // 1. Critical thermal runaway (worst alerting zone first).
    const alerting = zones.filter((z) => z.alert === true || z.alert === 'REMEDIATING')
      .sort((a, b) => (b.temp - b.setpoint) - (a.temp - a.setpoint));
    if (activeScenario === 'fault' && faultTarget) {
      out.push({
        id: 'fault', accent: '#FF3B30', icon: <AlertTriangle size={20} color="#FF3B30" />,
        title: 'Thermal Runaway Detected',
        message: `Zone ${faultTarget} is experiencing a critical thermal failure. Cooling capacity is degraded.`,
        actionLabel: 'FLOOD ZONE WITH COOLING',
        onAction: () => sendManualOverride && sendManualOverride('cool', faultTarget),
      });
    } else if (alerting.length) {
      const z = alerting[0];
      out.push({
        id: 'fault', accent: '#FF3B30', icon: <AlertTriangle size={20} color="#FF3B30" />,
        title: 'Thermal Runaway Detected',
        message: `${z.label} is at ${z.temp.toFixed(1)}°C — cooling capacity degraded.`,
        actionLabel: 'FLOOD ZONE WITH COOLING',
        onAction: () => sendManualOverride && sendManualOverride('cool', z.id),
      });
    }

    // 2. A bound edge node the broker has declared dead (MQTT Last Will) — a field
    // callout: its zone has fallen back to pure simulation.
    const dead = hwList.filter((n) => !n.online);
    if (dead.length) {
      const n = dead[0];
      out.push({
        id: 'offline', accent: '#FF3B30', icon: <WifiOff size={20} color="#FF3B30" />,
        title: `Edge Node${dead.length > 1 ? 's' : ''} Offline`,
        message: `${dead.map((d) => `${(d.source || 'edge').toUpperCase()} on ${(d.zoneId || '').replace('zone-', '')}`).join('; ')} — broker LWT reports offline. Sensing and socket control are gone until the node returns.`,
        actionLabel: 'SHOW ZONE →', onAction: () => onFocusZone && onFocusZone(n.zoneId),
      });
    }

    // 3. Physics-grounded AFDD divergence (real hardware residual).
    const afdd = hwList.filter((n) => n.afddAlert);
    if (afdd.length) {
      const n = afdd[0];
      out.push({
        id: 'afdd', accent: '#F5C242', icon: <Activity size={20} color="#F5C242" />,
        title: 'AFDD: Physics Divergence',
        message: `${(n.zoneId || '').replace('zone-', '')} is ${(n.residual || 0).toFixed(1)}°C off its calibrated 2R1C model — possible coil/damper fault or open window.`,
        actionLabel: 'INSPECT ZONE →', onAction: () => onFocusZone && onFocusZone(n.zoneId),
      });
    }

    // 3b. LEARNED anomaly recommendations from the engine's baseline model — each scored
    // in σ against the zone's own normal for the hour (ASHRAE 1000 ppm floor while a
    // sensor is still learning). Replaces the old co2 > 1000 / temp > deadband rules; the
    // action is the real remediation the model chose, dispatched over the same websocket.
    const recLabels = {
      purge: 'PURGE ZONE',
      cool: 'FLOOD COOLING',
      precool: 'ACTIVATE PRE-COOLING',
      turn_off_ac: 'TURN OFF AC',
      reset: 'RESET TO BASELINE',
    };
    recommendations.forEach((rec) => {
      const accent = rec.severity === 'critical' ? '#FF3B30' : rec.severity === 'warning' ? '#F5C242' : '#4A90E2';
      const icon = rec.metric === 'co2' ? <Wind size={20} color={accent} />
        : rec.metric === 'temp' ? <ThermometerSnowflake size={20} color={accent} />
        : rec.metric === 'buildingLoadMw' ? <TrendingDown size={20} color={accent} />
        : rec.metric === 'occupancy' ? <Zap size={20} color={accent} />
        : <Activity size={20} color={accent} />;
      const label = recLabels[rec.action];
      out.push({
        id: `rec-${rec.id}`, accent, icon,
        title: rec.title,
        message: rec.message,
        // The engine's reasoning travels with the card so the phone can show the same
        // evidence the desktop does: the learned band, the σ position, the identified
        // response, the sample counts.
        rec,
        badge: rec.kind === 'prediction' ? (rec.etaSec > 0 ? `PREDICTED ${rec.etaSec >= 5400 ? (rec.etaSec / 3600).toFixed(1) + 'h' : Math.round(rec.etaSec / 60) + 'min'}` : 'PREDICTED')
          : rec.kind === 'capability' ? 'CAPABILITY'
          : rec.basis === 'learned' ? 'LEARNED' : 'ASHRAE STD',
        actionLabel: label,
        onAction: label ? () => {
          if (rec.action === 'precool') {
            sendManualOverride && sendManualOverride('precool', 'GLOBAL');
          } else {
            sendManualOverride && sendManualOverride(rec.action, rec.zone);
          }
        } : undefined,
      });
    });

    // 4. High grid demand — the EVN TOU CLOCK decides, not a demo toggle: in cao điểm,
    // or within 90 minutes of it. Reflects the engine's real pre-cool window state.
    const tou = touPeriod();
    const toPeak = minutesToPeak();
    if (tou === 'peak' || (toPeak !== null && toPeak <= 90)) {
      const windowOpen = !!precool?.active;
      out.push({
        id: 'precool', accent: '#FFD60A', icon: <TrendingDown size={20} color="#FFD60A" />,
        title: tou === 'peak' ? 'Peak Tariff Running Now' : `Peak Tariff in ${toPeak} min`,
        message: windowOpen
          ? `A pre-cool window is open until ${untilLabel(precool.until)} — thermal mass is charging so chillers coast through the ${rateStr('peak')}/kWh window.`
          : `${tou === 'peak' ? `Peak rate is charging ${rateStr('peak')}/kWh right now.` : `Peak rate (${rateStr('peak')}/kWh) begins at 17:30.`}${
              shedKw != null
                ? ` Pre-cooling shifts an estimated ${powerKw(shedKw)} off peak — about ${money(peakShiftSavingPerMonth(shedKw))}/month at the rate gap, using the library's ${(precoolShift * 100).toFixed(0)}% planning figure rather than a measured coast.`
                : ' The size of the shift is not shown: it depends on a plant coefficient this dashboard could not read from the engine.'
            }`,
        actionLabel: 'ACTIVATE PRE-COOLING',
        // A window the ENGINE already has open is a state, not a button. The card used to
        // set done:true and put the status in actionLabel, but RecCard only renders a
        // button when there is an action — so with the window open the status vanished
        // and the card showed nothing at all about the pre-cool it was reporting.
        status: windowOpen ? `✓ Pre-cooling — window open until ${untilLabel(precool.until)}` : null,
        onAction: windowOpen ? undefined : () => { sendManualOverride && sendManualOverride('precool', 'GLOBAL'); },
      });
    }

    // 5. Load forecast with input provenance and active zero-shot / supervised trajectory
    const hasForecastSignal = (aiForecast && aiForecast.predicted_peak_load) || activeForecast.available;
    if (hasForecastSignal) {
      const predPeak = aiForecast?.predicted_peak_load ?? activeForecast.lstmPeakMw ?? (activeForecast.rawSeries ? Math.max(...activeForecast.rawSeries) : null);
      const src = aiForecast?.weather_source === 'engine' ? '(engine’s live weather feed)'
        : aiForecast?.weather_source === 'fallback' ? '(fallback weather)' : '(live weather)';
      const realN = aiForecast?.window_real_samples ?? recForecast?.samples;
      const winLen = aiForecast?.window_len || 12;
      const warmup = realN != null && realN < winLen ? ` Window warming up: ${realN}/${winLen} real samples.` : '';
      const ood = aiForecast?.implausible === true || activeForecast.plausible === false;
      const unjudged = !ood && aiForecast != null && aiForecast.plausibility_judged === false;
      const flagged = ood || unjudged;
      out.push({
        id: 'forecast', accent: flagged ? '#F5C242' : '#4A90E2',
        icon: <Activity size={20} color={flagged ? '#F5C242' : '#4A90E2'} />,
        title: ood ? 'Load Forecast Out Of Distribution'
          : unjudged ? 'Load Forecast Not Yet Checked'
          : `${activeForecast.engine === 'timesfm' ? 'TimesFM Zero-Shot' : 'LSTM'} Load Forecast`,
        badge: ood ? 'NOT THIS BUILDING' : unjudged ? 'UNVERIFIED' : (activeForecast.engine === 'timesfm' ? 'TIMESFM' : 'LSTM'),
        message: ood
          ? `The model returns ${predPeak ? powerMw(predPeak) : '—'}. ${aiForecast?.plausibility || activeForecast.plausibility || 'Out of distribution.'} Retrain it on this building, or rely on the zero-shot forecaster, which reads this building's own recorded series.`
          : unjudged
            ? `The supervised model returns ${predPeak ? powerMw(predPeak) : '—'}, but ${aiForecast?.plausibility || 'not yet checked.'}`
            : `Predictive model projects upcoming peak of ${predPeak ? powerMw(predPeak) : (activeForecast.peakUpperMw ? powerMw(activeForecast.peakUpperMw) : '—')} over ${activeForecast.stepMinutes * (activeForecast.seriesData.length || 12)} min horizon ${src}.${warmup}`,
        forecast: activeForecast,
      });
    }

    // 5b. Weather feed stale → envelope on the climatological fallback.
    if (weather && !weather.live) {
      out.push({
        id: 'weather', accent: '#F5C242', icon: <CloudOff size={20} color="#F5C242" />,
        title: 'Weather Feed Stale',
        message: `Open-Meteo has not refreshed${weather.ageSec > 0 ? ` in ${(weather.ageSec / 3600).toFixed(1)} h` : ''}. The envelope physics is running on the ${weather.outdoorC.toFixed(1)} °C fallback — loads and forecasts are less trustworthy until it recovers.`,
      });
    }

    // 5c. Plug sweep (APLC): the engine's own after-hours socket control, live.
    if (plugStatus) {
      const saved = simData.plugSavedKwh ?? plugStatus.savedKwh ?? 0;
      if (!plugStatus.config?.enabled) {
        out.push({
          id: 'plugs', accent: '#F5C242', icon: <Plug size={20} color="#F5C242" />,
          title: 'Plug Sweep Disabled',
          message: `${(simData.plugStandbyKw ?? plugStatus.standbyKw ?? 0).toFixed(1)} kW of always-on standby has no after-hours control — the case-study buildings lost 26.4% of their energy to exactly this.`,
          actionLabel: 'OPEN ENERGY →', onAction: onOpenEnergy,
        });
      } else if (plugStatus.armed) {
        out.push({
          id: 'plugs', accent: '#3DDC84', icon: <Plug size={20} color="#3DDC84" />,
          title: 'Plug Sweep Armed',
          message: `${plugStatus.shedZones} vacant zone${plugStatus.shedZones === 1 ? '' : 's'} swept — ${(simData.plugShedKw ?? plugStatus.shedKw ?? 0).toFixed(1)} kW off. Avoided so far: ${saved.toFixed(1)} kWh ≈ ${money(saved * TARIFF.normalPerKwh)}. Sockets restore on presence.`,
          actionLabel: 'OPEN ENERGY →', onAction: onOpenEnergy,
        });
      }
    }

    // 6. Physical edge nodes bound in.
    if (hwList.length) {
      const online = hwList.filter((n) => n.online).length;
      out.push({
        id: 'hw', accent: '#3DDC84', icon: <Radio size={20} color="#3DDC84" />,
        title: 'Hardware-in-the-Loop',
        message: `${online}/${hwList.length} physical edge node${hwList.length > 1 ? 's' : ''} online (${[...new Set(hwList.map((n) => (n.source || 'edge').toUpperCase()))].join(', ')}).`,
      });
    }

    // 7. Unoccupied zones still at occupied setpoints — priced through the live COP at
    // the live tariff, and attributed honestly: instrumented zones set back themselves.
    // 24/7-critical types excluded: an empty server room being cooled is correct, not waste.
    // Critical types come from the engine's library. The hardcoded pair this replaces
    // (`server-room`, `mechanical`) matched no zone type the current digitizer emits, so
    // it excluded nothing and this card counted the comms room as waste.
    const wasting = isCritical(zones[0]?.type) === null ? [] : zones.filter((z) =>
      z.occupancy === 0 && z.load > 0 && z.lightsOn !== false && !isCritical(z.type));
    if (wasting.length && plantCop > 0) {
      const wasteKw = wasting.reduce((acc, z) => acc + z.load, 0) / plantCop;
      out.push({
        id: 'eco', accent: '#4A90E2', icon: <Zap size={20} color="#4A90E2" />,
        title: 'Unoccupied, Still Cooled',
        message: `${wasting.length} unoccupied zone${wasting.length === 1 ? '' : 's'} still held at occupied setpoints — ≈ ${wasteKw.toFixed(1)} kW electrical (${money(energyCostPerDay(wasteKw))}/day). Zones with presence sensors set back automatically; the rest wait for edge nodes or the after-hours plug sweep.`,
      });
    }

    // 7. (Thermal-drift hotspots now come from the learned-baseline recommendations above:
    // a zone many σ hotter than its own hourly normal, not a fixed deadband rule.)

    // 8. Always-present autonomous-operations summary — real engine numbers.
    out.push({
      id: 'nominal', accent: autoPilot ? '#3DDC84' : '#FFD60A', icon: <Brain size={20} color={autoPilot ? '#3DDC84' : '#FFD60A'} />,
      title: autoPilot ? 'Autonomous Operations Active' : 'Auto-Pilot Suspended',
      message: autoPilot
        ? `Optimizer is holding ${simData.zonesInSetback ?? 0} zone${(simData.zonesInSetback ?? 0) === 1 ? '' : 's'} in setback — ${savingsPct.toFixed(1)}% of plant load, ≈ ${money(energyCostPerDay(savedMw * 1000))}/day. Streamed from the engine, not estimated.`
        : 'The optimizer is off — it released its setbacks to baseline and you are in manual control. Toggle Auto-Pilot above to resume autonomous setback.',
    });

    return out;
  }, [simData, activeScenario, faultTarget, aiForecast, hwList, shedKw, precoolShift, isCritical, savingsPct, savedMw, autoPilot, recommendations, onFocusZone, sendManualOverride, setAutoPilot, precool, weather, plugStatus, onOpenEnergy]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', color: '#fff', fontFamily: 'system-ui, -apple-system, "SF Pro Display", sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2 style={{ margin: 0, fontSize: '24px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Brain size={22} color="#4A90E2" /> AI & Automation
        </h2>
      </div>

      {/* AUTO-PILOT master switch */}
      <div
        onClick={() => setAutoPilot && setAutoPilot(!autoPilot)}
        style={{
          display: 'flex', alignItems: 'center', gap: '14px', cursor: 'pointer',
          background: autoPilot ? 'rgba(52,199,89,0.10)' : 'rgba(255,255,255,0.05)',
          border: `1px solid ${autoPilot ? 'rgba(52,199,89,0.4)' : 'rgba(255,255,255,0.12)'}`,
          borderRadius: '16px', padding: '18px', marginBottom: '22px',
        }}
      >
        <Power size={26} color={autoPilot ? '#34C759' : 'rgba(255,255,255,0.5)'} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '17px', fontWeight: 700, color: autoPilot ? '#34C759' : '#fff' }}>
            Auto-Pilot {autoPilot ? 'ON' : 'OFF'}
          </div>
          <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', marginTop: '3px', lineHeight: 1.35 }}>
            {autoPilot
              ? `Holding ${simData.zonesInSetback ?? 0} zone${(simData.zonesInSetback ?? 0) === 1 ? '' : 's'} in setback — ${powerMw(simData.energySavedMw || 0)} saved (${money(energyCostPerDay((simData.energySavedMw || 0) * 1000))}/day). Streamed from the engine.`
              : 'Manual mode — setpoints released to baseline, you are in control. Recommendations below are suggestions.'}
          </div>
        </div>
        {/* iOS-style track */}
        <div style={{ width: '48px', height: '28px', borderRadius: '999px', background: autoPilot ? '#34C759' : 'rgba(255,255,255,0.2)', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
          <div style={{ position: 'absolute', top: '3px', left: autoPilot ? '23px' : '3px', width: '22px', height: '22px', borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
        </div>
      </div>

      {/* Visual Forecast & Predictive Load Trajectory Graph on Mobile */}
      <div
        style={{
          background: 'rgba(74,144,226,0.08)',
          border: '1px solid rgba(74,144,226,0.3)',
          borderRadius: '16px',
          padding: '16px',
          marginBottom: '20px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
          <Activity size={18} color="#4A90E2" />
          <span style={{ fontSize: '14px', fontWeight: 700, color: '#4A90E2' }}>
            Load Forecast & Uncertainty
          </span>
          <span
            style={{
              marginLeft: 'auto',
              fontSize: '9px',
              fontWeight: 700,
              padding: '2px 6px',
              borderRadius: '4px',
              color: '#4A90E2',
              border: '1px solid #4A90E2',
            }}
          >
            {activeForecast.engine.toUpperCase()}
          </span>
        </div>
        <p style={{ margin: '0 0 6px 0', fontSize: '12px', color: 'rgba(255,255,255,0.7)', lineHeight: 1.4 }}>
          {activeForecast.engine === 'timesfm' ? 'TimesFM zero-shot' : 'LSTM supervised'} load forecast ({activeForecast.stepMinutes * (activeForecast.seriesData.length || 12)} min) with {activeForecast.upperQuantile?.toUpperCase() || 'Q9'} upper decile band.
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
          height={115}
          compact={false}
          showLegend={true}
        />
      </div>

      <div style={{ fontSize: '12px', fontWeight: 600, letterSpacing: '0.1em', color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase', marginBottom: recModel ? '4px' : '12px' }}>
        Live Recommendations
      </div>
      {recModel && (
        <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', marginBottom: '12px', lineHeight: 1.4 }}>
          Learned baseline: {recModel.established} signal{recModel.established === 1 ? '' : 's'} established, {recModel.learning} learning. Anomalies scored against each zone’s own normal for the hour.
        </div>
      )}

      {/* An empty list is ambiguous and the ambiguity matters more here than anywhere: in
          real mode the engine withholds any recommendation whose actuator is not wired
          (server/simulation/capability.go), so "nothing to show" can mean the building is
          well OR that nothing is connected. Saying which is not decoration. */}
      <RecommendationsEmptyState
        count={recs.length}
        hardware={recHardware}
        realMode={realMode}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {recs.map((r) => (
          <RecCard
            key={r.id}
            rec={r}
            done={!!engaged[r.id]}
            onEngage={() => mark(r.id)}
            model={r.rec ? roomModels[r.rec.zone] : null}
            matureAfter={recModel?.matureAfter}
            horizonMin={recModel?.horizonMin ?? 30}
            forecast={activeForecast}
            // The engine's own evaluated ceiling, not one re-derived here. See the
            // note beside the same prop in AiInsightsPanel.
            limit={r.rec?.limit > 0 ? r.rec.limit : undefined}
          />
        ))}
      </div>

      {/* What the twin has actually identified, phone-sized. */}
      <RoomModelsMobile rooms={roomList} identified={roomsIdentified} matureAfter={roomsMatureAfter} learning={recModel?.roomsLearning ?? 0} onFocusZone={onFocusZone} />

      {/* Local models: take the intelligence offline. */}
      <ModelDownloadMobile />

      {/* Manual-control hint */}
      <div style={{ marginTop: '22px', padding: '16px', borderRadius: '14px', background: 'rgba(255,255,255,0.04)', border: '1px dashed rgba(255,255,255,0.12)', fontSize: '13px', color: 'rgba(255,255,255,0.6)', lineHeight: 1.5 }}>
        <b style={{ color: '#fff' }}>Manual control:</b> tap any room in the 3D view to open it and force lights off, max-cool, or reset that zone — your override latches for 15 minutes over the optimizer.
      </div>
      <div style={{ height: '40px' }} />
    </div>
  );
}
