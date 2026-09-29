"""Load the cached open data and build the precinct model: buildings, trees, walking network."""
from __future__ import annotations

import json
import math
import pathlib
import re
from dataclasses import dataclass, field

import networkx as nx
import numpy as np
import shapely
from shapely.geometry import LineString, Point, Polygon

from .geo import CREMORNE_LONLAT, to_lonlat, to_xy

RAW = pathlib.Path(__file__).resolve().parents[2] / "data" / "raw"

FLOOR_HEIGHT = 3.5
DEFAULT_HEIGHT = {  # metres, used when OSM has neither height nor levels
    "house": 6.5, "terrace": 7.0, "detached": 6.5, "semidetached_house": 7.0,
    "garage": 3.0, "shed": 3.0, "roof": 4.0, "carport": 3.0,
    "commercial": 10.0, "office": 12.0, "retail": 7.0, "industrial": 9.0, "warehouse": 9.0,
    "apartments": 15.0, "school": 9.0, "train_station": 6.0, "bridge": 0.0,
}

WALKABLE = {
    "footway", "pedestrian", "path", "steps", "living_street", "residential", "service",
    "unclassified", "tertiary", "secondary", "primary", "tertiary_link", "secondary_link", "cycleway",
}
ROADS = {"living_street", "residential", "service", "unclassified", "tertiary", "secondary",
         "primary", "tertiary_link", "secondary_link"}

# Footpath width per side (m). OSM rarely carries widths, so these are class defaults,
# with the main streets hand-corrected from street-view estimates.
SIDEWALK_WIDTH = {
    "footway": 2.0, "pedestrian": 5.0, "path": 2.5, "cycleway": 2.5, "steps": 2.0,
    "living_street": 3.0, "residential": 1.8, "service": 1.2, "unclassified": 1.8,
    "tertiary": 2.2, "tertiary_link": 2.0, "secondary": 2.5, "secondary_link": 2.0, "primary": 3.0,
}
STREET_WIDTH_FIX = {
    "Cremorne Street": 1.4, "Church Street": 2.4, "Swan Street": 3.0, "Balmain Street": 1.6,
    "Stephenson Street": 1.6, "Dover Street": 1.5, "Chestnut Street": 1.5, "Punt Road": 2.0,
    "Harcourt Parade": 1.5, "Kipling Street": 1.5, "Gwynne Street": 1.5, "Cubitt Street": 1.5,
}
# Distance from road centreline to the footpath centre, per side (m).
SIDE_OFFSET = {
    "primary": 9.0, "secondary": 8.0, "secondary_link": 5.0, "tertiary": 6.5, "tertiary_link": 5.0,
    "unclassified": 5.0, "residential": 5.0, "living_street": 3.0, "service": 2.5,
}
SAMPLE_STEP = 3.0  # m between shade samples along an edge


def _num(v):
    if v is None:
        return None
    m = re.search(r"[-+]?\d*\.?\d+", str(v))
    return float(m.group()) if m else None


def _building_height(tags: dict) -> float:
    h = _num(tags.get("height"))
    if h and h > 0:
        return h
    lv = _num(tags.get("building:levels"))
    if lv and lv > 0:
        return lv * FLOOR_HEIGHT + 1.0
    return DEFAULT_HEIGHT.get(tags.get("building", "yes"), 7.0)


def _levels(tags: dict, height: float) -> float:
    lv = _num(tags.get("building:levels"))
    return lv if lv else max(1.0, round(height / FLOOR_HEIGHT))


def _poly_from_geometry(geom) -> Polygon | None:
    if not geom or len(geom) < 4:
        return None
    x, y = to_xy([p["lon"] for p in geom], [p["lat"] for p in geom])
    p = Polygon(np.column_stack([x, y]))
    if not p.is_valid:
        p = p.buffer(0)
    if p.is_empty or p.geom_type != "Polygon":
        return None
    return p


@dataclass
class Building:
    id: int
    poly: Polygon
    height: float
    levels: float
    name: str | None
    kind: str
    street: str | None

    @property
    def floor_area(self) -> float:
        return self.poly.area * self.levels


