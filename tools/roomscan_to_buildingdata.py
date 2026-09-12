#!/usr/bin/env python3
"""Turn a Polycam room scan (DXF floorplan + STL mesh) into a building fixture.

The digitizer in ai_modules/branch_b_digitization reads a raster floorplan and infers
rooms with OpenCV. A Polycam export needs none of that: the DXF already carries the room
boundary as vector geometry on a named layer, surveyed rather than segmented. This reads
it directly.

NOTHING about the building is invented here. Every thermal coefficient comes from
server/data/programme-library.json via officeize_fixture.Library, the same class the tower
fixture is generated with, so a scanned room and a digitized floor are described by the
same physics with the same sources. The two numbers that cannot come from the library --
the room's shape and its ceiling height -- are measurements read out of the scan itself:

  shape   Poly-Rooms LWPOLYLINE in the DXF
  height  the Y extent of the STL mesh (Polycam is Y-up), i.e. floor to ceiling as scanned

Usage:
    python3 tools/roomscan_to_buildingdata.py --dxf scan.dxf --stl scan.stl \\
            --out server/data/building-data-room-scan.json
"""

import argparse
import json
import struct
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

from officeize_fixture import Library, poly_area  # noqa: E402  (path set above)

LIBRARY = ROOT / "server" / "data" / "programme-library.json"

# Layers a Polycam DXF uses. Named here so a change in their export is one edit, and so a
# missing layer fails loudly rather than silently producing a room with no doors.
LAYER_ROOMS = "Poly-Rooms"
LAYER_LABELS = "Poly-RoomLabels"
LAYER_DOORS = "Poly-Doors"
LAYER_WINDOWS = "Poly-Windows"


def read_dxf_entities(path):
    """DXF is group-code/value pairs on alternating lines. The ENTITIES section is all we
    want, and only three group codes in it: 8 (layer), 10/20 (vertex x/y), 1/3 (text)."""
    lines = [l.rstrip("\r\n") for l in open(path, encoding="utf-8", errors="replace")]
    pairs = [(lines[i].strip(), lines[i + 1]) for i in range(0, len(lines) - 1, 2)]

    start = end = None
    for i, (code, val) in enumerate(pairs):
        if code == "2" and val.strip() == "ENTITIES":
            start = i
        if start is not None and code == "0" and val.strip() == "ENDSEC":
            end = i
            break
    if start is None:
        raise SystemExit("no ENTITIES section in %s" % path)

    ents, cur = [], None
    for code, val in pairs[start:end]:
        if code == "0":
            if cur:
                ents.append(cur)
            cur = {"type": val.strip(), "layer": None, "x": [], "y": [], "text": []}
        elif cur is not None:
            if code == "8":
                cur["layer"] = val.strip()
            elif code == "10":
                try:
                    cur["x"].append(float(val))
                except ValueError:
                    pass
            elif code == "20":
                try:
                    cur["y"].append(float(val))
                except ValueError:
                    pass
            elif code in ("1", "3"):
                cur["text"].append(val.strip())
    if cur:
        ents.append(cur)
    return ents


def stl_height_m(path):
    """Floor-to-ceiling height from the mesh's vertical extent. Polycam writes Y-up."""
    with open(path, "rb") as f:
        f.read(80)
        n = struct.unpack("<I", f.read(4))[0]
        lo, hi = 1e18, -1e18
        for _ in range(n):
            rec = f.read(50)
            if len(rec) < 50:
                break
            v = struct.unpack("<12fH", rec)
            for k in range(3):
                y = v[3 + k * 3 + 1]
                lo, hi = min(lo, y), max(hi, y)
    return round(hi - lo, 2)


def clean_label(raw):
    """MTEXT carries inline formatting codes (\\A1; and friends). Strip to the words."""
    t = " ".join(raw)
    for code in ("\\A1;", "\\A0;", "\\A2;", "\\P"):
        t = t.replace(code, " ")
    return " ".join(t.split()) or "Scanned room"


def slug(s):
    return "".join(c if c.isalnum() else "-" for c in s.lower()).strip("-")


def centroid(poly):
    """Area centroid, not the vertex mean: an L-shaped room's vertex mean can fall outside
    the room, and the dashboard anchors its zone label here."""
    a = cx = cy = 0.0
    for i in range(len(poly)):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % len(poly)]
        cross = x0 * y1 - x1 * y0
        a += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    a *= 0.5
    if abs(a) < 1e-9:
        n = len(poly)
        return {"x": round(sum(p[0] for p in poly) / n, 2), "y": round(sum(p[1] for p in poly) / n, 2)}
    return {"x": round(cx / (6 * a), 2), "y": round(cy / (6 * a), 2)}


