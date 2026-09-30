"""Personal home screens for the phone app: one or two things that matter to *this* person today.

Rules, not a model: user settings (station, building, start time, usual streets) + today's heat
+ the crowd model -> a few recommendations with numbers. The optional local LLM may reword the
text afterwards, but brief.polish rejects any rewrite that changes a number.

Nothing here is stored. Settings arrive as query parameters, are used once and dropped.
"""
from __future__ import annotations

import math
import re

import numpy as np
import shapely

from .brief import polish
from .crowd import LOS_LETTERS
from .engine import Lumen, fmt_time
from .router import comfort, heat_factor

AREA_BUFFER = 120.0   # m around Cremorne: its boundary streets (Swan St) count as "in the precinct"
LUNCH_RADIUS = 400.0  # m from the office
SUN_WEIGHT = 1.5      # score = walk min + SUN_WEIGHT * H * sun min + CROWD_WEIGHT * crowded min + early min * EARLY_WEIGHT
CROWD_WEIGHT = 2.0
EARLY_WEIGHT = 0.15
DELIVERY_HOURS = [(390, 690), (810, 990)]  # 6:30-11:30, 1:30-4:30
WINDOW = 45


def _short(street: str) -> str:
    return street.replace(" Street", " St").replace(" Road", " Rd").replace(" Parade", " Pde")


def _span(a: int, b: int) -> str:
    return f"{fmt_time(a)}–{fmt_time(b)}"


def street_index(lumen: Lumen) -> dict[str, np.ndarray]:
    """Named streets in (and on the edge of) Cremorne -> their edge ids. Cached on the engine."""
    if getattr(lumen, "_street_index", None) is None:
        area = lumen.p.cremorne.buffer(AREA_BUFFER)
        mids = shapely.points(np.array([c.mean(axis=0) for c in lumen.p.e_coords]))
        inside = shapely.contains(area, mids)
        named = {n for n, _ in lumen.p.street_lines}
        idx: dict[str, list[int]] = {}
        for i, n in enumerate(lumen.labels):
            if inside[i] and n in named:
                idx.setdefault(n, []).append(i)
        lumen._street_index = {n: np.array(v) for n, v in idx.items() if lumen.p.e_len[v].sum() > 100}
    return lumen._street_index


def street_list(lumen: Lumen) -> list[str]:
    idx = street_index(lumen)
    return sorted(idx, key=lambda n: -float(lumen.p.e_len[idx[n]].sum()))


# ---------------------------------------------------------------------- office worker
def _best_departure(lumen: Lumen, a: int, b: int, scenario: str, arrive: int):
    """Try leaving the station every 5 minutes before `arrive`; score each route and time."""
    r = lumen.router
    probe = lumen.conditions(scenario, arrive - 10, shade_minutes=15 * round((arrive - 10) / 15))
    walk = r.path_stats(r._path(a, b, r.weights("shortest", probe)), probe)["minutes"]
    latest = int(5 * math.floor((arrive - walk - 1) / 5))
    best, usual = None, None
    for leave in range(latest - 30, latest + 1, 5):
        cond = lumen.conditions(scenario, leave, shade_minutes=15 * round(leave / 15))
        h = min(1.5, heat_factor(cond.temp_c))
        ce = comfort(cond)
        for mode in ("shortest", "coolest", "calmest"):
            nodes = r._path(a, b, r.weights(mode, cond))
            st = r.path_stats(nodes, cond, ce)
            if leave + st["minutes"] > arrive + 0.01:
                continue
            early = arrive - leave - st["minutes"]
            score = st["minutes"] + SUN_WEIGHT * h * st["sun_minutes"] + CROWD_WEIGHT * st["crowded_minutes"] + EARLY_WEIGHT * early
            cand = (score, -leave, mode, leave, nodes, cond, st)
            if best is None or cand[:2] < best[:2]:
                best = cand
            if mode == "shortest" and leave == latest:
                usual = (leave, nodes, cond, st)
    return best, usual


