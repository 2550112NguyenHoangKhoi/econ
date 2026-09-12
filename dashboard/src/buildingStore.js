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
import bundledRoomScan from './building-data-room-scan.json' with { type: 'json' };
import { API_BASE } from './api.js';



let activeModelType = 'multi-level'; // 'multi-level' | 'domestic-home' | 'room-scan'
let towerData = bundledTower;
let homeData = bundledHome;
let roomScanData = bundledRoomScan;
let live = false;
const listeners = new Set();

// The last building-switch failure, or null. Kept so a panel can show "could not switch,
// still on X" in the page instead of a modal that stops the page.
let lastSwitchError = null;
// Set when a switch completed from the bundled fixture because the engine was unreachable.
// Not an error: the view is coherent, it is simply not engine-backed. See setBuildingModelType.
let lastSwitchOffline = false;

export function isMultiLevelBuilding(b) {
  return Boolean(
    b &&
    typeof b === 'object' &&
    b.buildingId !== 'bldg-econ-house-hcmc' &&
    Array.isArray(b.floors) &&
    b.floors.length > 1
  );
}

export const ROOM_SCAN_BUILDING_ID = 'bldg-econ-room-scan';

export function isRoomScanBuilding(b) {
  return Boolean(b && typeof b === 'object' && b.buildingId === ROOM_SCAN_BUILDING_ID);
}

// NOTE the room-scan exclusion. This matches any single-floor building by shape, which was
// unambiguous while the house was the only one — a surveyed room is also single-floor, and
// without this it would be accepted as the house and render under the wrong model.
export function isHomeBuilding(b) {
  return Boolean(
    b &&
    typeof b === 'object' &&
    !isRoomScanBuilding(b) &&
    (b.buildingId === 'bldg-econ-house-hcmc' || (Array.isArray(b.floors) && b.floors.length === 1))
  );
}

