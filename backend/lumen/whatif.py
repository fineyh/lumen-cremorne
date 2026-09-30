"""What-if plans: plant or remove trees, put up shade sails / awnings, close a block for works,
and see what it does to shade, comfort and every station -> workplace walk.

A plan is an overlay. The base precinct (OSM + council data) is never modified:

* New trees use the same circle-canopy shadow maths as the existing street trees (shade.py).
  Canopy size depends on the plan's "years after planting", because a new tree takes ~15 years
  to give full shade, and Lumen's brief is "within 12 months, existing assets".
* Shade sails and awnings are flat rectangles at a height, so their shadow is the rectangle
  shifted along the shadow vector. They can go up inside 12 months.
* A closure removes a block (the chain of segments between two intersections) from routing.

Only shade samples inside new or removed shadows are re-tested, and only station -> workplace
trips whose best path touches a changed segment are re-described. Everything here is a model
estimate and the UI says so.
"""
from __future__ import annotations

import hashlib
import json
import math
import pathlib
import re
import statistics
import threading
import time
import uuid
from dataclasses import dataclass, field

import numpy as np
import shapely
from shapely import affinity

from .geo import geom_to_geojson, ring_to_lonlat, to_lonlat, to_xy
from .precinct import Precinct
from .shade import ShadeFrame, ShadeModel, shadow_vector

STORE = pathlib.Path(__file__).resolve().parents[2] / "data" / "whatif"

MATURE_YEARS = 15
TREE_SIZES = {  # mature canopy radius (m), mature height (m)
    "small": {"r": 3.0, "h": 7.0, "label": "Small street tree"},
    "medium": {"r": 5.0, "h": 11.0, "label": "Medium street tree"},
    "large": {"r": 7.5, "h": 16.0, "label": "Large canopy tree"},
}
CANOPIES = {  # length along the street x depth (m), height of the fabric (m)
    "sail": {"length": 6.0, "width": 6.0, "height": 4.0, "label": "Shade sail"},
    "awning": {"length": 12.0, "width": 2.5, "height": 3.2, "label": "Awning"},
}
KINDS = {"tree", "sail", "awning", "remove_tree", "closure"}

# Indicative installed cost per item, A$ (low, high). Trees: advanced nursery stock planted into an
# existing nature strip or pit, plus 2 years of establishment watering. A new pit cut into the
# footpath with structural soil cells can cost several times more. Sails: commercial-grade fabric,
# steel posts and footings. Closures are an operating cost (traffic management) per day.
# Planning figures for comparing options, not quotes; confirm with City of Yarra before use.
COSTS = {
    "tree:small": (1_200, 2_000),
    "tree:medium": (2_000, 3_500),
    "tree:large": (3_500, 6_000),
    "sail": (8_000, 15_000),
    "awning": (15_000, 30_000),
    "remove_tree": (1_500, 4_000),
    "closure": (1_500, 3_000),  # per day
}
COST_NOTE = ("Indicative planning costs (A$, installed). Trees include 2 years of establishment watering; "
             "a new footpath pit with structural soil can cost several times more. Not quotes.")


def item_cost(it: dict) -> tuple[int, int]:
    key = f"tree:{it.get('size', 'medium')}" if it["kind"] == "tree" else it["kind"]
    return COSTS.get(key, (0, 0))


def plan_cost(items: list[dict]) -> dict:
    """Capital cost range of a plan, plus the per-day cost of any closures."""
    lo = hi = 0
    by: dict[str, dict] = {}
    day = [0, 0]
    for it in items:
        a, b = item_cost(it)
        key = f"tree:{it.get('size')}" if it["kind"] == "tree" else it["kind"]
        if it["kind"] == "closure":
            day[0] += a; day[1] += b
        else:
            lo += a; hi += b
        g = by.setdefault(key, {"n": 0, "low": 0, "high": 0})
        g["n"] += 1; g["low"] += a; g["high"] += b
    # what can be delivered inside the 12-month window (everything except the trees' full canopy)
    quick = sum(item_cost(it)[0] + item_cost(it)[1] for it in items if it["kind"] in CANOPIES) / 2
    return {"low": lo, "high": hi, "mid": (lo + hi) / 2, "by_kind": by,
            "closure_per_day": day if day[1] else None, "quick_win_mid": quick}
MAX_ITEMS = 300
CLOSURE_MAX_M = 400.0


