import { Activity } from 'lucide-react';
import AiInsightsPanel from '../AiInsightsPanel';
import TelemetryPanel from '../TelemetryPanel';
import TelemetryLogs from '../TelemetryLogs';
import PlugLoadPanel from '../PlugLoadPanel';
import SustainabilityRecommendationsPanel from '../SustainabilityRecommendationsPanel';
import UIErrorBoundary from '../UIErrorBoundary';

// The left dock and its tabs: AI insights, the zone profiler, the log stream, plug loads and
// sustainability. Collapsible and resizable, and each tab is wrapped so one panel throwing
// cannot take the dock down with it.
export default function LeftDock({
  simData,
  activeLeftTab,
  setActiveLeftTab,
  isLeftPanelOpen,
  setIsLeftPanelOpen,
  leftPanelSize,
  setLeftPanelSize,
  activeScenario,
  faultTarget,
  failingZone,
  aiForecast,
  autoPilot,
  setAutoPilot,
  hardwareNodes,
  sendManualOverride,
  setSelectedZone,
  setMaintenanceTarget,
  loadHistory,
  buildingModelType,
}) {
  return (
    <>
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
    </>
  );
}