def _lunch(lumen: Lumen, office_node: int, scenario: str) -> dict | None:
    p = lumen.p
    ox, oy = p.node_xy[office_node]
    idx = street_index(lumen)
    near = {}
    for name, eids in idx.items():
        mid = np.array([p.e_coords[e].mean(axis=0) for e in eids])
        d = np.hypot(mid[:, 0] - ox, mid[:, 1] - oy)
        keep = eids[d < LUNCH_RADIUS]
        if p.e_len[keep].sum() > 60:
            near[name] = keep
    if len(near) < 2:
        return None
    times = list(range(705, 826, 15))  # 11:45 - 1:45
    conds = {t: lumen.conditions(scenario, t, shade_minutes=15 * round(t / 15)) for t in times}
    peak_t = 750
    rows = []
    for name, e in near.items():
        L = p.e_len[e]
        c = conds[peak_t]
        rows.append({
            "street": name,
            "per_m": float(np.average(c.crowd.per_m[e], weights=L)),
            "los": LOS_LETTERS[int(c.crowd.los[e].max())],
            "shaded_pct": round(100 * float(np.average(1 - c.sun[e], weights=L))) if c.shade.sun_up else 100,
        })
    rows.sort(key=lambda x: x["per_m"])
    quiet, busy = rows[0], rows[-1]
    # when is the busiest nearby street calmer?
    e = near[busy["street"]]
    series = [(t, float(np.average(conds[t].crowd.per_m[e], weights=p.e_len[e]))) for t in times]
    top = max(v for _, v in series)
    calm = [t for t, v in series if v < 0.6 * top]
    before = max((t for t in calm if t < peak_t), default=None)
    after = min((t for t in calm if t > peak_t), default=None)
    return {"time": fmt_time(peak_t), "quiet": quiet, "busy": busy,
            "calm_before": fmt_time(before) if before else None, "calm_after": fmt_time(after) if after else None,
            "streets": rows[:5]}


def _meeting(lumen: Lumen, office: str, meeting: str | None, scenario: str) -> dict | None:
    p = lumen.p
    me = next((o for o in p.offices if o["id"] == office), None)
    if meeting is None and me is not None:
        mx, my = p.node_xy[me["node"]]
        cands = [o for o in p.offices if o["name"] and re.search(r"[A-Za-z]{3}", o["name"]) and o["id"] != office]
        cands.sort(key=lambda o: abs(math.hypot(p.node_xy[o["node"]][0] - mx, p.node_xy[o["node"]][1] - my) - 450))
        meeting = cands[0]["id"] if cands else None
    if meeting is None:
        return None
    t = 900
    res = lumen.routes(office, meeting, scenario, t)
    cool = next(r for r in res["routes"] if r["mode"] == "coolest")
    short = res["routes"][0]
    return {"to": res["to"], "to_id": meeting, "time": fmt_time(t), "temp_c": res["temp_c"],
            "heat_matters": res["heat_factor"] > 0, "route": cool, "shortest": _slim(short)}


def _slim(r: dict) -> dict:
    return {k: r[k] for k in ("mode", "label", "minutes", "sun_minutes", "crowded_minutes", "comfort", "distance_m")}


