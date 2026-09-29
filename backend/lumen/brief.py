"""Morning Brief and Ask Lumen.

Numbers only ever come from the backend. The local LLM (Ollama, if running) may reword the brief,
but its output is rejected unless every number from the facts survives unchanged. Without a model
the deterministic template is used, so the demo never depends on the LLM.
"""
from __future__ import annotations

import json
import os
import re

import requests

from .crowd import LOS_LETTERS
from .engine import Lumen, fmt_time

OLLAMA = os.environ.get("LUMEN_OLLAMA", "http://127.0.0.1:11434")
MODEL = os.environ.get("LUMEN_MODEL", "qwen2.5:7b")
DEFAULT_ORIGIN = "train-richmond"


def _office_name(lumen: Lumen, office_id: str) -> str:
    return lumen.resolve(office_id)[1]


def _pick_route(routes: list[dict], mode: str) -> dict:
    return next(r for r in routes if r["mode"] == mode)


def brief_facts(lumen: Lumen, scenario: str, office_id: str) -> dict:
    sc = lumen.scenario(scenario)
    am = lumen.routes(DEFAULT_ORIGIN, office_id, scenario, 525)
    pm = lumen.routes(DEFAULT_ORIGIN, office_id, scenario, 930)
    am_cond = lumen.conditions(scenario, 525)
    calm = _pick_route(am["routes"], "calmest")
    cool = _pick_route(pm["routes"], "coolest")
    short_am = _pick_route(am["routes"], "shortest")
    short_pm = _pick_route(pm["routes"], "shortest")
    # the most crowded segment on the usual (shortest) way in that the calm route avoids
    avoided = [e for e in short_am["edges"] if e not in set(calm["edges"]) and am_cond.crowd.los[e] >= 3]
    worst = None
    if avoided:
        e = max(avoided, key=lambda k: am_cond.crowd.per_m[k])
        worst = {"street": lumen.labels[e], "los": LOS_LETTERS[int(am_cond.crowd.los[e])]}
    via = [v for v in _via(calm, short_am) if not worst or v != worst["street"]]
    via_cool = _via(cool, short_pm)
    shady_tip = next((s for s in cool["steps"] if s["shady_side"] and s["length_m"] > 60), None)
    return {
        "scenario": sc["label"],
        "date": str(sc["date"]),
        "tmax": round(sc["tmax"]),
        "office": _office_name(lumen, office_id),
        "am_time": "8:45am",
        "am_worst_street": worst["street"] if worst else None,
        "am_worst_los": worst["los"] if worst else "A",
        "am_calm_via": _dedupe(via)[:3],
        "am_calm_extra_min": calm["vs_shortest"]["extra_min"],
        "am_crowd_min_shortest": short_am["crowded_minutes"],
        "am_crowd_min_calm": calm["crowded_minutes"],
        "pm_time": "3:30pm",
        "pm_temp": round(pm["temp_c"]),
        "pm_cool_via": _dedupe(via_cool)[:3],
        "pm_cool_extra_min": cool["vs_shortest"]["extra_min"],
        "pm_sun_min_shortest": short_pm["sun_minutes"],
        "pm_sun_min_cool": cool["sun_minutes"],
        "pm_shady_side": {"street": shady_tip["street"], "side": shady_tip["shady_side"]} if shady_tip else None,
        "heat_matters": pm["heat_factor"] > 0,
    }


def _via(route: dict, base: dict) -> list[str]:
    """Streets that make this route different from the shortest one (longest first)."""
    base_streets = {s["street"] for s in base["steps"]}
    lengths: dict[str, float] = {}
    for s in route["steps"]:
        if s["street"] not in ("laneway", "crossing"):
            lengths[s["street"]] = lengths.get(s["street"], 0) + s["length_m"]
    new = [k for k in lengths if k not in base_streets]
    return new or sorted(lengths, key=lambda k: -lengths[k])


def _dedupe(xs):
    out = []
    for x in xs:
        if x not in out:
            out.append(x)
    return out


