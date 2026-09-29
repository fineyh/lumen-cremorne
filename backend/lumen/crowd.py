"""Crowd model: pedestrian flow on every path segment and Fruin Level of Service.

flow(edge, t) = sum over stops of  outflow(stop, t) x share(stop, edge)   <- arrival pulses
              + background(edge class) x activity(t)                      <- everyone else

* outflow: 10,000 workers split across stations/tram stops, spread over the day with commute,
  lunch and home-time peaks, and multiplied by a train-arrival pulse (people leave the platform in a
  burst that decays over a couple of minutes). Timetable headways are a static approximation; the
  GTFS-Realtime feed would replace them.
* share: fraction of each stop's walkers whose shortest path to a workplace uses the edge, weighted
  by the workplace's floor area.
* LOS: flow per metre of *effective* footpath width (clear width minus 0.3 m shy distance each side).

Everything here is a heuristic, and the replayed window-node readings are synthetic. The UI labels
them that way.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import networkx as nx
import numpy as np

from .precinct import Precinct

WORKERS = 10_000
OTHER_TRIPS = 1.25  # students, residents, visitors using the same stops, on top of workers
STOP_SHARE = {
    "train-richmond": 0.40,
    "train-east-richmond": 0.12,
    "tram-swan-street-shopping-centre": 0.04,
    "tram-lennox-street": 0.03,
    "tram-east-richmond-station-church-street": 0.03,
    "tram-balmain-street": 0.04,
    "tram-adelaide-street": 0.02,
    "tram-howard-street": 0.02,
}
# (headway minutes, platform-clearing time constant minutes, first-arrival offset)
PULSE = {
    "train-richmond": (3.0, 1.5, 1.0),
    "train-east-richmond": (5.0, 1.2, 3.0),
}
LOS_LETTERS = "ABCDEF"
LOS_BOUNDS = np.array([23, 33, 49, 66, 82])  # people / min / m (Fruin walkways)
BACKGROUND = {  # people per minute, both directions, at activity = 1
    "primary": 14, "secondary": 10, "tertiary": 6, "residential": 2.0, "unclassified": 2.5,
    "living_street": 3, "service": 1.0, "footway": 3.0, "pedestrian": 6, "path": 1.5,
    "cycleway": 1.0, "steps": 1.0, "secondary_link": 3, "tertiary_link": 2,
}
MAIN_STREETS = {"Swan Street", "Church Street", "Cremorne Street", "Punt Road", "Balmain Street"}


def _gauss(t, mu, sigma):
    return math.exp(-0.5 * ((t - mu) / sigma) ** 2) / (sigma * math.sqrt(2 * math.pi))


def worker_rate(t: float) -> float:
    """Share of the workforce walking between a stop and work per minute."""
    return (
        0.50 * _gauss(t, 528, 28)      # morning arrival, peak ~8:50
        + 0.35 * _gauss(t, 515, 60)    # early and late arrivals
        + 0.30 * _gauss(t, 750, 28)    # lunch out and back
        + 0.08 * _gauss(t, 900, 90)    # meetings between buildings
        + 0.85 * _gauss(t, 1055, 42)   # home time, peak ~17:35
    )


def activity(t: float) -> float:
    """Background street activity, 0.15 at night to ~1 at the busiest hour."""
    base = worker_rate(t) / worker_rate(530)
    day = 1.0 if 420 <= t <= 1260 else 0.15
    return max(0.15, min(1.2, 0.35 * day + 0.8 * base))


def pulse(stop_id: str, t: float) -> float:
    """Peak train-arrival multiplier within the 5 minutes starting at t (mean over time = 1)."""
    if stop_id not in PULSE:
        return 1.0
    h, tau, off = PULSE[stop_id]
    if not (420 <= t <= 570 or 960 <= t <= 1140):
        h *= 2  # off-peak timetable
    norm = (h / tau) / (1 - math.exp(-h / tau))
    best = 0.0
    for dt in range(5):
        since = (t + dt - off) % h
        best = max(best, norm * math.exp(-since / tau))
    return best


def los_index(per_m: np.ndarray) -> np.ndarray:
    return np.searchsorted(LOS_BOUNDS, per_m, side="right")


@dataclass
class CrowdFrame:
    minutes: int
    flow: np.ndarray      # people / min
    per_m: np.ndarray     # people / min / m
    los: np.ndarray       # 0..5 -> A..F
    stop_outflow: dict


class CrowdModel:
    def __init__(self, p: Precinct):
        self.p = p
        # effective width: remove 0.3 m shy distance on both edges of each footpath
        sides = np.where(p.e_is_road, 2.0, 1.0)
        self.eff_width = np.maximum(0.6, p.e_width - 0.6 * sides)
        self.background = np.array([BACKGROUND.get(c, 1.0) for c in p.e_cls])
        main = np.array([n in MAIN_STREETS for n in p.e_name])
        self.background = np.where(main, self.background * 1.6, self.background)
        self.stop_ids = [s["id"] for s in p.stops if s["id"] in STOP_SHARE]
        self.share = {sid: self._path_share(sid) for sid in self.stop_ids}
        self.nodes = self._place_window_nodes()

    def _path_share(self, stop_id: str) -> np.ndarray:
        p = self.p
        stop = next(s for s in p.stops if s["id"] == stop_id)
        pred, _ = nx.dijkstra_predecessor_and_distance(p.graph, stop["node"], weight="length")
        share = np.zeros(len(p.e_len))
        total = sum(o["floor_area"] for o in p.offices)
        for o in p.offices:
            w = o["floor_area"] / total
            n = o["node"]
            while n != stop["node"] and pred.get(n):
                prev = pred[n][0]
                share[p.edge_between(prev, n)] += w
                n = prev
        return share

    def frame(self, minutes: int) -> CrowdFrame:
        t = float(minutes)
        flow = self.background * activity(t)
        outflow = {}
        for sid in self.stop_ids:
            rate = WORKERS * OTHER_TRIPS * STOP_SHARE[sid] * worker_rate(t) * pulse(sid, t)
            outflow[sid] = rate
            flow = flow + rate * self.share[sid]
        per_m = flow / self.eff_width
        return CrowdFrame(minutes, flow, per_m, los_index(per_m), outflow)

    # ------------------------------------------------------------------ window nodes
    def _place_window_nodes(self) -> list[dict]:
        """Put replayed nodes on the busiest segment of each street we'd pilot on.

        Node 00 is the physical node at the demo; it is anchored at the Richmond-station end of
        Cremorne Street so the live count feeds the pinch point everyone asks about.
        """
        p = self.p
        peak = self.frame_no_nodes(525)
        sites = [
            ("node-00", "Cremorne Street", "north", True),
            ("node-01", "Cremorne Street", "south", False),
            ("node-02", "Church Street", "busiest", False),
            ("node-03", "Swan Street", "busiest", False),
            ("node-04", "Balmain Street", "busiest", False),
            ("node-05", "Stephenson Street", "busiest", False),
            ("node-06", "Dover Street", "busiest", False),
            ("node-07", "Chestnut Street", "busiest", False),
            ("node-08", "Gwynne Street", "busiest", False),
            ("node-09", "Cubitt Street", "busiest", False),
            ("node-10", "Kipling Street", "busiest", False),
            ("node-11", "Balmain Street", "west", False),
            ("node-12", "Church Street", "south", False),
        ]
        out = []
        for nid, street, how, live in sites:
            idx = [i for i, n in enumerate(p.e_name) if n == street and p.cremorne.contains(_pt(p, i))]
            if not idx:
                continue
            if how == "busiest":
                i = max(idx, key=lambda k: peak[k])
            else:
                ys = [p.e_coords[k].mean(axis=0)[1] for k in idx]
                if how == "west":
                    ys = [-p.e_coords[k].mean(axis=0)[0] for k in idx]
                i = idx[int(np.argmax(ys) if how in ("north", "west") else np.argmin(ys))]
            x, y = p.e_coords[i].mean(axis=0)
            from .geo import to_lonlat

            lon, lat = to_lonlat(x, y)
            out.append({
                "id": nid, "street": street, "edge": int(i), "lon": float(lon), "lat": float(lat),
                "live": live, "source": "live" if live else "replayed",
            })
        return out

    def frame_no_nodes(self, minutes: int) -> np.ndarray:
        return self.frame(minutes).flow

    def node_readings(self, minutes: int, temp_c: float, seed: int = 0) -> list[dict]:
        """Replayed readings (synthetic, derived from the model) for the window nodes."""
        f = self.frame(minutes)
        rng = np.random.default_rng(minutes * 31 + seed)
        out = []
        for n in self.nodes:
            ppm = float(f.flow[n["edge"]]) * rng.uniform(0.85, 1.15)
            out.append({
                **n,
                "ppm": round(ppm, 1),
                "per_10s": round(ppm / 6, 1),
                "los": LOS_LETTERS[int(f.los[n["edge"]])],
                "temp_c": round(temp_c + rng.normal(0, 0.4) + (1.5 if n["street"] in MAIN_STREETS else 0), 1),
                "noise_db": round(52 + 14 * activity(minutes) + rng.normal(0, 1.5) + (4 if n["street"] in MAIN_STREETS else 0), 1),
            })
        return out

    def node_profile(self, node_id: str) -> list[dict]:
        """Hourly pedestrians past a node (what a shop owner sees in the tenant view)."""
        n = next(x for x in self.nodes if x["id"] == node_id)
        out = []
        for h in range(6, 22):
            per_min = [self.frame(h * 60 + m).flow[n["edge"]] for m in range(0, 60, 10)]
            out.append({"hour": h, "people": int(round(float(np.mean(per_min)) * 60))})
        return out


def _pt(p: Precinct, i: int):
    from shapely.geometry import Point

    x, y = p.e_coords[i].mean(axis=0)
    return Point(x, y)