def commuter(lumen: Lumen, stop: str, office: str, arrive: int, scenario: str, meeting: str | None = None,
             llm: bool = True) -> dict:
    sc = lumen.scenario(scenario)
    a, stop_name = lumen.resolve(stop)
    b, office_name = lumen.resolve(office)
    best, usual = _best_departure(lumen, a, b, scenario, arrive)
    _, _, mode, leave, nodes, cond, st = best
    route = lumen.router.describe(nodes, mode, cond)
    short_now = lumen.router.path_stats(lumen.router._path(a, b, lumen.router.weights("shortest", cond)), cond)
    vs_short = {
        "sun_saved": round(short_now["sun_minutes"] - st["sun_minutes"], 1),
        "crowd_saved": round(short_now["crowded_minutes"] - st["crowded_minutes"], 1),
        "extra_min": round(st["minutes"] - short_now["minutes"], 1),
    }
    vs_usual = None
    if usual:
        u_leave, _, _, u = usual
        vs_usual = {"leave": fmt_time(u_leave), "crowded_min": round(u["crowded_minutes"], 1),
                    "sun_min": round(u["sun_minutes"], 1), "comfort": round(u["comfort"])}
    heat = heat_factor(lumen.conditions(scenario, 900).temp_c) > 0
    lunch = _lunch(lumen, b, scenario)
    meet = _meeting(lumen, office, meeting, scenario) if office in {o["id"] for o in lumen.p.offices} else None

    via = [s["street"] for s in route["steps"] if s["street"] not in ("laneway", "crossing")]
    via = list(dict.fromkeys(via))[:2]
    tip = next((s for s in route["steps"] if s["shady_side"] and s["length_m"] > 60), None)
    lines = [f"Leave {stop_name} at {fmt_time(leave)} and walk {route['minutes']:.1f} min via "
             f"{', '.join(_short(v) for v in via)} to {office_name}."]
    if route["mode"] == "shortest" or (vs_short["sun_saved"] <= 0.05 and vs_short["crowd_saved"] <= 0.05):
        lines.append("The shortest way is also the most comfortable one this morning.")
    else:
        bits = []
        if vs_short["sun_saved"] > 0.05:
            bits.append(f"{vs_short['sun_saved']:.1f} min less sun")
        if vs_short["crowd_saved"] > 0.05:
            bits.append(f"{vs_short['crowd_saved']:.1f} min less crowding")
        lines.append(f"Compared with the shortest way: {' and '.join(bits)}, {max(0, vs_short['extra_min']):.1f} min more walking.")
    if vs_usual and vs_usual["leave"] != fmt_time(leave) and vs_usual["crowded_min"] - st["crowded_minutes"] > 0.2:
        lines.append(f"Leaving at {vs_usual['leave']} the short way would put you in {vs_usual['crowded_min']:.1f} min of crowded footpath.")
    if tip:
        lines.append(f"Keep to the {tip['shady_side']} side of {_short(tip['street'])}.")
    text, engine = polish(lines, "a commuter's phone card") if llm else (lines, "template")

    recs = []
    if lunch:
        q, bz = lunch["quiet"], lunch["busy"]
        when = " or ".join(x for x in (f"before {lunch['calm_before']}" if lunch["calm_before"] else "",
                                       f"after {lunch['calm_after']}" if lunch["calm_after"] else "") if x)
        recs.append({
            "kind": "lunch", "title": f"Lunch around {lunch['time']}",
            "text": f"{_short(q['street'])} is the quiet side (LOS {q['los']}, {q['shaded_pct']}% shaded). "
                    f"{_short(bz['street'])} is busiest (LOS {bz['los']})" + (f". Go {when} to miss the rush." if when else "."),
            "data": lunch,
        })
    if meet:
        rt, sh = meet["route"], meet["shortest"]
        if meet["heat_matters"] and sh["sun_minutes"] - rt["sun_minutes"] > 0.05:
            txt = (f"Coolest way is {rt['minutes']:.1f} min with {rt['sun_minutes']:.1f} min in the sun "
                   f"(shortest: {sh['sun_minutes']:.1f} min in the sun), +{max(0, rt['minutes'] - sh['minutes']):.1f} min.")
        elif meet["heat_matters"]:
            txt = f"The shortest way is already the shadiest: {rt['minutes']:.1f} min, {rt['sun_minutes']:.1f} min in the sun."
        else:
            txt = f"{meet['temp_c']:.0f}°C at {meet['time']}, so no need to chase shade: {sh['minutes']:.1f} min the short way."
        recs.append({"kind": "meeting", "title": f"Meeting at {meet['to']}, {meet['time']}", "text": txt, "data": meet})

    return {
        "role": "commuter",
        "scenario": {"key": sc["key"], "label": sc["label"], "tmax": round(sc["tmax"]), "tmin": round(sc["tmin"]),
                     "date": str(sc["date"]), "heat_matters": heat},
        "from": stop_name, "to": office_name, "arrive_by": fmt_time(arrive),
        "today": {
            "leave_at": fmt_time(leave), "leave_minutes": leave, "arrive_at": fmt_time(round(leave + route["minutes"])),
            "temp_c": round(cond.temp_c, 1), "route": route, "vs_shortest": vs_short, "vs_usual_time": vs_usual,
            "lines": text, "engine": engine,
        },
        "recommendations": recs,
    }


# ---------------------------------------------------------------------- delivery driver
def _windows(times: list[int], flags: list[bool], step: int) -> list[tuple[int, int]]:
    out, start = [], None
    for t, f in zip(times, flags):
        if f and start is None:
            start = t
        if not f and start is not None:
            out.append((start, t)); start = None
    if start is not None:
        out.append((start, times[-1] + step))
    return out


