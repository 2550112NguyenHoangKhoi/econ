// The 3D building: the Canvas, the floor stack, and the selection/hover state on top of it.
//
// The pieces it draws live in building3d/, each one thing:
//
//	csg.js           window cutouts as real subtractions, and the cache that pays for them
//	Walls.jsx        exterior walls
//	FloorPlate.jsx   the slab, with the service core subtracted
//	ZoneRenderer.jsx one zone, coloured by how far it is from its own setpoint
//	camera.jsx       where the camera goes for a given floor, and the animation to it

import React, { useRef, useMemo, useState, useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import { getBuilding, subscribeBuildingChange } from './buildingStore';
import FloorInfrastructure from './FloorInfrastructure';
import { toWorld } from './floorGeometry';
import { ExteriorWalls } from './building3d/Walls';
import { FloorPlate } from './building3d/FloorPlate';
import { ZoneRenderer } from './building3d/ZoneRenderer';
import { towerFraming, DynamicControls } from './building3d/camera';

// Re-exported: towerFraming was part of this module's surface before the 3D pieces moved
// into building3d/, and callers should not have to know that it did.
export { towerFraming };







export function SingleFloorLayout({ floor, isActive, simState, activeScenario, faultTarget, onFloorClick, selectedZone, setSelectedZone, hoveredZone, setHoveredZone, viewMode = 'hybrid' }) {
  return (
    <>
      <FloorPlate floor={floor} isActive={isActive} onClick={onFloorClick} simState={simState} viewMode={viewMode} />
      {isActive && <ExteriorWalls floor={floor} isActive={isActive} viewMode={viewMode} />}
      <group>
        {floor.zones.map((zone) => (
          <ZoneRenderer
            key={zone.zoneId}
            zone={zone}
            isActive={isActive}
            simState={simState}
            isHovered={hoveredZone === zone.zoneId}
            onHover={setHoveredZone}
            isSelected={selectedZone === zone.zoneId}
            onSelect={setSelectedZone}
            viewMode={viewMode}
          />
        ))}
      </group>
      {isActive && <FloorInfrastructure floor={floor} simState={simState} viewMode={viewMode} />}
    </>
  );
}

// ========== STEP 5: Complete Production Building Component ==========
export default function BuildingModel({ simState, activeFloor, onFloorClick, showAirflow, selectedZone, setSelectedZone, viewMode = 'hybrid', safeArea = null, building: propBuilding = null }) {
  const [hoveredZone, setHoveredZone] = useState(null);
  const [activeBuilding, setActiveBuilding] = useState(() => propBuilding || getBuilding());

  useEffect(() => {
    if (propBuilding) {
      setActiveBuilding(propBuilding);
    } else {
      setActiveBuilding(getBuilding());
      const unsub = subscribeBuildingChange((b) => setActiveBuilding(b));
      return unsub;
    }
  }, [propBuilding]);

  const currentBld = propBuilding || activeBuilding;
  const floors = currentBld.floors || [];

  const targetCoords = useMemo(() => {
    if (!selectedZone) return { x: 0, y: 0, z: 0 };
    for (const f of floors) {
      const z = f.zones.find(zone => zone.zoneId === selectedZone);
      if (z) {
        let yOffset = f.level > activeFloor ? 30.0 : (f.level === activeFloor ? 5.0 : 0.0);
        const [wx, wz] = toWorld([z.centroid.x, z.centroid.y]);
        return {
          x: wx,
          y: f.elevation + yOffset + 1.5,
          z: wz
        };
      }
    }
    return { x: 0, y: 0, z: 0 };
  }, [selectedZone, activeFloor, floors]);

  const initialOverview = useMemo(() => {
    const aspect = (typeof window !== 'undefined' ? window.innerWidth / Math.max(1, window.innerHeight) : 1.6);
    return towerFraming(activeFloor, aspect, safeArea, currentBld);
  }, [activeFloor, safeArea, currentBld]);


  return (
    <div style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, zIndex: 1 }}>
      <Canvas
        camera={{ position: [initialOverview.position.x, initialOverview.position.y, initialOverview.position.z], fov: 45 }}
        frameloop="always"
        dpr={[1, 1.5]}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        onCreated={({ gl, invalidate }) => {
          const canvas = gl.domElement;
          canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); }, false);
          canvas.addEventListener('webglcontextrestored', () => { invalidate(); }, false);
        }}
      >
        {/* Ambient, Hemisphere, and Multi-directional lighting for vibrant digital twin illumination */}
        <ambientLight intensity={0.85} />
        <hemisphereLight skyColor="#ffffff" groundColor="#3a4b5c" intensity={0.65} />
        <directionalLight position={[25, 45, 25]} intensity={1.4} />
        <directionalLight position={[-25, 25, -25]} intensity={0.6} />
        
        <DynamicControls
          targetX={targetCoords.x}
          targetY={targetCoords.y}
          targetZ={targetCoords.z}
          isZoomed={!!selectedZone}
          activeFloor={activeFloor}
          safeArea={safeArea}
          building={currentBld}
        />

        <group>
          {floors.map((floor) => {
            const isActive = floor.level === activeFloor;

            let yOffset = 0;
            if (floor.level > activeFloor) {
                yOffset = 30.0;
            } else if (floor.level === activeFloor) {
                yOffset = 5.0;
            }

            const displayElevation = floor.elevation + yOffset;

            return (
              <group 
                key={`floor-${floor.level}`} 
                position={[0, displayElevation, 0]}
                onClick={(e) => {
                  e.stopPropagation();
                  onFloorClick(floor.level);
                }}
              >
                <SingleFloorLayout
                  floor={floor}
                  isActive={isActive}
                  simState={simState}
                  selectedZone={selectedZone}
                  setSelectedZone={setSelectedZone}
                  hoveredZone={hoveredZone}
                  setHoveredZone={setHoveredZone}
                  onFloorClick={onFloorClick}
                  viewMode={viewMode}
                />
              </group>
            );
          })}
        </group>
      </Canvas>
    </div>
  );
}
