// Bottom-centre selector for which digitized building the twin is showing. Switching
// models reloads the fixture, so the handler lives in App and this component only renders
// the choice.
export default function BuildingModelSelector({
  buildingModelType,
  handleToggleBuildingModel,
}) {
  return (
    <>
  {/* 3D BUILDING MODEL SELECTOR (Floating Bottom Center, above command bar) */}
  <div
    data-testid="building-model-toggle"
    style={{
      position: 'absolute',
      bottom: '5.2rem',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 15,
      display: 'flex',
      alignItems: 'center',
      gap: '4px',
      background: 'rgba(10, 16, 28, 0.85)',
      padding: '4px 6px',
      borderRadius: '10px',
      border: '1px solid var(--border-glass)',
      backdropFilter: 'blur(12px)',
      boxShadow: '0 4px 20px rgba(0, 0, 0, 0.4)',
    }}
  >
    <span style={{ fontSize: '10px', fontWeight: 'bold', color: 'var(--text-secondary)', padding: '0 6px', letterSpacing: '0.04em' }}>
      3D ASSET:
    </span>
    <button
      data-testid="toggle-multilevel"
      onClick={() => handleToggleBuildingModel('multi-level')}
      style={{
        padding: '5px 12px',
        fontSize: '11px',
        borderRadius: '6px',
        border: 'none',
        cursor: 'pointer',
        background: buildingModelType === 'multi-level' ? 'var(--accent-blue)' : 'transparent',
        color: buildingModelType === 'multi-level' ? '#ffffff' : 'var(--text-secondary)',
        fontWeight: 'bold',
        display: 'flex',
        alignItems: 'center',
        gap: '5px',
        transition: 'all 0.15s ease',
      }}
    >
      <span>🏢</span> Multi-Level Building
    </button>
    <button
      data-testid="toggle-domestic-home"
      onClick={() => handleToggleBuildingModel('domestic-home')}
      style={{
        padding: '5px 12px',
        fontSize: '11px',
        borderRadius: '6px',
        border: 'none',
        cursor: 'pointer',
        background: buildingModelType === 'domestic-home' ? 'var(--accent-blue)' : 'transparent',
        color: buildingModelType === 'domestic-home' ? '#ffffff' : 'var(--text-secondary)',
        fontWeight: 'bold',
        display: 'flex',
        alignItems: 'center',
        gap: '5px',
        transition: 'all 0.15s ease',
      }}
    >
      <span>🏠</span> 1-Level Domestic Home
    </button>
    <button
      data-testid="toggle-room-scan"
      onClick={() => handleToggleBuildingModel('room-scan')}
      style={{
        padding: '5px 12px',
        fontSize: '11px',
        borderRadius: '6px',
        border: 'none',
        cursor: 'pointer',
        background: buildingModelType === 'room-scan' ? 'var(--accent-blue)' : 'transparent',
        color: buildingModelType === 'room-scan' ? '#ffffff' : 'var(--text-secondary)',
        fontWeight: 'bold',
        display: 'flex',
        alignItems: 'center',
        gap: '5px',
        transition: 'all 0.15s ease',
      }}
    >
      <span>📐</span> Scanned Room
    </button>
  </div>
    </>
  );
}
