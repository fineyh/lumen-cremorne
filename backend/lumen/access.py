"""Step-free access from OpenStreetMap: what a wheelchair, pram or walking-frame user meets on the way.

Two jobs:
* classify each walking-network edge (steps, raised kerb, rough surface, signalised or unmarked crossing)
  so the router can plan step-free routes;
* a map layer of stops and access features (kerb ramps, accessible crossings, parking, toilets, steps)
  with the detail people need before they set off.

OSM coverage is partial: a kerb with no tag is unknown, not inaccessible, and the layer says so.
"""
from __future__ import annotations

import json
import pathlib
import re

RAW = pathlib.Path(__file__).resolve().parents[2] / "data" / "raw"

ROUGH_SURFACES = {"gravel", "ground", "dirt", "unpaved", "grass", "sand", "mud", "sett", "unhewn_cobblestone",
                  "cobblestone", "pebblestone", "woodchips"}
BARRIERS = ("steps", "kerb", "blocked")  # edge classes a wheelchair can't get past


def _load() -> list[dict]:
    f = RAW / "access.json"
    return json.loads(f.read_text(encoding="utf-8"))["elements"] if f.exists() else []


def edge_class(tags: dict) -> str:
    """Access class of an OSM way, for every edge built from it."""
    hw = tags.get("highway")
    if hw == "steps" and tags.get("ramp:wheelchair") != "yes":
        return "steps"
    if tags.get("wheelchair") == "no":
        return "blocked"
    if tags.get("surface") in ROUGH_SURFACES or tags.get("smoothness") in ("bad", "very_bad", "horrible")\
            or tags.get("wheelchair") == "limited":
        return "rough"
    if hw == "footway" and tags.get("footway") == "crossing":
        return "signal" if tags.get("crossing") == "traffic_signals" else "unmarked"
    return ""


def raised_kerbs() -> set[tuple[float, float]]:
    """(lat, lon) keys of kerbs a wheelchair can't mount, matching the network's node keys."""
    out = set()
    for e in _load():
        t = e.get("tags", {})
        if e["type"] == "node" and (t.get("kerb") in ("raised", "rolled") or t.get("barrier") == "kerb" and t.get("wheelchair") == "no"):
            out.add((round(e["lat"], 7), round(e["lon"], 7)))
    return out


def _yes(v: str | None) -> bool | None:
    return None if v is None else v in ("yes", "designated")


def _point(e: dict) -> tuple[float, float] | None:
    c = e.get("center") or e
    return (c["lon"], c["lat"]) if "lon" in c else None


def features() -> list[dict]:
    """Access features for the map, one kind each (the most useful thing a person needs to know)."""
    out = []
    for e in _load():
        t = e.get("tags", {})
        pt = _point(e)
        if not pt:
            continue
        kind, props = None, {}
        hw, amenity = t.get("highway"), t.get("amenity")
        if amenity == "parking_space" and t.get("parking_space") == "disabled":
            kind = "parking"
        elif amenity == "toilets":
            kind = "toilet"
            props["wheelchair"] = t.get("wheelchair") or t.get("toilets:wheelchair")
        elif hw == "steps":
            kind = "steps"
            props.update(count=t.get("step_count"), handrail=_yes(t.get("handrail")),
                         ramp=t.get("ramp:wheelchair") in ("yes", "separate") or t.get("ramp") == "separate")
        elif hw == "elevator":
            kind = "lift"
        elif e["type"] == "node" and (t.get("kerb") in ("raised", "rolled") or t.get("barrier") == "kerb" and t.get("wheelchair") == "no"):
            kind = "kerb_raised"
        elif hw in ("crossing", "traffic_signals") and t.get("crossing") == "traffic_signals":
            kind = "signal"
            props.update(sound=_yes(t.get("traffic_signals:sound")), vibration=_yes(t.get("traffic_signals:vibration")),
                         tactile=_yes(t.get("tactile_paving")), kerb=t.get("kerb"), button=_yes(t.get("button_operated")))
        elif t.get("kerb") in ("lowered", "flush", "no") or hw == "crossing" and t.get("tactile_paving") == "yes":
            kind = "kerb"
            props.update(kerb=t.get("kerb"), tactile=_yes(t.get("tactile_paving")))
        elif t.get("wheelchair") in ("yes", "limited", "no") and t.get("name") and not t.get("public_transport")\
                and t.get("railway") != "platform":
            kind = "venue"
            props.update(wheelchair=t["wheelchair"], what=(amenity or t.get("shop") or t.get("office") or "place").replace("_", " "))
        if not kind:
            continue
        if t.get("name"):
            props["name"] = t["name"]
        out.append({"type": "Feature", "properties": {"kind": kind, **{k: v for k, v in props.items() if v is not None}},
                    "geometry": {"type": "Point", "coordinates": [round(pt[0], 6), round(pt[1], 6)]}})
    return out