export function getBuilding() {
  if (activeModelType === 'domestic-home') {
    return isHomeBuilding(homeData) ? homeData : bundledHome;
  }
  if (activeModelType === 'room-scan') {
    return isRoomScanBuilding(roomScanData) ? roomScanData : bundledRoomScan;
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
  const r = isRoomScanBuilding(roomScanData) ? roomScanData : bundledRoomScan;
  return [t, h, r];
}

export function getBuildingModelType() {
  return activeModelType;
}

// Apply a model the ENGINE has already switched to, without telling it to switch again.
//
// The engine broadcasts buildingModelType to every client. Routing that broadcast back
// through setBuildingModelType() POSTs /api/building/switch, which makes the engine
// broadcast again — and with two dashboards open on different models neither yields, so
// the engine reloads the building hundreds of times a minute. autoPilot and operationMode
// already had adopt paths for exactly this reason (adoptAutoPilot, adoptMode); the
// building model never did.
export function adoptBuildingModelType(type) {
  if (type !== 'multi-level' && type !== 'domestic-home' && type !== 'room-scan') return getBuilding();
  if (activeModelType === type) return getBuilding();
  activeModelType = type;
  listeners.forEach((fn) => {
    try { fn(getBuilding(), activeModelType); } catch (e) { console.error(e); }
  });
  return getBuilding();
}

export async function setBuildingModelType(type, options = {}) {
  if (type !== 'multi-level' && type !== 'domestic-home' && type !== 'room-scan') return getBuilding();

  const force = Boolean(options?.force);
  const changed = activeModelType !== type;

  if (!changed && !force) {
    return getBuilding();
  }

  lastSwitchError = null;
  const prevModelType = activeModelType;
  const prevTowerData = towerData;
  const prevHomeData = homeData;
  const prevRoomScanData = roomScanData;
  const prevLive = live;

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
  } else if (type === 'room-scan') {
    if (!isRoomScanBuilding(roomScanData)) {
      roomScanData = bundledRoomScan;
    }
  }

  // Notify listeners immediately
  listeners.forEach((fn) => {
    try { fn(getBuilding(), activeModelType); } catch (e) { console.error(e); }
  });

  try {
    // Notify Go backend of the active building model switch.
    //
    // Two failure modes hide behind this one await, and they deserve opposite responses:
    //
    //   the engine ANSWERED and refused (!ok)  -> revert. The engine is the authority on
    //       which building is live, and a dashboard showing one building while the twin
    //       simulates another is the desync this project has already shipped a fix for.
    //
    //   the engine did not answer at all (fetch rejects) -> do NOT revert. There is no
    //       authority to disagree with. The dashboard bundles all three fixtures precisely
    //       so it can be driven with no engine, and refusing to switch in that state gives
    //       an operator a dead button and a console error instead of the offline view the
    //       bundles exist to provide. `live` is already false in that state, so nothing
    //       downstream mistakes the result for engine-backed data.
    //
    // Collapsing both into "revert" is what made five assertions in verify_ui_rendering.js
    // and five in verify_3d_asset_resolution.js unfixable: those suites serve dist/ with no
    // engine behind it, which is exactly the unreachable case.
    let switchRes;
    try {
      switchRes = await fetch(`${API_BASE}/api/building/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: type }),
      });
    } catch (netErr) {
      // Unreachable. Keep the switch, keep the bundled fixture, and say so once.
      live = false;
      lastSwitchError = null;
      lastSwitchOffline = true;
      console.info(
        `[building] switched to "${type}" from the bundled fixture — the engine at ${API_BASE} did not answer, ` +
        `so this view is not engine-backed (${netErr?.message || netErr}).`
      );
      listeners.forEach((fn) => {
        try { fn(getBuilding(), activeModelType); } catch (e) { console.error(e); }
      });
      return getBuilding();
    }
    lastSwitchOffline = false;

    if (!switchRes.ok) {
      throw new Error(`Backend switch failed: ${switchRes.status} ${switchRes.statusText}`);
    }

    // Asynchronously fetch live data with ?model=${type}
    const dataRes = await fetch(`${API_BASE}/api/building-data?model=${encodeURIComponent(type)}`);
    if (dataRes.ok) {
      const j = await dataRes.json();
      if (j) {
        let updated = false;
        if (type === 'multi-level' && isMultiLevelBuilding(j)) {
          towerData = j;
          live = true;
          updated = true;
        } else if (type === 'domestic-home' && isHomeBuilding(j)) {
          homeData = j;
          updated = true;
        } else if (type === 'room-scan' && isRoomScanBuilding(j)) {
          roomScanData = j;
          updated = true;
        }
        if (updated && activeModelType === type) {
          listeners.forEach((fn) => {
            try { fn(getBuilding(), activeModelType); } catch (e) { console.error(e); }
          });
        }
      }
    }
  } catch (error) {
    console.error('Building switch failed, reverting UI:', error);
    
    // Revert local state
    activeModelType = prevModelType;
    towerData = prevTowerData;
    homeData = prevHomeData;
    roomScanData = prevRoomScanData;
    live = prevLive;
    
    // Report the failure WITHOUT alert().
    //
    // alert() is a modal: it suspends the page until someone clicks OK. On an operator
    // console that is streaming telemetry at 30 fps that is the wrong instrument — the
    // twin freezes behind the dialog, and on a wall display nobody is there to dismiss
    // it. It also silently wedged the verify_*.js suites: puppeteer does not auto-accept
    // dialogs, so the modal raised by one failed switch blocked every later evaluation
    // and the run died on protocol timeouts that looked like a hang in the 3D scene.
    // Under Node it was worse still — `alert` is not defined there, so the error handler
    // itself threw a ReferenceError and took the whole process down.
    //
    // The revert above already put the UI back on a coherent building. Listeners are told
    // about it, and now carry the error so a panel can surface it in place.
    lastSwitchError = error;
    console.error(`[building] switch to "${type}" failed; reverted to ${prevModelType}:`, error);

    // Notify listeners of the revert
    listeners.forEach((fn) => {
      try { fn(getBuilding(), activeModelType, error); } catch (e) { console.error(e); }
    });
  }

  return getBuilding();
}

export function getLastBuildingSwitchError() {
  return lastSwitchError;
}

// True when the last switch completed from the bundled fixture because the engine could not
// be reached. Distinct from getLastBuildingSwitchError(), which means the engine answered
// and said no — that one reverts, this one does not. A panel that wants to tell the operator
// "you are looking at a bundled building, not the twin" reads this.
export function isBuildingSwitchOffline() {
  return lastSwitchOffline;
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

// Load the active building's geometry from the engine at startup.
//
// Two things here used to be wrong and are worth stating, because both failed silently:
//
//  1. It asked for `/api/building-data` with no `?model=`, so the engine answered with
//     whichever building IT considered active and the dashboard adopted that — overriding
//     the model the UI was on. Boot now asks for the model it is actually displaying.
//
//  2. The type dispatch ended in a catch-all `else` that assigned anything not recognised as
//     tower or room-scan to homeData and switched activeModelType to 'domestic-home'. A
//     malformed payload, an error envelope, a truncated response — all became "the home
//     building", and the whole UI switched to it. Guessing a building's type from the
//     absence of two others is not identification.
//
// The rule now: the payload must validate as the type that was REQUESTED, or it is not
// adopted at all and the bundled fixture stands. `live` stays false in that case, which is
// what buildingIsLive() reports to the surfaces that tell an operator whether they are
// looking at the twin or at a bundle.
export async function bootBuilding() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  const requested = activeModelType;
  try {
    const r = await fetch(
      `${API_BASE}/api/building-data?model=${encodeURIComponent(requested)}`,
      { signal: ctl.signal },
    );
    if (r.ok) {
      const j = await r.json();
      if (requested === 'multi-level' && isMultiLevelBuilding(j)) {
        towerData = j;
        live = true;
      } else if (requested === 'room-scan' && isRoomScanBuilding(j)) {
        roomScanData = j;
        live = true;
      } else if (requested === 'domestic-home' && isHomeBuilding(j)) {
        homeData = j;
        live = true;
      } else {
        // The engine answered with something that is not the building we asked for. Keep
        // the bundle, keep the model, and say which is which — this is the case that used
        // to silently flip the entire UI to the home fixture.
        console.warn(
          `[building] engine returned a payload that does not validate as "${requested}"; ` +
          `keeping the bundled fixture. buildingIsLive() stays false.`
        );
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

