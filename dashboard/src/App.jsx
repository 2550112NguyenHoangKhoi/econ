import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { AlertTriangle, Activity, Map } from 'lucide-react';
import { ReactFlow, Background, applyNodeChanges, applyEdgeChanges } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import BuildingModel, { SingleFloorLayout } from './BuildingModel';
import { getBuilding, getBuildingModelType, setBuildingModelType, subscribeBuildingChange, getActiveFloorAsset, adoptBuildingModelType } from './buildingStore';

import TelemetryPanel from './TelemetryPanel';

import GlobalMetricsPanel from './GlobalMetricsPanel';
import TelemetryLogs from './TelemetryLogs';
import MaintenanceDrawer from './MaintenanceDrawer';
import BlueprintImportPanel from './BlueprintImportPanel';
import AiInsightsPanel from './AiInsightsPanel';
import PlugLoadPanel from './PlugLoadPanel';
import SustainabilityRecommendationsPanel from './SustainabilityRecommendationsPanel';
import * as flatbuffers from 'flatbuffers';
import MobileImpactScreen from './MobileImpactScreen';
import LiveWeatherBackground from './LiveWeatherBackground';
import UIErrorBoundary from './UIErrorBoundary';
import { API_BASE } from './api';
import { useOpsStatus } from './useOpsStatus';
import { useLibrary } from './useLibrary';
import { useDigitalTwin, buildFaultZones, DEFAULT_FAULT_TARGET } from './useDigitalTwin';
import AirflowWindow from './AirflowWindow';
import StreamStatus from './StreamStatus';
import OperatorTokenBar from './OperatorTokenBar';
import CanvasErrorBoundary from './CanvasErrorBoundary';
import { Canvas } from '@react-three/fiber';
import { useOperationMode } from './useOperationMode';
import { useStatePersistence } from './useStatePersistence';
import nodeTypes from './topology/FlowNodes';
import { buildTopologyFromSim, defaultFloor } from './topology/buildTopology';
import ZoneDrilldownHUD from './ZoneDrilldownHUD';
import ViewModeControls from './hud/ViewModeControls';
import BuildingModelSelector from './hud/BuildingModelSelector';
import LevelSelector from './hud/LevelSelector';
import FloorAssetBadge from './hud/FloorAssetBadge';
import CommandBar from './hud/CommandBar';


