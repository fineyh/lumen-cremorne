"""Shade Router: shortest / coolest / calmest walking routes.

    w_e = l_e * (1 + alpha * s_e * H + beta * C_e),   H = max(0, (T_air - 24) / 10)

s_e is the sunlit share of the shadier side of the segment, C_e a penalty from its Level of Service.
H makes shade matter only on warm days: below 24 C the coolest route *is* the shortest route.

Comfort Score (0-100, per segment, length-weighted for a route or the precinct):

    comfort_e = 100 - 60 * s_e * min(H, 1) - 40 * min(C_e, 2) / 2

so a fully sunlit segment at 34 C+ loses 60 points and a LOS E+ footpath loses 40.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import networkx as nx
import numpy as np

from .crowd import LOS_LETTERS, CrowdFrame
from .geo import ring_to_lonlat
from .precinct import Precinct
from .shade import ShadeFrame

WALK_SPEED = 1.3  # m/s
CROWD_PENALTY = np.array([0.0, 0.1, 0.4, 1.0, 2.0, 3.0])  # LOS A..F
MODES = {
    "shortest": {"alpha": 0.0, "beta": 0.0, "label": "Shortest"},
    "coolest": {"alpha": 3.0, "beta": 0.2, "label": "Coolest"},
    "calmest": {"alpha": 0.3, "beta": 3.0, "label": "Least crowded"},
}
NIGHT_START = 18 * 60
QUIET_CLASSES = {"service", "path", "steps", "cycleway"}
OPPOSITE = {"north": "south", "south": "north", "east": "west", "west": "east"}


def heat_factor(temp_c: float) -> float:
    return max(0.0, (temp_c - 24.0) / 10.0)


@dataclass
class Conditions:
    shade: ShadeFrame
    crowd: CrowdFrame
    temp_c: float
    minutes: int
    closed: np.ndarray | None = field(default=None)  # bool per edge: shut for works (what-if plans)

    @property
    def sun(self) -> np.ndarray:
        """Sunlit share of each edge's shadier side (0 when the sun is down)."""
        return (1.0 - self.shade.edge_shade) if self.shade.sun_up else np.zeros(len(self.shade.edge_shade))


def comfort(cond: Conditions) -> np.ndarray:
    """Comfort Score per edge, 0-100 (see module docstring)."""
    h = min(1.0, heat_factor(cond.temp_c))
    crowd = np.minimum(CROWD_PENALTY[cond.crowd.los], 2.0) / 2.0
    return 100.0 - 60.0 * cond.sun * h - 40.0 * crowd


