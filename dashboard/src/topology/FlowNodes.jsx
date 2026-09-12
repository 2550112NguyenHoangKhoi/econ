import { Handle, Position } from '@xyflow/react';
import { Zap, Camera, Cpu, Thermometer } from 'lucide-react';
import { FOOTPRINT } from '../floorGeometry';
import { FALLBACK_SETPOINT_C, FALLBACK_DEADBAND_K } from '../useDigitalTwin';

// The P&ID node vocabulary for the topology panel: one component per equipment class,
// plus the `nodeTypes` map ReactFlow resolves a node's `type` string against. Lifted out
// of App.jsx unchanged -- these are module-scope presentational components with no
// dependency on App's state, and they were half of what made that file unreadable.



// --- P&ID ENGINEERING CUSTOM NODES ---
// Custom smoothstep implementation for heatmap color
const smoothstep = (min, max, value) => {
  const x = Math.max(0, Math.min(1, (value - min) / (max - min)));
  return x * x * (3 - 2 * x);
};

const ThermalNode = ({ data, selected }) => {
  const setpoint = data.setpoint ?? FALLBACK_SETPOINT_C;
  const deadband = data.deadband ?? FALLBACK_DEADBAND_K;
  
  const deviation = (parseFloat(data.temp) - setpoint) / deadband;
  
  const rFloat = smoothstep(0.3, 1.0, deviation);
  const bFloat = smoothstep(0.3, 1.0, -deviation);
  const gFloat = 1.0 - Math.max(smoothstep(0.8, 1.5, deviation), smoothstep(0.8, 1.5, -deviation));

  const r = Math.round(rFloat * 255);
  const g = Math.round(gFloat * 255);
  const b = Math.round(bFloat * 255);

  const borderColor = `rgb(${r}, ${g}, ${b})`;
  const bgColor = `rgba(${r}, ${g}, ${b}, 0.1)`;

  return (
    <div className={`thermal-node ${selected ? 'selected' : ''} ${data.alert ? 'pulse-red-node' : ''}`} style={{ borderColor, backgroundColor: bgColor, transition: 'all 0.5s ease' }}>
      <Handle type="target" position={Position.Top} style={{ visibility: 'hidden' }} />
      <div className="thermal-label">{data.label}</div>
      {/* Rounded for display: the stream carries a float, and rendering it raw printed
          things like 24.036891937255859 into a card 148 px wide. */}
      <div className="thermal-value">{Number(data.temp ?? 0).toFixed(1)}°C</div>
      <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>{data.occupancy} PAX</div>
      <div style={{ fontSize: '7px', color: 'var(--accent-blue)', opacity: 0.8, marginTop: '2px', wordBreak: 'break-all', fontFamily: 'monospace' }}>BIM: {data.bim_asset_id?.split('-')[0]}</div>
      <Handle type="source" position={Position.Bottom} style={{ visibility: 'hidden' }} />
    </div>
  );
};

// The AHU card. Static pressure is the engine's Hardy-Cross solve, streamed as
// ahuPressurePa — it used to render `data.pressure?.toFixed(0) || 500`, and since nothing
// ever wrote data.pressure, every deployment of this dashboard has displayed a literal
// 500 Pa for the life of the project. The mode line was likewise the constant string
// "AUTO" regardless of whether the optimizer was engaged.
const AHUNode = ({ data, selected }) => {
  const pa = Number(data.pressure);
  const solved = Number.isFinite(pa) && pa > 0;
  return (
    <div className={`node-ahu ${selected ? 'selected' : ''} ${data.status === 'FAULT' ? 'fault' : ''}`}>
      <div className="thermal-label" style={{ color: 'var(--accent-blue)' }}>{data.label}</div>
      <div className="thermal-value" title={solved ? 'Static pressure from the engine’s Hardy-Cross network solve' : 'The network solver has not reported yet'}>
        {solved ? `${pa.toFixed(0)} Pa` : '— Pa'}
      </div>
      <div style={{ fontSize: '9px', color: data.autoPilot === false ? 'var(--accent-yellow)' : 'var(--text-muted)' }}>
        M: {data.autoPilot === false ? 'MANUAL' : 'AUTO'}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ visibility: 'hidden' }} />
    </div>
  );
};

