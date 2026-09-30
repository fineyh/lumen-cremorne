"""Wires the Sense / Understand / Act layers together for the API."""
from __future__ import annotations

import math
import threading
from datetime import date

import numpy as np
import requests
import shapely

from .crowd import LOS_LETTERS, CrowdModel
from .geo import ring_to_lonlat, to_xy
from .precinct import Precinct, load
from .router import WALK_SPEED, Conditions, Router, comfort, heat_factor
from .shade import ShadeModel
from .sun import sun_times
from .whatif import Plan, WhatIf

HOT_DAY = date(2026, 2, 11)  # a Wednesday in February
SCENARIOS = {
    "hot": {"label": "Hot Feb weekday", "date": HOT_DAY, "tmin": 25.0, "tmax": 35.0,
            "note": "Wed 11 Feb 2026 sun path, 35 °C heat scenario"},
    "mild": {"label": "Mild Feb weekday", "date": HOT_DAY, "tmin": 14.0, "tmax": 21.0,
             "note": "Same sun path, 21 °C control day"},
    "today": {"label": "Today", "date": None, "tmin": 9.0, "tmax": 17.0,
              "note": "Today's sun path; forecast from Open-Meteo when online"},
}
UNNAMED = ("", "footpath", "crossing", "path")


def temp_at(sc: dict, minutes: float) -> float:
    """Diurnal curve: minimum at 6:00, maximum at 15:30."""
    t = minutes if minutes >= 360 else minutes + 1440
    if t <= 930:
        frac = (1 - math.cos(math.pi * (t - 360) / 570)) / 2
    else:
        frac = (1 + math.cos(math.pi * (t - 930) / (1800 - 930))) / 2
    return sc["tmin"] + (sc["tmax"] - sc["tmin"]) * frac


def fmt_time(minutes: int) -> str:
    h, m = divmod(int(minutes), 60)
    suffix = "am" if h < 12 else "pm"
    h12 = h % 12 or 12
    return f"{h12}:{m:02d}{suffix}" if m else f"{h12}{suffix}"