class Router:
    def __init__(self, p: Precinct, labels: list[str]):
        self.p = p
        self.labels = labels
        fw = [c == "footway" and n not in ("footpath", "crossing") for c, n in zip(p.e_cls, p.e_name)]
        self.quiet = np.array([c in QUIET_CLASSES for c in p.e_cls]) | np.array(fw)

    # ------------------------------------------------------------------ weights
    def weights(self, mode: str, cond: Conditions) -> np.ndarray:
        p = self.p
        if mode == "calmest" and cond.minutes >= NIGHT_START:
            # After dark "least crowded" can mean "deserted". Prefer lit, lively streets instead.
            w = p.e_len * (1.0 + 1.5 * self.quiet)
        else:
            m = MODES[mode]
            h = heat_factor(cond.temp_c)
            c = CROWD_PENALTY[cond.crowd.los]
            w = p.e_len * (1.0 + m["alpha"] * cond.sun * h + m["beta"] * c)
        if cond.closed is not None:
            w = np.where(cond.closed, np.inf, w)
        return w

    @staticmethod
    def _weight_fn(w: np.ndarray):
        # networkx treats a None weight as "edge does not exist": that is how closures work
        return lambda u, v, d: None if w[d["eid"]] == np.inf else w[d["eid"]]

    def _path(self, src: int, dst: int, w: np.ndarray) -> list[int]:
        _, nodes = nx.bidirectional_dijkstra(self.p.graph, src, dst, weight=self._weight_fn(w))
        return nodes

    def paths_from(self, src: int, w: np.ndarray) -> dict[int, list[int]]:
        """Best path from src to every reachable node (one Dijkstra run)."""
        return self.tree_from(src, w)[1]

    def tree_from(self, src: int, w: np.ndarray) -> tuple[dict[int, float], dict[int, list[int]]]:
        """Cost and best path from src to every reachable node (one Dijkstra run)."""
        return nx.single_source_dijkstra(self.p.graph, src, weight=self._weight_fn(w))

    def path_stats(self, nodes: list[int], cond: Conditions, comfort_e: np.ndarray | None = None) -> dict:
        """Minutes / sun minutes / crowded minutes of a node path, without steps or geometry."""
        p = self.p
        eids = np.array([p.edge_between(a, b) for a, b in zip(nodes[:-1], nodes[1:])], dtype=int)
        if not len(eids):
            return {"edges": eids, "minutes": 0.0, "sun_minutes": 0.0, "crowded_minutes": 0.0, "comfort": 100.0}
        L = p.e_len[eids]
        ce = comfort(cond) if comfort_e is None else comfort_e
        return {
            "edges": eids,
            "minutes": float(L.sum()) / WALK_SPEED / 60,
            "sun_minutes": float((L * cond.sun[eids]).sum()) / WALK_SPEED / 60,
            "crowded_minutes": float(L[cond.crowd.los[eids] >= 3].sum()) / WALK_SPEED / 60,
            "comfort": float(np.average(ce[eids], weights=L)) if L.sum() > 0 else 100.0,
        }

    # ------------------------------------------------------------------ public
    def route(self, src: int, dst: int, mode: str, cond: Conditions, with_geometry: bool = True) -> dict:
        w = self.weights(mode, cond)
        nodes = self._path(src, dst, w)
        return self.describe(nodes, mode, cond, with_geometry)

    def routes(self, src: int, dst: int, cond: Conditions) -> list[dict]:
        out = [self.route(src, dst, m, cond) for m in MODES]
        base = out[0]
        for r in out:
            r["vs_shortest"] = {
                "extra_min": round(r["minutes"] - base["minutes"], 1),
                "sun_min_saved": round(base["sun_minutes"] - r["sun_minutes"], 1),
                "crowd_min_saved": round(base["crowded_minutes"] - r["crowded_minutes"], 1),
                "comfort_gain": r["comfort"] - base["comfort"],
            }
            r["same_as_shortest"] = r["edges"] == base["edges"]
        return out

    def describe(self, nodes: list[int], mode: str, cond: Conditions, with_geometry: bool = True) -> dict:
        p = self.p
        eids, coords = [], []
        for a, b in zip(nodes[:-1], nodes[1:]):
            eids.append(p.edge_between(a, b))
        eids_arr = np.array(eids, dtype=int)
        lengths = p.e_len[eids_arr] if eids else np.zeros(0)
        sun_share = cond.sun[eids_arr] if eids else np.zeros(0)
        los = cond.crowd.los[eids_arr] if eids else np.zeros(0, int)
        dist = float(lengths.sum())
        sun_m = float((lengths * sun_share).sum())
        crowd_m = float(lengths[los >= 3].sum())
        night_calm = mode == "calmest" and cond.minutes >= NIGHT_START
        out = {
            "mode": mode,
            "label": "Lit & lively" if night_calm else MODES[mode]["label"],
            "note": "After 6pm we stop steering people onto empty streets." if night_calm else None,
            "distance_m": round(dist),
            "minutes": round(dist / WALK_SPEED / 60, 1),
            "sun_minutes": round(sun_m / WALK_SPEED / 60, 1),
            "shaded_pct": round(100 * (1 - sun_m / dist)) if dist > 0 else 100,
            "crowded_minutes": round(crowd_m / WALK_SPEED / 60, 1),
            "worst_los": LOS_LETTERS[int(los.max())] if len(los) else "A",
            "comfort": round(float(np.average(comfort(cond)[eids_arr], weights=lengths))) if dist > 0 else 100,
            "edges": eids,
            "steps": self._steps(eids, cond),
        }
        if with_geometry:
            for a in nodes:
                coords.append(p.node_xy[a])
            out["geometry"] = {"type": "LineString", "coordinates": ring_to_lonlat(coords)}
        return out

    def _steps(self, eids: list[int], cond: Conditions) -> list[dict]:
        """Group consecutive segments by street name into turn-by-turn style steps with side-of-street tips."""
        p = self.p
        steps: list[dict] = []
        for e in eids:
            name = self.labels[e]
            if name in ("crossing", "laneway") and steps:
                name = steps[-1]["street"]
            sun = cond.sun[e]
            side = None
            if p.e_is_road[e] and cond.shade.sun_up and cond.shade.edge_side_gain[e] > 0.25:
                left = p.e_left_compass[e]
                side = left if cond.shade.edge_best_side[e] == 0 else OPPOSITE[left]
            if steps and steps[-1]["street"] == name:
                s = steps[-1]
            else:
                s = {"street": name, "length_m": 0.0, "sun_m": 0.0, "sides": {}, "worst_los": 0}
                steps.append(s)
            s["length_m"] += p.e_len[e]
            s["sun_m"] += p.e_len[e] * sun
            s["worst_los"] = max(s["worst_los"], int(cond.crowd.los[e]))
            if side:
                s["sides"][side] = s["sides"].get(side, 0) + p.e_len[e]
        out = []
        for s in steps:
            if s["length_m"] < 15 and out:
                continue
            side = max(s["sides"], key=s["sides"].get) if s["sides"] else None
            out.append({
                "street": s["street"],
                "length_m": round(s["length_m"]),
                "shaded_pct": round(100 * (1 - s["sun_m"] / s["length_m"])) if s["length_m"] else 100,
                "shady_side": side if side and s["sides"][side] > 0.4 * s["length_m"] else None,
                "los": LOS_LETTERS[s["worst_los"]],
            })
        return out

    def walk_steps(self, nodes: list[int], cond: Conditions) -> list[dict]:
        """Steps for following a route on the phone: like `_steps`, plus which way to turn onto each
        street, how long it takes and the stretch of map it covers. Short jogs fold into the step
        before so the steps join up end to end."""
        p = self.p
        if len(nodes) < 2:
            return []
        groups: list[dict] = []
        for i, (a, b) in enumerate(zip(nodes[:-1], nodes[1:])):
            e = p.edge_between(a, b)
            name = self.labels[e]
            if name in ("crossing", "laneway") and groups:
                name = groups[-1]["street"]
            side = None
            if p.e_is_road[e] and cond.shade.sun_up and cond.shade.edge_side_gain[e] > 0.25:
                left = p.e_left_compass[e]
                side = left if cond.shade.edge_best_side[e] == 0 else OPPOSITE[left]
            if not groups or groups[-1]["street"] != name:
                groups.append({"street": name, "length_m": 0.0, "sun_m": 0.0, "sides": {}, "los": 0, "i0": i})
            g = groups[-1]
            g["i1"] = i + 1
            g["length_m"] += p.e_len[e]
            g["sun_m"] += p.e_len[e] * cond.sun[e]
            g["los"] = max(g["los"], int(cond.crowd.los[e]))
            if side:
                g["sides"][side] = g["sides"].get(side, 0) + p.e_len[e]
        kept: list[dict] = []
        for g in groups:
            prev = kept[-1] if kept else None
            if prev and (g["length_m"] < 15 or g["street"] == prev["street"]):
                prev["i1"] = g["i1"]
                prev["length_m"] += g["length_m"]
                prev["sun_m"] += g["sun_m"]
                prev["los"] = max(prev["los"], g["los"])
                for k, v in g["sides"].items():
                    prev["sides"][k] = prev["sides"].get(k, 0) + v
            else:
                kept.append(g)
        if len(kept) > 1 and kept[0]["length_m"] < 15:  # a few metres to reach the first street
            first, nxt = kept.pop(0), kept[0]
            nxt["i0"] = first["i0"]
            nxt["length_m"] += first["length_m"]
            nxt["sun_m"] += first["sun_m"]
            nxt["los"] = max(nxt["los"], first["los"])
        xy = [p.node_xy[n] for n in nodes]
        out = []
        for k, g in enumerate(kept):
            side = max(g["sides"], key=g["sides"].get) if g["sides"] else None
            heading = _bearing(xy, g["i0"], g["i1"])
            if k == 0:
                turn = "start"
            else:
                turn = _turn(heading - _bearing(xy, kept[k - 1]["i1"], kept[k - 1]["i0"], back=True))
            out.append({
                "street": g["street"],
                "turn": turn,
                "heading": _compass(heading),
                "length_m": round(g["length_m"]),
                "minutes": round(g["length_m"] / WALK_SPEED / 60, 1),
                "shaded_pct": round(100 * (1 - g["sun_m"] / g["length_m"])) if g["length_m"] else 100,
                "shady_side": side if side and g["sides"][side] > 0.4 * g["length_m"] else None,
                "los": LOS_LETTERS[g["los"]],
                "path": ring_to_lonlat(xy[g["i0"]:g["i1"] + 1]),
            })
        return out


TURN_LOOK = 20.0  # m either side of a corner used to read the turn, so a kerb ramp doesn't count as one


def _bearing(xy: list, i: int, j: int, back: bool = False) -> float:
    """Compass bearing (0 = north, clockwise) leaving node i towards node j, measured over the first
    TURN_LOOK metres. With back=True, the bearing arriving at node i from the j side."""
    x0, y0 = xy[i]
    step = 1 if j > i else -1
    x1, y1 = x0, y0
    for n in range(i + step, j + step, step):
        x1, y1 = xy[n]
        if math.hypot(x1 - x0, y1 - y0) >= TURN_LOOK:
            break
    dx, dy = (x0 - x1, y0 - y1) if back else (x1 - x0, y1 - y0)
    return math.degrees(math.atan2(dx, dy)) % 360


def _turn(delta: float) -> str:
    d = (delta + 180) % 360 - 180  # -180..180, positive = right
    a = abs(d)
    if a < 25:
        return "straight"
    if a > 150:
        return "uturn"
    return ("slight-" if a < 60 else "") + ("right" if d > 0 else "left")


def _compass(b: float) -> str:
    return ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][round(b / 45) % 8]
