"""Offline evaluation: does Lumen measurably improve the walk to work?

For every (stop -> workplace) pair, compare the shortest route with Lumen's coolest and calmest
routes under three conditions: hot-day 8:45, hot-day 15:30 and a mild control day at 15:30
(where Lumen should *not* send anyone on a detour).

    python -m lumen.evaluate          # from backend/, writes data/cache/evaluation.json
"""
from __future__ import annotations

import json
import pathlib
import statistics
import time

import numpy as np

from .engine import Lumen

CACHE = pathlib.Path(__file__).resolve().parents[2] / "data" / "cache" / "evaluation.json"
ORIGINS = ["train-richmond", "train-east-richmond", "tram-swan-street-shopping-centre", "tram-balmain-street"]
CASES = [
    {"key": "hot_0845", "label": "Hot day · 8:45am", "scenario": "hot", "minutes": 525},
    {"key": "hot_1530", "label": "Hot day · 3:30pm", "scenario": "hot", "minutes": 930},
    {"key": "mild_1530", "label": "Mild control · 3:30pm", "scenario": "mild", "minutes": 930},
]
VERSION = 3


def _pct(values, q):
    return round(float(np.percentile(values, q)), 2) if values else 0.0


def run(lumen: Lumen) -> dict:
    t0 = time.time()
    p = lumen.p
    dests = p.offices
    out = {"version": VERSION, "origins": [], "n_destinations": len(dests), "cases": []}
    out["origins"] = [next(s["name"] for s in p.stops if s["id"] == o) for o in ORIGINS]
    for case in CASES:
        cond = lumen.conditions(case["scenario"], case["minutes"])
        w = {m: lumen.router.weights(m, cond) for m in ("shortest", "coolest", "calmest")}
        rows = []
        for oid in ORIGINS:
            src = next(s["node"] for s in p.stops if s["id"] == oid)
            for d in dests:
                if d["node"] == src:
                    continue
                r = {}
                for m in w:
                    nodes = lumen.router._path(src, d["node"], w[m])
                    r[m] = lumen.router.describe(nodes, m, cond, with_geometry=False)
                rows.append(r)
        sun_base = [r["shortest"]["sun_minutes"] for r in rows]
        sun_saved = [r["shortest"]["sun_minutes"] - r["coolest"]["sun_minutes"] for r in rows]
        sun_pct = [100 * s / b for s, b in zip(sun_saved, sun_base) if b > 0.5]
        detour_cool = [r["coolest"]["minutes"] - r["shortest"]["minutes"] for r in rows]
        crowd_base = [r["shortest"]["crowded_minutes"] for r in rows]
        crowd_saved = [r["shortest"]["crowded_minutes"] - r["calmest"]["crowded_minutes"] for r in rows]
        crowd_trips = [(s, b) for s, b in zip(crowd_saved, crowd_base) if b > 0.05]
        detour_calm = [r["calmest"]["minutes"] - r["shortest"]["minutes"] for r in rows]
        hist_edges = list(range(0, 11))
        hist = np.histogram(np.clip(sun_saved, 0, 9.99), bins=hist_edges)[0].tolist()
        out["cases"].append({
            **case,
            "temp_c": round(cond.temp_c, 1),
            "n_trips": len(rows),
            "sun": {
                "baseline_median_min": _pct(sun_base, 50),
                "saved_median_min": _pct(sun_saved, 50),
                "saved_p75_min": _pct(sun_saved, 75),
                "saved_median_pct": _pct(sun_pct, 50),
                "total_saved_min": round(float(sum(sun_saved)), 1),
                "share_trips_improved": round(sum(1 for s in sun_saved if s > 0.25) / len(rows), 3),
                "detour_median_min": _pct(detour_cool, 50),
                "detour_p90_min": _pct(detour_cool, 90),
                "hist_saved_min": {"edges": hist_edges, "counts": hist},
            },
            "crowd": {
                "trips_through_los_d": len(crowd_trips),
                "baseline_median_min": _pct([b for _, b in crowd_trips], 50),
                "saved_median_min": _pct([s for s, _ in crowd_trips], 50),
                "saved_median_pct": _pct([100 * s / b for s, b in crowd_trips], 50),
                "detour_median_min": _pct([d for d, b in zip(detour_calm, crowd_base) if b > 0.05], 50),
            },
            "scatter": [
                [round(r["coolest"]["minutes"] - r["shortest"]["minutes"], 2),
                 round(r["shortest"]["sun_minutes"] - r["coolest"]["sun_minutes"], 2)] for r in rows
            ],
        })
    out["seconds"] = round(time.time() - t0, 1)
    return out


def load_or_run(lumen: Lumen, force: bool = False) -> dict:
    if CACHE.exists() and not force:
        data = json.loads(CACHE.read_text(encoding="utf-8"))
        if data.get("version") == VERSION:
            return data
    data = run(lumen)
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(data), encoding="utf-8")
    return data


if __name__ == "__main__":
    res = load_or_run(Lumen(), force=True)
    for c in res["cases"]:
        s, k = c["sun"], c["crowd"]
        print(f"{c['label']:<24} T={c['temp_c']}°C  trips={c['n_trips']}")
        print(f"   sun: shortest median {s['baseline_median_min']} min in sun; coolest saves median "
              f"{s['saved_median_min']} min ({s['saved_median_pct']}%), p75 {s['saved_p75_min']}; "
              f"{100 * s['share_trips_improved']:.0f}% of trips improve; detour median {s['detour_median_min']} "
              f"p90 {s['detour_p90_min']} min")
        print(f"   crowd: {k['trips_through_los_d']} trips hit LOS D+; calmest saves median {k['saved_median_min']} "
              f"min ({k['saved_median_pct']}%), detour median {k['detour_median_min']} min")
    print("took", res["seconds"], "s")