def street_day(lumen: Lumen, street: str, step: int = 5) -> dict:
    e = street_index(lumen)[street]
    times = list(range(360, 1200, step))
    per_m, los = [], []
    for t in times:
        f = lumen.crowd.frame(t)
        per_m.append(float(f.per_m[e].max()))
        los.append(int(f.los[e].max()))
    busy = _windows(times, [k >= 2 for k in los], step)
    merged: list[tuple[int, int]] = []
    for a, b in busy:  # a 5-minute lull between two train surges is not a delivery window
        if merged and a - merged[-1][1] <= 10:
            merged[-1] = (merged[-1][0], b)
        else:
            merged.append((a, b))
    busy = [w for w in merged if w[1] - w[0] >= 10]
    # quietest 45-min windows inside delivery hours that don't touch a busy window
    cands = []
    for lo, hi in DELIVERY_HOURS:
        for s in range(lo, hi - WINDOW + 1, 15):
            ks = [i for i, t in enumerate(times) if s <= t < s + WINDOW]
            if max(los[i] for i in ks) >= 2:
                continue
            cands.append((float(np.mean([per_m[i] for i in ks])), s))
    cands.sort()
    quiet = []
    for v, s in cands:
        if all(abs(s - q[0]) >= WINDOW for q in quiet):
            quiet.append((s, s + WINDOW, v))
        if len(quiet) == 2:
            break
    peak_i = int(np.argmax(per_m))
    return {
        "street": street, "short": _short(street),
        "timeline": [{"t": t, "per_m": round(v, 1), "los": LOS_LETTERS[k]} for t, v, k in zip(times, per_m, los)][::3],
        "busy": [{"from": fmt_time(a), "to": fmt_time(b), "from_min": a, "to_min": b,
                  "worst": LOS_LETTERS[max(los[i] for i, t in enumerate(times) if a <= t < b)]} for a, b in busy],
        "quiet": [{"from": fmt_time(a), "to": fmt_time(b), "from_min": a, "to_min": b} for a, b, _ in sorted(quiet)],
        "peak": {"time": fmt_time(times[peak_i]), "los": LOS_LETTERS[los[peak_i]], "per_m": round(per_m[peak_i], 1)},
    }


def driver_sms(days: list[dict]) -> str:
    """One text, plain GSM-7 characters only (an en dash would force UCS-2 and halve the length limit)."""
    span = lambda a, b: f"{fmt_time(a)}-{fmt_time(b)}"  # noqa: E731
    parts = ["Lumen Cremorne today:"]
    for d in days:
        if d["busy"]:
            b = d["busy"][0]
            q = ", ".join(span(w["from_min"], w["to_min"]) for w in d["quiet"])
            parts.append(f"{d['short']} busy {span(b['from_min'], b['to_min'])}" + (f", unload {q}." if q else "."))
        else:
            parts.append(f"{d['short']} quiet all day.")
    parts.append("Reply CHANGE to edit, STOP to opt out.")
    return " ".join(parts)


def driver(lumen: Lumen, streets: list[str], scenario: str, llm: bool = True) -> dict:
    idx = street_index(lumen)
    streets = [s for s in streets if s in idx][:4] or ["Swan Street", "Cremorne Street"]
    days = [street_day(lumen, s) for s in streets]
    # one window that suits the whole run
    all_quiet = None
    for lo, hi in DELIVERY_HOURS:
        for s in range(lo, hi - WINDOW + 1, 15):
            ok = all(not any(w["from_min"] < s + WINDOW and s < w["to_min"] for w in d["busy"]) for d in days)
            if ok:
                all_quiet = (s, s + WINDOW)
                break
        if all_quiet:
            break
    lines = []
    for d in days:
        if d["busy"]:
            b = d["busy"][0]
            lines.append(f"{d['short']}: busy {_span(b['from_min'], b['to_min'])} (LOS {b['worst']}, train arrivals).")
        else:
            lines.append(f"{d['short']}: no crowding expected today.")
    if all_quiet:
        lines.append(f"Best window for the whole run: {_span(*all_quiet)}.")
    text, engine = polish(lines, "a delivery driver's phone card") if llm else (lines, "template")
    sc = lumen.scenario(scenario)
    return {"role": "driver", "scenario": {"key": sc["key"], "label": sc["label"], "tmax": round(sc["tmax"])},
            "streets": days, "best_window": {"from": fmt_time(all_quiet[0]), "to": fmt_time(all_quiet[1])} if all_quiet else None,
            "lines": text, "engine": engine, "sms": driver_sms(days)}