def perimeter(poly):
    total = 0.0
    for i in range(len(poly)):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % len(poly)]
        total += ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
    return total


def build(dxf_path, stl_path, building_id, zone_name_override, exterior_fraction, ac_walls=None):
    ents = read_dxf_entities(dxf_path)

    rooms = [e for e in ents
             if e["layer"] == LAYER_ROOMS and e["type"] == "LWPOLYLINE" and len(e["x"]) >= 3]
    if not rooms:
        raise SystemExit("no %s polygons found — is this a Polycam DXF?" % LAYER_ROOMS)

    # Largest polygon wins if the export nests an outline inside a boundary.
    rooms.sort(key=lambda e: -poly_area(list(zip(e["x"], e["y"]))))
    room = rooms[0]
    raw_poly = list(zip(room["x"], room["y"]))

    # Shift to a positive quadrant: Polycam centres the scan on its own origin, and every
    # existing fixture places the floor outline with its minimum corner at (0, 0).
    min_x = min(p[0] for p in raw_poly)
    min_y = min(p[1] for p in raw_poly)
    poly = [[round(p[0] - min_x, 2), round(p[1] - min_y, 2)] for p in raw_poly]
    # A closing vertex repeated at the end would double-count one edge of the perimeter.
    if len(poly) > 1 and poly[0] == poly[-1]:
        poly = poly[:-1]

    area = poly_area(poly)
    height = stl_height_m(stl_path) if stl_path else None
    if not height or height <= 0:
        raise SystemExit("could not measure ceiling height from the STL; pass --height")

    labels = [e for e in ents if e["layer"] == LAYER_LABELS and e["text"]]
    zone_name = zone_name_override or (clean_label(labels[0]["text"]) if labels else "Scanned room")

    doors = [e for e in ents if e["layer"] == LAYER_DOORS and e["x"]]
    windows = [e for e in ents if e["layer"] == LAYER_WINDOWS and e["x"]]

    lib = Library(json.loads(LIBRARY.read_text()))
    # classify() is the library's own area banding — the room is not hand-labelled here.
    prog = lib.classify(area, is_ground=True, cell_rank=0, svc_rank=0)

    perim = perimeter(poly)
    wall_m = perim * exterior_fraction
    wall_m2 = wall_m * height
    partition_m2 = max(0.0, perim - wall_m) * height
    # A single-storey scan has its own roof; the tower's interior floors do not.
    roof_m2 = area

    thermal = lib.thermal(prog, area, height, lib.cal.get("solarGainMultiplierDefault", 0.3)
                          if isinstance(lib.cal, dict) else 0.3,
                          wall_m2, roof_m2, partition_m2)

    zid = "zone-%s-lvl1" % slug(zone_name)
    zone = {
        "zoneId": zid,
        "name": zone_name,
        "zoneType": prog,
        "bim_asset_id": str(uuid.uuid5(uuid.NAMESPACE_URL, "econ://roomscan/%s" % zid)),
        "polygon": poly,
        "centroid": centroid(poly),
        "thermalProperties": thermal,
        "hvacMapping": {"vavId": "vav-%s-lvl1" % slug(zone_name)},
    }

    # Wall-mounted split units. A Polycam floorplan cuts at ~1.2 m, so units mounted above
    # that never appear in the DXF and cannot be derived from the scan -- these are placed
    # from the installer's knowledge of the room and marked as such, not measured.
    def wall_units(specs):
        out = []
        n = len(poly)
        for spec in specs or []:
            wid = int(spec)
            if wid < 0 or wid >= n:
                raise SystemExit("wall id %d out of range (0..%d)" % (wid, n - 1))
            x0, y0 = poly[wid]
            x1, y1 = poly[(wid + 1) % n]
            mx, my = (x0 + x1) / 2.0, (y0 + y1) / 2.0
            # Inward normal: rotate the wall direction 90 degrees and point it at the
            # room's centroid, so the unit blows into the room rather than through the wall.
            dx, dy = x1 - x0, y1 - y0
            L = (dx * dx + dy * dy) ** 0.5 or 1.0
            nx, ny = -dy / L, dx / L
            c = centroid(poly)
            if (c["x"] - mx) * nx + (c["y"] - my) * ny < 0:
                nx, ny = -nx, -ny
            out.append({
                "wall": wid,
                "x": round(mx, 2), "y": round(my, 2),
                "mountHeightM": round(min(2.3, height - 0.4), 2),
                "dirX": round(nx, 3), "dirY": round(ny, 3),
                "type": "wall-split",
                "placement": "installer-specified",
            })
        return out

    def openings(ents_list):
        out = []
        for e in ents_list:
            cx = sum(e["x"]) / len(e["x"]) - min_x
            cy = sum(e["y"]) / len(e["y"]) - min_y
            out.append({"x": round(cx, 2), "y": round(cy, 2), "tx": 0, "tz": 1})
        return out

    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    outline = [[0, 0], [round(max(xs), 2), 0], [round(max(xs), 2), round(max(ys), 2)], [0, round(max(ys), 2)]]

    return {
        "buildingId": building_id,
        "floors": [{
            "level": 1,
            "elevation": 0.0,
            "height": height,
            "name": "Scanned room",
            "geometry": {
                "outline": outline,
                "exteriorPolygon": poly,
                "corePolygon": [],
                "wallThickness": 0.2,
            },
            "airflowDomain": {
                "doors": openings(doors),
                "windows": openings(windows),
                "hvacUnits": wall_units(ac_walls),
            },
            "zones": [zone],
        }],
    }, {"area": area, "height": height, "prog": prog, "doors": len(doors),
        "windows": len(windows), "name": zone_name, "verts": len(poly)}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dxf", required=True, help="Polycam DXF floorplan export")
    ap.add_argument("--stl", required=True, help="Polycam STL mesh (used only for ceiling height)")
    ap.add_argument("--out", required=True, help="fixture JSON to write")
    ap.add_argument("--building-id", default="bldg-econ-room-scan")
    ap.add_argument("--name", default=None, help="override the room label from the DXF")
    ap.add_argument("--exterior-fraction", type=float, default=1.0,
                    help="fraction of the perimeter that is external wall. A standalone "
                         "scan carries no information about what is on the other side of "
                         "each wall; 1.0 treats the room as its own building (its outline "
                         "IS the building outline), which is what this fixture represents.")
    ap.add_argument("--ac-wall", action="append", type=int, metavar="WALL_ID",
                    help="wall index carrying a wall-mounted split unit; repeatable. Printed "
                         "by --list-walls. Not derivable from the scan: a Polycam floorplan "
                         "cuts below mounting height.")
    ap.add_argument("--list-walls", action="store_true", help="print wall ids and exit")
    ap.add_argument("--write", action="store_true", help="write the file (otherwise dry run)")
    a = ap.parse_args()

    doc, s = build(a.dxf, a.stl, a.building_id, a.name, a.exterior_fraction, a.ac_wall)
    print("room      : %r (%d vertices)" % (s["name"], s["verts"]))
    print("programme : %s   (from the library's own area bands)" % s["prog"])
    print("area      : %.1f m2      height: %.2f m (measured from the STL)" % (s["area"], s["height"]))
    print("openings  : %d doors, %d windows" % (s["doors"], s["windows"]))
    units = doc["floors"][0]["airflowDomain"]["hvacUnits"]
    if units:
        print("hvac units: %d wall-split (installer-specified, not scanned)" % len(units))
        for u in units:
            print("              wall W%-3d at (%.2f, %.2f) h=%.2f m" % (u["wall"], u["x"], u["y"], u["mountHeightM"]))
    tp = doc["floors"][0]["zones"][0]["thermalProperties"]
    print("thermal   : setpoint %.1f C, %d W base load, tau %.2f h"
          % (tp["setpoint"], tp["baseHeatLoad"], tp["timeConstantH"]))
    if a.write:
        payload = json.dumps(doc, indent=2) + "\n"
        Path(a.out).write_text(payload)
        print("\nwrote %s" % a.out)
        # The dashboard bundles its own copy as the offline fallback it renders when the
        # engine cannot be reached. officeize_fixture.py learned the hard way that a mirror
        # nothing regenerates is a mirror that drifts, so it is written from here too.
        mirror = ROOT / "dashboard" / "src" / Path(a.out).name
        mirror.write_text(payload)
        print("wrote %s  (dashboard offline mirror)" % mirror.relative_to(ROOT))
    else:
        print("\n(dry run — pass --write to save to %s)" % a.out)


if __name__ == "__main__":
    main()
