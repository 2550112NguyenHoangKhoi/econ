import React, { useMemo, useState } from 'react';
import * as THREE from 'three';
import { Html, Edges } from '@react-three/drei';
import { exteriorPolygon, corePolygon, wallThickness, ORIGIN, FOOTPRINT } from '../floorGeometry';
import { getCachedGeometry } from './csg';

// One floor's slab, with the service core subtracted out of it.

// ========== STEP 3: Floor Plate with Core Cutout ==========
function FloorPlate({ floor, isActive, onClick, simState, viewMode = 'hybrid' }) {
  const [hovered, setHovered] = useState(false);

  const hasAlert = useMemo(() => {
    if (!simState || !simState.zones) return false;
    return floor.zones.some(z => {
        const alertState = simState.zones[z.zoneId]?.alert;
        return alertState === true || alertState === 'REMEDIATING';
    });
  }, [floor.zones, simState]);

  const geometry = useMemo(() => {
    const ext = exteriorPolygon(floor);
    if (!ext) return null; // no envelope for this floor — draw nothing rather than throw
    const core = corePolygon(floor);
    const thick = wallThickness(floor);
    const signature = `plate_native|${JSON.stringify(ext)}|${JSON.stringify(core)}|${thick}|${ORIGIN.x}|${ORIGIN.y}`;
    return getCachedGeometry(signature, () => {
      const exteriorShape = new THREE.Shape();
      ext.forEach((p, idx) => {
        if (idx === 0) exteriorShape.moveTo(p[0] - ORIGIN.x, p[1] - ORIGIN.y);
        else exteriorShape.lineTo(p[0] - ORIGIN.x, p[1] - ORIGIN.y);
      });
      exteriorShape.lineTo(ext[0][0] - ORIGIN.x, ext[0][1] - ORIGIN.y);

      // Natively subtract the core hole (No CSG needed, solves triangulation artifacts!)
      // A building with no service core — a house — simply has no hole to cut.
      if (core.length > 0) {
        const corePath = new THREE.Path();
        core.forEach((p, idx) => {
          if (idx === 0) corePath.moveTo(p[0] - ORIGIN.x, p[1] - ORIGIN.y);
          else corePath.lineTo(p[0] - ORIGIN.x, p[1] - ORIGIN.y);
        });
        corePath.lineTo(core[0][0] - ORIGIN.x, core[0][1] - ORIGIN.y);
        exteriorShape.holes.push(corePath);
      }

      const exteriorGeom = new THREE.ExtrudeGeometry(exteriorShape, {
        depth: thick,
        bevelEnabled: false,
      });
      
      // Bake rotation and Y shift into the geometry
      exteriorGeom.rotateX(-Math.PI / 2);
      exteriorGeom.translate(0, -thick, 0);

      // Return perfectly indexed geometry to prevent EdgesGeometry from drawing internal diagonals
      return exteriorGeom;
    });
  }, [floor]);
  
  const isLogical = viewMode === 'logical';
  const baseOpacity = isLogical ? 0.05 : (isActive ? 0.55 : 0.42);
  const opacity = hasAlert ? 0.75 : (hovered ? 0.75 : baseOpacity);

  // No envelope for this floor: the slab is what this component draws, so there is
  // nothing to draw. Zones render from their own polygons in a sibling component and are
  // unaffected. Returning null beats handing <mesh> a null geometry.
  if (!geometry) return null;

  return (
    <group>
      <mesh
        geometry={geometry}
        dispose={null}
        onClick={(e) => { e.stopPropagation(); onClick(floor.level); }}
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer'; }}
        onPointerOut={() => { setHovered(false); document.body.style.cursor = 'auto'; }}
      >
        <meshStandardMaterial 
          color={hasAlert ? "#cc2222" : (isActive ? "#e2e8f0" : hovered ? "#718096" : "#4a5568")}
          roughness={0.7}
          transparent={true}
          opacity={opacity}
          polygonOffset={true}
          polygonOffsetFactor={2}
          wireframe={isLogical && isActive}
        />
        <Edges color={hasAlert ? "#ff0000" : (isActive ? "#ffffff" : hovered ? "#00ffff" : "#444444")} threshold={15} />
      </mesh>

      {/* Tesla-Style Vertical Drop Label */}
      {/* Floor label, just off the building's left edge and stepped per level so a
          stacked tower's labels do not overlap. The literal -30 this replaces was half the
          office plate's width; on a 13.6 m house it placed the label a building and a half
          away from the building. Anchored at mid-height rather than at the roofline, where
          on a portrait phone it collided with the HUD readouts across the top. */}
      {(isActive || hovered || hasAlert) && (
        <Html position={[-(FOOTPRINT.width / 2) - 2 + (floor.level * 1.8), floor.height / 2, 0]} style={{ pointerEvents: 'none' }}>
          <div style={{ 
            position: 'absolute', 
            bottom: '0px', 
            left: '-60px', 
            width: '120px', 
            display: 'flex', 
            flexDirection: 'column', 
            alignItems: 'center',
            zIndex: 10
          }}>
            {/* The Text Tag (No Background) */}
            <div style={{ 
              color: hasAlert ? '#ff453a' : '#ffffff', 
              fontSize: '13px', 
              fontFamily: 'system-ui, -apple-system, sans-serif', 
              fontWeight: '700',
              letterSpacing: '0.05em',
              textShadow: '0 2px 8px rgba(0,0,0,0.8)'
            }}>
              {hasAlert ? '⚠️ ' : ''}LEVEL {floor.level}
            </div>
            <div style={{ 
              color: hasAlert ? '#ff453a' : 'rgba(255,255,255,0.7)', 
              fontSize: '10px', 
              fontWeight: '600',
              textTransform: 'uppercase',
              textShadow: '0 2px 4px rgba(0,0,0,0.8)'
            }}>
              {hasAlert ? 'CRITICAL FAULT' : `${floor.zones.length} ZONES`}
            </div>

            {/* Vertical Drop Line */}
            <div style={{ 
              width: '1px', 
              height: '40px', 
              backgroundColor: hasAlert ? 'rgba(255,69,58,0.8)' : 'rgba(255,255,255,0.4)', 
              margin: '6px 0' 
            }} />
            
            {/* Anchor Dot */}
            <div style={{ 
              width: '5px', 
              height: '5px', 
              borderRadius: '50%', 
              backgroundColor: hasAlert ? '#ff453a' : '#ffffff', 
              marginBottom: '-2px',
              boxShadow: hasAlert ? '0 0 8px #ff453a' : '0 0 8px rgba(255,255,255,0.8)'
            }} />
          </div>
        </Html>
      )}
    </group>
  );
}

export { FloorPlate };
