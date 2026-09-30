"""Nearby in N minutes: places you can walk to, use and get back from inside a time budget.

    walk out + time there + walk on  <=  budget

* walk on: back to where you started ("return"), on to where you were going ("via"), or nothing
  ("oneway").
* time there: an errand has a fixed estimate (a coffee ~3 min, longer in the morning rush). A rest
  stop gets whatever the budget leaves, and is ranked by how much of that time you can sit in the
  shade away from crowds, which is the part a normal map can't tell you.

Every leg is routed three ways (shortest / coolest / calmest) and the fastest-feeling one that fits
is kept, so on a hot day the walk out is shady too.

Places are OpenStreetMap POIs (data/raw/pois.json). Opening hours come from OSM when mapped;
otherwise a typical window for that kind of place is assumed and the result says so.
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field

import numpy as np
import shapely
from shapely.geometry import Point, Polygon

from .crowd import LOS_LETTERS, activity
from .engine import Lumen, fmt_time
from .geo import ring_to_lonlat, to_lonlat, to_xy
from .precinct import RAW
from .router import MODES, NIGHT_START, WALK_SPEED, comfort, heat_factor

SHAPES = ("return", "via", "oneway")
PREFER = {"auto": (1.5, 2.0), "shortest": (0.0, 0.0), "coolest": (4.0, 0.5), "calmest": (0.5, 4.0)}  # (sun, crowd) weights
MIN_STAY = 5.0          # a rest stop is only worth it with at least this long sitting down
MAX_ACCESS = 120.0      # m from the POI to the walking network; further means it's off our map
SEAT_CLUSTER = 25.0     # m: benches closer than this are one "place to sit"
PARK_SAMPLE = 9.0       # m between shade samples inside a park
PARK_SHADE_M2 = 80.0    # m² of shade in a park that counts as "plenty to sit in"
UNKNOWN_HOURS_PENALTY = 1.5  # minutes added to the rank of a place whose hours we had to assume

CATEGORIES: dict[str, dict] = {
    "coffee": {"noun": ("café", "cafés"), "label": "Coffee", "kind": "errand", "verb": "to order", "dwell": 3.0, "queue": True,
               "tags": {"amenity": {"cafe"}, "shop": {"coffee"}}},
    "bite": {"noun": ("food stop", "food stops"), "label": "Quick bite", "kind": "errand", "verb": "to grab", "dwell": 5.0, "queue": True,
             "tags": {"amenity": {"fast_food", "ice_cream"}, "shop": {"bakery", "deli"}}},
    "lunch": {"noun": ("lunch place", "lunch places"), "label": "Sit-down lunch", "kind": "errand", "verb": "to eat", "dwell": 25.0, "queue": False,
              "tags": {"amenity": {"restaurant", "pub", "cafe"}}},
    "rest": {"noun": ("rest spot", "rest spots"), "label": "Shady rest", "kind": "stay", "verb": "to sit",
             "tags": {"leisure": {"park", "garden", "picnic_table"}, "amenity": {"bench", "shelter"}}},
    "groceries": {"noun": ("shop", "shops"), "label": "Groceries", "kind": "errand", "verb": "to shop", "dwell": 4.0, "queue": True,
                  "tags": {"shop": {"convenience", "supermarket"}}},
    "pharmacy": {"noun": ("pharmacy", "pharmacies"), "label": "Pharmacy", "kind": "errand", "verb": "inside", "dwell": 5.0, "queue": True,
                 "tags": {"amenity": {"pharmacy"}, "shop": {"chemist"}}},
    "cash": {"noun": ("ATM", "ATMs"), "label": "Cash", "kind": "errand", "verb": "at the ATM", "dwell": 2.0, "queue": False,
             "tags": {"amenity": {"atm", "bank"}}},
    "toilets": {"noun": ("toilet", "toilets"), "label": "Toilets", "kind": "errand", "verb": "", "dwell": 3.0, "queue": False,
                "tags": {"amenity": {"toilets"}}},
    "water": {"noun": ("water fountain", "water fountains"), "label": "Water refill", "kind": "errand", "verb": "to refill", "dwell": 1.0, "queue": False,
              "tags": {"amenity": {"drinking_water"}}},
}
DWELL_BY_TAG = {"supermarket": 8.0, "bank": 6.0, "pub": 30.0}
TYPE_LABEL = {
    "cafe": "Café", "coffee": "Coffee shop", "fast_food": "Takeaway", "ice_cream": "Ice cream", "bakery": "Bakery",
    "deli": "Deli", "restaurant": "Restaurant", "pub": "Pub", "convenience": "Corner store", "supermarket": "Supermarket",
    "pharmacy": "Pharmacy", "chemist": "Chemist", "atm": "ATM", "bank": "Bank", "toilets": "Public toilets",
    "drinking_water": "Drinking fountain", "park": "Park", "garden": "Garden", "bench": "Bench",
    "picnic_table": "Picnic table", "shelter": "Shelter",
}
# Typical weekday hours (minutes) when OSM has none: Cremorne cafés are breakfast-and-lunch places.
TYPICAL = {
    "cafe": [(420, 900)], "coffee": [(420, 900)], "bakery": [(420, 960)], "deli": [(480, 1020)],
    "fast_food": [(660, 1260)], "ice_cream": [(720, 1320)], "restaurant": [(720, 900), (1050, 1320)],
    "pub": [(720, 1380)], "convenience": [(420, 1320)], "supermarket": [(420, 1320)], "pharmacy": [(540, 1080)],
    "chemist": [(540, 1080)], "bank": [(570, 960)],
}
WEEKDAY_ONLY = {"bank"}
DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]


# ---------------------------------------------------------------------- opening hours
_DAY = r"(?:Mo|Tu|We|Th|Fr|Sa|Su)"
_DAYSPEC = rf"{_DAY}(?:\s*-\s*{_DAY})?(?:\s*,\s*{_DAY}(?:\s*-\s*{_DAY})?)*"
_TIME = r"\d{1,2}:\d{2}(?:\s*-\s*\d{1,2}:\d{2})?\+?"
_RULE = re.compile(rf"(?:({_DAYSPEC})\s+)?((?:{_TIME})(?:\s*,\s*{_TIME})*|off|closed)")
_SKIP = re.compile(r"\b(PH|SH|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|week)\b")


def _days(spec: str) -> list[int]:
    out = []
    for part in re.split(r"\s*,\s*", spec):
        ends = [DAYS.index(d) for d in re.findall(_DAY, part)]
        if len(ends) == 2:
            a, b = ends
            out += [(a + i) % 7 for i in range((b - a) % 7 + 1)]
        elif ends:
            out.append(ends[0])
    return out


def _span(t: str) -> tuple[int, int]:
    nums = [int(h) * 60 + int(m) for h, m in re.findall(r"(\d{1,2}):(\d{2})", t)]
    a = nums[0]
    b = nums[1] if len(nums) > 1 else 1440  # "11:00+" = open-ended
    if b <= a:
        b += 1440  # past midnight
    return a, b


def parse_hours(text: str | None) -> list[list[tuple[int, int]]] | None:
    """OSM opening_hours -> seven lists (Mo..Su) of (open, close) minutes, close may pass 1440.

    Covers the forms mapped in Cremorne ("Mo-Fr 07:00-15:00; Sa 08:00-14:00", "We,Th 16:00-23:00+",
    "24/7"); public-holiday and month rules are ignored. None when nothing could be read."""
    if not text:
        return None
    s = text.strip()
    if s == "24/7":
        return [[(0, 1440)] for _ in range(7)]
    week: list[list[tuple[int, int]] | None] = [None] * 7
    found = False
    for part in s.split(";"):
        part = part.strip()
        if not part or _SKIP.search(part):
            continue
        for m in _RULE.finditer(part):
            days = _days(m.group(1)) if m.group(1) else list(range(7))
            spans = [] if m.group(2) in ("off", "closed") else [_span(t) for t in re.findall(_TIME, m.group(2))]
            for d in days:
                week[d] = spans  # a later rule replaces an earlier one for the days it names
            found = True
    return [w or [] for w in week] if found else None


def _open_until(week: list[list[tuple[int, int]]], day: int, t: float) -> float | None:
    """Closing time (minutes from today's midnight) if open at t, else None."""
    for a, b in week[day]:
        if a <= t < b:
            return b
    for a, b in week[(day - 1) % 7]:
        if b > 1440 and t < b - 1440:
            return b - 1440
    return None


def _opens_next(week: list[list[tuple[int, int]]], day: int, t: float) -> int | None:
    later = [a for a, _ in week[day] if a > t]
    return min(later) if later else None


# ---------------------------------------------------------------------- places
@dataclass
class Place:
    id: str
    name: str
    named: bool
    tag: str                 # OSM value: cafe, bench, park ...
    cats: set[str]
    x: float
    y: float
    lon: float
    lat: float
    entries: list[tuple[int, float]]  # (graph node, metres from the place to that node)
    edge: int                # nearest path segment (crowding at the door)
    address: str
    hours_text: str | None = None
    hours: list | None = None
    poly: Polygon | None = None
    seats: int = 0
    covered: bool = False
    samples: slice = field(default_factory=lambda: slice(0, 0))  # rows of Places.sample_xy


class Places:
    """Every POI in the precinct, snapped to the walking network. Built once per engine."""

    def __init__(self, lumen: Lumen):
        self.lumen = lumen
        p = lumen.p
        self._edge_tree = shapely.STRtree([shapely.LineString(c) for c in p.e_coords])
        self._streets = shapely.STRtree([g for _, g in p.street_lines])
        self._node_pts = shapely.points(p.node_arr)
        raw = json.loads((RAW / "pois.json").read_text(encoding="utf-8"))["elements"] if (RAW / "pois.json").exists() else []
        areas, points, seats = [], [], []
        for e in raw:
            t = e.get("tags", {})
            tag = t.get("amenity") or t.get("shop") or t.get("leisure")
            if not tag or t.get("access") in ("private", "no", "customers") and tag not in ("cafe", "restaurant"):
                continue
            geom = self._geometry(e)
            if geom is None:
                continue
            if tag in ("park", "garden"):
                if geom.geom_type != "Polygon" and geom.geom_type != "MultiPolygon":
                    continue
                if tag == "garden" and not t.get("name"):
                    continue  # unnamed "gardens" in OSM are mostly private landscaping
                if geom.area < 300:
                    continue
                areas.append((e, t, tag, geom))
            elif tag in ("bench", "picnic_table", "shelter"):
                seats.append((t, tag, geom.centroid))
            else:
                points.append((e, t, tag, geom.centroid))
        self.items: list[Place] = []
        self._build_areas(areas)
        self._build_points(points)
        self._build_seats(seats)
        self._disambiguate()
        self._build_samples()

    # -------------------------------------------------------------- geometry helpers
    @staticmethod
    def _geometry(e: dict):
        if e["type"] == "node":
            x, y = to_xy(e["lon"], e["lat"])
            return Point(float(x), float(y))
        rings = []
        if e["type"] == "way":
            rings = [e.get("geometry") or []]
        else:
            rings = [m.get("geometry") or [] for m in e.get("members", []) if m.get("role") == "outer"]
        polys, pts = [], []
        for g in rings:
            if len(g) < 2:
                continue
            x, y = to_xy([q["lon"] for q in g], [q["lat"] for q in g])
            xy = np.column_stack([x, y])
            pts.append(xy)
            if len(g) >= 4 and g[0] == g[-1]:
                poly = Polygon(xy)
                if not poly.is_valid:
                    poly = poly.buffer(0)
                if not poly.is_empty:
                    polys.append(poly)
        if polys:
            u = shapely.union_all(polys)
            if u.geom_type == "MultiPolygon":
                u = max(u.geoms, key=lambda g: g.area)
            return u if u.geom_type == "Polygon" else None
        if pts:
            c = np.concatenate(pts).mean(axis=0)
            return Point(float(c[0]), float(c[1]))
        return None

    def _street_at(self, x: float, y: float) -> str:
        """The street a point is on, for places OSM didn't name."""
        pt = Point(x, y)
        i = self._edge_tree.nearest(pt)
        label = self.lumen.labels[int(i)] if i is not None else ""
        if label and label not in ("laneway", "crossing", "footpath", "path"):
            return label
        j = self._streets.nearest(pt)
        if j is not None and self.lumen.p.street_lines[int(j)][1].distance(pt) < 80:
            return self.lumen.p.street_lines[int(j)][0]
        return "the laneway"

    def _snap(self, x: float, y: float) -> tuple[list[tuple[int, float]], int]:
        p = self.lumen.p
        node = p.nearest_node(x, y)
        nx_, ny_ = p.node_xy[node]
        edge = int(self._edge_tree.nearest(Point(x, y)))
        return [(node, math.hypot(nx_ - x, ny_ - y))], edge

    @staticmethod
    def _short(street: str) -> str:
        return street.replace(" Street", " St").replace(" Road", " Rd").replace(" Parade", " Pde").replace(" Avenue", " Ave")

    def _add(self, **kw) -> Place:
        lon, lat = to_lonlat(kw["x"], kw["y"])
        pl = Place(lon=round(float(lon), 6), lat=round(float(lat), 6), **kw)
        self.items.append(pl)
        return pl

    @staticmethod
    def _cats(tag: str) -> set[str]:
        return {k for k, c in CATEGORIES.items() if any(tag in v for v in c["tags"].values())}

    # -------------------------------------------------------------- builders
    def _build_areas(self, areas):
        p = self.lumen.p
        # named first, then bigger: an unnamed lawn inside a named park is the same place
        areas.sort(key=lambda a: (not a[1].get("name"), -a[3].area))
        kept: list[Polygon] = []
        for e, t, tag, poly in areas:
            if any(k.intersection(poly).area > 0.5 * poly.area for k in kept):
                continue
            inside = np.nonzero(shapely.contains_xy(poly.buffer(8), p.node_arr[:, 0], p.node_arr[:, 1]))[0]
            if len(inside):
                entries = [(int(p.node_ids[i]), 0.0) for i in inside]
            else:
                d = shapely.distance(poly, self._node_pts)
                i = int(np.argmin(d))
                if d[i] > MAX_ACCESS:
                    continue
                entries = [(int(p.node_ids[i]), float(d[i]))]
            kept.append(poly)
            c = poly.representative_point()
            street = self._street_at(c.x, c.y)
            name = t.get("name") or f"Pocket park off {self._short(street)}"
            self._add(id=f"{e['type'][0]}{e['id']}", name=name, named=bool(t.get("name")), tag="park",
                      cats=self._cats(tag), x=c.x, y=c.y, entries=entries,
                      edge=int(self._edge_tree.nearest(c)), address=f"{round(poly.area / 100) * 100:,.0f} m² of green",
                      poly=poly)

    def _build_points(self, points):
        seen: dict[tuple[str, str], list[tuple[float, float]]] = {}
        # places with hours (or more tags) first, so duplicates keep the better record
        points.sort(key=lambda q: (not q[1].get("opening_hours"), -len(q[1])))
        for e, t, tag, pt in points:
            entries, edge = self._snap(pt.x, pt.y)
            if entries[0][1] > MAX_ACCESS:
                continue
            name = t.get("name") or t.get("brand")
            key = (re.sub(r"[^a-z0-9]|\bthe\b|hotel", "", (name or "").lower()), tag)
            if name and any(math.hypot(pt.x - a, pt.y - b) < 80 for a, b in seen.get(key, [])):
                continue
            seen.setdefault(key, []).append((pt.x, pt.y))
            street = t.get("addr:street") or self._street_at(pt.x, pt.y)
            num = t.get("addr:housenumber")
            addr = f"{num} {self._short(street)}" if num else f"on {self._short(street)}"
            pl = self._add(id=f"{e['type'][0]}{e['id']}", name=name or f"{TYPE_LABEL.get(tag, tag.title())}, {self._short(street)}",
                           named=bool(name), tag=tag, cats=self._cats(tag), x=pt.x, y=pt.y, entries=entries, edge=edge,
                           address=addr, hours_text=t.get("opening_hours"))
            pl.hours = parse_hours(pl.hours_text)

    def _build_seats(self, seats):
        parks = [pl for pl in self.items if pl.poly is not None]
        loose: list[dict] = []
        for t, tag, pt in seats:
            host = next((pk for pk in parks if pk.poly.buffer(5).contains(pt)), None)
            if host:
                host.seats += 1
                host.covered |= tag == "shelter"
                continue
            c = next((c for c in loose if math.hypot(c["x"] - pt.x, c["y"] - pt.y) < SEAT_CLUSTER), None)
            if c is None:
                c = {"x": pt.x, "y": pt.y, "n": 0, "tags": set()}
                loose.append(c)
            c["n"] += 1
            c["tags"].add(tag)
        for i, c in enumerate(loose):
            entries, edge = self._snap(c["x"], c["y"])
            if entries[0][1] > MAX_ACCESS:
                continue
            tag = next(k for k in ("shelter", "picnic_table", "bench") if k in c["tags"])
            street = self._street_at(c["x"], c["y"])
            what = {"shelter": "Covered seat", "picnic_table": "Picnic table", "bench": "Bench" if c["n"] == 1 else "Benches"}[tag]
            near = self._landmark(c["x"], c["y"])
            pl = self._add(id=f"seat{i}", name=f"{what} by {near}" if near else f"{what}, {self._short(street)}", named=False,
                           tag=tag, cats={"rest"},
                           x=c["x"], y=c["y"], entries=entries, edge=edge,
                           address=f"{c['n']} seat{'s' if c['n'] > 1 else ''} on {self._short(street)}")
            pl.seats = c["n"]
            pl.covered = tag == "shelter"

    def _disambiguate(self):
        """Two "Bench by Crop"s become "... (north)" and "... (south)"."""
        groups: dict[str, list[Place]] = {}
        for pl in self.items:
            groups.setdefault(pl.name, []).append(pl)
        for name, same in groups.items():
            if len(same) < 2:
                continue
            xs, ys = [q.x for q in same], [q.y for q in same]
            ns = max(ys) - min(ys) >= max(xs) - min(xs)
            same.sort(key=lambda q: -q.y if ns else q.x)
            words = (["north", "middle", "south"] if ns else ["west", "middle", "east"]) if len(same) == 3 else                 (["north", "south"] if ns else ["west", "east"]) if len(same) == 2 else [str(i + 1) for i in range(len(same))]
            for q, w in zip(same, words):
                q.name = f"{name} ({w})"

    def _landmark(self, x: float, y: float, within: float = 60.0) -> str | None:
        """Closest named shop, café or park, so a bench reads "Bench by Baker Bleu" instead of a street."""
        best = None
        for pl in self.items:
            if not pl.named or pl.tag in ("atm", "toilets", "drinking_water"):
                continue
            d = pl.poly.distance(Point(x, y)) if pl.poly is not None else math.hypot(pl.x - x, pl.y - y)
            if d < within and (best is None or d < best[0]):
                best = (d, pl.name)
        return best[1] if best else None

    def _build_samples(self):
        """Shade sample points: a grid inside each park, the spot itself for everything else."""
        xs, ys = [], []
        for pl in self.items:
            if "rest" not in pl.cats:
                continue
            start = len(xs)
            if pl.poly is not None:
                minx, miny, maxx, maxy = pl.poly.bounds
                step = max(PARK_SAMPLE, math.sqrt(pl.poly.area / 80))
                gx, gy = np.meshgrid(np.arange(minx + step / 2, maxx, step), np.arange(miny + step / 2, maxy, step))
                gx, gy = gx.ravel(), gy.ravel()
                ok = shapely.contains_xy(pl.poly, gx, gy)
                gx, gy = gx[ok], gy[ok]
                if not len(gx):
                    c = pl.poly.representative_point()
                    gx, gy = np.array([c.x]), np.array([c.y])
                xs.extend(gx); ys.extend(gy)
            else:
                xs.append(pl.x); ys.append(pl.y)
            pl.samples = slice(start, len(xs))
        self.sample_pts = shapely.points(np.array(xs), np.array(ys)) if xs else np.array([])

    def of(self, want: str) -> list[Place]:
        return [pl for pl in self.items if want in pl.cats]

    def counts(self) -> dict[str, int]:
        return {k: len(self.of(k)) for k in CATEGORIES}


def places(lumen: Lumen) -> Places:
    if getattr(lumen, "_places", None) is None:
        lumen._places = Places(lumen)
    return lumen._places


def categories(lumen: Lumen) -> list[dict]:
    n = places(lumen).counts()
    return [{"key": k, "label": c["label"], "kind": c["kind"], "count": n[k],
             "dwell": c.get("dwell")} for k, c in CATEGORIES.items()]


# ---------------------------------------------------------------------- the search
def _q15(t: float) -> int:
    return int(15 * round(t / 15))


def _hours(pl: Place, day: int, arrive: float, leave: float) -> dict:
    """Open state for a visit from `arrive` to `leave` (minutes)."""
    if pl.tag not in TYPICAL:
        return {"state": "always", "text": None, "closes": None, "opens": None}
    week = pl.hours
    assumed = week is None
    if assumed:
        spans = [] if pl.tag in WEEKDAY_ONLY and day >= 5 else TYPICAL[pl.tag]
        week = [spans] * 7
    close = _open_until(week, day, arrive)
    if close is None or close < leave - 0.01:
        nxt = _opens_next(week, day, arrive)
        return {"state": "closed", "assumed": assumed, "closes": None, "opens": nxt,
                "text": (f"Opens {fmt_time(nxt)}" if nxt is not None else "Closed today") if close is None
                else f"Closes {fmt_time(close % 1440)}, too soon"}
    text = "Open 24 hours" if close - arrive >= 1439 else f"Open till {fmt_time(close % 1440)}"
    return {"state": "assumed_open" if assumed else "open", "assumed": assumed, "closes": close % 1440, "opens": None,
            "text": "Hours not listed, usually open now" if assumed else text}


def _coords(nodes: list[int], p) -> list[list[float]]:
    return ring_to_lonlat([p.node_xy[n] for n in nodes]) if len(nodes) > 1 else []


def nearby(lumen: Lumen, want: str, origin: str, dest: str | None = None, shape: str = "return",
           budget: float = 10.0, minutes: int = 750, scenario: str = "hot", prefer: str = "auto", limit: int = 6) -> dict:
    if want not in CATEGORIES:
        raise KeyError(want)
    shape = shape if shape in SHAPES else "return"
    if shape == "via" and not dest:
        shape = "return"
    prefer = prefer if prefer in PREFER else "auto"
    cat = CATEGORIES[want]
    stay = cat["kind"] == "stay"
    ws, wc = PREFER[prefer]
    budget = float(max(1.0, min(120.0, budget)))
    P = places(lumen)
    p, r = lumen.p, lumen.router
    sc = lumen.scenario(scenario)
    day = sc["date"].weekday()

    a, a_name = lumen.resolve(origin)
    b, b_name = (lumen.resolve(dest) if shape == "via" else (a, a_name) if shape == "return" else (None, None))
    cond1 = lumen.conditions(scenario, minutes, shade_minutes=_q15(minutes))
    t2 = minutes + budget * 0.5
    cond2 = cond1 if abs(t2 - minutes) < 8 else lumen.conditions(scenario, int(t2), shade_minutes=_q15(t2))
    ce1, ce2 = comfort(cond1), comfort(cond2)
    h = min(1.0, heat_factor(cond1.temp_c)) if cond1.shade.sun_up else 0.0
    night = minutes >= NIGHT_START or not cond1.shade.sun_up

    out = {m: r.tree_from(a, r.weights(m, cond1)) for m in MODES}
    back = {m: r.tree_from(b, r.weights(m, cond2)) for m in MODES} if b is not None else None
    dist_out = out["shortest"][0]
    dist_back = back["shortest"][0] if back else None
    direct = None
    if shape == "via":
        direct = r.path_stats(out["shortest"][1][b], cond1, ce1)["minutes"]

    counts = {"places": 0, "closed": 0, "too_far": 0, "fit": 0}
    need = math.inf
    cands = []
    for pl in P.of(want):
        counts["places"] += 1
        # the entrance that makes the whole trip shortest (parks have many)
        best = None
        for node, acc in pl.entries:
            if node not in dist_out or (dist_back is not None and node not in dist_back):
                continue
            legs = 2 if back else 1
            m = dist_out[node] + (dist_back[node] if dist_back is not None else 0.0) + legs * acc
            if best is None or m < best[0]:
                best = (m, node, acc)
        if best is None:
            continue
        min_walk = best[0] / WALK_SPEED / 60
        node, acc = best[1], best[2]
        acc_min = acc / WALK_SPEED / 60
        arrive0 = minutes + dist_out[node] / WALK_SPEED / 60 + acc_min
        if stay:
            dwell = MIN_STAY
        else:
            dwell = DWELL_BY_TAG.get(pl.tag, cat["dwell"])
            if cat["queue"]:
                dwell = round(2 * dwell * (0.6 + 0.8 * activity(arrive0))) / 2  # queues follow the precinct's rush hours
        hrs = _hours(pl, day, arrive0, arrive0 + dwell)
        if hrs["state"] == "closed":
            counts["closed"] += 1
            continue
        if min_walk + dwell > budget + 1e-6:
            counts["too_far"] += 1
            need = min(need, min_walk + dwell)
            continue
        cands.append((pl, node, acc_min, dwell, hrs))

    # route every leg three ways and keep the best-feeling one that still fits
    results = []
    for pl, node, acc_min, dwell, hrs in cands:
        pick, opts = None, {}
        for m in MODES:
            so = r.path_stats(out[m][1][node], cond1, ce1)
            bn = back[m][1][node][::-1] if back else [node]
            sb = r.path_stats(bn, cond2, ce2)
            legs = 2 if back else 1
            walk = so["minutes"] + sb["minutes"] + legs * acc_min
            if walk + (MIN_STAY if stay else dwell) > budget + 1e-6:
                continue
            sun = so["sun_minutes"] + sb["sun_minutes"]
            crowd = so["crowded_minutes"] + sb["crowded_minutes"]
            feel = walk + ws * h * sun + wc * crowd
            opts[m] = {"mode": m, "so": so, "sb": sb, "out": out[m][1][node], "back": bn, "walk": walk,
                       "sun": sun, "crowd": crowd, "feel": feel}
            if pick is None or feel < pick["feel"] - 1e-9:
                pick = opts[m]
        if pick is None:
            continue
        pick["opts"] = opts  # every way that fits, so the walker can choose
        counts["fit"] += 1
        results.append((pl, node, acc_min, dwell, hrs, pick))

    spot = _spot_shade(lumen, P, sc["date"], minutes, results, budget) if stay else {}
    ranked = []
    def walk_fields(pk: dict, acc_min: float, dwell: float) -> dict:
        """Everything about a place's result that depends on which way you walk."""
        so, sb = pk["so"], pk["sb"]
        walk_out = so["minutes"] + acc_min
        walk_back = (sb["minutes"] + acc_min) if back else 0.0
        stay_min = float(math.floor(budget - pk["walk"])) if stay else None  # whole minutes; the rest is spare
        there = stay_min if stay else dwell
        total = pk["walk"] + there
        return {
            "mode": pk["mode"], "route_label": MODES[pk["mode"]]["label"],
            "walk_out": round(walk_out, 1), "walk_back": round(walk_back, 1), "walk": round(pk["walk"], 1),
            "dwell": round(there, 1), "total": round(total, 1), "spare": round(max(0.0, budget - total), 1),
            "detour": round(pk["walk"] - direct, 1) if direct is not None else None,
            "arrive_at": fmt_time(round(minutes + walk_out)), "leave_at": fmt_time(round(minutes + walk_out + there)),
            "back_at": fmt_time(round(minutes + total)),
            "sun_min": round(pk["sun"], 1),
            "shaded_pct": round(100 * (1 - pk["sun"] / pk["walk"])) if pk["walk"] > 0 and cond1.shade.sun_up else 100,
            "crowded_min": round(pk["crowd"], 1),
            "comfort": round((so["comfort"] * so["minutes"] + sb["comfort"] * sb["minutes"]) / max(1e-6, so["minutes"] + sb["minutes"]))
            if so["minutes"] + sb["minutes"] > 0 else 100,
            "geometry": {"out": _coords(pk["out"], p), "back": None if shape == "return" and pk["back"] == pk["out"][::-1]
                         else _coords(pk["back"], p)},
        }

    for pl, node, acc_min, dwell, hrs, pk in results:
        los = int(cond1.crowd.los[pl.edge])
        item = {
            "id": pl.id, "name": pl.name, "named": pl.named, "tag": pl.tag, "type": TYPE_LABEL.get(pl.tag, pl.tag),
            "address": pl.address, "lon": pl.lon, "lat": pl.lat,
            **walk_fields(pk, acc_min, dwell),
            "spot_los": LOS_LETTERS[los],
            "hours": hrs,
        }
        stay_min = item["dwell"] if stay else None
        if stay:
            sh = spot.get(pl.id, 1.0)
            shade_m2 = round(sh * pl.poly.area) if pl.poly is not None else None
            item["spot"] = {"shade_pct": round(100 * sh), "shade_m2": shade_m2, "seats": pl.seats, "covered": pl.covered,
                            "park": pl.poly is not None}
            # a park only needs part of it shaded: a patch the size of a big tree's shadow is somewhere to sit
            usable = 1.0 if pl.covered else min(1.0, shade_m2 / PARK_SHADE_M2) if shade_m2 is not None else sh
            item["spot"]["shade_ok"] = bool(pl.covered or usable >= (1.0 if shade_m2 is not None else 0.6))
            q = (1 - 0.7 * h * (1 - usable)) * (1 - 0.25 * min(los, 3) / 3) * (1.0 if pl.seats or pl.poly is not None else 0.9)
            if night:
                q *= 0.5 if pl.poly is not None else (0.7 if r.quiet[pl.edge] else 1.0)
            rank = -(stay_min * q - 0.5 * (ws * h * pk["sun"] + wc * pk["crowd"]))
        else:
            rank = pk["feel"] + dwell + (UNKNOWN_HOURS_PENALTY if hrs.get("assumed") else 0.0)
        item["chips"] = _chips(item, cat, h, stay, night, dwell, minutes)
        ranked.append((rank, item, pk, acc_min, dwell))
    ranked.sort(key=lambda x: x[0])
    items = []
    for _, it, pk, acc_min, dwell in ranked[:limit]:
        # turn-by-turn for the in-app walk; the leg back is walked later, so under later conditions
        def steps(o: dict) -> dict:
            return {"out": r.walk_steps(o["out"], cond1), "back": r.walk_steps(o["back"], cond2) if back else None}
        it["steps"] = steps(pk)
        it["options"] = {}
        for m, o in pk["opts"].items():
            wf = walk_fields(o, acc_min, dwell)
            wf["chips"] = _chips({**it, **wf}, cat, h, stay, night, dwell, minutes)
            wf["steps"] = it["steps"] if o is pk else steps(o)
            it["options"][m] = wf
        items.append(it)

    temp = round(cond1.temp_c, 1)
    return {
        "want": want, "label": cat["label"], "noun": cat["noun"][0], "nouns": cat["noun"][1], "kind": cat["kind"],
        "verb": cat["verb"], "shape": shape, "prefer": prefer,
        "budget": budget, "minutes": minutes, "time": fmt_time(minutes), "temp_c": temp,
        "hot": h > 0, "sun_up": bool(cond1.shade.sun_up), "night": night,
        "from": a_name, "to": b_name, "direct_min": round(direct, 1) if direct is not None else None,
        "counts": counts, "need_min": math.ceil(need) if not items and need < math.inf else None,
        "results": items,
        "note": "Places from OpenStreetMap. Hours are OSM's where mapped, otherwise typical for the kind of place. "
                "Queue times are estimates that grow in the morning and lunch rush.",
    }


def _spot_shade(lumen: Lumen, P: Places, d, minutes: int, results: list, budget: float) -> dict[str, float]:
    """Mean shaded share of each rest spot over the time you'd be sitting there."""
    frames: dict[int, np.ndarray | None] = {}

    def mask(t: int):
        if t not in frames:
            f = lumen.shade.frame(d, t)
            if not f.sun_up or not len(P.sample_pts):
                frames[t] = None
            else:
                inside = np.zeros(len(P.sample_pts), dtype=bool)
                inside[f.tree.query(P.sample_pts, predicate="intersects")[0]] = True
                frames[t] = inside
        return frames[t]

    out = {}
    for pl, node, acc_min, dwell, hrs, pk in results:
        if pl.covered:
            out[pl.id] = 1.0
            continue
        arrive = minutes + pk["so"]["minutes"] + acc_min
        leave = minutes + budget - (pk["walk"] - pk["so"]["minutes"] - acc_min)  # minus the walk back, if any
        ts = list(range(_q15(arrive), _q15(max(arrive, leave)) + 1, 15))[:5] or [_q15(arrive)]
        vals = []
        for t in ts:
            m = mask(t)
            vals.append(1.0 if m is None else float(m[pl.samples].mean()) if pl.samples.stop > pl.samples.start else 0.0)
        out[pl.id] = float(np.mean(vals))
    return out


def _chips(it: dict, cat: dict, h: float, stay: bool, night: bool, dwell: float, minutes: int) -> list[dict]:
    """Short badges under each result: why this place, in a few words."""
    rush = "morning rush" if minutes < 630 else "lunch rush" if 690 <= minutes < 840 else \
        "home-time rush" if minutes >= 990 else "busy-time"
    chips = []
    hrs = it["hours"]
    if hrs["state"] == "open":
        chips.append({"k": "open", "t": hrs["text"]})
    elif hrs["state"] == "assumed_open":
        chips.append({"k": "unknown", "t": "Hours not listed"})
    if stay:
        s = it["spot"]
        # how shady the spot is sits next to the headline, so the chips add the rest
        if s["park"] and h > 0:
            chips.append({"k": "shade", "t": f"{s['shade_pct']}% of the park shaded"})
        if s["seats"]:
            chips.append({"k": "seat", "t": f"{s['seats']} seat{'s' if s['seats'] > 1 else ''}"})
        if night and s["park"]:
            chips.append({"k": "warn", "t": "Dark after sunset"})
    elif cat.get("queue") and dwell > DWELL_BY_TAG.get(it["tag"], cat["dwell"]) + 0.4:
        chips.append({"k": "queue", "t": f"~{dwell:g} min, {rush} queue"})
    if h > 0 and it["walk"] > 1 and it["shaded_pct"] >= 60:
        chips.append({"k": "shade", "t": f"Walk {it['shaded_pct']}% shaded"})
    if it["spot_los"] in "AB" and not night:
        chips.append({"k": "quiet", "t": "Quiet spot"})
    elif it["spot_los"] in "DEF":
        chips.append({"k": "busy", "t": f"Busy footpath (LOS {it['spot_los']})"})
    return chips[:4]