@dataclass
class Precinct:
    buildings: list[Building]
    tree_xy: np.ndarray        # (n, 2)
    tree_radius: np.ndarray    # canopy radius (m)
    tree_height: np.ndarray    # canopy centre height (m)
    graph: nx.Graph
    # --- edge arrays, indexed by edge id ---
    e_u: np.ndarray
    e_v: np.ndarray
    e_len: np.ndarray
    e_width: np.ndarray        # effective walking width (m) across both footpaths
    e_cls: list[str]
    e_name: list[str]
    e_is_road: np.ndarray
    e_coords: list[np.ndarray]  # (k, 2) metres
    # shade sample points: for side s in (0 centre/left, 1 right)
    s_edge: np.ndarray
    s_side: np.ndarray
    s_x: np.ndarray
    s_y: np.ndarray
    e_nsamples: np.ndarray
    e_left_compass: list[str]
    node_xy: dict[int, tuple[float, float]]
    node_ids: np.ndarray
    node_arr: np.ndarray
    cremorne: Polygon
    street_lines: list = field(default_factory=list)  # (name, LineString) of every named street
    stops: list[dict] = field(default_factory=list)
    offices: list[dict] = field(default_factory=list)

    def nearest_node(self, x: float, y: float) -> int:
        d = (self.node_arr[:, 0] - x) ** 2 + (self.node_arr[:, 1] - y) ** 2
        return int(self.node_ids[int(np.argmin(d))])

    def edge_between(self, u: int, v: int) -> int:
        return self.graph.edges[u, v]["eid"]


