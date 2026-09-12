import React, { useRef, useMemo, useState, useEffect } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { getBuilding } from '../buildingStore';
import { getFootprint } from '../floorGeometry';

// Framing the tower, and the controls that animate between framings.
//
// towerFraming is pure arithmetic -- given the active floor and the viewport's aspect and
// safe area, where the camera goes and what it looks at. DynamicControls interpolates to
// whatever that function returns, so a floor change is an animation rather than a cut.

// The FIXED hero angle for the building: a front-left 3/4 view, moderately elevated.
// Azimuth 45° puts the camera in the +x/+z octant; elevation 26° looks gently down so the
// exploded active floor's top reads. Distance is aspect-aware so the WHOLE exploded tower
// fits the viewport at any shape (wide desktop or tall mobile/portrait) without cropping.
const VIEW_AZ = THREE.MathUtils.degToRad(45);
const VIEW_EL = THREE.MathUtils.degToRad(26);
const VIEW_DIR = new THREE.Vector3(
  Math.cos(VIEW_EL) * Math.sin(VIEW_AZ),
  Math.sin(VIEW_EL),
  Math.cos(VIEW_EL) * Math.cos(VIEW_AZ),
);

// safeArea describes the part of the canvas the operator can actually SEE — the console
// paints the AI panel, the metrics dock, the topology window and the airflow window over
// the 3D view, and framing the building to the full canvas centres it behind them. It is
// {left, right, top, bottom} in pixels, plus the viewport size. Absent (mobile, or any
// caller with no overlays), framing falls back to the whole canvas exactly as before.
function towerFraming(activeFloor, aspect = 1.6, safeArea = null, customBuilding = null) {
  const building = customBuilding || getBuilding();
  const floors = building.floors || [];
  const footprint = getFootprint(building);
  const dispElev = (f) => f.elevation + (f.level > activeFloor ? 30 : (f.level === activeFloor ? 5 : 0));
  let topY = -Infinity, botY = Infinity, activeY = 0;
  floors.forEach((f) => {
    const e = dispElev(f);
    topY = Math.max(topY, e + (f.height || 4));
    botY = Math.min(botY, e);
    if (f.level === activeFloor) activeY = e + (f.height || 4) / 2;
  });
  // The building is drawn about the world origin (see floorGeometry.ORIGIN), so that is
  // what the camera aims at.
  const center = { x: 0, z: 0 };

  // span is the building's TRUE vertical extent, floored only so the arithmetic stays
  // well-conditioned for a single low floor.
  const span = Math.max(topY - botY, 0.5);

  // Bounding sphere of the exploded tower, from the building's REAL footprint and real
  // height.
  const R = Math.hypot(footprint.width / 2, span / 2, footprint.depth / 2);
  const vFov = (45 * Math.PI) / 180;
  // Fit to the FREE band, not the whole canvas. On the desktop console the visible strip
  // between the AI panel and the metrics dock is barely half the canvas width.
  const vw = safeArea?.viewportW || 0;
  const vh = safeArea?.viewportH || 0;
  const freeW = safeArea ? Math.max(200, vw - safeArea.left - safeArea.right) : 0;
  const freeH = safeArea ? Math.max(200, vh - safeArea.top - safeArea.bottom) : 0;
  const fitAspect = safeArea && freeH > 0 ? freeW / freeH : aspect;

  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(0.3, fitAspect));
  const fitFov = Math.min(vFov, hFov);
  const portrait = aspect < 1;
  const margin = portrait ? 1.2 : (safeArea ? 1.15 : 1.45);
  const dist = Math.max((R / Math.sin(fitFov / 2)) * margin, 14);
  const aimBias = portrait ? span * 0.16 : 0;

  // Aim at the vertical middle of what is actually there.
  const target = new THREE.Vector3(center.x, (topY + botY) / 2 + aimBias, center.z);
  const position = target.clone().add(VIEW_DIR.clone().multiplyScalar(dist));

  if (safeArea && vw > 0 && vh > 0) {
    const halfH = dist * Math.tan(vFov / 2);
    const worldPerPxY = (2 * halfH) / vh;
    const worldPerPxX = (2 * halfH * aspect) / vw;
    const dxPx = (safeArea.left + (vw - safeArea.right)) / 2 - vw / 2;
    const dyPx = (safeArea.top + (vh - safeArea.bottom)) / 2 - vh / 2;
    const forward = VIEW_DIR.clone().negate().normalize();
    const camRight = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const camUp = new THREE.Vector3().crossVectors(camRight, forward).normalize();
    const shift = camRight.multiplyScalar(-dxPx * worldPerPxX).add(camUp.multiplyScalar(dyPx * worldPerPxY));
    target.add(shift);
    position.add(shift);
  }

  return { position, target, span, topY, botY, activeY };
}

function DynamicControls({ targetX, targetY, targetZ, isZoomed, activeFloor, safeArea, building }) {
  const controlsRef = useRef();
  const { camera, size } = useThree();
  const aspect = size.width / Math.max(1, size.height);

  // The fixed hero overview, recomputed when the attention floor, building model, OR viewport shape
  // changes (so it stays correctly framed across desktop/mobile, multi-level/domestic, and on rotate/resize).
  const overview = useMemo(
    () => towerFraming(activeFloor, aspect, safeArea, building),
    [activeFloor, aspect, building, safeArea?.left, safeArea?.right, safeArea?.top, safeArea?.bottom, safeArea?.viewportW, safeArea?.viewportH],
  );

  const [animating, setAnimating] = useState(false);
  const [targetCameraPos, setTargetCameraPos] = useState(overview.position);
  const [targetLookAt, setTargetLookAt] = useState(overview.target);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!controlsRef.current) return;
    if (!initializedRef.current) {
      controlsRef.current.target.copy(overview.target);
      camera.position.copy(overview.position);
      controlsRef.current.update();
      initializedRef.current = true;
    } else if (!isZoomed) {
      setTargetCameraPos(overview.position);
      setTargetLookAt(overview.target);
      setAnimating(true);
    }
  }, [overview, camera, isZoomed]);

  useEffect(() => {
    if (isZoomed) {
      const footprint = getFootprint(building);
      const reach = Math.max(footprint.width, footprint.depth) * 0.35;
      const lateral = Math.max(reach, 4);
      const rise = Math.max(reach * 1.9, 8);
      setTargetCameraPos(new THREE.Vector3(targetX + lateral, targetY + rise, targetZ + lateral));
      setTargetLookAt(new THREE.Vector3(targetX, targetY, targetZ));
      setAnimating(true);
    } else {
      setTargetCameraPos(overview.position);
      setTargetLookAt(overview.target);
      setAnimating(true);
    }
  }, [isZoomed, targetX, targetY, targetZ, overview, building, activeFloor]);


  useFrame(() => {
    if (controlsRef.current && animating) {
      controlsRef.current.target.lerp(targetLookAt, 0.08);
      camera.position.lerp(targetCameraPos, 0.08);

      if (camera.position.distanceTo(targetCameraPos) < 0.02 && controlsRef.current.target.distanceTo(targetLookAt) < 0.02) {
        camera.position.copy(targetCameraPos);
        controlsRef.current.target.copy(targetLookAt);
        setAnimating(false);
      }
      controlsRef.current.update();
    }
  });

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enableRotate={false}
      enablePan={false}
      enableZoom
    />
  );
}

export { VIEW_AZ, VIEW_EL, VIEW_DIR, towerFraming, DynamicControls };