def growth(years: float) -> tuple[float, float]:
    """(canopy radius, height) as a share of the mature size, `years` after planting advanced stock."""
    g = min(1.0, max(0.0, years) / MATURE_YEARS)
    return min(1.0, 0.2 + 0.8 * g), min(1.0, 0.35 + 0.65 * g)


@dataclass
class Plan:
    key: str
    years: float
    items: list[dict]
    tree_xy: np.ndarray        # new trees (n, 2), metres
    tree_r: np.ndarray
    tree_h: np.ndarray         # canopy centre height
    canopies: list[tuple[shapely.Polygon, float]]
    removed: np.ndarray        # indices into the base tree arrays
    closed: np.ndarray | None  # bool per edge, None when nothing is closed
    overlay: dict = field(default_factory=dict)

    @property
    def changes_shade(self) -> bool:
        return bool(len(self.tree_xy) or self.canopies or len(self.removed))

    def to_raw(self) -> dict:
        return {"years": self.years, "items": [{k: v for k, v in it.items() if not k.startswith("_")} for it in self.items]}


class WhatIf:
    def __init__(self, p: Precinct, shade: ShadeModel):
        self.p = p
        self.shade = shade
        self._lines = shapely.linestrings(np.stack(p.e_coords))
        self._line_tree = shapely.STRtree(self._lines)
        self.plans: dict[str, Plan] = {}
        self._frames: dict[tuple, tuple[ShadeFrame, dict]] = {}
        self._compare: dict[tuple, dict] = {}
        self._base_trips: dict[tuple, dict] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ plans
    def register(self, raw: dict) -> Plan:
        items_in = list(raw.get("items") or [])[:MAX_ITEMS]
        years = float(min(40.0, max(0.0, raw.get("years", 1))))
        items, seen_closed = [], set()
        for raw_it in items_in:
            it = self._normalise(raw_it)
            if not it:
                continue
            if it["kind"] == "closure":  # clicking the same block twice closes it once
                if set(it["edges"]) <= seen_closed:
                    continue
                seen_closed.update(it["edges"])
            items.append(it)
        canon = json.dumps({"years": years, "items": [{k: v for k, v in it.items() if not k.startswith("_")} for it in items]},
                           sort_keys=True)
        key = hashlib.sha1(canon.encode()).hexdigest()[:12]
        if key in self.plans:
            return self.plans[key]
        p = self.p
        gr, gh = growth(years)
        txy, tr, th, canopies, removed = [], [], [], [], set()
        closed = np.zeros(len(p.e_len), dtype=bool)
        for it in items:
            k = it["kind"]
            if k == "tree":
                size = TREE_SIZES[it["size"]]
                txy.append(it["_xy"]); tr.append(max(1.0, size["r"] * gr)); th.append(max(2.5, size["h"] * gh * 0.65))
            elif k in CANOPIES:
                canopies.append((it["_poly"], CANOPIES[k]["height"]))
            elif k == "remove_tree":
                removed.add(it["tree"])
            elif k == "closure":
                closed[it["edges"]] = True
        plan = Plan(
            key=key, years=years, items=items,
            tree_xy=np.array(txy).reshape(-1, 2), tree_r=np.array(tr), tree_h=np.array(th),
            canopies=canopies, removed=np.array(sorted(removed), dtype=int),
            closed=closed if closed.any() else None,
        )
        plan.overlay = self._overlay(plan)
        with self._lock:
            self.plans[key] = plan
            if len(self.plans) > 500:
                self.plans.pop(next(iter(self.plans)))
        return plan

    def get(self, key: str | None) -> Plan | None:
        return self.plans.get(key) if key else None

    def _normalise(self, it: dict) -> dict | None:
        p = self.p
        kind = it.get("kind")
        if kind not in KINDS:
            return None
        if kind == "remove_tree":
            i = int(it.get("tree", -1))
            return {"kind": kind, "tree": i} if 0 <= i < len(p.tree_xy) else None
        lon, lat = float(it["lon"]), float(it["lat"])
        x, y = (float(v) for v in to_xy(lon, lat))
        if abs(x) > 1500 or abs(y) > 1500:
            return None
        out = {"kind": kind, "lon": round(lon, 6), "lat": round(lat, 6), "_xy": (x, y)}
        if kind == "tree":
            out["size"] = it.get("size") if it.get("size") in TREE_SIZES else "medium"
        elif kind in CANOPIES:
            c = CANOPIES[kind]
            ang = it.get("angle")
            if ang is None:
                ang = self._street_angle(x, y)
            out["angle"] = round(float(ang), 1)
            rect = shapely.box(-c["length"] / 2, -c["width"] / 2, c["length"] / 2, c["width"] / 2)
            out["_poly"] = affinity.translate(affinity.rotate(rect, out["angle"], origin=(0, 0)), x, y)
        elif kind == "closure":
            e = int(it["edge"]) if it.get("edge") is not None else self._nearest_edge(x, y)
            out["edges"] = self._block(e)
            out["street"] = None
        return out

    def _nearest_edge(self, x: float, y: float) -> int:
        return int(self._line_tree.nearest(shapely.Point(x, y)))

    def _street_angle(self, x: float, y: float) -> float:
        """Orientation (deg, counter-clockwise from east) of the nearest path segment."""
        (x1, y1), (x2, y2) = self.p.e_coords[self._nearest_edge(x, y)]
        return math.degrees(math.atan2(y2 - y1, x2 - x1))

    def _block(self, e: int) -> list[int]:
        """The edge plus its neighbours out to the nearest intersections (a 'block' to close)."""
        p, g = self.p, self.p.graph
        out, total = [e], float(p.e_len[e])
        for start, came in ((int(p.e_u[e]), int(p.e_v[e])), (int(p.e_v[e]), int(p.e_u[e]))):
            n, prev = start, came
            while g.degree(n) == 2 and total < CLOSURE_MAX_M:
                nxt = next(m for m in g.neighbors(n) if m != prev)
                eid = p.edge_between(n, nxt)
                if eid in out:
                    break
                out.append(eid); total += float(p.e_len[eid])
                prev, n = n, nxt
        return sorted(out)

    def _overlay(self, plan: Plan) -> dict:
        """GeoJSON of the plan's interventions, for drawing on the map."""
        p = self.p
        feats, ti = [], 0
        for i, it in enumerate(plan.items):
            k = it["kind"]
            props = {"i": i, "kind": k, "cost": list(item_cost(it))}
            if k == "tree":
                props.update(size=it["size"], r=round(float(plan.tree_r[ti]), 1), r_mature=TREE_SIZES[it["size"]]["r"])
                ti += 1
                geom = {"type": "Point", "coordinates": [it["lon"], it["lat"]]}
            elif k in CANOPIES:
                geom = geom_to_geojson(it["_poly"])
            elif k == "remove_tree":
                lon, lat = to_lonlat(*p.tree_xy[it["tree"]])
                props["r"] = round(float(p.tree_radius[it["tree"]]), 1)
                geom = {"type": "Point", "coordinates": [round(float(lon), 6), round(float(lat), 6)]}
            else:
                geom = {"type": "MultiLineString", "coordinates": [ring_to_lonlat(p.e_coords[e]) for e in it["edges"]]}
            feats.append({"type": "Feature", "properties": props, "geometry": geom})
        return {"type": "FeatureCollection", "features": feats}

    # ------------------------------------------------------------------ shade overlay
    def _samples_in(self, geoms: np.ndarray) -> np.ndarray:
        """Indices of shade sample points inside any of `geoms` (bbox pre-filter, then exact test)."""
        if not len(geoms):
            return np.zeros(0, dtype=int)
        b = shapely.bounds(geoms)
        sx, sy = self.p.s_x, self.p.s_y
        near = np.nonzero((sx >= b[:, 0].min()) & (sx <= b[:, 2].max()) & (sy >= b[:, 1].min()) & (sy <= b[:, 3].max()))[0]
        if not len(near):
            return near
        hit = shapely.STRtree(geoms).query(self.shade._sample_pts[near], predicate="intersects")[0]
        return np.unique(near[hit])

    def frame(self, plan: Plan, d, minutes: int) -> ShadeFrame:
        return self._frame(plan, d, minutes)[0]

    def new_shadows_geojson(self, plan: Plan, d, minutes: int) -> dict:
        return self._frame(plan, d, minutes)[1]

    def _frame(self, plan: Plan, d, minutes: int) -> tuple[ShadeFrame, dict]:
        base = self.shade.frame(d, minutes)
        empty = {"type": "FeatureCollection", "features": []}
        if base.shadows is None or not plan.changes_shade:
            return base, empty
        ck = (plan.key, d, minutes)
        with self._lock:
            if ck in self._frames:
                return self._frames[ck]
        dx, dy = shadow_vector(base.azimuth, base.elevation)
        new = []
        if len(plan.tree_xy):
            cx = plan.tree_xy[:, 0] + dx * plan.tree_h
            cy = plan.tree_xy[:, 1] + dy * plan.tree_h
            new.extend(shapely.buffer(shapely.points(cx, cy), plan.tree_r, quad_segs=4))
        for poly, h in plan.canopies:
            new.append(affinity.translate(poly, dx * h, dy * h))
        inside = base.inside.copy()
        touched = []
        if len(plan.removed):
            gone_idx = self.shade.n_building_shadows + plan.removed
            cand = self._samples_in(base.shadows[gone_idx])
            if len(cand):
                ip, ig = base.tree.query(self.shade._sample_pts[cand], predicate="intersects")
                keep = ~np.isin(ig, gone_idx)
                inside[cand] = False
                inside[cand[ip[keep]]] = True
                touched.append(cand)
        if new:
            hits = self._samples_in(np.array(new, dtype=object))
            inside[hits] = True
            touched.append(hits)
        es, best, gain = self.shade.edge_fractions(inside)
        f = ShadeFrame(d, minutes, base.azimuth, base.elevation, base.shadows, es, best, gain, inside=inside)
        gj = empty
        if new:
            u = shapely.union_all(np.array(new, dtype=object))
            gj = {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {}, "geometry": geom_to_geojson(u)}]}
        with self._lock:
            self._frames[ck] = (f, gj)
            if len(self._frames) > 300:
                self._frames.pop(next(iter(self._frames)))
        return f, gj

    # ------------------------------------------------------------------ before / after
    def compare(self, lumen, plan: Plan, scenario: str, minutes: int) -> dict:
        ck = (plan.key, scenario, minutes)
        with self._lock:
            if ck in self._compare:
                return self._compare[ck]
        out = _compare(lumen, self, plan, scenario, minutes)
        with self._lock:
            self._compare[ck] = out
            if len(self._compare) > 300:
                self._compare.pop(next(iter(self._compare)))
        return out

    def base_trips(self, lumen, scenario: str, minutes: int) -> dict:
        """Shortest and coolest path of every station -> workplace trip under base conditions (cached)."""
        ck = (scenario, minutes)
        with self._lock:
            if ck in self._base_trips:
                return self._base_trips[ck]
        from .evaluate import ORIGINS
        from .router import comfort

        cond = lumen.conditions(scenario, minutes)
        ce = comfort(cond)
        r = lumen.router
        out = {}
        for oid in ORIGINS:
            src = next(s["node"] for s in lumen.p.stops if s["id"] == oid)
            for mode in ("shortest", "coolest"):
                paths = r.paths_from(src, r.weights(mode, cond))
                for o in lumen.p.offices:
                    if o["node"] == src:
                        continue
                    nodes = paths[o["node"]]
                    out[(oid, o["id"], mode)] = {"nodes": nodes, **r.path_stats(nodes, cond, ce)}
        with self._lock:
            self._base_trips[ck] = out
        return out


