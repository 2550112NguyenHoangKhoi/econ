// The floor stepper. Offset by `rightPanelWidth` so it stays centred in the space the
// right dock leaves, rather than under it.
export default function LevelSelector({
  currentBuilding,
  activeFloor,
  setActiveFloor,
  rightPanelWidth,
}) {
  return (
    <>
  {/* DESKTOP LEVEL SELECTOR (Floating Bottom, beside 3D Model toggle) */}
  <div
    data-testid="desktop-level-toggle"
    style={{
      position: 'absolute',
      bottom: '5.2rem',
      right: rightPanelWidth + 24 + 12,
      zIndex: 15,
      display: 'flex',
      alignItems: 'center',
      gap: '4px',
      background: 'rgba(10, 16, 28, 0.85)',
      padding: '4px 8px',
      borderRadius: '10px',
      border: '1px solid var(--border-glass)',
      backdropFilter: 'blur(12px)',
      boxShadow: '0 4px 20px rgba(0, 0, 0, 0.4)',
    }}
  >
    <span style={{ fontSize: '10px', fontWeight: 'bold', color: 'var(--text-secondary)', padding: '0 4px', letterSpacing: '0.04em' }}>
      LEVEL:
    </span>
    <button
      data-testid="level-step-prev"
      onClick={() => {
        const floors = (currentBuilding?.floors || []).map(f => f.level).sort((a, b) => a - b);
        const idx = floors.indexOf(activeFloor);
        if (idx > 0) setActiveFloor(floors[idx - 1]);
      }}
      style={{ background: 'transparent', border: 'none', color: 'var(--accent-blue)', cursor: 'pointer', fontWeight: 'bold', fontSize: '12px', padding: '2px 6px' }}
    >
      ◀
    </button>
    <span data-testid="desktop-active-level" style={{ fontSize: '12px', fontWeight: 'bold', color: '#ffffff', minWidth: '28px', textAlign: 'center', fontFamily: 'monospace' }}>
      L{activeFloor}
    </span>
    <button
      data-testid="level-step-next"
      onClick={() => {
        const floors = (currentBuilding?.floors || []).map(f => f.level).sort((a, b) => a - b);
        const idx = floors.indexOf(activeFloor);
        if (idx >= 0 && idx < floors.length - 1) setActiveFloor(floors[idx + 1]);
      }}
      style={{ background: 'transparent', border: 'none', color: 'var(--accent-blue)', cursor: 'pointer', fontWeight: 'bold', fontSize: '12px', padding: '2px 6px' }}
    >
      ▶
    </button>
  </div>
    </>
  );
}
