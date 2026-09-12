import React, { useRef, useMemo } from 'react';
import * as THREE from 'three';
import { exteriorPolygon, wallThickness, toWorld } from '../floorGeometry';
import { csgSubtract, getCachedGeometry } from './csg';

// Exterior walls, with their window openings cut out rather than drawn on.

// ========== STEP 1: CSG-Based Wall with Window Cutouts ==========
function WallWithWindows({ position: [x, y, z], width, height, depth, rotation, windows = [], isActive, viewMode = 'hybrid' }) {
  const meshRef = useRef();
  
  const wallGeometry = useMemo(() => {
    const signature = `wall|${width}|${height}|${depth}|${JSON.stringify(windows)}`;
    return getCachedGeometry(signature, () => {
      const wallBox = new THREE.BoxGeometry(width, height, depth);
      wallBox.translate(0, height / 2, 0); // Bake the Y shift into the geometry directly!
      const wallMesh = new THREE.Mesh(wallBox);

      const windowMeshes = windows.map((window) => {
        const windowBox = new THREE.BoxGeometry(window.width, window.height, depth + 0.5);
        windowBox.translate(window.x, window.y, 0); // Bake local window pos into geometry!
        const windowMesh = new THREE.Mesh(windowBox);
        return windowMesh;
      });

      return csgSubtract(wallMesh, windowMeshes);
    });
  }, [width, height, depth, windows]);
  
  const isLogical = viewMode === 'logical';
  const opacity = isLogical ? 0.05 : (isActive ? 0.35 : 0.15);

  return (
    <mesh
      ref={meshRef}
      position={[x, y, z]}
      rotation={[0, -rotation, 0]}
      geometry={wallGeometry}
      dispose={null}
    >
      <meshStandardMaterial 
        color={isActive ? "#a0aec0" : "#4a5568"}
        roughness={0.7}
        metalness={0.1}
        transparent={true}
        opacity={opacity}
        wireframe={isLogical && isActive}
      />
    </mesh>
  );
}

// ========== STEP 2: Exterior Walls Generator ==========
function ExteriorWalls({ floor, isActive, viewMode = 'hybrid' }) {
  const walls = useMemo(() => {
    // Via the shared accessor: a fixture whose generator spelled the envelope differently
    // used to throw here, and the canvas boundary swallowed it — so the whole building
    // silently failed to render rather than reporting anything.
    const polygon = exteriorPolygon(floor);
    if (!polygon) return [];
    const wallSegments = [];
    
    for (let i = 0; i < polygon.length; i++) {
      const start = polygon[i];
      const end = polygon[(i + 1) % polygon.length];
      
      // Convert from 2D coordinates [x, y] to 3D [x, 0, -z] centered around (20, 20)
      const [sx, sz] = toWorld(start);
      const [ex, ez] = toWorld(end);

      const width = Math.sqrt((ex - sx) ** 2 + (ez - sz) ** 2);
      const angle = Math.atan2(ez - sz, ex - sx);
      
      const windowSpacing = floor.floorType === 'typical-office' ? 4.0 : 6.0;
      const windows = [];
      let currentX = windowSpacing / 2;
      while (currentX < width - windowSpacing / 2) {
        windows.push({
          x: currentX - width / 2,
          y: 1.0 + (floor.height - 1.5) / 2, // Bottom sill at 1m from floor
          width: 2.0,
          height: floor.height - 1.5,
        });
        currentX += windowSpacing;
      }

      wallSegments.push({
        position: [(sx + ex) / 2, 0, (sz + ez) / 2],
        width,
        height: floor.height,
        depth: wallThickness(floor),
        rotation: angle,
        windows: windows,
      });
    }
    
    return wallSegments;
  }, [floor]);
  
  return (
    <group>
      {walls.map((wall, idx) => (
        <WallWithWindows
          key={`wall-${idx}`}
          position={wall.position}
          width={wall.width}
          height={wall.height}
          depth={wall.depth}
          rotation={wall.rotation}
          windows={wall.windows}
          isActive={isActive}
          viewMode={viewMode}
        />
      ))}
    </group>
  );
}

export { WallWithWindows, ExteriorWalls };