# ---------------------------------------------------------------------- shop owner
def merchant(lumen: Lumen, node_id: str, open_t: int, close_t: int, scenario: str, llm: bool = True) -> dict:
    node = next((n for n in lumen.crowd.nodes if n["id"] == node_id), None) or lumen.crowd.nodes[1]
    today = lumen.crowd.node_profile(node["id"])
    # Last week's replay: same model, a different day's noise (synthetic, labelled in the UI).
    rng = np.random.default_rng(int(node["id"][-2:]) * 7 + 1)
    drift = rng.uniform(0.9, 1.02)
    last = [{"hour": h["hour"], "people": int(round(h["people"] * drift * rng.uniform(0.9, 1.1)))} for h in today]
    peak = max(today, key=lambda h: h["people"])
    top = peak["people"]
    busy = [h["hour"] for h in today if h["people"] >= 0.75 * top]
    open_h, close_h = open_t // 60, math.ceil(close_t / 60)
    recs = []
    # staffing: group busy hours into runs
    runs, cur = [], []
    for h in busy:
        if cur and h != cur[-1] + 1:
            runs.append(cur); cur = []
        cur.append(h)
    if cur:
        runs.append(cur)
    for run in runs[:2]:
        ppl = sum(x["people"] for x in today if x["hour"] in run)
        recs.append({"kind": "roster", "title": f"Extra hands {fmt_time(run[0] * 60)}–{fmt_time((run[-1] + 1) * 60)}",
                     "text": f"About {ppl:,} people pass in {'those ' + str(len(run)) + ' hours' if len(run) > 1 else 'that hour'}, "
                             f"your busiest stretch. Roster one more person."})
    before = next((h for h in today if h["hour"] == open_h - 1), None)
    if before and before["people"] >= 0.5 * top:
        recs.append({"kind": "open", "title": f"Open at {fmt_time((open_h - 1) * 60)}?",
                     "text": f"{before['people']:,} people walk past between {fmt_time((open_h - 1) * 60)} and "
                             f"{fmt_time(open_h * 60)}, before you open."})
    after = next((h for h in today if h["hour"] == close_h), None)
    if after and after["people"] >= 0.5 * top:
        recs.append({"kind": "close", "title": f"Stay open until {fmt_time((close_h + 1) * 60)}?",
                     "text": f"The home-time wave brings {after['people']:,} people past between {fmt_time(close_h * 60)} "
                             f"and {fmt_time((close_h + 1) * 60)}, after you close."})
    quiet = [h for h in today if open_h <= h["hour"] < close_h and h["people"] < 0.3 * top]
    if quiet:
        recs.append({"kind": "quiet", "title": f"Quiet from {fmt_time(quiet[0]['hour'] * 60)}",
                     "text": f"{len(quiet)} open hour{'s' if len(quiet) > 1 else ''} under 30% of peak. "
                             f"Good for deliveries, prep and breaks."})
    cond = lumen.conditions(scenario, 930)
    sunlit = round(100 * float(cond.sun[node["edge"]]))
    if heat_factor(cond.temp_c) > 0 and sunlit >= 50:
        recs.append({"kind": "heat", "title": f"{cond.temp_c:.0f}°C at 3:30pm",
                     "text": f"Your footpath is {sunlit}% in sun then. Walkers drift to the shady side, so an umbrella "
                             f"or awning keeps them on yours."})
    tot, tot_last = sum(h["people"] for h in today), sum(h["people"] for h in last)
    wow = round(100 * (tot - tot_last) / tot_last, 1) if tot_last else 0.0
    lines = [f"{tot:,} people passed your window yesterday, {'+' if wow >= 0 else ''}{wow}% on the same day last week.",
             f"Peak: {fmt_time(peak['hour'] * 60)}–{fmt_time((peak['hour'] + 1) * 60)}, about {peak['people']:,} people."]
    text, engine = polish(lines, "a shop owner's phone card") if llm else (lines, "template")
    return {"role": "merchant", "node": {k: node[k] for k in ("id", "street", "lon", "lat")},
            "today": today, "last_week": last, "total": tot, "wow_pct": wow, "peak": peak,
            "open": fmt_time(open_t), "close": fmt_time(close_t), "lines": text, "engine": engine,
            "recommendations": recs}


# ---------------------------------------------------------------------- CDH / council
def council(lumen: Lumen, scenario: str) -> dict:
    rows = lumen.street_table(scenario)
    crowded = [r for r in rows if r["am_peak_los"] in "DEF"][:3]
    sunny = sorted(rows, key=lambda r: -r["sunlit_pct_1530_hot_day"] * r["length_m"])[:3]
    st = lumen.state(scenario, 930)
    return {"role": "council", "comfort_1530": st["comfort"], "shaded_share_1530": st["shaded_share"],
            "crowded": crowded, "sunny": sunny, "n_streets": len(rows)}
