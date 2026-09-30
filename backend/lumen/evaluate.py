"""Offline evaluation: does Lumen measurably improve the walk to work?

For every (stop -> workplace) pair, compare the shortest route with Lumen's coolest and calmest
routes under three conditions: hot-day 8:45, hot-day 15:30 and a mild control day at 15:30
(where Lumen should *not* send anyone on a detour).

    python -m lumen.evaluate                         # from backend/, writes data/cache/evaluation.json
    python -m lumen.evaluate --plan <id or file>     # re-run the same trips with a what-if plan applied

With --plan, only trips whose shortest or coolest path touches a segment the plan changes are
re-computed (the rest are provably identical), and the before / after is printed per case.
"""
from __future__ import annotations

import argparse
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


def run_plan(lumen: Lumen, raw: dict) -> dict:
    """Before / after for a what-if plan under every evaluation case."""
    plan = lumen.whatif.register(raw)
    out = {"plan": raw.get("name") or plan.key, "key": plan.key, "years": plan.years, "cases": []}
    for case in CASES:
        r = lumen.whatif.compare(lumen, plan, case["scenario"], case["minutes"])
        out["cases"].append({**case, **{k: v for k, v in r.items() if k not in ("new_shadows", "edges")}})
    return out


def _load_plan(ref: str) -> dict:
    from .whatif import load_saved

    f = pathlib.Path(ref)
    if f.exists():
        return json.loads(f.read_text(encoding="utf-8"))
    doc = load_saved(ref)
    if doc is None:
        raise SystemExit(f"no plan file or saved plan id '{ref}'")
    return doc


def _print_plan(res: dict) -> None:
    print(f"What-if plan: {res['plan']} (key {res['key']}, trees at year {res['years']:g})")
    cost = res["cases"][0]["cost"]
    print(f"   indicative capital cost A${cost['low']:,}-{cost['high']:,}"
          + (f", closures A${cost['closure_per_day'][0]:,}-{cost['closure_per_day'][1]:,}/day" if cost["closure_per_day"] else ""))
    for c in res["cases"]:
        u, k = c["usual"], c["coolest"]
        print(f"{c['label']:<24} T={c['temp_c']}°C  re-computed {c['trips_recomputed']}/{c['trips_total']} trips "
              f"in {c['compute_ms']} ms")
        print(f"   shaded share {100 * c['precinct']['shaded_share'][0]:.1f}% -> {100 * c['precinct']['shaded_share'][1]:.1f}%  "
              f"comfort {c['precinct']['comfort'][0]} -> {c['precinct']['comfort'][1]}")
        print(f"   usual routes: sun {u['sun_min'][0]} -> {u['sun_min'][1]} min total ({u['trips_benefit']} trips better, "
              f"{u['trips_worse']} worse, {u['trips_detoured']} detoured); ~{u['person_sun_min_saved']} person-min saved")
        print(f"   coolest routes: sun {k['sun_min'][0]} -> {k['sun_min'][1]} min, walking {k['walk_min'][0]} -> {k['walk_min'][1]} min")
        print(f"   {c['trips_benefit']} station -> workplace trips benefit")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--plan", help="saved plan id (data/whatif/<id>.json) or a plan JSON file")
    args = ap.parse_args()
    if args.plan:
        lumen = Lumen()
        res = run_plan(lumen, _load_plan(args.plan))
        _print_plan(res)
        dest = CACHE.parent / f"whatif-eval-{res['key']}.json"
        dest.write_text(json.dumps(res), encoding="utf-8")
        print("wrote", dest)
        raise SystemExit(0)
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