function App() {
  const [buildingModelType, setBuildingModelTypeState] = useState(() => getBuildingModelType());
  const [currentBuilding, setCurrentBuilding] = useState(() => getBuilding());
  const [activeFloor, setActiveFloor] = useState(() => defaultFloor());
  const [selectedZone, setSelectedZone] = useState(null);
  const [showAiModal, setShowAiModal] = useState(false);
  const [panelSize, setPanelSize] = useState({ w: 600, h: 400 });
  const [airflowSize, setAirflowSize] = useState({ w: 560, h: 380 });
  const [rightPanelWidth, setRightPanelWidth] = useState(360);
  const [activeLeftTab, setActiveLeftTab] = useState('ai');
  const [isLeftPanelOpen, setIsLeftPanelOpen] = useState(true);
  const [leftPanelSize, setLeftPanelSize] = useState({ w: 380 });
  const [showWindSim, setShowWindSim] = useState(true);
  const { mode: operationMode, isReal: isRealMode, setMode: setOperationMode, adoptMode: adoptOperationMode } = useOperationMode();
  const activeFloorAsset = useMemo(
    () => getActiveFloorAsset(currentBuilding, activeFloor),
    [currentBuilding, activeFloor]
  );

  useEffect(() => {
    const unsub = subscribeBuildingChange((b, type) => {
      setCurrentBuilding(b);
      setBuildingModelTypeState(type);
      setActiveFloor((prev) => {
        const floorExists = (b?.floors || []).some(fl => fl.level === prev);
        return floorExists ? prev : defaultFloor(b);
      });
      setSelectedZone(null);
    });
    return unsub;
  }, []);

  const handleToggleBuildingModel = (type) => {
    setBuildingModelType(type, { force: true });
    setBuildingModelTypeState(type);
    const newBld = getBuilding();
    setCurrentBuilding(newBld);
    if (type === 'domestic-home' || type === 'room-scan') {
      // Both are single-storey: defaultFloor() would pick whatever the tower's default is
      // and the level stepper would then clamp against a building with one level.
      setActiveFloor(1);
      setSelectedZone(null);
    } else {
      setActiveFloor(defaultFloor(newBld));
      setSelectedZone(null);
    }
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
  };


  // Recomputes safeArea on a viewport change — the insets are in pixels against
  // window.innerWidth/Height, so a resize or rotate must re-frame.
  const [viewportTick, setViewportTick] = useState(0);
  useEffect(() => {
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setViewportTick((t) => t + 1));
    };
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); cancelAnimationFrame(raf); };
  }, []);

  // What part of the 3D canvas the operator can actually see.
  //
  // The console paints four things over the full-bleed canvas: the AI panel on the left,
  // the metrics dock on the right, and — stacked in the bottom-right corner — the topology
  // window and, when open, the airflow window. Framing the building to the canvas centres
  // it behind them, which is what "the overview gets blocked" is: the model is correctly
  // framed for a viewport the operator cannot see most of.
  //
  // These are the same numbers the panels are laid out from, so the framing follows a
  // resize or a collapse rather than being tuned once against one arrangement. The bottom
  // inset is deliberately NOT applied: the overlays occupy only the right half of the
  // lower area, and reserving full-width height for them would push the building up out of
  // the frame for no gain.
  const safeArea = useMemo(() => {
    if (typeof window === 'undefined') return null;
    const GUTTER = 24;      // the docks' own offset from the viewport edge
    const TOP_BAR = 72;     // view-mode toggle strip across the top
    const BOTTOM_BAR = 96;  // scenario / auto-pilot bar across the bottom
    // The floating windows are anchored beside the metrics dock rather than on top of it,
    // so the region they exclude between them is the dock PLUS the widest window, not the
    // wider of the two.
    const floating = Math.max(
      panelSize.w,                                       // topology window
      showWindSim ? airflowSize.w : 0,                   // airflow window
    );
    const rightOverlay = rightPanelWidth + (floating > 0 ? floating + 12 : 0);

    let left = (isLeftPanelOpen ? leftPanelSize.w : 0) + GUTTER;
    let right = rightOverlay + GUTTER;

    // Never let the insets claim so much width that the building is framed into a strip
    // it cannot be seen in. The overlays are measured at their FULL width but the topology
    // and airflow windows are only about half the viewport tall, so on a 1512-wide console
    // the left panel plus a 600 px topology window plus the metrics dock asked for 1421 px
    // of exclusion and left a 91 px band. The camera dutifully aimed at the middle of it —
    // x = 295 px — which is behind the AI panel, and the building vanished.
    //
    // Shrinking both insets proportionally keeps the bias (the building still sits in the
    // freest part of the canvas) while guaranteeing it stays on screen.
    const vw = window.innerWidth;
    const MIN_FREE_FRACTION = 0.34;
    const minFree = vw * MIN_FREE_FRACTION;
    const claimed = left + right;
    if (claimed > vw - minFree && claimed > 0) {
      const allowed = Math.max(0, vw - minFree);
      const scale = allowed / claimed;
      left = Math.round(left * scale);
      right = Math.round(right * scale);
    }

    return {
      left,
      right,
      top: TOP_BAR,
      bottom: BOTTOM_BAR,
      viewportW: vw,
      viewportH: window.innerHeight,
    };
  }, [isLeftPanelOpen, leftPanelSize.w, rightPanelWidth, panelSize.w, airflowSize.w, showWindSim, viewportTick]);
  const [maintenanceTarget, setMaintenanceTarget] = useState(null);
  const [showImport, setShowImport] = useState(false);
  const [ontology, setOntology] = useState(null);
  const [viewMode, setViewMode] = useState('hybrid');
  const ontologyRef = useRef(null);

  // Phones get the lightweight live Impact screen instead of mounting the
  // WebGL-heavy desktop stack (three canvases + React Flow on a 1350-zone building).
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 820px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 820px)');
    const onChange = (e) => setIsMobile(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [liveLogs, setLiveLogs] = useState([]);
  const logEndRef = useRef(null);
  const activeFloorRef = useRef(activeFloor);

  useEffect(() => {
    fetch(`${API_BASE}/api/ontology`)
      .then(res => res.json())
      .then(data => { setOntology(data); ontologyRef.current = data; })
      .catch(err => console.error("Failed to load Brick ontology:", err));
  }, []);

  // Physical edge nodes (ESP32): poll which zones mirror real hardware so the
  // micro-HUD can badge them. Stays an empty map when no node has ever reported.
  const [hardwareNodes, setHardwareNodes] = useState({});

  // The site's coordinates, from the engine's weather feed (WEATHER_LAT/WEATHER_LON) —
  // the same location the 2R1C envelope integrates against. The sky background used to
  // carry Ho Chi Minh City's coordinates as literals, so relocating the building left the
  // dashboard rendering the wrong sunrise. Falls back to the component default until the
  // feed answers.
  const { weather: siteWeather } = useOpsStatus(60000);
  // Ventilation coefficients for the modelled-CO2 readout (see useLibrary).
  const { modelledCo2 } = useLibrary();
  const siteLat = siteWeather?.lat ?? 10.8231;
  const siteLon = siteWeather?.lon ?? 106.6297;
  useEffect(() => {
    let alive = true;
    const load = () => fetch(`${API_BASE}/api/hardware`)
      .then(res => res.json())
      .then(list => { if (alive) setHardwareNodes(Object.fromEntries((list || []).map(n => [n.zoneId, n]))); })
      .catch(() => {});
    load();
    const id = setInterval(load, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // Kick the 3D canvas after mount so it paints on load. The main building <Canvas> fills a
  // 100vw/vh wrapper that can measure 0 during initial layout, leaving R3F's render loop idle
  // until something forces a re-measure (previously: toggling airflow). A couple of resize
  // pulses make it size + start drawing without any interaction.
  useEffect(() => {
    const ids = [60, 250, 600].map(ms => setTimeout(() => window.dispatchEvent(new Event('resize')), ms));
    return () => ids.forEach(clearTimeout);
  }, []);

  const onSimUpdate = useCallback((newSimData, currentScenario) => {
    // Both of these are WHOLE-BUILDING facts, so they are computed once per frame and not
    // once per node. Written inside the map below they were O(nodes x vavs) — on the office
    // fixture that is 735 x 735 ≈ 540,000 operations on every websocket frame at ~30 fps,
    // which is what made the topology view crawl.
    let liveFlowMax = 0;
    for (const vv of Object.values(newSimData.vavs || {})) {
      if ((vv.flow || 0) > liveFlowMax) liveFlowMax = vv.flow || 0;
    }
    let anyAlarm = false;
    for (const z of Object.values(newSimData.zones || {})) {
      if (z.alert === true) { anyAlarm = true; break; }
    }

    setNodes(nds => nds.map(n => {
      if (n.type === 'unit' && newSimData.zones[n.id]) {
          const zz = newSimData.zones[n.id];
          const v = n.data.vavId ? newSimData.vavs[n.data.vavId] : null;
          return { ...n, data: { ...n.data, temp: zz.temp, alert: zz.alert, occupancy: zz.occupancy, flowVal: v ? v.flow : n.data.flowVal, flowMax: liveFlowMax || n.data.flowMax } };
      }
      if (n.type === 'ahu') {
          return { ...n, data: {
            ...n.data,
            pressure: newSimData.ahuPressure,
            autoPilot: newSimData.autoPilot,
            status: anyAlarm ? 'FAULT' : 'NOMINAL',
          } };
      }
      return n;
    }));

    // Professional restraint: the supply bus stays a calm thin line in normal
    // operation and only animates (colored dashes) while a scenario is in flight.
    setEdges(eds => eds.map(e => {
      if (!e.data?.isFlow) return e;
      const isFault = currentScenario === 'fault';
      const isRem = currentScenario === 'remediating';
      return {
         ...e,
         animated: isFault || isRem,
         style: {
           ...e.style,
           stroke: isFault ? 'rgba(239, 68, 68, 0.45)' : isRem ? 'rgba(234, 179, 8, 0.45)' : 'rgba(0, 163, 224, 0.16)',
           strokeDasharray: (isFault || isRem) ? '4 4' : undefined,
         },
         markerEnd: undefined,
      };
    }));
  }, []);

  const onNodesChange = useCallback((changes) => setNodes((nds) => applyNodeChanges(changes, nds)), []);
  const onEdgesChange = useCallback((changes) => setEdges((eds) => applyEdgeChanges(changes, eds)), []);

  const {
    simData,
    initialData,
    activeScenario,
    autoPilot,
    setAutoPilot,
    adoptAutoPilot,
    faultTarget,
    setFaultTarget,
    loadHistory,
    globalMetrics,
    loadScenario,
    sendManualOverride,
    aiForecast,
    wsAuthorized,
    authorize,
    streamOpen,
    streamAgeMs,
  } = useDigitalTwin(onSimUpdate);

  // Backend State Persistence & Multi-Device Synchronization (Milestone 2)
  const handleRemoteStateUpdate = useCallback((updates, isInitial) => {
    if (!updates) return;
    if (typeof updates.activeFloor === 'number') {
      setActiveFloor(updates.activeFloor);
    }
    if (updates.showWindSim !== undefined) {
      setShowWindSim(!!updates.showWindSim);
    }
    if (typeof updates.viewMode === 'string') {
      setViewMode(updates.viewMode);
    }
    if (typeof updates.activeLeftTab === 'string') {
      setActiveLeftTab(updates.activeLeftTab);
    }
    if (updates.isLeftPanelOpen !== undefined) {
      setIsLeftPanelOpen(!!updates.isLeftPanelOpen);
    }
    if (typeof updates.autoPilot === 'boolean') {
      // These updates arrive FROM the engine, so adopt them locally rather than sending
      // them back as a command — see adoptAutoPilot in useDigitalTwin.
      adoptAutoPilot(updates.autoPilot);
    }
    if (updates.operationMode && typeof adoptOperationMode === 'function') {
      // Adopted, not re-POSTed — see adoptMode in useOperationMode.
      adoptOperationMode(updates.operationMode);
    }
    if (updates.buildingModelType && updates.buildingModelType !== getBuildingModelType()) {
      // ADOPTED, not re-POSTed — same reason as autoPilot and operationMode above. Routing
      // this through handleToggleBuildingModel() sent /api/building/switch back to the
      // engine, which broadcast the result, which every other dashboard answered with
      // another switch. With two windows on different models neither yielded and the
      // engine reloaded the building ~475 times a minute, 735 zones each time.
      adoptBuildingModelType(updates.buildingModelType);
      setBuildingModelTypeState(updates.buildingModelType);
      const adopted = getBuilding();
      setCurrentBuilding(adopted);
      setActiveFloor(adopted.floors?.length > 1 ? defaultFloor(adopted) : 1);
      setSelectedZone(null);
    }
  }, [adoptAutoPilot, adoptOperationMode]);

  const {
    toggles: persistentToggles,
    updateToggle,
  } = useStatePersistence({
    onRemoteUpdate: handleRemoteStateUpdate,
  });

  // Synchronize local changes to backend state persistence with debouncing
  useEffect(() => {
    if (typeof activeFloor === 'number') {
      updateToggle('activeFloor', activeFloor);
    }
  }, [activeFloor, updateToggle]);

  useEffect(() => {
    updateToggle('showWindSim', showWindSim);
  }, [showWindSim, updateToggle]);

  useEffect(() => {
    updateToggle('viewMode', viewMode);
  }, [viewMode, updateToggle]);

  useEffect(() => {
    updateToggle('activeLeftTab', activeLeftTab);
  }, [activeLeftTab, updateToggle]);

  useEffect(() => {
    updateToggle('isLeftPanelOpen', isLeftPanelOpen);
  }, [isLeftPanelOpen, updateToggle]);

  // autoPilot is deliberately NOT mirrored through the persistence channel. It is the one
  // toggle with its own authoritative control path: the engine's {action:"autopilot"}
  // handler already calls stateStore.Set + Save and broadcasts the result, so mirroring it
  // here as a set_state would make the dashboard a SECOND writer of a value the engine
  // already owns. That second writer raced the telemetry stream's "engine is
  // authoritative" adoption: a frame computed just before the toggle re-adopted the old
  // value, the mirror wrote it straight back, and a single operator click rang the
  // engine's autopilot on/off five times before settling.

  // These mirror a LOCAL choice up to the engine. They must not fire on mount.
  //
  // On the first render these hold this tab's defaults — multi-level, simulation — not the
  // operator's selection, which is still in flight from GET /api/state. Pushing them anyway
  // meant every page load overwrote the engine's persisted state with a fresh tab's
  // defaults: an engine deliberately left on the scanned room in real mode was put back on
  // the tower in simulation by nothing more than someone reloading a dashboard. The same
  // hazard the comment above describes for autoPilot, via a different route.
  // operationMode is NOT mirrored here. POST /api/mode already calls stateStore.Set +
  // Save (modeapi.go), so the engine owns this value the way it owns autoPilot, and
  // mirroring it made the dashboard a second writer of it. A skip-first-render guard is
  // not enough either: StrictMode invokes effects twice, so the guard is spent on the
  // first pass and the second pass still writes this tab's default. An engine left in
  // real mode was put back into simulation by a page reload.

  // Mirrored, but never with a value the engine just gave us, and never with this tab's
  // boot default. StrictMode double-invokes effects, so a plain first-render guard is
  // spent before the real first push; comparing against the last engine-reported value is
  // what actually holds.
  const modelMirrorRef = useRef(null);
  useEffect(() => {
    if (!buildingModelType) return;
    if (modelMirrorRef.current === null) { modelMirrorRef.current = buildingModelType; return; }
    if (modelMirrorRef.current === buildingModelType) return;
    modelMirrorRef.current = buildingModelType;
    updateToggle('buildingModelType', buildingModelType);
  }, [buildingModelType, updateToggle]);

  // The fault-injection picker follows the active building. Keyed on buildingModelType so
  // switching the 3D asset rebuilds it instead of leaving the previous building's rooms on
  // offer, and re-pointed when the current target is not a zone of the new building —
  // otherwise <select> holds a value none of its options carry and renders blank.
  const faultZones = useMemo(() => buildFaultZones(getBuilding()), [buildingModelType]);

  useEffect(() => {
    if (faultZones.length && !faultZones.some(z => z.id === faultTarget)) {
      setFaultTarget(faultZones[0].id);
    }
  }, [faultZones, faultTarget, setFaultTarget]);

  const executeRemediation = () => {
    const target = faultTarget || (failingZone?.id && failingZone.id !== 'Unknown Zone' ? failingZone.id : DEFAULT_FAULT_TARGET);
    if (target && sendManualOverride) {
      sendManualOverride('cool', target);
    }
    setShowAiModal(false);
  };

  useEffect(() => {
    if (activeScenario === 'fault') {
      setShowAiModal(true);
    } else {
      setShowAiModal(false);
    }
  }, [activeScenario]);

  // When activeFloor changes or ontology loads, completely rebuild the topology
  useEffect(() => {
    activeFloorRef.current = activeFloor;
    // NOTE: In the original App.jsx, buildTopologyFromSim needs simData.
    // We pass simData to it to build initial nodes
    // Wait, buildTopologyFromSim is defined below this component? Yes.
    // We can just use simData directly.
    const topo = buildTopologyFromSim(simData, activeFloor, ontology, currentBuilding);
    setNodes(topo.nodes);
    setEdges(topo.edges);
  }, [activeFloor, ontology, currentBuilding]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [liveLogs]);

  const failingZone = (activeScenario === 'fault' || activeScenario === 'remediating') && faultTarget
    ? (simData.zones[faultTarget] || { label: faultTarget, temp: 0 }) 
    : Object.values(simData.zones).find(z => z.alert === true || z.alert === 'REMEDIATING') || { label: 'Unknown Zone', temp: 0 };

  const selectedNode = nodes.find(n => n.selected);

  // Small viewport: serve the live mobile Impact screen (same stream, no WebGL).
  if (isMobile) {
    return (
      <MobileImpactScreen
        simData={simData}
        aiForecast={aiForecast}
        hardwareNodes={hardwareNodes}
        streamOpen={streamOpen}
        streamAgeMs={streamAgeMs}
      />
    );
  }

  return (
    <div className="hud-container">
      {/* Nothing at all while the stream is healthy; explicit the moment it is not. Every
          streamed number below this line is the last frame received, and without this the
          page reads as normal operation straight through an engine outage. */}
      <div style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 4000 }}>
        <StreamStatus streamOpen={streamOpen} streamAgeMs={streamAgeMs} />
        <OperatorTokenBar authorized={wsAuthorized} onAuthorize={authorize} />
      </div>

      {/* Live time-of-day sky, shared with the mobile view: golden hour, morning, afternoon,
          sunset, evening. Sits behind the transparent 3D canvas. */}
      <LiveWeatherBackground lat={siteLat} lon={siteLon} />

      <div className="three-d-canvas-wrapper">
        <CanvasErrorBoundary>
          <BuildingModel
            key={buildingModelType}
            simState={simData}
            activeFloor={activeFloor}
            onFloorClick={setActiveFloor}
            showAirflow={showWindSim}
            selectedZone={selectedZone}
            setSelectedZone={(zoneId) => {
              setSelectedZone(zoneId);
              setFaultTarget(zoneId);
            }}
            viewMode={viewMode}
            safeArea={safeArea}
            building={currentBuilding}
          />
        </CanvasErrorBoundary>
      </div>

      {/* AI INTERACTIVE MODAL (Non-blocking so user can watch the building fail) */}
      {showAiModal && (
        <div style={{ position: 'absolute', top: '24px', left: '24px', zIndex: 50 }}>
          <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--accent-red)', padding: '2rem', width: '450px', boxShadow: '0 10px 30px rgba(255,0,0,0.2)' }}>
            <h2 style={{ color: 'var(--accent-red)', display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: 0 }}>
              <AlertTriangle size={24} /> ALARM DETECTED
            </h2>
            <p style={{ color: 'var(--text-primary)', lineHeight: 1.5, fontFamily: 'monospace' }}>
              ERR: THERMAL_RUNAWAY<br/>
              LOCATION: {failingZone ? failingZone.label : 'Unknown Zone'}<br/>
              ASSET: {failingZone ? failingZone.bim_asset_id : '---'}
            </p>
            <div style={{ background: '#000', padding: '1rem', margin: '1.5rem 0', border: '1px solid var(--border-glass)' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--accent-blue)', textTransform: 'uppercase', letterSpacing: '1px' }}>AI Override Recommendation</span>
              <p style={{ margin: '0.5rem 0 0 0', color: 'var(--text-secondary)', fontFamily: 'monospace', lineHeight: 1.4 }}>
                The system detects critical thermal runaway.<br/>
                Would you like AI Auto-Pilot to automatically alleviate the problem by routing 100% cooling capacity to {failingZone ? failingZone.label : 'this specific room'}?
              </p>
            </div>
            <div style={{ display: 'flex', gap: '1rem', justifyContent: 'flex-end' }}>
              <button className="cmd-btn" onClick={() => setShowAiModal(false)}>IGNORE</button>
              <button className="cmd-btn active-fault" onClick={executeRemediation} style={{ background: 'var(--accent-red)' }}>EXECUTE RECOMMENDATION</button>
            </div>
          </div>
        </div>
      )}

      {/* LAYER 5: Micro-HUD for Drill-down */}
      {selectedZone && simData.zones[selectedZone] && (
        <ZoneDrilldownHUD
          selectedZone={selectedZone}
          setSelectedZone={setSelectedZone}
          simData={simData}
          hardwareNodes={hardwareNodes}
          modelledCo2={modelledCo2}
          sendManualOverride={sendManualOverride}
        />
      )}

      {/* LAYER 1: React Flow Topology in Bottom Right Corner */}
      <div 
        className="minimap-wrapper" 
        style={{ 
          // Anchored to the INSIDE edge of the metrics dock, not to the viewport edge.
          // At right: 24 these floating windows sat directly on top of the ENTERPRISE
          // OVERVIEW — the panel carrying total load, savings, EUI, carbon and the fault
          // count — and hid most of it behind a secondary view the moment either was
          // opened. safeArea already treats the dock and these windows as one right-hand
          // exclusion for framing the building; this makes the layout agree with it.
          position: 'absolute', width: panelSize.w, height: panelSize.h, bottom: '90px',
          right: rightPanelWidth + 24 + 12, padding: 0, overflow: 'visible', zIndex: 10
        }}
      >
        <div 
          className="resize-handle" 
          onPointerDown={(e) => {
            e.preventDefault();
            const startW = panelSize.w;
            const startH = panelSize.h;
            const startX = e.clientX;
            const startY = e.clientY;
            const onPointerMove = (moveEvent) => {
              const dx = startX - moveEvent.clientX;
              const dy = startY - moveEvent.clientY;
              setPanelSize({
                w: Math.max(360, Math.min(startW + dx, window.innerWidth * 0.9)),
                h: Math.max(260, Math.min(startH + dy, window.innerHeight * 0.9))
              });
            };
            const onPointerUp = () => {
              document.removeEventListener('pointermove', onPointerMove);
              document.removeEventListener('pointerup', onPointerUp);
            };
            document.addEventListener('pointermove', onPointerMove);
            document.addEventListener('pointerup', onPointerUp);
          }}
          style={{
            position: 'absolute', top: -10, left: -10, width: 20, height: 20, background: 'var(--accent-blue)', 
            cursor: 'nwse-resize', zIndex: 100, borderRadius: '50%', border: '2px solid #000'
          }} 
        />
        <div className="topology-panel" style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden', borderRadius: '12px', border: '1px solid var(--border-glass)', background: 'var(--bg-panel)' }}>
          <div className="panel-header" style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, padding: '12px 16px', background: 'var(--bg-panel)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '10px', color: 'var(--text-primary)', fontWeight: 'bold' }}>MAP LEVEL {activeFloor} TOPOLOGY</span>
            
            <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
              <button 
                 onClick={() => setShowWindSim(!showWindSim)}
                 style={{ 
                   background: 'transparent', 
                   border: '1px solid var(--accent-blue)', 
                   color: 'var(--accent-blue)', 
                   fontSize: '9px', 
                   padding: '4px 8px', 
                   cursor: 'pointer',
                   fontWeight: 'bold',
                   pointerEvents: 'auto'
                 }}
              >
                 {showWindSim ? '⏸ HIDE AIRFLOW' : '🌬 SHOW AIRFLOW'}
              </button>
              <span style={{ fontSize: '10px', color: 'var(--accent-blue)' }}>{Math.max(0, nodes.length - 1)} TERMINAL UNITS · 1 AHU</span>
            </div>
          </div>

          <UIErrorBoundary name="Topology Map">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={(e, node) => {
              if (node.type === 'zone' || node.type === 'unit') setSelectedZone(node.id);
            }}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.15 }}
            proOptions={{ hideAttribution: true }}
            minZoom={0.1}
            maxZoom={1.5}
            translateExtent={[[-350, -400], [1900, 1400]]}
            nodesDraggable={false}
          >
            <Background gap={40} size={1} color="rgba(255,255,255,0.05)" />
            
            {/* SVG Defs for Airflow Vector Gradients */}
            <svg style={{ position: 'absolute', width: 0, height: 0 }}>
              <defs>
                <linearGradient id="flow-nominal" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#3b82f6" />
                  <stop offset="100%" stopColor="#10b981" />
                </linearGradient>
                <linearGradient id="flow-fault" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#3b82f6" />
                  <stop offset="100%" stopColor="#ef4444" />
                </linearGradient>
                <linearGradient id="flow-rem" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#3b82f6" />
                  <stop offset="100%" stopColor="#eab308" />
                </linearGradient>
              </defs>
            </svg>
          </ReactFlow>
          </UIErrorBoundary>
        </div>
      </div>

      {/* Standalone, resizable airflow window (its own WebGL canvas), toggled by the
          "SHOW/HIDE AIRFLOW" control in the topology header. */}
      {showWindSim && (
        <AirflowWindow
          floor={currentBuilding?.floors?.find(f => f.level === activeFloor)}
          activeFloor={activeFloor}
          simState={simData}
          size={airflowSize}
          setSize={setAirflowSize}
          onClose={() => setShowWindSim(false)}
          right={rightPanelWidth + 24 + 12}
          bottom={90 + panelSize.h + 12}
        />
      )}

      {/* LAYER 4: AI & TELEMETRY (Left Dock) */}
      <div style={{ position: 'absolute', top: '1.5rem', left: '1.5rem', zIndex: 50, display: 'flex', gap: '8px', maxHeight: 'calc(100vh - 3rem)' }}>
        <button 
           onClick={() => setIsLeftPanelOpen(!isLeftPanelOpen)}
           style={{ 
             background: 'var(--bg-panel)', border: '1px solid var(--border-glass)', color: 'var(--text-primary)', 
             borderRadius: '12px', padding: '12px', cursor: 'pointer', height: 'fit-content', display: 'flex', alignItems: 'center'
           }}
        >
          <Activity size={20} color="var(--accent-blue)" />
        </button>

        {isLeftPanelOpen && (
          <div style={{ width: leftPanelSize.w, height: 'calc(100vh - 3rem)', background: 'var(--bg-panel)', border: '1px solid var(--border-glass)', borderRadius: '12px', display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
            <div 
              className="resize-handle" 
              onPointerDown={(e) => {
                e.preventDefault();
                const startW = leftPanelSize.w;
                const startX = e.clientX;
                const onPointerMove = (moveEvent) => {
                  const dx = moveEvent.clientX - startX;
                  setLeftPanelSize({
                    w: Math.max(300, Math.min(startW + dx, window.innerWidth * 0.5)),
                  });
                };
                const onPointerUp = () => {
                  document.removeEventListener('pointermove', onPointerMove);
                  document.removeEventListener('pointerup', onPointerUp);
                };
                document.addEventListener('pointermove', onPointerMove);
                document.addEventListener('pointerup', onPointerUp);
              }}
              style={{
                position: 'absolute', top: '50%', right: 0, transform: 'translateY(-50%)', width: 10, height: 40, cursor: 'ew-resize', zIndex: 100
              }} 
            />
            <div style={{ display: 'flex', borderBottom: '1px solid var(--border-glass)', background: 'rgba(0,0,0,0.2)', overflowX: 'auto', scrollbarWidth: 'none' }}>
              <button 
                data-testid="tab-ai-insights"
                onClick={() => setActiveLeftTab('ai')}
                style={{
                  flex: '1 1 auto',
                  padding: '10px 6px',
                  background: activeLeftTab === 'ai' ? 'rgba(0, 163, 224, 0.12)' : 'transparent',
                  color: activeLeftTab === 'ai' ? 'var(--accent-blue)' : 'var(--text-secondary)',
                  border: 'none',
                  borderBottom: activeLeftTab === 'ai' ? '2px solid var(--accent-blue)' : '2px solid transparent',
                  cursor: 'pointer',
                  fontWeight: 'bold',
                  fontSize: '11px',
                  whiteSpace: 'nowrap',
                  letterSpacing: '0.02em',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: 'fit-content',
                  transition: 'all 0.15s ease'
                }}
              >
                AI INSIGHTS
              </button>
              <button 
                data-testid="tab-profiler"
                onClick={() => setActiveLeftTab('telemetry')}
                style={{
                  flex: '1 1 auto',
                  padding: '10px 6px',
                  background: activeLeftTab === 'telemetry' ? 'rgba(0, 163, 224, 0.12)' : 'transparent',
                  color: activeLeftTab === 'telemetry' ? 'var(--accent-blue)' : 'var(--text-secondary)',
                  border: 'none',
                  borderBottom: activeLeftTab === 'telemetry' ? '2px solid var(--accent-blue)' : '2px solid transparent',
                  cursor: 'pointer',
                  fontWeight: 'bold',
                  fontSize: '11px',
                  whiteSpace: 'nowrap',
                  letterSpacing: '0.02em',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: 'fit-content',
                  transition: 'all 0.15s ease'
                }}
              >
                PROFILER
              </button>
              <button
                data-testid="tab-logs"
                onClick={() => setActiveLeftTab('logs')}
                style={{
                  flex: '1 1 auto',
                  padding: '10px 6px',
                  background: activeLeftTab === 'logs' ? 'rgba(0, 163, 224, 0.12)' : 'transparent',
                  color: activeLeftTab === 'logs' ? 'var(--accent-blue)' : 'var(--text-secondary)',
                  border: 'none',
                  borderBottom: activeLeftTab === 'logs' ? '2px solid var(--accent-blue)' : '2px solid transparent',
                  cursor: 'pointer',
                  fontWeight: 'bold',
                  fontSize: '11px',
                  whiteSpace: 'nowrap',
                  letterSpacing: '0.02em',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: 'fit-content',
                  transition: 'all 0.15s ease'
                }}
              >
                LOGS
              </button>
              <button
                data-testid="tab-plugs"
                onClick={() => setActiveLeftTab('plugs')}
                style={{
                  flex: '1 1 auto',
                  padding: '10px 6px',
                  background: activeLeftTab === 'plugs' ? 'rgba(0, 163, 224, 0.12)' : 'transparent',
                  color: activeLeftTab === 'plugs' ? 'var(--accent-blue)' : 'var(--text-secondary)',
                  border: 'none',
                  borderBottom: activeLeftTab === 'plugs' ? '2px solid var(--accent-blue)' : '2px solid transparent',
                  cursor: 'pointer',
                  fontWeight: 'bold',
                  fontSize: '11px',
                  whiteSpace: 'nowrap',
                  letterSpacing: '0.02em',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: 'fit-content',
                  transition: 'all 0.15s ease'
                }}
              >
                PLUGS
              </button>
              <button
                data-testid="tab-sustainability"
                onClick={() => setActiveLeftTab('sustainability')}
                style={{
                  flex: '1 1 auto',
                  padding: '10px 6px',
                  background: activeLeftTab === 'sustainability' ? 'rgba(16, 185, 129, 0.12)' : 'transparent',
                  color: activeLeftTab === 'sustainability' ? '#10b981' : 'var(--text-secondary)',
                  border: 'none',
                  borderBottom: activeLeftTab === 'sustainability' ? '2px solid #10b981' : '2px solid transparent',
                  cursor: 'pointer',
                  fontWeight: 'bold',
                  fontSize: '11px',
                  whiteSpace: 'nowrap',
                  letterSpacing: '0.02em',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: 'fit-content',
                  transition: 'all 0.15s ease'
                }}
              >
                SUSTAINABILITY
              </button>
            </div>
            
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
              {activeLeftTab === 'sustainability' ? (
                <SustainabilityRecommendationsPanel
                  key={buildingModelType}
                  simData={simData}
                  sendManualOverride={sendManualOverride}
                />
              ) : activeLeftTab === 'plugs' ? (
                <PlugLoadPanel simData={simData} />
              ) : activeLeftTab === 'logs' ? (
                <TelemetryLogs simData={simData} />
              ) : activeLeftTab === 'telemetry' ? (
                <TelemetryPanel
                  simData={simData}
                  loadHistory={loadHistory}
                  activeScenario={activeScenario}
                  faultTarget={faultTarget}
                  onOpenMaintenance={() => setMaintenanceTarget(failingZone ? failingZone.bim_asset_id : null)}
                  autoPilot={autoPilot}
                  setAutoPilot={setAutoPilot}
                  setSelectedZone={setSelectedZone}
                />
              ) : (
                <AiInsightsPanel
                  simData={simData}
                  activeScenario={activeScenario}
                  faultTarget={faultTarget}
                  aiForecast={aiForecast}
                  setAutoPilot={setAutoPilot}
                  hardwareNodes={hardwareNodes}
                  setSelectedZone={setSelectedZone}
                  sendManualOverride={sendManualOverride}
                  onOpenPlugs={() => setActiveLeftTab('plugs')}
                />
              )}
            </div>
          </div>
        )}
      </div>

      {/* LAYER 2: Global Metrics (Right Dock) */}
      <GlobalMetricsPanel
        simData={simData}
        globalMetrics={globalMetrics}
        loadHistory={loadHistory}
        activeScenario={activeScenario}
        selectedNode={selectedNode}
        activeFloor={activeFloor}
        setActiveFloor={setActiveFloor}
        building={currentBuilding}
        width={rightPanelWidth}
        setWidth={setRightPanelWidth}
        sendManualOverride={sendManualOverride}
        hardwareNodes={hardwareNodes}
      />

      {maintenanceTarget && (
        <MaintenanceDrawer
          zoneId={maintenanceTarget}
          simData={simData}
          sendManualOverride={sendManualOverride}
          onClose={() => setMaintenanceTarget(null)}
        />
      )}

      <ViewModeControls
        viewMode={viewMode}
        setViewMode={setViewMode}
        isRealMode={isRealMode}
        setOperationMode={setOperationMode}
        setShowImport={setShowImport}
      />

      {showImport && <BlueprintImportPanel onClose={() => setShowImport(false)} />}

      <BuildingModelSelector
        buildingModelType={buildingModelType}
        handleToggleBuildingModel={handleToggleBuildingModel}
      />

      <LevelSelector
        currentBuilding={currentBuilding}
        activeFloor={activeFloor}
        setActiveFloor={setActiveFloor}
        rightPanelWidth={rightPanelWidth}
      />

      <FloorAssetBadge
        activeFloor={activeFloor}
        activeFloorAsset={activeFloorAsset}
        rightPanelWidth={rightPanelWidth}
      />



      <CommandBar
        activeScenario={activeScenario}
        loadScenario={loadScenario}
        autoPilot={autoPilot}
        setAutoPilot={setAutoPilot}
        faultZones={faultZones}
        faultTarget={faultTarget}
        setFaultTarget={setFaultTarget}
        setActiveFloor={setActiveFloor}
        setShowAiModal={setShowAiModal}
      />

    </div>
  );
}

export default App;