def _stop_key(name: str) -> str:
    return re.sub(r"^Stop \w+:\s*", "", name).strip().lower()


def platforms() -> list[dict]:
    """Tram/train platforms and bus stops with their amenities."""
    out = []
    for e in _load():
        t = e.get("tags", {})
        pt = _point(e)
        if not pt or not (t.get("public_transport") == "platform" or t.get("railway") == "platform" or t.get("highway") == "bus_stop"):
            continue
        kind = "train" if t.get("train") == "yes" else "tram" if t.get("tram") == "yes" else "bus" if t.get("bus") == "yes" or t.get("highway") == "bus_stop" else None
        if not kind:
            continue
        out.append({
            "kind": kind, "name": t.get("name", ""), "lon": pt[0], "lat": pt[1],
            "routes": [r for r in re.split(r"[;,]\s*", t.get("route_ref", "")) if r],
            "wheelchair": t.get("wheelchair"), "shelter": _yes(t.get("shelter")), "bench": _yes(t.get("bench")),
            "tactile": _yes(t.get("tactile_paving")), "lit": _yes(t.get("lit")),
            "realtime": t.get("departures_board") == "realtime" or None,
        })
    return out


def _merge(vals: list) -> bool | None:
    known = [v for v in vals if v is not None]
    return any(known) if known else None


def stop_details(stops: list[dict]) -> dict[str, dict]:
    """Per stop id: level access, platforms, routes, shelter... gathered from nearby platforms of the same name."""
    plats = platforms()
    stations = {e["tags"]["name"].lower(): e["tags"] for e in json.loads((RAW / "transit.json").read_text(encoding="utf-8"))["elements"]
                if e.get("tags", {}).get("railway") == "station" and e["tags"].get("name")}
    out = {}
    for s in stops:
        if s["kind"] == "train":
            base = s["name"].removesuffix(" Station").lower()
            mine = [q for q in plats if q["kind"] == "train" and _near(q, s, 250)]
            st = stations.get(base, {})
            names = sorted({q["name"] for q in mine if q["name"].startswith("Platform")},
                           key=lambda n: int(re.sub(r"\D", "", n) or 0))
            out[s["id"]] = {
                "code": st.get("ref"), "wheelchair": st.get("wheelchair") or _wc([q["wheelchair"] for q in mine]),
                "platforms": len(names) or None, "fare_gates": _yes(st.get("fare_gates")),
                "shelter": _merge([q["shelter"] for q in mine]), "tactile": _merge([q["tactile"] for q in mine]),
                "realtime": _merge([q["realtime"] for q in mine])
            }
        else:
            key = _stop_key(s["name"].removesuffix(" (tram)"))
            mine = [q for q in plats if q["kind"] == "tram" and _stop_key(q["name"]) == key and _near(q, s, 250)]
            out[s["id"]] = {
                "wheelchair": _wc([q["wheelchair"] for q in mine]),
                "routes": sorted({r for q in mine for r in q["routes"]}, key=lambda r: (len(r), r)),
                "shelter": _merge([q["shelter"] for q in mine]), "bench": _merge([q["bench"] for q in mine]),
                "tactile": _merge([q["tactile"] for q in mine]), "realtime": _merge([q["realtime"] for q in mine]),
            }
    return out


def bus_stops() -> list[dict]:
    """Bus stops, with the two sides of the road merged into one."""
    out: list[dict] = []
    for q in platforms():
        if q["kind"] != "bus":
            continue
        twin = next((s for s in out if s["name"] == q["name"] and _near(q, s, 120)), None)
        if twin:
            twin["routes"] = sorted(set(twin["routes"]) | set(q["routes"]))
        else:
            out.append(dict(q))
    return out


def _wc(vals: list) -> str | None:
    known = [v for v in vals if v]
    if not known:
        return None
    return "yes" if all(v == "yes" for v in known) else "no" if all(v == "no" for v in known) else "limited"


def _near(a: dict, b: dict, metres: float) -> bool:
    return abs(a["lat"] - b["lat"]) * 110_574 < metres and abs(a["lon"] - b["lon"]) * 88_000 < metres
