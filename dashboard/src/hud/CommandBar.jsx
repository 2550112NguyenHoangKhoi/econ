import { Zap, AlertTriangle, Settings } from 'lucide-react';

// Scenario controls: inject or clear a fault, arm the autopilot, and open the AI panel.
// The fault target is a zone id, and choosing one also jumps the view to its floor.
export default function CommandBar({
  activeScenario,
  loadScenario,
  autoPilot,
  setAutoPilot,
  faultZones,
  faultTarget,
  setFaultTarget,
  setActiveFloor,
  setShowAiModal,
}) {
  return (
    <>
  {/* COMMAND BAR (Floating Bottom Center) */}
  <div className="hud-command-bar">
    <button 
      className={`cmd-btn ${activeScenario === 'peak' ? 'active-peak' : ''}`} 
      onClick={() => loadScenario('peak')}
    >
      <Zap size={16} /> Peak Load
    </button>

    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', background: 'rgba(0,0,0,0.3)', padding: '0 0.5rem', borderRadius: '12px' }}>
      <select 
        value={faultTarget}
        onChange={(e) => setFaultTarget(e.target.value)}
        style={{ background: 'transparent', color: 'var(--text-secondary)', border: 'none', padding: '0.5rem', outline: 'none', fontFamily: 'Inter', fontSize: '12px', cursor: 'pointer' }}
      >
        {faultZones.map(z => (
          <option key={z.id} value={z.id}>{z.label}</option>
        ))}
      </select>
      <button
        className={`cmd-btn ${activeScenario === 'fault' ? 'active-fault' : ''}`}
        onClick={() => {
          loadScenario(`fault:${faultTarget}`, (level) => setActiveFloor(level));
          setShowAiModal(true);
        }}
        style={{ paddingLeft: '0.5rem' }}
      >
        <AlertTriangle size={16} /> Inject
      </button>
    </div>

    <button 
      className={`cmd-btn ${autoPilot ? 'active-auto' : ''}`} 
      onClick={() => setAutoPilot(!autoPilot)}
    >
      <Settings size={16} /> AI: {autoPilot ? 'ON' : 'OFF'}
    </button>
  </div>
    </>
  );
}
