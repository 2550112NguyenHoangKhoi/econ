// Building geometry source-of-truth for the frontend.
//
// The dashboard used to bundle building-data.json at build time, which made the blueprint
// import flow impossible: a building deployed through /api/building would run in the
// engine while every panel kept rendering the geometry compiled into the JS bundle.
//
// Now the app boots in two stages (see main.jsx): this store fetches the engine's copy
// FIRST, and only then is the app module graph imported — so the module-scope constants
// derived from geometry (FLOOR_AREA_M2, FAULT_ZONES, DESIGN_PEAK_MW, ...) all compute
// from the live building. The bundled copy remains solely the offline fallback, keeping
// the 3D shell renderable with no backend.

import bundledTower from './building-data.json' with { type: 'json' };
import bundledHome from './building-data-home.json' with { type: 'json' };
import { API_BASE } from './api.js';



let activeModelType = 'multi-level'; // 'multi-level' or 'domestic-home'
let towerData = bundledTower;
let homeData = bundledHome;
let live = false;
const listeners = new Set();

export function isMultiLevelBuilding(b) {
  return Boolean(
    b &&
    typeof b === 'object' &&
    b.buildingId !== 'bldg-econ-house-hcmc' &&
    Array.isArray(b.floors) &&
    b.floors.length > 1
  );
}

export function isHomeBuilding(b) {
  return Boolean(
    b &&
    typeof b === 'object' &&
    (b.buildingId === 'bldg-econ-house-hcmc' || (Array.isArray(b.floors) && b.floors.length === 1))
  );
}

export function getBuilding() {
  if (activeModelType === 'domestic-home') {
    return isHomeBuilding(homeData) ? homeData : bundledHome;
  }
  return isMultiLevelBuilding(towerData) ? towerData : bundledTower;
}

export function getActiveFloorAsset(building, activeFloor) {
  const floors = Array.isArray(building?.floors) ? building.floors : [];
  const targetLevel = Number.isFinite(Number(activeFloor)) ? Number(activeFloor) : 1;
  const floor = floors.find((f) => f.level === targetLevel) || floors[0];
  if (!floor) return null;
  const primaryZone = floor.zones?.[0];
  return {
    level: floor.level,
    name: floor.name || `Level ${floor.level}`,
    assetId: primaryZone?.bim_asset_id || `floor-asset-${floor.level}`,
    zoneCount: floor.zones?.length || 0,
    elevation: typeof floor.elevation === 'number' ? floor.elevation : 0,
    height: typeof floor.height === 'number' ? floor.height : 4.0,
  };
}


export function getAllKnownBuildings() {
  const t = isMultiLevelBuilding(towerData) ? towerData : bundledTower;
  const h = isHomeBuilding(homeData) ? homeData : bundledHome;
  return [t, h];
}

export function getBuildingModelType() {
  return activeModelType;
}

export function setBuildingModelType(type, options = {}) {
  if (type !== 'multi-level' && type !== 'domestic-home') return getBuilding();

  const force = Boolean(options?.force);
  const changed = activeModelType !== type;

  if (!changed && !force) {
    return getBuilding();
  }

  activeModelType = type;

  // Immediate synchronous guarantee: Ensure active model matches context
  if (type === 'multi-level') {
    if (!isMultiLevelBuilding(towerData)) {
      towerData = bundledTower;
    }
  } else if (type === 'domestic-home') {
    if (!isHomeBuilding(homeData)) {
      homeData = bundledHome;
    }
  }

  // Notify listeners immediately
  listeners.forEach((fn) => {
    try { fn(getBuilding(), activeModelType); } catch (e) { console.error(e); }
  });

  // Notify Go backend of the active building model switch
  fetch(`${API_BASE}/api/building/switch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: type }),
  }).catch(() => {
    // Backend might be offline or running in mock testbed mode
  });

  // Asynchronously fetch live data with ?model=${type}
  fetch(`${API_BASE}/api/building-data?model=${encodeURIComponent(type)}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (!j) return;
      let updated = false;
      if (type === 'multi-level' && isMultiLevelBuilding(j)) {
        towerData = j;
        live = true;
        updated = true;
      } else if (type === 'domestic-home' && isHomeBuilding(j)) {
        homeData = j;
        updated = true;
      }
      if (updated && activeModelType === type) {
        listeners.forEach((fn) => {
          try { fn(getBuilding(), activeModelType); } catch (e) { console.error(e); }
        });
      }
    })
    .catch(() => {
      // Backend unreachable: bundled fallback stands
    });

  return getBuilding();
}

export function subscribeBuildingChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// True when the geometry came from the engine rather than the bundle — surfaces let the
// user know when they are looking at the fallback.
export function buildingIsLive() {
  return live && activeModelType === 'multi-level';
}

export async function bootBuilding() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await fetch(`${API_BASE}/api/building-data?model=multi-level`, { signal: ctl.signal });
    if (r.ok) {
      const j = await r.json();
      if (isMultiLevelBuilding(j)) {
        towerData = j;
        live = true;
      } else {
        towerData = bundledTower;
      }
    }
  } catch {
    // Engine unreachable: the bundled fallback stands, flagged via buildingIsLive().
    towerData = bundledTower;
  } finally {
    clearTimeout(timer);
  }
  return getBuilding();
}