def template(f: dict) -> list[str]:
    lines = []
    if f["heat_matters"]:
        lines.append(f"☀️ *Cremorne today:* {f['tmax']}°C by mid-afternoon. Shade matters today.")
    else:
        lines.append(f"🌤️ *Cremorne today:* top of {f['tmax']}°C, so no need to chase shade. Shortest is best.")
    if f["am_worst_street"] and LOS_LETTERS.index(f["am_worst_los"]) >= 3:
        lines.append(
            f"🚶 *{f['am_time']} crunch:* {f['am_worst_street']} reaches LOS {f['am_worst_los']} after each train. "
            f"{'Via ' + ', '.join(f['am_calm_via']) if f['am_calm_via'] else 'Lumen’s quieter footpaths'} "
            f"to {f['office']}: +{max(f['am_calm_extra_min'], 0):.1f} min, "
            f"crowded walking {f['am_crowd_min_shortest']:.1f} → {f['am_crowd_min_calm']:.1f} min."
        )
    else:
        lines.append(f"🚶 *{f['am_time']}:* footpaths are flowing freely. Take your usual way in.")
    if f["heat_matters"]:
        tip = ""
        if f["pm_shady_side"]:
            tip = f" Keep to the {f['pm_shady_side']['side']} side of {f['pm_shady_side']['street']}."
        lines.append(
            f"🌳 *{f['pm_time']} ({f['pm_temp']}°C):* the coolest walk from Richmond Station to {f['office']} goes via "
            f"{', '.join(f['pm_cool_via'])}. Sun time drops {f['pm_sun_min_shortest']:.1f} → {f['pm_sun_min_cool']:.1f} min "
            f"for +{max(f['pm_cool_extra_min'], 0):.1f} min.{tip}"
        )
    return lines


def _numbers(text: str) -> set[str]:
    return set(re.findall(r"\d+(?:\.\d+)?", text))


def ollama_available() -> str | None:
    try:
        tags = requests.get(f"{OLLAMA}/api/tags", timeout=0.8).json().get("models", [])
        names = [t["name"] for t in tags]
        if MODEL in names:
            return MODEL
        return names[0] if names else None
    except Exception:
        return None


def polish(lines: list[str]) -> tuple[list[str], str]:
    """Let the local model reword the brief; keep the template if any number changed."""
    model = ollama_available()
    if not model:
        return lines, "template"
    prompt = (
        "Rewrite this Slack message for office workers in Cremorne, Melbourne. Keep exactly 3 lines, "
        "keep each emoji at the start of its line, keep every number exactly as written, be friendly and brief. "
        "Return only the message.\n\n" + "\n".join(lines)
    )
    try:
        r = requests.post(f"{OLLAMA}/api/generate", json={"model": model, "prompt": prompt, "stream": False,
                                                          "options": {"temperature": 0.3}}, timeout=45)
        text = r.json()["response"].strip()
        out = [l.strip() for l in text.splitlines() if l.strip()]
        if _numbers("\n".join(lines)) <= _numbers(text) and 2 <= len(out) <= 4:
            return out, f"ollama:{model}"
    except Exception:
        pass
    return lines, "template"


def morning_brief(lumen: Lumen, scenario: str, office_id: str, use_llm: bool = True) -> dict:
    facts = brief_facts(lumen, scenario, office_id)
    lines = template(facts)
    text, engine = polish(lines) if use_llm else (lines, "template")
    return {"posted_at": "8:15am", "channel": "#cremorne-precinct", "lines": text, "facts": facts, "engine": engine}


# ---------------------------------------------------------------------- Ask Lumen

