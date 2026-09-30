"""Shade model: building + tree shadows for any date/time, and the shaded share of every path segment."""
from __future__ import annotations

import json
import math
import pathlib
import threading
from dataclasses import dataclass
from datetime import date

import numpy as np
import shapely

from .precinct import Precinct
from .sun import local_dt, solar_position

CACHE_DIR = pathlib.Path(__file__).resolve().parents[2] / "data" / "cache" / "shadows"
CACHE_VERSION = 1
MAX_SHADOW = 250.0  # m; beyond this the sun is so low the whole precinct is effectively in shade


@dataclass
class ShadeFrame:
    date: date
    minutes: int
    azimuth: float
    elevation: float
    shadows: np.ndarray | None    # shadow polygons (metres), None at night
    edge_shade: np.ndarray        # shaded fraction of the best side of each edge, 0..1
    edge_best_side: np.ndarray    # 0 = left of u->v (or centre), 1 = right
    edge_side_gain: np.ndarray    # how much more shade the best side has than the other
    inside: np.ndarray | None = None  # per shade sample: inside any shadow (None at night)
    _tree: shapely.STRtree | None = None

    @property
    def tree(self) -> shapely.STRtree:
        """Spatial index over this frame's shadow polygons (built on first use)."""
        if self._tree is None:
            self._tree = shapely.STRtree(self.shadows)
        return self._tree

    @property
    def sun_up(self) -> bool:
        return self.elevation > 0.5


def shadow_vector(azimuth: float, elevation: float) -> tuple[float, float]:
    """Shadow offset (m) per metre of object height; shadows point away from the sun."""
    k = min(1.0 / math.tan(math.radians(elevation)), MAX_SHADOW / 10.0)
    return -math.sin(math.radians(azimuth)) * k, -math.cos(math.radians(azimuth)) * k


class ShadeModel:
    def __init__(self, precinct: Precinct):
        self.p = precinct
        self._cache: dict[tuple[date, int], ShadeFrame] = {}
        self._lock = threading.Lock()
        # Pre-build per-building ring arrays so each frame is pure vector maths.
        rings, heights, footprints = [], [], []
        for b in precinct.buildings:
            if b.height <= 0.5:
                continue
            rings.append(np.asarray(b.poly.exterior.coords))
            heights.append(b.height)
            footprints.append(b.poly)
        self._rings = rings
        self._heights = np.array(heights)
        self._footprints = np.array(footprints, dtype=object)
        hull_ratio = shapely.area(shapely.convex_hull(self._footprints)) / shapely.area(self._footprints)
        self._concave = np.nonzero(hull_ratio > 1.25)[0]
        self._geojson_cache: dict[tuple[date, int], dict] = {}
        self._sample_pts = shapely.points(precinct.s_x, precinct.s_y)
        self.n_building_shadows = len(rings)  # tree shadows follow the building shadows in ShadeFrame.shadows

    # ------------------------------------------------------------------ geometry
    def _building_shadows(self, dx: float, dy: float):
        """Shadow = footprint swept along the shadow vector (Minkowski sum with a segment).

        For convex footprints that is exactly the convex hull of the footprint and its translated
        copy. Strongly concave footprints (L/U shapes, courtyards) get the exact sweep instead:
        the union of every edge swept into a quad, plus the footprint.
        """
        pts = [shapely.multipoints(np.concatenate([r, r + [dx * h, dy * h]]))
               for r, h in zip(self._rings, self._heights)]
        out = shapely.convex_hull(np.array(pts, dtype=object))
        for i in self._concave:
            r, h = self._rings[i], self._heights[i]
            a, b = r[:-1], r[1:]
            q = shapely.polygons(np.stack([a, b, b + [dx * h, dy * h], a + [dx * h, dy * h], a], axis=1))
            q = shapely.make_valid(q[shapely.area(q) > 0.05])
            out[i] = shapely.union_all(np.concatenate([q, [self._footprints[i]]]), grid_size=0.05)
        return out

    def _tree_shadows(self, dx: float, dy: float):
        p = self.p
        cx = p.tree_xy[:, 0] + dx * p.tree_height
        cy = p.tree_xy[:, 1] + dy * p.tree_height
        return shapely.buffer(shapely.points(cx, cy), p.tree_radius, quad_segs=4)

    def frame(self, d: date, minutes: int) -> ShadeFrame:
        key = (d, minutes)
        with self._lock:
            if key in self._cache:
                return self._cache[key]
        az, el = solar_position(local_dt(d, minutes))
        n_edges = len(self.p.e_len)
        if el <= 0.5:
            f = ShadeFrame(d, minutes, az, el, None, np.ones(n_edges), np.zeros(n_edges, int), np.zeros(n_edges))
        else:
            dx, dy = shadow_vector(az, el)
            shadows = np.concatenate([self._building_shadows(dx, dy), self._tree_shadows(dx, dy)])
            tree = shapely.STRtree(shadows)
            hits = tree.query(self._sample_pts, predicate="intersects")[0]
            inside = np.zeros(len(self.p.s_x), dtype=bool)
            inside[hits] = True
            f = ShadeFrame(d, minutes, az, el, shadows, *self.edge_fractions(inside), inside=inside, _tree=tree)
        with self._lock:
            self._cache[key] = f
            if len(self._cache) > 400:
                self._cache.pop(next(iter(self._cache)))
        return f

    def edge_fractions(self, inside: np.ndarray):
        p = self.p
        n = len(p.e_len)
        cnt = np.zeros((n, 2))
        tot = np.zeros((n, 2))
        np.add.at(cnt, (p.s_edge, p.s_side), inside.astype(float))
        np.add.at(tot, (p.s_edge, p.s_side), 1.0)
        frac = np.divide(cnt, tot, out=np.full((n, 2), -1.0), where=tot > 0)
        best_side = np.argmax(frac, axis=1)
        best = frac.max(axis=1)
        other = np.where(tot[:, 1] > 0, frac.min(axis=1), best)
        return np.clip(best, 0, 1), best_side, np.clip(best - other, 0, 1)

    # ------------------------------------------------------------------ outputs
    def shadow_geojson(self, d: date, minutes: int) -> dict:
        from .geo import geom_to_geojson

        key = (d, minutes)
        if key in self._geojson_cache:
            return self._geojson_cache[key]
        disk = CACHE_DIR / f"v{CACHE_VERSION}_{d.isoformat()}_{minutes:04d}.json"
        if disk.exists():
            out = json.loads(disk.read_text(encoding="utf-8"))
            self._geojson_cache[key] = out
            return out
        f = self.frame(d, minutes)
        if f.shadows is None:
            out = {"type": "FeatureCollection", "features": []}
        else:
            union = shapely.union_all(f.shadows)
            union = shapely.simplify(shapely.intersection(union, shapely.box(-1000, -900, 1000, 900)), 0.5)
            out = {
                "type": "FeatureCollection",
                "features": [{"type": "Feature", "properties": {}, "geometry": geom_to_geojson(union)}],
            }
        self._geojson_cache[key] = out
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        disk.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
        if len(self._geojson_cache) > 200:
            self._geojson_cache.pop(next(iter(self._geojson_cache)))
        return out

    def precinct_shaded_share(self, f: ShadeFrame) -> float:
        """Length-weighted share of the walking network that has a shaded side."""
        return float(np.average(f.edge_shade, weights=self.p.e_len))
