import React from 'react';
import { Brain, Zap, AlertTriangle, TrendingDown, ThermometerSnowflake, Activity, Radio, Plug, CloudOff, Wind, WifiOff, Clock } from 'lucide-react';
import { money, energyCostPerDay, peakShiftSavingPerMonth, rateStr, touPeriod, minutesToPeak, TARIFF } from '../tariff';
import { untilLabel } from '../useOpsStatus';
import { powerMw, powerKw } from '../units';

// The rule set: everything the twin currently knows, turned into the ranked cards the AI
// panel shows. Lifted out of AiInsightsPanel's useMemo unchanged -- 310 lines of domain
// judgement that had nothing to do with rendering, and that no one could read while it
// sat inside a component.
//
// Pure: it reads only the context handed to it and returns a fresh array. The caller keeps
// the memoisation, with the dependency list it already had.
//
// fmtEta renders a predicted time-to-breach the way an operator reads it.
function fmtEta(sec) {
  if (!sec || sec <= 0) return '';
  return sec >= 5400 ? `${(sec / 3600).toFixed(1)}h` : `${Math.round(sec / 60)}min`;
}

export function buildInsights({
  simData,
  activeScenario,
  faultTarget,
  aiForecast,
  activeForecast,
  recForecast,
  hwList,
  hwOnline,
  savingsPct,
  savedMw,
  loadMw,
  precool,
  weather,
  plugStatus,
  recommendations,
  sendManualOverride,
  setSelectedZone,
  onOpenPlugs,
  isCritical,
  precoolShift,
}) {
  const generated = [];
  const zones = Object.values(simData.zones || {});
  const cop = simData.plantCop || 0;

  // 1. Critical scenario fault → REAL remediation: a websocket override that floods
  // the zone with cooling (engine publishes to the edge node and latches 15 min).
  if (activeScenario === 'fault' && faultTarget) {
    generated.push({
      id: 'fault',
      type: 'critical',
      icon: <AlertTriangle size={18} color="var(--accent-red)" />,
      title: 'Thermal Runaway Detected',
      message: `Zone ${faultTarget} is experiencing a critical thermal failure. Cooling capacity is degraded.`,
      action: 'FLOOD ZONE WITH COOLING',
      once: true,
      onAction: () => sendManualOverride && sendManualOverride('cool', faultTarget),
    });
  }

  // 1b. A bound edge node the broker has declared dead (MQTT Last Will). Its zone has
  // fallen back to simulation — that is a field callout, not a UI state.
  const deadNodes = hwList.filter((n) => !n.online);
  if (deadNodes.length > 0) {
    generated.push({
      id: 'offline',
      type: 'critical',
      icon: <WifiOff size={18} color="var(--accent-red)" />,
      title: `Edge Node${deadNodes.length > 1 ? 's' : ''} Offline`,
      message: `${deadNodes.map((n) => `${(n.source || 'edge').toUpperCase()} on ${(n.zoneId || '').replace('zone-', '')}`).join('; ')} — broker LWT reports offline. The zone${deadNodes.length > 1 ? 's have' : ' has'} fallen back to the 2R1C model; sensing and socket control are gone until the node returns.`,
      action: 'SHOW IN 3D',
      onAction: () => setSelectedZone && setSelectedZone(deadNodes[0].zoneId),
    });
  }

  // 2. Physical hardware bound into the twin (ESP32 edge nodes)
  if (hwList.length > 0) {
    const pinned = hwList.filter((n) => n.tempPinned).length;
    generated.push({
      id: 'hardware',
      type: hwOnline === hwList.length ? 'success' : 'warning',
      expandable: true,
      icon: <Radio size={18} color={hwOnline === hwList.length ? 'var(--accent-green)' : 'var(--accent-yellow)'} />,
      title: 'Hardware-in-the-Loop Active',
      message: `${hwOnline}/${hwList.length} physical edge node${hwList.length > 1 ? 's' : ''} online (${[...new Set(hwList.map((n) => (n.source || 'edge').toUpperCase()))].join(', ')}). ${pinned > 0 ? `${pinned} zone${pinned > 1 ? 's' : ''} pinned to a real temperature sensor.` : 'Occupancy is driven by the physical sensors.'}`,
      action: 'INSPECT NODES'
    });
  }

  // 2b. Physics-grounded AFDD: a sensor-bound room whose measured temperature has
  // diverged from its sensor-free 2R1C shadow model — a fault, not a forecast.
  const afddNodes = hwList.filter((n) => n.afddAlert);
  if (afddNodes.length > 0) {
    generated.push({
      id: 'afdd',
      type: 'critical',
      expandable: true, // expands the persisted residual trend — the maintenance evidence
      afddZone: afddNodes[0].zoneId,
      icon: <AlertTriangle size={18} color="var(--accent-red)" />,
      title: 'AFDD: Physics Divergence',
      message: `${afddNodes.map((n) => (n.zoneId || '').replace('zone-', '')).join(', ')} reading ${afddNodes.map((n) => `${(n.residual || 0).toFixed(1)}°C`).join(', ')} away from the calibrated thermal model — possible coil/damper fault, blocked diffuser or open window.`,
      action: 'VIEW DRIFT HISTORY',
    });
  }

  // 2c. LEARNED anomaly recommendations from the engine's online baseline model
  // (server/simulation/baselines.go). These REPLACE the old hardcoded threshold cards
  // (co2 > 1000, temp > setpoint + deadband): each is scored in σ against what the zone
  // actually does at THIS hour, with the ASHRAE 1000 ppm guideline as a clearly-labelled
  // cold-start floor. The message is authored server-side (learned mean±σ, deviation,
  // maturity), and every card's action is the real remediation the model chose — a purge
  // override, a cooling flood, a pre-cool window — dispatched over the same websocket.
  const recIcon = (metric, color) =>
    metric === 'co2' ? <Wind size={18} color={color} />
    : metric === 'temp' ? <ThermometerSnowflake size={18} color={color} />
    : metric === 'buildingLoadMw' ? <TrendingDown size={18} color={color} />
    : metric === 'occupancy' ? <Zap size={18} color={color} />
    : <Activity size={18} color={color} />;
  const recActionLabel = {
    purge: 'PURGE ZONE',
    cool: 'FLOOD COOLING',
    precool: 'ACTIVATE PRE-COOLING',
    turn_off_ac: 'TURN OFF AC',
    reset: 'RESET TO BASELINE',
  };
  // Three kinds of judgement, badged distinctly so a forecast never reads as a
  // present-tense fact. "anomaly" = the baselines say this is far from normal right now.
  // "prediction" = this room's own identified physics says it breaches in N minutes.
  // "capability" = its learned cooling authority cannot hold setpoint at all.
  const recBadge = (rec) => {
    if (rec.kind === 'prediction') {
      return { text: rec.etaSec > 0 ? `PREDICTED · ${fmtEta(rec.etaSec)}` : 'PREDICTED', color: 'var(--accent-yellow)',
        title: "Forward prediction from this room's identified thermal/CO₂ response, not a threshold" };
    }
    if (rec.kind === 'capability') {
      return { text: 'CAPABILITY', color: 'var(--accent-red)',
        title: "Learned cooling authority cannot hold this room's setpoint even at full flow" };
    }
    return rec.basis === 'learned'
      ? { text: 'LEARNED', color: 'var(--accent-blue)', title: "Scored against this zone's learned normal for the hour" }
      : { text: 'ASHRAE STD', color: 'var(--text-muted)', title: 'Recognized fixed standard (baseline still learning this zone)' };
  };
  recommendations.forEach((rec) => {
    const color = rec.severity === 'critical' ? 'var(--accent-red)' : rec.severity === 'warning' ? 'var(--accent-yellow)' : 'var(--accent-blue)';
    const label = recActionLabel[rec.action];
    const badge = recBadge(rec);
    generated.push({
      id: `rec-${rec.id}`,
      type: rec.severity,
      icon: rec.kind === 'prediction' ? <Clock size={18} color={color} /> : recIcon(rec.metric, color),
      title: rec.title,
      message: rec.message,
      badge: badge.text,
      badgeColor: badge.color,
      badgeTitle: badge.title,
      // The engine ships the reasoning — learned mean and σ, sample count, the hour
      // bucket that answered, the predicted and settling values, the identified time
      // constant. Carry it through so the card can be opened and checked instead of
      // being taken on faith.
      rec,
      action: label,
      // A card with a real remediation gets the action button AND an evidence toggle;
      // an advisory-only card gets the toggle alone.
      evidence: true,
      once: !!label,
      onAction: label ? () => {
        if (rec.action === 'precool') {
          sendManualOverride && sendManualOverride('precool', 'GLOBAL');
        } else {
          sendManualOverride && sendManualOverride(rec.action, rec.zone);
        }
      } : undefined,
    });
  });

  // 3. High grid demand — driven by the EVN TOU CLOCK, not a demo toggle: warn while
  // cao điểm is running, and ahead of it when it starts within 90 minutes. The card
  // reflects the engine's real pre-cool window state and its action opens one.
  const tou = touPeriod();
  const toPeak = minutesToPeak();
  if (tou === 'peak' || (toPeak !== null && toPeak <= 90)) {
    const hvacMw = cop > 0 ? Math.min(loadMw, (simData.coolingOutputMw || 0) / cop) : 0;
    // The shift fraction is a BUILDING coefficient, so it comes from the engine's
    // programme library (physics.precoolShiftFraction) rather than a literal here. It
    // had been typed in three files with three different justifications — "5% coast
    // from a charged thermal mass" here, "~5%-per-°C deadband shave" on mobile — which
    // is how you end up unable to say what the number means. Null until the library
    // arrives, and the card then states the rate without pricing a shift it cannot size.
    const shedKw = precoolShift != null ? precoolShift * hvacMw * 1000 : null;
    const windowOpen = !!precool?.active;
    generated.push({
      id: 'peak',
      type: tou === 'peak' ? 'warning' : 'info',
      icon: <TrendingDown size={18} color={tou === 'peak' ? 'var(--accent-yellow)' : 'var(--accent-blue)'} />,
      title: tou === 'peak' ? 'Peak Tariff Running Now' : `Peak Tariff in ${toPeak} min`,
      message: `${tou === 'peak' ? 'The 17:30–22:30 peak window is charging ' + rateStr('peak') + '/kWh right now.' : `Peak rate (${rateStr('peak')}/kWh vs ${rateStr('normal')} normal) begins at 17:30.`} ${
        windowOpen
          ? `A pre-cool window is OPEN until ${untilLabel(precool.until)} — thermal mass is charging so chillers can coast.`
          : shedKw != null
            ? `Pre-cooling now charges the thermal mass at the cheaper rate — shifting an estimated ${powerKw(shedKw)} off peak, worth roughly ${money(peakShiftSavingPerMonth(shedKw))}/month at the rate gap. The shift fraction is the library's ${(precoolShift * 100).toFixed(0)}% planning estimate, not a measured coast.`
            : 'Pre-cooling now charges the thermal mass at the cheaper rate. The size of the shift is not shown: it depends on the plant coefficient in the engine\'s programme library, which this dashboard has not been able to read.'
      }`,
      action: windowOpen ? 'PRE-COOLING' : 'ACTIVATE PRE-COOLING',
      done: windowOpen,
      doneLabel: `✓ OPEN UNTIL ${untilLabel(precool?.until)}`,
      once: true,
      onAction: () => sendManualOverride && sendManualOverride('precool', 'GLOBAL'),
    });
  }

  const hasForecastSignal = (aiForecast && aiForecast.predicted_peak_load) || activeForecast.available;
  if (hasForecastSignal) {
    const predPeak = aiForecast?.predicted_peak_load ?? activeForecast.lstmPeakMw ?? (activeForecast.rawSeries ? Math.max(...activeForecast.rawSeries) : null);
    const weatherNote = aiForecast?.weather_source === 'engine'
      ? 'Weather from the engine’s live Open-Meteo feed — same numbers the envelope physics uses.'
      : aiForecast?.weather_source === 'fallback' ? '(Using fallback weather.)' : '(Live engine telemetry incorporated.)';
    const realN = aiForecast?.window_real_samples ?? recForecast?.samples;
    const winLen = aiForecast?.window_len || 12;
    const warmup = realN != null && realN < winLen
      ? ` Input window warming up: ${realN}/${winLen} real 5-min samples since boot.`
      : '';
    const ood = aiForecast?.implausible === true || activeForecast.plausible === false;
    const unjudged = !ood && aiForecast != null && aiForecast.plausibility_judged === false;
    const flagged = ood || unjudged;
    generated.push({
      id: 'forecast',
      type: flagged ? 'warning' : 'info',
      expandable: true,
      icon: <Activity size={18} color={flagged ? 'var(--accent-yellow)' : 'var(--accent-blue)'} />,
      title: ood ? 'Load Forecast Out Of Distribution'
        : unjudged ? 'Load Forecast Not Yet Checked'
        : `${activeForecast.engine === 'timesfm' ? 'TimesFM Zero-Shot' : 'LSTM'} Forecast Diagnostics`,
      badge: ood ? 'NOT THIS BUILDING' : unjudged ? 'UNVERIFIED' : (activeForecast.engine === 'timesfm' ? 'TIMESFM' : 'LSTM'),
      badgeColor: flagged ? 'var(--accent-yellow)' : 'var(--accent-blue)',
      badgeTitle: ood ? "Checked against this building's own recorded load range"
        : unjudged ? 'Not enough observed load yet to check it against this building'
        : 'Predictive load trajectory and model diagnostics',
      message: ood
        ? `The model returns ${predPeak ? powerMw(predPeak) : '—'}, which the engine has flagged: ${aiForecast?.plausibility || activeForecast.plausibility || 'out of distribution'}. Retrain it on this building (backend/forecasting/train.py) or read the zero-shot forecaster instead.`
        : unjudged
          ? `The supervised model returns ${predPeak ? powerMw(predPeak) : '—'}, but ${aiForecast?.plausibility || 'not yet checked'}. Until it can be, treat it as the model's answer rather than this building's forecast.`
          : `AI predictive engine projects upcoming load horizon (${activeForecast.stepMinutes * (activeForecast.seriesData.length || 12)} min) with peak load of ${predPeak ? powerMw(predPeak) : (activeForecast.peakUpperMw ? powerMw(activeForecast.peakUpperMw) : '—')}. ${weatherNote}${warmup}`,
      action: 'VIEW MODEL DIAGNOSTICS',
    });
  }

  // 3b. The envelope's weather feed has gone stale: the physics is integrating against
  // the 30 °C climatological fallback, so loads and forecasts degrade together.
  if (weather && !weather.live) {
    generated.push({
      id: 'weather',
      type: 'warning',
      icon: <CloudOff size={18} color="var(--accent-yellow)" />,
      title: 'Weather Feed Stale',
      message: `The Open-Meteo feed has not refreshed${weather.ageSec > 0 ? ` in ${(weather.ageSec / 3600).toFixed(1)} h` : ''}. The 2R1C envelope is running on the ${weather.outdoorC.toFixed(1)} °C climatological fallback — envelope loads and the LSTM forecast are less trustworthy until the feed recovers.`,
    });
  }

  // 3c. Plug loads (APLC): the sweep's live state, from the engine. Disabled after
  // hours = the phantom runs unmanaged, which is a cost, not a preference.
  if (plugStatus) {
    const saved = simData.plugSavedKwh ?? plugStatus.savedKwh ?? 0;
    if (!plugStatus.config?.enabled) {
      generated.push({
        id: 'plugs',
        type: 'warning',
        icon: <Plug size={18} color="var(--accent-yellow)" />,
        title: 'Plug Sweep Disabled',
        message: `${(simData.plugStandbyKw ?? plugStatus.standbyKw ?? 0).toFixed(1)} kW of always-on standby is running with no after-hours control. The case-study buildings lost 26.4% of their energy to exactly this. Enable the sweep in the PLUGS tab.`,
        action: onOpenPlugs ? 'OPEN PLUGS TAB' : undefined,
        onAction: onOpenPlugs,
      });
    } else if (plugStatus.armed) {
      generated.push({
        id: 'plugs',
        type: 'success',
        icon: <Plug size={18} color="var(--accent-green)" />,
        title: 'Plug Sweep Armed (After Hours)',
        message: `${plugStatus.shedZones} vacant zone${plugStatus.shedZones === 1 ? '' : 's'} swept — ${(simData.plugShedKw ?? plugStatus.shedKw ?? 0).toFixed(1)} kW of switchable standby off. Cumulative avoided: ${saved.toFixed(1)} kWh ≈ ${money(saved * TARIFF.normalPerKwh)}. Sockets restore the instant presence returns.`,
        action: onOpenPlugs ? 'OPEN PLUGS TAB' : undefined,
        onAction: onOpenPlugs,
      });
    }
  }

  // 4. Unoccupied zones still holding occupied setpoints. Priced honestly: their heat
  // load through the LIVE plant COP at today's tariff — and attributed honestly: the
  // optimizer sets back instrumented zones itself; unmetered zones wait for sensors.
  // 24/7-critical types are excluded — an empty server room being cooled is correct
  // operation, not waste, exactly as the plug sweep's critical list already encodes.
  // 24/7-critical types are excluded via the ENGINE's programme library, not a list
  // typed here. The list that used to live here named `server-room` and `mechanical` —
  // types this digitizer has not minted since it began emitting `comms-room` and
  // `plant-room` — so on the current fixture it excluded nothing and this card counted
  // the comms room as waste and priced shutting it down as a saving.
  //
  // While the library has not arrived isCritical returns null, and the card is withheld
  // rather than shown with an exclusion that may be wrong.
  const wastingZones = isCritical(zones[0]?.type) === null ? [] : zones.filter((z) =>
    z.occupancy === 0 && z.load > 0 && z.lightsOn !== false && !isCritical(z.type));
  if (wastingZones.length > 0 && cop > 0) {
    const wasteKw = wastingZones.reduce((acc, z) => acc + z.load, 0) / cop;
    generated.push({
      id: 'wasting',
      type: 'info',
      icon: <Zap size={18} color="var(--accent-blue)" />,
      title: 'Unoccupied Zones at Occupied Setpoints',
      message: `${wastingZones.length} unoccupied zone${wastingZones.length === 1 ? '' : 's'} still cooled and lit as if occupied — ≈ ${wasteKw.toFixed(1)} kW electrical at the plant's live COP (${money(energyCostPerDay(wasteKw))}/day at the current rate). Zones with presence sensors set back automatically; the rest are why the after-hours plug sweep and more edge nodes pay for themselves.`,
      action: onOpenPlugs ? 'OPEN PLUGS TAB' : undefined,
      onAction: onOpenPlugs,
    });
  }

  // 5. (Thermal-drift hotspots are now handled by the learned-baseline recommendations
  // above: a zone many σ hotter than its own hourly normal, scored server-side, instead
  // of a fixed temp > setpoint + deadband rule that fires on every warm afternoon.)

  // 5b. Carbon footprint / offset recommendation
  const offset = simData.carbonCreditRecommendations;
  if (offset && offset.overBudget) {
    generated.push({
      id: 'carbon-offset',
      type: 'warning',
      icon: <TrendingDown size={18} color="var(--accent-yellow)" />,
      title: 'Carbon Budget Exceeded',
      message: offset.recommendation || `Emissions exceed target budget by ${offset.deficitKgCO2e} kgCO2e. It is recommended to purchase carbon credits to offset this deficit.`,
      action: 'VIEW QUOTES & ALTERNATIVES',
      once: true,
      onAction: () => {
        window.open('https://carboncredits.com/', '_blank');
      },
    });
  }

  // 6. Autonomous operations status (always present) — real engine state.
  const apOn = simData.autoPilot !== false;
  const inSetback = simData.zonesInSetback || 0;
  generated.push({
    id: 'general',
    type: apOn ? 'success' : 'warning',
    expandable: true,
    icon: <Brain size={18} color={apOn ? 'var(--accent-green)' : 'var(--accent-yellow)'} />,
    title: apOn ? 'Autonomous Operations Active' : 'Auto-Pilot Suspended',
    message: apOn
      ? `Occupancy-driven optimizer is holding ${inSetback} zone${inSetback === 1 ? '' : 's'} in setback — ${savingsPct.toFixed(1)}% of plant load (${powerMw(savedMw)} ≈ ${money(energyCostPerDay(savedMw * 1000))}/day). Streamed from the engine.`
      : 'The optimizer is off — it released its setbacks to the occupied baseline and the operator is in manual control. Re-engage to resume autonomous setback.',
    action: 'VIEW MODEL METRICS'
  });

  return generated;
}
