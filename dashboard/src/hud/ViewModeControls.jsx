// The floating top-centre control cluster: the 2D/3D/hybrid view switch, the
// Simulation/Real operation-mode toggle, the blueprint-import button, and the link to the
// WebSerial hardware inspector.
export default function ViewModeControls({
  viewMode,
  setViewMode,
  isRealMode,
  setOperationMode,
  setShowImport,
}) {
  return (
    <>
  {/* VIEW & OPERATION MODE CONTROLS (Floating Top Center) */}
  <div style={{
    position: 'absolute',
    top: '1.5rem',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 20,
    display: 'flex', 
    alignItems: 'center',
    gap: '6px', 
    background: 'rgba(0,0,0,0.6)', 
    padding: '4px 6px', 
    borderRadius: '8px', 
    border: '1px solid var(--border-glass)',
    backdropFilter: 'blur(10px)'
  }}>
    <button 
      onClick={() => setViewMode('physical')}
      style={{ padding: '6px 12px', fontSize: '11px', borderRadius: '4px', border: 'none', cursor: 'pointer', background: viewMode === 'physical' ? 'var(--accent-blue)' : 'transparent', color: viewMode === 'physical' ? '#fff' : 'var(--text-secondary)', fontWeight: 'bold' }}
    >
      PHYSICAL
    </button>
    <button 
      onClick={() => setViewMode('hybrid')}
      style={{ padding: '6px 12px', fontSize: '11px', borderRadius: '4px', border: 'none', cursor: 'pointer', background: viewMode === 'hybrid' ? 'var(--accent-blue)' : 'transparent', color: viewMode === 'hybrid' ? '#fff' : 'var(--text-secondary)', fontWeight: 'bold' }}
    >
      HYBRID
    </button>
    <button
      onClick={() => setViewMode('logical')}
      style={{ padding: '6px 12px', fontSize: '11px', borderRadius: '4px', border: 'none', cursor: 'pointer', background: viewMode === 'logical' ? 'var(--accent-blue)' : 'transparent', color: viewMode === 'logical' ? '#fff' : 'var(--text-secondary)', fontWeight: 'bold' }}
    >
      LOGICAL
    </button>

    {/* OPERATION MODE TOGGLE: [🧪 Simulation | ⚡ Real] */}
    <div
      data-testid="operation-mode-toggle"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '3px',
        background: 'rgba(15, 23, 42, 0.75)',
        padding: '3px 4px',
        borderRadius: '6px',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        borderLeft: '1px solid var(--border-glass)',
        marginLeft: '4px'
      }}
    >
      <button
        data-testid="toggle-mode-simulation"
        onClick={() => setOperationMode('simulation')}
        title="Simulation Mode: Accepts synthetic, mock, and simulated telemetry"
        style={{
          padding: '5px 10px',
          fontSize: '11px',
          borderRadius: '4px',
          border: 'none',
          cursor: 'pointer',
          background: !isRealMode ? 'var(--accent-blue, #0284c7)' : 'transparent',
          color: !isRealMode ? '#ffffff' : 'var(--text-secondary, #94a3b8)',
          fontWeight: 'bold',
          transition: 'all 0.15s ease'
        }}
      >
        🧪 Simulation
      </button>
      <button
        data-testid="toggle-mode-real"
        onClick={() => setOperationMode('real')}
        title="Real Mode: Strictly ingests genuine physical hardware telemetry and rejects mock data"
        style={{
          padding: '5px 10px',
          fontSize: '11px',
          borderRadius: '4px',
          border: 'none',
          cursor: 'pointer',
          background: isRealMode ? 'var(--accent-green, #10b981)' : 'transparent',
          color: isRealMode ? '#ffffff' : 'var(--text-secondary, #94a3b8)',
          fontWeight: 'bold',
          transition: 'all 0.15s ease'
        }}
      >
        ⚡ Real
      </button>
    </div>

    <button
      onClick={() => setShowImport(true)}
      title="Digitize a DXF / PDF / scanned floorplan into a new building"
      style={{ padding: '6px 12px', fontSize: '11px', borderRadius: '4px', border: 'none', cursor: 'pointer', background: 'transparent', color: 'var(--accent-green)', fontWeight: 'bold', borderLeft: '1px solid var(--border-glass)' }}
    >
      + BLUEPRINT
    </button>
    {/* TEMPORARY bring-up module (HardwareInspector.jsx). A plain link, not a panel:
        it opens a separate page so debugging a wire does not also load the 3D scene,
        and removing the module is deleting this button plus three lines in Root.jsx. */}
    <a
      href="?inspector"
      title="TEMPORARY: raw MQTT view of every node — live fields, dropouts, history"
      style={{ padding: '6px 12px', fontSize: '11px', borderRadius: '4px', cursor: 'pointer', background: 'transparent', color: 'var(--accent-yellow, #f59e0b)', fontWeight: 'bold', borderLeft: '1px solid var(--border-glass)', textDecoration: 'none', display: 'inline-block' }}
    >
      ⚙ HARDWARE
    </a>
  </div>
    </>
  );
}