const VAVNode = ({ data, selected }) => (
  <div className={`node-vav ${selected ? 'selected' : ''}`}>
    <Handle type="target" position={Position.Top} style={{ visibility: 'hidden' }} />
    <div style={{ fontSize: '9px', fontWeight: 'bold', color: 'var(--text-primary)' }}>VAV</div>
    <div style={{ fontSize: '8px', color: 'var(--text-secondary)' }}>{data.flow.split(' ')[0]}</div>
    <Handle type="source" position={Position.Bottom} style={{ visibility: 'hidden' }} />
  </div>
);

// Professional BMS-style terminal-unit card: one card per zone, merging the zone and
// the VAV that feeds it (they map 1:1 here). Reads like an equipment-schedule row —
// status LED + colored rail (green in-band / amber drifting / red alarm), temperature
// against setpoint, occupancy, and the VAV airflow as a bar.
const UnitNode = ({ data, selected }) => {
  const temp = Number(data.temp || 0);
  const dev = Math.abs(temp - (data.setpoint ?? FALLBACK_SETPOINT_C)) / (data.deadband ?? FALLBACK_DEADBAND_K);
  const state = data.alert === true ? 'alarm' : (dev > 1 ? 'drift' : 'ok');
  const c = state === 'alarm' ? 'var(--accent-red)' : state === 'drift' ? 'var(--accent-yellow)' : 'var(--accent-green)';
  // Airflow bar scaled against the largest flow the building is currently delivering,
  // which the parent passes in. It used to divide by a literal 0.8 m³/s — a plausible
  // figure for a commercial VAV and roughly two orders of magnitude wrong for the house
  // pilot, where every bar sat pinned at zero.
  const flowMax = Number(data.flowMax) > 0 ? data.flowMax : 0;
  const flowFrac = flowMax > 0 ? Math.max(0, Math.min(1, (data.flowVal || 0) / flowMax)) : 0;
  // Sides are set individually: mixing the `border` shorthand with `borderLeft` makes React
  // warn on rerender, because whichever lands last wins non-deterministically.
  const edge = `1px solid ${selected ? '#ffffff' : 'rgba(127, 139, 150, 0.35)'}`;
  return (
    <div style={{
      width: 148, background: 'rgba(13, 17, 20, 0.95)', borderRadius: 4, padding: '5px 7px',
      borderTop: edge, borderRight: edge, borderBottom: edge,
      borderLeft: `3px solid ${c}`, fontFamily: 'monospace',
      boxShadow: state === 'alarm' ? '0 0 10px rgba(255, 69, 58, 0.45)' : 'none',
    }}>
      <Handle type="target" position={Position.Top} style={{ visibility: 'hidden' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}>
        <span style={{ fontSize: '8px', fontWeight: 700, letterSpacing: '0.04em', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {(data.label || '').toUpperCase()}
        </span>
        <span style={{ flexShrink: 0, width: 6, height: 6, borderRadius: '50%', background: c, boxShadow: `0 0 4px ${c}` }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3 }}>
        <span style={{ fontSize: '9px', fontWeight: 700, color: c }}>{temp.toFixed(1)}°C</span>
        <span style={{ fontSize: '8px', color: 'var(--text-muted)' }}>SP {(data.setpoint ?? FALLBACK_SETPOINT_C).toFixed(0)}°</span>
        <span style={{ fontSize: '8px', color: 'var(--text-secondary)' }}>{data.occupancy ?? 0} PAX</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 3 }}>
        <span style={{ fontSize: '7px', color: 'var(--text-muted)', flexShrink: 0 }}>{data.vavLabel}</span>
        <div style={{ flex: 1, height: 3, background: 'rgba(127, 139, 150, 0.25)', borderRadius: 2 }}>
          <div style={{ width: `${flowFrac * 100}%`, height: '100%', background: 'var(--accent-blue)', borderRadius: 2, transition: 'width 0.5s' }} />
        </div>
        <span style={{ fontSize: '7px', color: 'var(--accent-blue)', flexShrink: 0 }}>{(data.flowVal || 0).toFixed(1)}</span>
      </div>
    </div>
  );
};