class Lumen:
    def __init__(self):
        self.p: Precinct = load()
        self.shade = ShadeModel(self.p)
        self.crowd = CrowdModel(self.p)
        self.labels = self._edge_labels()
        self.router = Router(self.p, self.labels)
        self.whatif = WhatIf(self.p, self.shade)
        self.in_cremorne = np.array([
            self.p.cremorne.contains(shapely.Point(*c.mean(axis=0))) for c in self.p.e_coords
        ])
        self._today_fetched = False

    # ------------------------------------------------------------------ setup helpers
    def _edge_labels(self) -> list[str]:
        """Give unnamed footpaths the name of the street they run beside."""
        p = self.p
        names = [n for n, _ in p.street_lines]
        lines = [g for _, g in p.street_lines]
        tree = shapely.STRtree(lines)
        labels = list(p.e_name)
        for i, n in enumerate(p.e_name):
            if n not in UNNAMED:
                continue
            mid = shapely.Point(*p.e_coords[i].mean(axis=0))
            j = tree.nearest(mid)
            if j is not None and lines[j].distance(mid) < 25:
                labels[i] = names[j]
            else:
                labels[i] = "crossing" if n == "crossing" else "laneway"
        return labels

    def scenario(self, key: str) -> dict:
        sc = dict(SCENARIOS.get(key, SCENARIOS["hot"]))
        if key == "today":
            sc["date"] = date.today()
            if not self._today_fetched:
                self._today_fetched = True
                try:
                    r = requests.get(
                        "https://api.open-meteo.com/v1/forecast",
                        params={"latitude": -37.829, "longitude": 144.995, "timezone": "Australia/Melbourne",
                                "daily": "temperature_2m_max,temperature_2m_min", "forecast_days": 1},
                        timeout=4,
                    )
                    d = r.json()["daily"]
                    SCENARIOS["today"]["tmax"] = float(d["temperature_2m_max"][0])
                    SCENARIOS["today"]["tmin"] = float(d["temperature_2m_min"][0])
                    SCENARIOS["today"]["note"] = "Today's sun path, Open-Meteo forecast"
                except Exception:  # offline demo: keep the default
                    pass
                sc.update({k: SCENARIOS["today"][k] for k in ("tmin", "tmax", "note")})
        sc["key"] = key if key in SCENARIOS else "hot"
        return sc

    def conditions(self, scenario: str, minutes: int, temp: float | None = None, plan: Plan | None = None,
                   shade_minutes: int | None = None) -> Conditions:
        """Shade + crowd + temperature at a time; `plan` overlays a what-if plan on the base data.

        `shade_minutes` lets callers reuse a nearby pre-computed shadow frame (shade moves slowly,
        crowds move by the minute).
        """
        sc = self.scenario(scenario)
        t = temp if temp is not None else temp_at(sc, minutes)
        sm = minutes if shade_minutes is None else shade_minutes
        shade = self.whatif.frame(plan, sc["date"], sm) if plan else self.shade.frame(sc["date"], sm)
        return Conditions(shade, self.crowd.frame(minutes), t, minutes, closed=plan.closed if plan else None)

    def resolve(self, ref: str) -> tuple[int, str]:
        """A stop id, office id or 'lon,lat' -> (graph node, display name)."""
        for s in self.p.stops:
            if s["id"] == ref:
                return s["node"], s["name"]
        for o in self.p.offices:
            if o["id"] == ref:
                return o["node"], o["name"] or f"{o['street'] or 'Office'} building"
        lon, lat = (float(v) for v in ref.split(","))
        x, y = to_xy(lon, lat)
        return self.p.nearest_node(float(x), float(y)), "Dropped pin"

    # ------------------------------------------------------------------ static layers
    def network_geojson(self) -> dict:
        p = self.p
        feats = []
        for i, c in enumerate(p.e_coords):
            feats.append({
                "type": "Feature", "id": i,
                "properties": {"id": i, "name": self.labels[i], "cls": p.e_cls[i], "inside": bool(self.in_cremorne[i])},
                "geometry": {"type": "LineString", "coordinates": ring_to_lonlat(c)},
            })
        return {"type": "FeatureCollection", "features": feats}

    def buildings_geojson(self) -> dict:
        feats = []
        for b in self.p.buildings:
            feats.append({
                "type": "Feature",
                "properties": {"h": round(b.height, 1), "name": b.name},
                "geometry": {"type": "Polygon", "coordinates": [ring_to_lonlat(b.poly.exterior.coords)]},
            })
        return {"type": "FeatureCollection", "features": feats}

    def trees_geojson(self) -> dict:
        from .geo import to_lonlat

        lon, lat = to_lonlat(self.p.tree_xy[:, 0], self.p.tree_xy[:, 1])
        return {"type": "FeatureCollection", "features": [
            {"type": "Feature", "id": i, "properties": {"i": i, "r": round(float(r), 1)},
             "geometry": {"type": "Point", "coordinates": [round(float(a), 6), round(float(b), 6)]}}
            for i, (a, b, r) in enumerate(zip(lon, lat, self.p.tree_radius))
        ]}

    # ------------------------------------------------------------------ state per time
    def state(self, scenario: str, minutes: int, temp: float | None = None, plan: Plan | None = None) -> dict:
        sc = self.scenario(scenario)
        cond = self.conditions(scenario, minutes, temp, plan)
        sh, cr = cond.shade, cond.crowd
        rise, set_ = sun_times(sc["date"])
        ce = comfort(cond)
        m = self.in_cremorne
        return {
            "scenario": {k: (str(v) if k == "date" else v) for k, v in sc.items()},
            "minutes": minutes,
            "time": fmt_time(minutes),
            "temp_c": round(cond.temp_c, 1),
            "heat_factor": round(heat_factor(cond.temp_c), 2),
            "sun": {"azimuth": round(sh.azimuth, 1), "elevation": round(sh.elevation, 1),
                    "up": sh.sun_up, "sunrise": rise, "sunset": set_},
            "shaded_share": round(float(np.average(sh.edge_shade[m], weights=self.p.e_len[m])), 3),
            "comfort": round(float(np.average(ce[m], weights=self.p.e_len[m])), 1),
            "plan": plan.key if plan else None,
            "edges": {
                "shade": np.round(sh.edge_shade, 2).tolist(),
                "per_m": np.round(cr.per_m, 1).tolist(),
                "los": cr.los.tolist(),
                "comfort": np.round(ce).astype(int).tolist(),
            },
            "los_counts": self._los_km(cr.los),
            "stop_outflow": {k: round(v) for k, v in cr.stop_outflow.items()},
            "nodes": self.crowd.node_readings(minutes, cond.temp_c),
            "hotspots": self.hotspots(cond),
        }

    def _los_km(self, los: np.ndarray) -> dict:
        m = self.in_cremorne
        return {LOS_LETTERS[k]: round(float(self.p.e_len[m & (los == k)].sum()) / 1000, 2) for k in range(6)}

    def hotspots(self, cond: Conditions, n: int = 5) -> dict:
        """Most crowded and most sun-exposed streets right now, grouped by street name."""
        p = self.p
        crowd_by, heat_by = {}, {}
        sun = cond.sun
        exposure = cond.crowd.flow * sun * p.e_len / WALK_SPEED / 60  # person-minutes in sun per minute
        for i in np.nonzero(self.in_cremorne)[0]:
            name = self.labels[i]
            if name in ("laneway", "crossing"):
                continue
            c = crowd_by.setdefault(name, {"street": name, "per_m": 0.0, "los": 0})
            if cond.crowd.per_m[i] > c["per_m"]:
                c["per_m"] = float(cond.crowd.per_m[i]); c["los"] = int(cond.crowd.los[i])
            h = heat_by.setdefault(name, {"street": name, "len": 0.0, "sun_len": 0.0, "exposure": 0.0})
            h["len"] += p.e_len[i]; h["sun_len"] += p.e_len[i] * sun[i]; h["exposure"] += exposure[i]
        crowded = sorted(crowd_by.values(), key=lambda d: -d["per_m"])[:n]
        hot = sorted((h for h in heat_by.values() if h["len"] > 60), key=lambda d: -d["exposure"])[:n]
        return {
            "crowded": [{"street": c["street"], "per_m": round(c["per_m"], 1), "los": LOS_LETTERS[c["los"]]} for c in crowded],
            "hot": [{"street": h["street"], "sunlit_pct": round(100 * h["sun_len"] / h["len"]),
                     "person_sun_min": round(float(h["exposure"]), 1)} for h in hot],
        }

    # ------------------------------------------------------------------ routes
    def routes(self, src: str, dst: str, scenario: str, minutes: int, temp: float | None = None,
               plan: Plan | None = None) -> dict:
        a, a_name = self.resolve(src)
        b, b_name = self.resolve(dst)
        cond = self.conditions(scenario, minutes, temp, plan)
        return {
            "from": a_name, "to": b_name, "time": fmt_time(minutes), "temp_c": round(cond.temp_c, 1),
            "heat_factor": round(heat_factor(cond.temp_c), 2),
            "plan": plan.key if plan else None,
            "routes": self.router.routes(a, b, cond),
        }

    def street_table(self, scenario: str = "hot") -> list[dict]:
        """Per-street summary for the Hub's weekly report (modelled from the replay)."""
        am, pm, heat = (self.conditions(scenario, t) for t in (525, 1050, 930))
        rows = {}
        for i in np.nonzero(self.in_cremorne)[0]:
            name = self.labels[i]
            if name in ("laneway", "crossing"):
                continue
            r = rows.setdefault(name, {"street": name, "length_m": 0.0, "am_peak_per_m": 0.0, "pm_peak_per_m": 0.0,
                                       "sun_len_1530": 0.0, "min_width_m": 99.0})
            L = self.p.e_len[i]
            r["length_m"] += L
            r["am_peak_per_m"] = max(r["am_peak_per_m"], float(am.crowd.per_m[i]))
            r["pm_peak_per_m"] = max(r["pm_peak_per_m"], float(pm.crowd.per_m[i]))
            r["sun_len_1530"] += L * (1 - heat.shade.edge_shade[i])
            r["min_width_m"] = min(r["min_width_m"], float(self.crowd.eff_width[i]))
        out = []
        for r in rows.values():
            if r["length_m"] < 40:
                continue
            los_am = LOS_LETTERS[int(np.searchsorted([23, 33, 49, 66, 82], r["am_peak_per_m"], side="right"))]
            out.append({
                "street": r["street"], "length_m": round(r["length_m"]),
                "effective_width_m": round(r["min_width_m"], 1),
                "am_peak_ppm_per_m": round(r["am_peak_per_m"], 1), "am_peak_los": los_am,
                "pm_peak_ppm_per_m": round(r["pm_peak_per_m"], 1),
                "sunlit_pct_1530_hot_day": round(100 * r["sun_len_1530"] / r["length_m"]),
            })
        out.sort(key=lambda r: -r["am_peak_ppm_per_m"])
        return out
