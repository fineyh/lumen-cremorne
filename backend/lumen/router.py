"""Shade Router: shortest / coolest / calmest walking routes.

    w_e = l_e * (1 + alpha * s_e * H + beta * C_e),   H = max(0, (T_air - 24) / 10)

s_e is the sunlit share of the shadier side of the segment, C_e a penalty from its Level of Service.
H makes shade matter only on warm days: below 24 C the coolest route *is* the shortest route.
"""
from __future__ import annotations

from dataclasses import dataclass

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


class Router:
    def __init__(self, p: Precinct, labels: list[str]):
        self.p = p
        self.labels = labels
        fw = [c == "footway" and n not in ("footpath", "crossing") for c, n in zip(p.e_cls, p.e_name)]
        self.quiet = np.array([c in QUIET_CLASSES for c in p.e_cls]) | np.array(fw)

    # ------------------------------------------------------------------ weights
    def weights(self, mode: str, cond: Conditions) -> np.ndarray:
        p = self.p
        sun = (1.0 - cond.shade.edge_shade) if cond.shade.sun_up else np.zeros(len(p.e_len))
        if mode == "calmest" and cond.minutes >= NIGHT_START:
            # After dark "least crowded" can mean "deserted". Prefer lit, lively streets instead.
            return p.e_len * (1.0 + 1.5 * self.quiet)
        m = MODES[mode]
        h = heat_factor(cond.temp_c)
        c = CROWD_PENALTY[cond.crowd.los]
        return p.e_len * (1.0 + m["alpha"] * sun * h + m["beta"] * c)

    def _path(self, src: int, dst: int, w: np.ndarray) -> list[int]:
        g = self.p.graph
        _, nodes = nx.bidirectional_dijkstra(g, src, dst, weight=lambda u, v, d: w[d["eid"]])
        return nodes

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
        sun_share = (1 - cond.shade.edge_shade[eids_arr]) if cond.shade.sun_up else np.zeros(len(eids))
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
            sun = 0.0 if not cond.shade.sun_up else 1 - cond.shade.edge_shade[e]
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
