import { getBuilding } from '../buildingStore';
import { DEFAULT_FAULT_TARGET } from '../useDigitalTwin';

// Turns a simulation frame into the ReactFlow node/edge graph the topology panel draws,
// and picks the floor the app opens on. Pure functions of their arguments -- no React,
// no module state -- which is why they live here rather than inside App.jsx.

// Professional riser layout: the AHU plant node sits on top and one terminal-unit
// card per zone (zone + its feeding VAV merged — they map 1:1) fills a sorted grid
// beneath it, like an equipment schedule. Replaces the old centroid-scattered boxes,
// which overlapped unreadably on a 90-zone digitized floor.
const buildTopologyFromSim = (simState, activeFloor, ontology, building = getBuilding()) => {
  const nodes = [];
  const edges = [];

  // Normalize the Brick ontology to {source, target, predicate}. Tolerates both the legacy
  // shape ({ relationships: [{source, predicate, target}] }) and the digitized-pipeline shape
  // (a flat array of {subject, predicate, object}). Missing/empty ontology -> no edges (no crash).
  const rawRels = Array.isArray(ontology) ? ontology : (ontology?.relationships ?? []);
  const relationships = rawRels.map(r => ({
    source: r.source ?? r.subject,
    target: r.target ?? r.object,
    predicate: r.predicate,
  }));

  const floorObj = (building?.floors || []).find(f => f.level === activeFloor);
  const floorZoneIds = new Set((floorObj?.zones || []).map(z => z.zoneId));

  const activeZones = Object.values(simState.zones)
    .filter(z => floorZoneIds.size > 0 ? floorZoneIds.has(z.id) : z.level === activeFloor)
    .sort((a, b) => (a.label || a.id).localeCompare(b.label || b.id));

  // Largest VAV flow anywhere in the building right now, so every unit's airflow bar is
  // drawn against a scale this building actually reaches.
  const flowMax = Object.values(simState.vavs || {}).reduce((m, v) => Math.max(m, v.flow || 0), 0);

  const PER_ROW = 9, STEP_X = 166, STEP_Y = 92;
  const gridW = Math.min(Math.max(activeZones.length, 1), PER_ROW) * STEP_X - 18;

  nodes.push({
    id: 'ahu-main', type: 'ahu', draggable: false,
    position: { x: gridW / 2 - 70, y: -130 },
    // Status follows the building's real alarm state, not the demo scenario selector: a
    // fault scenario that has not yet driven any zone out of band is not an AHU fault.
    data: {
      label: 'AHU-MAIN',
      status: Object.values(simState.zones || {}).some(z => z.alert === true) ? 'FAULT' : 'NOMINAL',
      pressure: simState.ahuPressure,
      autoPilot: simState.autoPilot,
    }
  });

  // Index the feeds-relationships once. Scanning the whole ontology per zone was
  // O(zones x relationships) on every topology rebuild — ~90 x 2,000 on a digitized floor.
  //
  // A plain object, not a Map. This lived in App.jsx, which imports lucide-react's `Map`
  // icon -- that shadows the global constructor for the whole module, so `new Map()` threw
  // "Map is not a constructor" and took the entire console down through the error boundary.
  // Moving the function here removes the shadow, but the plain object stays: Object.create(null)
  // also avoids inherited keys like "constructor" colliding with a zone id, which is a reason
  // of its own.
  const feedsByZone = Object.create(null);
  for (const r of relationships) {
    if (r.predicate === 'brick:feeds' && typeof r.source === 'string' && r.source.startsWith('vav')
        && feedsByZone[r.target] === undefined) {
      feedsByZone[r.target] = r.source;
    }
  }

  activeZones.forEach((z, i) => {
    const col = i % PER_ROW, row = Math.floor(i / PER_ROW);

    // Topology driven by the Brick Schema semantic ontology: find the VAV feeding this zone.
    const vavId = feedsByZone[z.id] || null;
    const v = vavId ? simState.vavs[vavId] : null;

    nodes.push({
      id: z.id, type: 'unit', draggable: false,
      position: { x: col * STEP_X, y: row * STEP_Y },
      data: {
        label: z.label, temp: z.temp, setpoint: z.setpoint, deadband: z.deadband,
        occupancy: z.occupancy, alert: z.alert,
        plugW: z.plugW ?? 0,
        stripW: z.stripW ?? 0,
        // Label the terminal unit by the SERVING RELATIONSHIP, not by its raw id. Zone and
        // VAV ids are opaque keys minted by the digitizer and referenced across the Brick
        // ontology, so they outlive any re-classification of what the room is for — which
        // is how a zone correctly labelled "Cellular Office" came to sit under a unit
        // captioned "VAV-SERVER-ROOM-59-LVL1". The id stays; the caption follows the room.
        vavId,
        vavLabel: vavId ? `VAV · ${(z.label || z.id).toUpperCase()}` : 'DIRECT',
        flowVal: v?.flow || 0,
        flowMax,
      }
    });

    // One thin supply line per unit off the AHU — together they read as the supply bus.
    edges.push({
      id: `e-ahu-${z.id}`, source: 'ahu-main', target: z.id, type: 'step',
      animated: false, style: { stroke: 'rgba(0, 163, 224, 0.16)', strokeWidth: 1 },
      data: { isFlow: true },
    });
  });

  return { nodes, edges };
};



function defaultFloor(bld = getBuilding()) {
  const floors = bld?.floors || [];
  const f = floors.find(fl => (fl.zones || []).some(z => z.zoneId === DEFAULT_FAULT_TARGET));
  return f ? f.level : (floors[Math.floor(floors.length / 2)]?.level || 1);
}

export { buildTopologyFromSim, defaultFloor };