def _person_weights(lumen) -> dict[tuple[str, str], float]:
    """Workers per (origin, workplace) if everyone walked from the four evaluation stops (model estimate)."""
    from .crowd import STOP_SHARE, WORKERS
    from .evaluate import ORIGINS

    shares = {o: STOP_SHARE.get(o, 0.02) for o in ORIGINS}
    tot_s = sum(shares.values())
    tot_a = sum(o["floor_area"] for o in lumen.p.offices)
    return {(oid, o["id"]): WORKERS * shares[oid] / tot_s * o["floor_area"] / tot_a
            for oid in ORIGINS for o in lumen.p.offices}


def _compare(lumen, wi: WhatIf, plan: Plan, scenario: str, minutes: int) -> dict:
    from .engine import fmt_time
    from .evaluate import ORIGINS
    from .router import comfort, heat_factor

    t0 = time.time()
    p, r = lumen.p, lumen.router
    c0 = lumen.conditions(scenario, minutes)
    c1 = lumen.conditions(scenario, minutes, plan=plan)
    sun_up = c0.shade.sun_up
    d_shade = (c1.shade.edge_shade - c0.shade.edge_shade) if sun_up else np.zeros(len(p.e_len))
    changed = np.abs(d_shade) > 0.01
    closed = plan.closed if plan.closed is not None else np.zeros(len(p.e_len), dtype=bool)
    touched = changed | closed
    ce0, ce1 = comfort(c0), comfort(c1)
    # precinct figures use the same segments before and after; closures only show up in the trips
    m, L = lumen.in_cremorne, p.e_len

    base = wi.base_trips(lumen, scenario, minutes)
    persons = _person_weights(lumen)
    names = {s["id"]: s["name"] for s in p.stops}
    rows, affected_pairs = [], set()
    per_mode = {}
    for mode in ("shortest", "coolest"):
        w1 = r.weights(mode, c1)
        agg = {"sun_before": 0.0, "sun_after": 0.0, "min_before": 0.0, "min_after": 0.0,
               "comfort_before": [], "comfort_after": [], "saved": [], "detours": [], "unreachable": 0,
               "person_sun_saved": 0.0}
        # the shortest route only moves when something is closed; the coolest one moves with shade too
        reroute = plan.closed is not None or (mode == "coolest" and plan.changes_shade)
        for oid in ORIGINS:
            src = next(s["node"] for s in p.stops if s["id"] == oid)
            paths1 = r.paths_from(src, w1) if reroute else None
            for o in p.offices:
                b = base.get((oid, o["id"], mode))
                if b is None:
                    continue
                need = bool(len(b["edges"])) and bool(touched[b["edges"]].any())
                nodes1 = paths1.get(o["node"]) if paths1 is not None else b["nodes"]
                if nodes1 is None:
                    agg["unreachable"] += 1
                    continue
                if not need and nodes1 == b["nodes"]:
                    a = b  # untouched trip: identical before and after, nothing to recompute
                else:
                    a = r.path_stats(nodes1, c1, ce1)
                    affected_pairs.add((oid, o["id"]))
                agg["sun_before"] += b["sun_minutes"]; agg["sun_after"] += a["sun_minutes"]
                agg["min_before"] += b["minutes"]; agg["min_after"] += a["minutes"]
                agg["comfort_before"].append(b["comfort"]); agg["comfort_after"].append(a["comfort"])
                saved = b["sun_minutes"] - a["sun_minutes"]
                agg["saved"].append(saved)
                agg["detours"].append(a["minutes"] - b["minutes"])
                agg["person_sun_saved"] += persons[(oid, o["id"])] * saved
                if a is not b and (abs(saved) > 0.01 or abs(a["minutes"] - b["minutes"]) > 0.01):
                    rows.append({
                        "origin": names[oid], "destination": o["name"] or f"{o['street'] or 'Office'} building",
                        "dest_id": o["id"], "origin_id": oid, "route": "usual (shortest)" if mode == "shortest" else "Lumen coolest",
                        "minutes_before": round(b["minutes"], 2), "minutes_after": round(a["minutes"], 2),
                        "sun_min_before": round(b["sun_minutes"], 2), "sun_min_after": round(a["sun_minutes"], 2),
                        "comfort_before": round(b["comfort"], 1), "comfort_after": round(a["comfort"], 1),
                    })
        n = len(agg["saved"])
        benefit = [s for s in agg["saved"] if s > 0.1]
        worse = [s for s in agg["saved"] if s < -0.1]
        detoured = [d for d in agg["detours"] if d > 0.05]
        per_mode[mode] = {
            "trips": n,
            "sun_min": [round(agg["sun_before"], 1), round(agg["sun_after"], 1)],
            "sun_min_saved": round(agg["sun_before"] - agg["sun_after"], 1),
            "sun_saved_pct": round(100 * (agg["sun_before"] - agg["sun_after"]) / agg["sun_before"], 1) if agg["sun_before"] > 0 else 0.0,
            "walk_min": [round(agg["min_before"], 1), round(agg["min_after"], 1)],
            "comfort": [round(statistics.fmean(agg["comfort_before"]), 1) if n else 0,
                        round(statistics.fmean(agg["comfort_after"]), 1) if n else 0],
            "trips_benefit": len(benefit),
            "trips_worse": len(worse),
            "median_saved_benefit": round(statistics.median(benefit), 2) if benefit else 0.0,
            "trips_detoured": len(detoured),
            "median_detour_min": round(statistics.median(detoured), 2) if detoured else 0.0,
            "unreachable": agg["unreachable"],
            "person_sun_min_saved": round(agg["person_sun_saved"]),
        }

    # routes that benefit, whichever way people walk
    benefit_pairs = {(x["origin_id"], x["dest_id"]) for x in rows if x["sun_min_before"] - x["sun_min_after"] > 0.1}
    top = sorted(rows, key=lambda x: x["sun_min_after"] - x["sun_min_before"])[:6]
    sh0 = float(np.average(c0.shade.edge_shade[m], weights=L[m])) if sun_up else 1.0
    sh1 = float(np.average(c1.shade.edge_shade[m], weights=L[m])) if sun_up else 1.0
    sunlit0 = float((L[m] * c0.sun[m]).sum()) / 1000
    sunlit1 = float((L[m] * c1.sun[m]).sum()) / 1000
    idx = np.nonzero(changed)[0]
    sc = lumen.scenario(scenario)
    cost = plan_cost(plan.items)
    saved = per_mode["shortest"]["person_sun_min_saved"]
    n_benefit = len(benefit_pairs)
    cost["value"] = {
        # value for money at this moment: shade bought per A$10k, and A$ per station -> workplace route improved
        "person_min_per_10k": round(10_000 * saved / cost["mid"], 1) if cost["mid"] > 0 else None,
        "aud_per_route_improved": round(cost["mid"] / n_benefit) if n_benefit and cost["mid"] > 0 else None,
    }
    return {
        "key": plan.key,
        "cost": cost,
        "scenario": scenario, "minutes": minutes, "time": fmt_time(minutes),
        "temp_c": round(c0.temp_c, 1), "sun_up": sun_up, "heat_matters": heat_factor(c0.temp_c) > 0,
        "precinct": {
            "shaded_share": [round(sh0, 4), round(sh1, 4)],
            "comfort": [round(float(np.average(ce0[m], weights=L[m])), 1), round(float(np.average(ce1[m], weights=L[m])), 1)],
            "sunlit_km": [round(sunlit0, 3), round(sunlit1, 3)],
        },
        "edges": {
            "changed": [[int(i), round(float(d_shade[i]), 3)] for i in idx],
            "closed": [int(i) for i in np.nonzero(closed)[0]],
        },
        "affected_edges": int(len(idx) + closed.sum()),
        "trips_total": per_mode["shortest"]["trips"] + per_mode["shortest"]["unreachable"],
        "trips_recomputed": len(affected_pairs),
        "trips_benefit": len(benefit_pairs),
        "usual": per_mode["shortest"],
        "coolest": per_mode["coolest"],
        "top": top,
        "rows": rows,
        "new_shadows": wi.new_shadows_geojson(plan, sc["date"], minutes),
        "compute_ms": round(1000 * (time.time() - t0)),
    }


