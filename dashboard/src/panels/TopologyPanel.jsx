import React from 'react';
import { ReactFlow, Background } from '@xyflow/react';
import nodeTypes from '../topology/FlowNodes';
import AirflowWindow from '../AirflowWindow';
import UIErrorBoundary from '../UIErrorBoundary';

// The bottom-right topology panel: the P&ID graph of this floor's plant and terminal units,
// resizable, with the standalone airflow window it toggles.
//
// Clicking a zone or unit node here is one of the two ways to open the drill-down HUD.
export default function TopologyPanel({
  simData,
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  setSelectedZone,
  activeFloor,
  currentBuilding,
  safeArea,
  panelSize,
  setPanelSize,
  airflowSize,
  setAirflowSize,
  showWindSim,
  setShowWindSim,
  rightPanelWidth,
}) {
  return (
    <>
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
    </>
  );
}