TOOLS = [
    {"type": "function", "function": {
        "name": "get_route", "description": "Walking routes between two places in Cremorne",
        "parameters": {"type": "object", "properties": {
            "origin": {"type": "string"}, "destination": {"type": "string"},
            "mode": {"type": "string", "enum": ["shortest", "coolest", "calmest"]},
            "time": {"type": "string", "description": "e.g. 3:30pm"}}, "required": ["destination"]}}},
    {"type": "function", "function": {
        "name": "get_crowd", "description": "Which Cremorne streets are busy or quiet at a time",
        "parameters": {"type": "object", "properties": {"time": {"type": "string"}}}}},
    {"type": "function", "function": {
        "name": "get_hotspots", "description": "Most sun-exposed and most crowded streets at a time",
        "parameters": {"type": "object", "properties": {"time": {"type": "string"}}}}},
]


def parse_time(text: str, default: int) -> int:
    m = re.search(r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b", text, re.I) or re.search(r"\b(\d{1,2}):(\d{2})\b", text)
    if not m:
        if re.search(r"lunch", text, re.I):
            return 750
        if re.search(r"morning", text, re.I):
            return 525
        if re.search(r"afternoon", text, re.I):
            return 930
        if re.search(r"evening|tonight|home", text, re.I):
            return 1080
        return default
    h = int(m.group(1)); mi = int(m.group(2) or 0)
    ap = m.group(3).lower() if m.lastindex and m.lastindex >= 3 and m.group(3) else None
    if ap == "pm" and h < 12:
        h += 12
    if ap == "am" and h == 12:
        h = 0
    return max(0, min(1439, h * 60 + mi))


def _find_place(lumen: Lumen, text: str) -> list[tuple[int, str]]:
    """Places mentioned in the text, in order of appearance: (position, ref)."""
    found = []
    low = text.lower()
    for s in lumen.p.stops:
        key = s["name"].lower().replace(" (tram)", "").replace(" station", "")
        i = low.find(key)
        if i >= 0 and (s["kind"] == "train" or "tram" in low):
            found.append((i, s["id"], len(key)))
    for o in lumen.p.offices:
        if o["name"]:
            i = low.find(o["name"].lower())
            if i >= 0:
                found.append((i, o["id"], len(o["name"])))
    # prefer longest match at a position ("east richmond" over "richmond")
    found.sort(key=lambda f: (f[0], -f[2]))
    out, last_end = [], -1
    for i, ref, n in found:
        if i >= last_end:
            out.append((i, ref)); last_end = i + n
    return out


def tool_get_route(lumen, scenario, minutes, office_id, origin=None, destination=None, mode=None, time=None, question=""):
    t = parse_time(time or question, minutes)
    places = _find_place(lumen, question)
    o = origin or (places[0][1] if len(places) >= 2 else DEFAULT_ORIGIN)
    d = destination or (places[-1][1] if places else office_id)
    if mode is None:
        q = question.lower()
        mode = "calmest" if re.search(r"crowd|busy|quiet|packed", q) else "coolest"
    res = lumen.routes(o, d, scenario, t)
    r = _pick_route(res["routes"], mode)
    base = res["routes"][0]
    via = ", ".join(_via(r, base)[:3])
    if mode == "calmest":
        gain = f"crowded walking {base['crowded_minutes']} → {r['crowded_minutes']} min"
    else:
        gain = f"time in the sun {base['sun_minutes']} → {r['sun_minutes']} min"
    answer = (f"{r['label']} route from {res['from']} to {res['to']} at {res['time']} ({res['temp_c']}°C): "
              f"{r['minutes']} min via {via}. vs shortest: +{max(r['vs_shortest']['extra_min'], 0)} min, {gain}.")
    if r.get("note"):
        answer += " " + r["note"]
    return answer, {"type": "route", "from": o, "to": d, "mode": mode, "minutes": t}


def tool_get_crowd(lumen, scenario, minutes, time=None, question="", **_):
    t = parse_time(time, minutes) if time else parse_time(question, minutes)
    cond = lumen.conditions(scenario, t)
    import numpy as np

    streets = {}
    street_names = {n for n, _ in lumen.p.street_lines} - {"Punt Road", "Alexandra Avenue"}
    for i in np.nonzero(lumen.in_cremorne)[0]:
        name = lumen.labels[i]
        if name not in street_names:
            continue
        s = streets.setdefault(name, [0.0, 0.0])
        s[0] += float(cond.crowd.per_m[i]) * lumen.p.e_len[i]; s[1] += lumen.p.e_len[i]
    avg = sorted(((v[0] / v[1], k) for k, v in streets.items() if v[1] > 80))
    quiet = ", ".join(k for _, k in avg[:3])
    busy = ", ".join(f"{k} ({v:.0f} ppl/min/m)" for v, k in avg[::-1][:3])
    return (f"Around {fmt_time(t)}: busiest are {busy}. Quietest are {quiet}. "
            f"(Modelled from window-node replay and train arrivals.)"), {"type": "crowd", "minutes": t}


def tool_get_hotspots(lumen, scenario, minutes, time=None, question="", **_):
    t = parse_time(time, minutes) if time else parse_time(question, minutes)
    cond = lumen.conditions(scenario, t)
    h = lumen.hotspots(cond, n=3)
    hot = ", ".join(f"{x['street']} ({x['sunlit_pct']}% sunlit)" for x in h["hot"])
    if not cond.shade.sun_up:
        return f"At {fmt_time(t)} the sun is down, so heat exposure is not an issue.", {"type": "hotspots", "minutes": t}
    return (f"At {fmt_time(t)} ({cond.temp_c:.0f}°C) most people are walking in the sun on {hot}. "
            f"Busiest: {h['crowded'][0]['street']} (LOS {h['crowded'][0]['los']})."), {"type": "hotspots", "minutes": t}


def ask(lumen: Lumen, question: str, scenario: str, minutes: int, office_id: str) -> dict:
    ctx = dict(scenario=scenario, minutes=minutes)
    fns = {"get_route": tool_get_route, "get_crowd": tool_get_crowd, "get_hotspots": tool_get_hotspots}
    model = ollama_available()
    if model:
        try:
            r = requests.post(f"{OLLAMA}/api/chat", timeout=40, json={
                "model": model, "stream": False, "tools": TOOLS,
                "messages": [
                    {"role": "system", "content": "You are Lumen, a precinct assistant for Cremorne, Melbourne. "
                                                  "Always call exactly one tool."},
                    {"role": "user", "content": question}],
            }).json()
            calls = r.get("message", {}).get("tool_calls") or []
            if calls:
                c = calls[0]["function"]
                args = c.get("arguments") or {}
                if isinstance(args, str):
                    args = json.loads(args)
                args = {k: v for k, v in args.items() if k in ("origin", "destination", "mode", "time") and v}
                # model-proposed place names are resolved by our own matcher, never trusted as ids
                args.pop("origin", None); args.pop("destination", None)
                fn = fns.get(c["name"])
                if fn:
                    extra = {"office_id": office_id} if fn is tool_get_route else {}
                    answer, action = fn(lumen, **ctx, **extra, **args, question=question)
                    return {"answer": answer, "action": action, "tool": c["name"], "engine": f"ollama:{model}"}
        except Exception:
            pass
    q = question.lower()
    if re.search(r"route|walk|get to|how do i|\bway\b|go to|head to|meeting", q):
        answer, action = tool_get_route(lumen, **ctx, office_id=office_id, question=question)
        tool = "get_route"
    elif re.search(r"lunch|busy|crowd|quiet|people|packed", q):
        answer, action = tool_get_crowd(lumen, **ctx, question=question)
        tool = "get_crowd"
    elif re.search(r"hot|heat|sun|shade|cool|temperature", q):
        answer, action = tool_get_hotspots(lumen, **ctx, question=question)
        tool = "get_hotspots"
    else:
        return {"answer": "I can help with routes (\"coolest way to Dover House at 3:30pm?\"), crowds "
                          "(\"where's quiet for lunch?\") and heat (\"which streets are hottest now?\").",
                "action": None, "tool": None, "engine": "rules"}
    return {"answer": answer, "action": action, "tool": tool, "engine": "rules"}