// Registered in nodeTypes but never instantiated — nothing in this file creates a node of
// type 'floorplan'. Kept because the registration is harmless and the component documents
// the plan-underlay idea, but its projection is written against the 60x40 office plate
// (centre 30,20 at 22 px/m) and would need the shared footprint from floorGeometry.js
// before it could be used on any other building.
const FloorplanNode = ({ data }) => {
  const pts = (z) => z.polygon
    .map((p) => `${(p[0] - FOOTPRINT.cx) * 22 + 400},${(p[1] - FOOTPRINT.cy) * 22 + 300}`)
    .join(' ');
  return (
    <div style={{ width: 800, height: 600, pointerEvents: 'none', position: 'relative' }}>
      <svg width="100%" height="100%" viewBox="0 0 800 600" preserveAspectRatio="none">
        {data.zones && data.zones.map((z, i) => (
          <polygon key={i} points={pts(z)} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="2" />
        ))}
      </svg>
    </div>
  );
};

const CameraNode = ({ selected }) => (
  <div className={`node-icon ${selected ? 'selected' : ''}`} style={{ background: 'var(--bg-panel)', padding: '4px', border: '1px solid var(--text-secondary)', borderRadius: '4px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
    <Camera size={12} color="var(--accent-blue)" />
    <Handle type="target" position={Position.Top} style={{ visibility: 'hidden' }} />
  </div>
);

const SensorNode = ({ selected }) => (
  <div className={`node-icon ${selected ? 'selected' : ''}`} style={{ background: 'var(--bg-panel)', padding: '4px', border: '1px solid var(--accent-yellow)', borderRadius: '4px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
    <Thermometer size={12} color="var(--accent-yellow)" />
    <Handle type="target" position={Position.Top} style={{ visibility: 'hidden' }} />
  </div>
);

const ElectricalPanelNode = ({ data, selected }) => (
  <div className={`node-panel ${selected ? 'selected' : ''}`} style={{ background: 'var(--bg-panel)', padding: '8px', border: '2px solid var(--accent-red)', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
    <Zap size={16} color="var(--accent-red)" />
    <span style={{ fontSize: '8px', color: 'var(--text-primary)' }}>{data.label}</span>
    <Handle type="source" position={Position.Bottom} style={{ visibility: 'hidden' }} />
  </div>
);

const CircuitNode = ({ selected }) => (
  <div className={`node-circuit ${selected ? 'selected' : ''}`} style={{ background: 'var(--bg-panel)', padding: '4px', border: '1px solid var(--accent-red)', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
    <Cpu size={12} color="var(--accent-red)" />
    <Handle type="target" position={Position.Top} style={{ visibility: 'hidden' }} />
    <Handle type="source" position={Position.Bottom} style={{ visibility: 'hidden' }} />
  </div>
);

const nodeTypes = {
  zone: ThermalNode,
  ahu: AHUNode,
  vav: VAVNode,
  unit: UnitNode,
  floorplan: FloorplanNode,
  camera: CameraNode,
  sensor: SensorNode,
  panel: ElectricalPanelNode,
  circuit: CircuitNode
};

export { smoothstep, ThermalNode, AHUNode, VAVNode, UnitNode, FloorplanNode, CameraNode, SensorNode, ElectricalPanelNode, CircuitNode };
export default nodeTypes;