# ---------------------------------------------------------------------- saved plans
def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:40] or "plan"


def list_saved() -> list[dict]:
    if not STORE.exists():
        return []
    out = []
    for f in sorted(STORE.glob("*.json")):
        try:
            out.append(json.loads(f.read_text(encoding="utf-8")))
        except Exception:
            continue
    return sorted(out, key=lambda d: d.get("created", 0))


def save(name: str, raw: dict, note: str = "") -> dict:
    STORE.mkdir(parents=True, exist_ok=True)
    pid = f"{_slug(name)}-{uuid.uuid4().hex[:6]}"
    doc = {"id": pid, "name": name.strip()[:80] or "Untitled plan", "note": note[:500], "created": time.time(),
           "years": raw.get("years", 1), "items": raw.get("items", [])}
    (STORE / f"{pid}.json").write_text(json.dumps(doc, indent=1), encoding="utf-8")
    return doc


def load_saved(pid: str) -> dict | None:
    if not re.fullmatch(r"[a-z0-9-]+", pid):
        return None
    f = STORE / f"{pid}.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else None


def delete_saved(pid: str) -> bool:
    if not re.fullmatch(r"[a-z0-9-]+", pid):
        return False
    f = STORE / f"{pid}.json"
    if f.exists():
        f.unlink()
        return True
    return False


def summary_items(items: list[dict]) -> dict[str, int]:
    out: dict[str, int] = {}
    for it in items:
        out[it["kind"]] = out.get(it["kind"], 0) + 1
    return out
