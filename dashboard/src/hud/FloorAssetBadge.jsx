// Names the floorplan asset backing the active level -- which raster or vector the 3D
// model and the topology panel are both reading. Silent when the floor has no asset.
export default function FloorAssetBadge({
  activeFloor,
  activeFloorAsset,
  rightPanelWidth,
}) {
  return (
    <>
  {/* Active Floor Asset Badge */}
  <div
    data-testid="active-asset"
    data-asset-id={activeFloorAsset?.assetId || ''}
    style={{
      position: 'absolute',
      bottom: '7.6rem',
      right: rightPanelWidth + 24 + 12,
      zIndex: 14,
      display: 'flex',
      alignItems: 'center',
      gap: '4px',
      background: 'rgba(10, 16, 28, 0.85)',
      padding: '4px 8px',
      borderRadius: '8px',
      border: '1px solid var(--border-glass)',
      backdropFilter: 'blur(12px)',
      boxShadow: '0 4px 20px rgba(0, 0, 0, 0.4)',
      fontSize: '11px',
      color: 'var(--accent-blue)',
      fontFamily: 'monospace',
      pointerEvents: 'none',
    }}
  >
    <span data-testid="active-floor-asset" data-asset-id={activeFloorAsset?.assetId || ''}>
      {activeFloorAsset?.name || `Level ${activeFloor}`} ({activeFloorAsset?.assetId || ''})
    </span>
  </div>
    </>
  );
}