def _compass(dx: float, dy: float) -> str:
    ang = (math.degrees(math.atan2(dx, dy)) + 360) % 360  # 0 = north
    return ["north", "east", "south", "west"][int(((ang + 45) % 360) // 90)]


def _load_trees():
    trees = json.loads((RAW / "yarra_trees.json").read_text(encoding="utf-8"))["features"]
    lon = [f["geometry"]["coordinates"][0] for f in trees]
    lat = [f["geometry"]["coordinates"][1] for f in trees]
    x, y = to_xy(lon, lat)
    radius, height = [], []
    for f in trees:
        p = f["properties"]
        dbh_cm = _num(p.get("dbh")) or 15.0
        h = _num(p.get("height")) or 6.0
        # Urban street trees: crown diameter ~ 20-25 x DBH. Cap to keep outliers sane.
        r = min(7.5, max(1.0, 0.11 * dbh_cm + 0.5))
        if p.get("maturity") == "Young":
            r = min(r, 2.0)
        radius.append(r)
        height.append(max(2.5, h * 0.65))
    tx, ty = np.array(x), np.array(y)

    # OSM trees that are not already in the council inventory (private / park trees).
    osm = json.loads((RAW / "trees.json").read_text(encoding="utf-8"))["elements"]
    ox, oy = to_xy([e["lon"] for e in osm], [e["lat"] for e in osm])
    extra = []
    for a, b in zip(ox, oy):
        if tx.size == 0 or np.min((tx - a) ** 2 + (ty - b) ** 2) > 16:
            extra.append((a, b))
    if extra:
        ex = np.array(extra)
        tx = np.concatenate([tx, ex[:, 0]])
        ty = np.concatenate([ty, ex[:, 1]])
        radius += [2.5] * len(extra)
        height += [4.0] * len(extra)
    return np.column_stack([tx, ty]), np.array(radius), np.array(height)


def _load_buildings() -> list[Building]:
    data = json.loads((RAW / "buildings.json").read_text(encoding="utf-8"))["elements"]
    out = []
    for e in data:
        tags = e.get("tags", {})
        if tags.get("building") in ("bridge", "construction") or tags.get("location") == "underground":
            continue
        if e["type"] == "way":
            poly = _poly_from_geometry(e.get("geometry"))
        else:
            outers = [m for m in e.get("members", []) if m.get("role") == "outer"]
            polys = [_poly_from_geometry(m.get("geometry")) for m in outers]
            polys = [p for p in polys if p is not None]
            poly = max(polys, key=lambda p: p.area) if polys else None
        if poly is None or poly.area < 6:
            continue
        h = _building_height(tags)
        out.append(Building(
            id=e["id"], poly=poly, height=h, levels=_levels(tags, h),
            name=tags.get("name"), kind=tags.get("building", "yes"), street=tags.get("addr:street"),
        ))
    return out


def _load_graph():
    data = json.loads((RAW / "ways.json").read_text(encoding="utf-8"))["elements"]
    g = nx.Graph()
    node_xy: dict[int, tuple[float, float]] = {}
    node_key: dict[tuple[float, float], int] = {}
    raw_edges = []
    street_lines: list[tuple[str, LineString]] = []
    for w in data:
        tags = w.get("tags", {})
        hw = tags.get("highway")
        if tags.get("name") and hw in ROADS and len(w.get("geometry") or []) >= 2:
            lx, ly = to_xy([q["lon"] for q in w["geometry"]], [q["lat"] for q in w["geometry"]])
            street_lines.append((tags["name"], LineString(np.column_stack([lx, ly]))))
        if hw not in WALKABLE:
            continue
        if tags.get("foot") in ("no", "private") or tags.get("access") in ("private", "no") and tags.get("foot") not in ("yes", "designated"):
            continue
        if tags.get("sidewalk") in ("separate",) and hw in ROADS:
            # Sidewalks already mapped as footways; walking the carriageway centreline would double count.
            continue
        geom = w.get("geometry") or []
        if len(geom) < 2:
            continue
        # Shared OSM nodes have identical coordinates, so they double as node keys.
        nodes = [node_key.setdefault((round(q["lat"], 7), round(q["lon"], 7)), len(node_key)) for q in geom]
        xs, ys = to_xy([p["lon"] for p in geom], [p["lat"] for p in geom])
        for nid, x, y in zip(nodes, xs, ys):
            node_xy[nid] = (float(x), float(y))
        name = tags.get("name") or ""
        if hw == "footway" and tags.get("footway") == "sidewalk" and not name:
            name = "footpath"
        if hw == "footway" and tags.get("footway") == "crossing":
            name = "crossing"
        width_tag = _num(tags.get("width")) if hw in ("footway", "path", "pedestrian", "cycleway") else None
        side_w = width_tag or STREET_WIDTH_FIX.get(name, SIDEWALK_WIDTH[hw])
        is_road = hw in ROADS
        eff_w = side_w * (2 if is_road and tags.get("sidewalk") not in ("left", "right", "no") else 1)
        if is_road and tags.get("sidewalk") == "no":
            eff_w = 1.0  # walking on the carriageway edge
        for i in range(len(nodes) - 1):
            a, b = nodes[i], nodes[i + 1]
            if a == b:
                continue
            raw_edges.append((a, b, hw, name, eff_w, is_road))
    # Names of arterials we don't walk on (their footpaths are mapped separately), for labelling.
    trunk = RAW / "trunk.json"
    if trunk.exists():
        for w in json.loads(trunk.read_text(encoding="utf-8"))["elements"]:
            name = w.get("tags", {}).get("name")
            if name and name != "CityLink" and len(w.get("geometry") or []) >= 2:
                lx, ly = to_xy([q["lon"] for q in w["geometry"]], [q["lat"] for q in w["geometry"]])
                street_lines.append((name, LineString(np.column_stack([lx, ly]))))
    for a, b, hw, name, eff_w, is_road in raw_edges:
        if g.has_edge(a, b):
            continue
        g.add_edge(a, b, hw=hw, name=name, width=eff_w, road=is_road)
    # keep the main connected component
    main = max(nx.connected_components(g), key=len)
    g = g.subgraph(main).copy()
    return g, node_xy, street_lines


def load() -> Precinct:
    buildings = _load_buildings()
    tree_xy, tree_r, tree_h = _load_trees()
    g, node_xy, street_lines = _load_graph()
    cx, cy = to_xy([p[0] for p in CREMORNE_LONLAT], [p[1] for p in CREMORNE_LONLAT])
    cremorne = Polygon(np.column_stack([cx, cy]))

    e_u, e_v, e_len, e_width, e_cls, e_name, e_road, e_coords, e_left = [], [], [], [], [], [], [], [], []
    s_edge, s_side, s_x, s_y, e_ns = [], [], [], [], []
    for eid, (u, v, d) in enumerate(g.edges(data=True)):
        (x1, y1), (x2, y2) = node_xy[u], node_xy[v]
        length = math.hypot(x2 - x1, y2 - y1)
        d["eid"] = eid
        d["length"] = length
        e_u.append(u); e_v.append(v); e_len.append(length); e_width.append(d["width"])
        e_cls.append(d["hw"]); e_name.append(d["name"]); e_road.append(d["road"])
        e_coords.append(np.array([[x1, y1], [x2, y2]]))
        n = max(2, int(math.ceil(length / SAMPLE_STEP)) + 1)
        t = np.linspace(0, 1, n)
        px, py = x1 + (x2 - x1) * t, y1 + (y2 - y1) * t
        # left normal (relative to u->v)
        nx_, ny_ = (-(y2 - y1) / length, (x2 - x1) / length) if length > 0 else (0.0, 0.0)
        e_left.append(_compass(nx_, ny_))
        if d["road"]:
            off = SIDE_OFFSET.get(d["hw"], 4.0)
            for side, sgn in ((0, 1.0), (1, -1.0)):
                s_x.append(px + sgn * off * nx_); s_y.append(py + sgn * off * ny_)
                s_edge.append(np.full(n, eid)); s_side.append(np.full(n, side))
        else:
            s_x.append(px); s_y.append(py)
            s_edge.append(np.full(n, eid)); s_side.append(np.full(n, 0))
        e_ns.append(n)

    node_ids = np.array(list(g.nodes()))
    node_arr = np.array([node_xy[n] for n in node_ids])

    p = Precinct(
        buildings=buildings, tree_xy=tree_xy, tree_radius=tree_r, tree_height=tree_h, graph=g,
        e_u=np.array(e_u), e_v=np.array(e_v), e_len=np.array(e_len), e_width=np.array(e_width),
        e_cls=e_cls, e_name=e_name, e_is_road=np.array(e_road, dtype=bool), e_coords=e_coords,
        s_edge=np.concatenate(s_edge), s_side=np.concatenate(s_side),
        s_x=np.concatenate(s_x), s_y=np.concatenate(s_y), e_nsamples=np.array(e_ns),
        e_left_compass=e_left, node_xy=node_xy, node_ids=node_ids, node_arr=node_arr,
        cremorne=cremorne, street_lines=street_lines,
    )
    p.stops = _load_stops(p)
    p.offices = _pick_offices(p)
    return p


def _load_stops(p: Precinct) -> list[dict]:
    """Stations and tram stops (de-duplicated by name) that people walk into Cremorne from."""
    data = json.loads((RAW / "transit.json").read_text(encoding="utf-8"))["elements"]
    seen = {}
    for e in data:
        t = e.get("tags", {})
        c = e.get("center") or e
        name = t.get("name")
        if not name:
            continue
        kind = "train" if t.get("railway") == "station" else "tram"
        if kind == "tram":
            name = re.sub(r"^Stop \w+:\s*", "", name)
        key = (kind, name)
        seen.setdefault(key, []).append((c["lon"], c["lat"]))
    stops = []
    for (kind, name), pts in seen.items():
        lon = sum(a for a, _ in pts) / len(pts)
        lat = sum(b for _, b in pts) / len(pts)
        x, y = to_xy(lon, lat)
        stops.append({
            "id": re.sub(r"[^a-z0-9]+", "-", f"{kind}-{name}".lower()).strip("-"),
            "name": name + (" Station" if kind == "train" else " (tram)"),
            "kind": kind, "lon": float(lon), "lat": float(lat),
            "node": p.nearest_node(float(x), float(y)),
        })
    stops.sort(key=lambda s: (s["kind"] != "train", s["name"]))
    return stops


def _pick_offices(p: Precinct) -> list[dict]:
    """Buildings inside Cremorne large enough to be workplaces; named ones become presets."""
    out = []
    for b in p.buildings:
        c = b.poly.centroid
        if not p.cremorne.contains(c):
            continue
        workplace = b.kind in ("commercial", "office", "industrial", "retail") or b.levels >= 3 or b.height >= 10
        if not (workplace and b.poly.area >= 150) and not (b.name and b.poly.area >= 100):
            continue
        # entrance ~ nearest point on building edge to the network
        node = p.nearest_node(c.x, c.y)
        lon, lat = to_lonlat(c.x, c.y)
        out.append({
            "id": f"b{b.id}", "name": b.name, "street": b.street, "lon": float(lon), "lat": float(lat),
            "node": node, "floor_area": round(b.floor_area), "levels": b.levels, "height": b.height,
        })
    return out
