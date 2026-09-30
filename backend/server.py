"""Lumen API server.

    cd backend
    python server.py              # http://localhost:8000  (serves the built frontend too)

Everything runs on this machine: no cloud APIs, no images, no personal data.
"""
from __future__ import annotations

import asyncio
import csv
import io
import json
import mimetypes
import os
import pathlib
import socket
import threading
import time
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, PlainTextResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from lumen import brief as brief_mod
from lumen import evaluate, personal, sms
from lumen import whatif as whatif_mod
from lumen.engine import SCENARIOS, Lumen
from lumen.live import LiveHub, Reading
from lumen.router import MODES

mimetypes.add_type("text/javascript", ".mjs")  # Windows registries often map .mjs wrongly; module workers need JS
mimetypes.add_type("application/manifest+json", ".webmanifest")
ROOT = pathlib.Path(__file__).resolve().parents[1]
DIST = ROOT / "frontend" / "dist"

print("Loading Cremorne precinct model ...")
t0 = time.time()
lumen = Lumen()
hub = LiveHub()
print(f"  {len(lumen.p.buildings)} buildings, {len(lumen.p.tree_xy)} trees, "
      f"{lumen.p.graph.number_of_edges()} path segments in {time.time() - t0:.1f}s")


def fast(obj) -> Response:
    """Serialise with plain json.dumps; FastAPI's default encoder is very slow on MB-sized GeoJSON."""
    return Response(json.dumps(obj, separators=(",", ":")), media_type="application/json")


STATIC = {
    name: json.dumps(fn(), separators=(",", ":"))
    for name, fn in (("network", lumen.network_geojson), ("buildings", lumen.buildings_geojson),
                     ("trees", lumen.trees_geojson))
}
EVAL: dict = {}
# Council smart poles: locations only; their sensor data isn't published.
POLES = json.loads((ROOT / "data" / "raw" / "yarra_smart_poles.json").read_text(encoding="utf-8"))


def _warm():
    """Pre-compute the evaluation and today's shadow frames so the demo never waits."""
    EVAL.update(evaluate.load_or_run(lumen))
    for key in ("hot", "mild"):
        d = lumen.scenario(key)["date"]
        for m in range(360, 1260 + 1, 15):
            lumen.shade.shadow_geojson(d, m)
    print("  warm-up done")


@asynccontextmanager
async def lifespan(app: FastAPI):
    hub.loop = asyncio.get_running_loop()
    print("  MQTT:", hub.start_mqtt())
    threading.Thread(target=_warm, daemon=True).start()
    yield


app = FastAPI(title="Lumen", lifespan=lifespan)
app.add_middleware(GZipMiddleware, minimum_size=2000)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def _minutes(t: int) -> int:
    return max(0, min(1439, int(t)))


def _plan(key: str | None):
    """Resolve a what-if plan key (registered by POST /api/whatif/compare)."""
    if not key:
        return None
    plan = lumen.whatif.get(key)
    if plan is None:
        raise HTTPException(404, "unknown what-if plan; post it to /api/whatif/compare first")
    return plan


def _lan_url() -> str:
    """Address phones on the same Wi-Fi can open (for the QR code on the Console)."""
    if public := os.environ.get("LUMEN_PUBLIC_URL"):  # deployed behind a domain: the LAN IP is meaningless
        return public.rstrip("/")
    ip = "127.0.0.1"
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))  # no packet is sent; this just picks the outgoing interface
        ip = s.getsockname()[0]
        s.close()
    except OSError:
        pass
    return f"http://{ip}:{os.environ.get('LUMEN_PORT', 8000)}"


@app.get("/api/meta")
def meta():
    p = lumen.p
    offices = sorted(p.offices, key=lambda o: (o["name"] is None, o["name"] or ""))
    return {
        "scenarios": [{"key": k, "label": v["label"], "note": v["note"], "tmax": v["tmax"]} for k, v in SCENARIOS.items()],
        "modes": [{"key": k, "label": v["label"]} for k, v in MODES.items()],
        "stops": [{k: s[k] for k in ("id", "name", "kind", "lon", "lat")} for s in p.stops],
        "offices": [{k: o[k] for k in ("id", "name", "street", "lon", "lat", "levels")} for o in offices],
        "nodes": lumen.crowd.nodes,
        "poles": {"sensors": POLES["sensors"], "items": POLES["poles"]},
        "center": [144.9942, -37.8282],
        "stats": {
            "buildings": len(p.buildings), "trees": int(len(p.tree_xy)),
            "segments": int(p.graph.number_of_edges()), "network_km": round(float(p.e_len.sum()) / 1000, 1),
        },
        "llm": brief_mod.ollama_available(),
        "streets": personal.street_list(lumen),
        "lan_url": _lan_url(),
        "whatif": {"tree_sizes": whatif_mod.TREE_SIZES, "canopies": whatif_mod.CANOPIES,
                   "mature_years": whatif_mod.MATURE_YEARS, "costs": whatif_mod.COSTS,
                   "cost_note": whatif_mod.COST_NOTE},
    }


@app.get("/api/layers/{name}")
def layer(name: str):
    if name not in STATIC:
        raise HTTPException(404)
    return Response(STATIC[name], media_type="application/json")


@app.get("/api/state")
def state(scenario: str = "hot", t: int = 525, temp: float | None = None, plan: str | None = None):
    return fast(lumen.state(scenario, _minutes(t), temp, _plan(plan)))


@app.get("/api/shadows")
def shadows(scenario: str = "hot", t: int = 525):
    return fast(lumen.shade.shadow_geojson(lumen.scenario(scenario)["date"], _minutes(t)))


@app.get("/api/route")
def route(src: str = Query(..., alias="from"), dst: str = Query(..., alias="to"),
          scenario: str = "hot", t: int = 525, temp: float | None = None, plan: str | None = None):
    pl = _plan(plan)
    try:
        return fast(lumen.routes(src, dst, scenario, _minutes(t), temp, pl))
    except (ValueError, KeyError) as exc:
        raise HTTPException(400, f"unknown place: {exc}")


@app.get("/api/evaluation")
def evaluation():
    if not EVAL:
        raise HTTPException(503, "evaluation still running")
    return fast(EVAL)


@app.get("/api/brief")
def morning_brief(scenario: str = "hot", office: str | None = None, llm: bool = True):
    office = office or _default_office()
    return brief_mod.morning_brief(lumen, scenario, office, use_llm=llm)


class AskBody(BaseModel):
    question: str
    scenario: str = "hot"
    t: int = 750
    office: str | None = None


@app.post("/api/ask")
def ask(body: AskBody):
    # The question is used once to answer and never stored.
    return brief_mod.ask(lumen, body.question[:300], body.scenario, _minutes(body.t), body.office or _default_office())


@app.get("/api/nodes/{node_id}/profile")
def node_profile(node_id: str):
    try:
        return lumen.crowd.node_profile(node_id)
    except StopIteration:
        raise HTTPException(404)


@app.get("/api/report.csv", response_class=PlainTextResponse)
def report(scenario: str = "hot"):
    rows = lumen.street_table(scenario)
    buf = io.StringIO()
    buf.write("# Lumen weekly precinct report (modelled from window-node replay; not measured)\n")
    w = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)
    return PlainTextResponse(buf.getvalue(), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=lumen-weekly-report.csv"})


@app.get("/api/report")
def report_json(scenario: str = "hot"):
    return lumen.street_table(scenario)


# ---------------------------------------------------------------------- what-if plans
class PlanBody(BaseModel):
    items: list[dict] = []
    years: float = 1
    scenario: str = "hot"
    t: int = 930
    name: str | None = None
    note: str = ""


def _compare(raw: dict, scenario: str, t: int, slim: bool = False) -> dict:
    plan = lumen.whatif.register(raw)
    res = lumen.whatif.compare(lumen, plan, scenario, _minutes(t))
    drop = ("rows", "edges", "new_shadows") if slim else ("rows",)
    return {"plan": {"key": plan.key, "years": plan.years, "overlay": plan.overlay, "n_items": len(plan.items),
                     "counts": whatif_mod.summary_items(plan.items), "cost": whatif_mod.plan_cost(plan.items)},
            "result": {k: v for k, v in res.items() if k not in drop}}


@app.post("/api/whatif/compare")
def whatif_compare(body: PlanBody):
    """Register a plan (content-addressed key) and return its before / after at one moment."""
    return fast(_compare({"items": body.items, "years": body.years}, body.scenario, body.t))


@app.get("/api/whatif/plans")
def whatif_plans():
    return whatif_mod.list_saved()


@app.post("/api/whatif/plans")
def whatif_save(body: PlanBody):
    return whatif_mod.save(body.name or "Untitled plan", {"items": body.items, "years": body.years}, body.note)


@app.delete("/api/whatif/plans/{pid}")
def whatif_delete(pid: str):
    if not whatif_mod.delete_saved(pid):
        raise HTTPException(404)
    return {"ok": True}


@app.get("/api/whatif/side-by-side")
def whatif_side_by_side(ids: str, scenario: str = "hot", t: int = 930):
    out = []
    for pid in ids.split(",")[:6]:
        doc = whatif_mod.load_saved(pid)
        if doc:
            out.append({"id": pid, "name": doc["name"], "note": doc.get("note", ""), **_compare(doc, scenario, t, slim=True)})
    return fast(out)


@app.get("/api/whatif/export.csv", response_class=PlainTextResponse)
def whatif_export(ids: str = ""):
    """Council pack: before / after for each saved plan under the three evaluation cases."""
    plans = [d for d in (whatif_mod.load_saved(x) for x in ids.split(",")[:6] if x) if d]
    if not plans:
        raise HTTPException(400, "no saved plans selected")
    return _export(plans)


@app.post("/api/whatif/export.csv", response_class=PlainTextResponse)
def whatif_export_draft(body: PlanBody):
    """Same pack for the unsaved plan on screen."""
    return _export([{"id": "draft", "name": body.name or "Current draft", "years": body.years, "items": body.items}])


def _export(plans: list[dict]) -> PlainTextResponse:
    buf = io.StringIO()
    buf.write("\ufeff")  # BOM so Excel opens the UTF-8 file correctly
    buf.write("# Lumen what-if plans: MODEL ESTIMATES from open data (OSM, City of Yarra trees) and the Lumen shade,\n"
              "# crowd and routing models. Not measured. Trips = 4 stations/tram stops x 76 Cremorne workplaces.\n")
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["plan", "plan_id", "trees_at_year", "case", "time_min", "temp_c", "metric", "before", "after", "change"])
    detail = []
    for doc in plans:
        plan = lumen.whatif.register(doc)
        for case in evaluate.CASES:
            r = lumen.whatif.compare(lumen, plan, case["scenario"], case["minutes"])
            u, c = r["usual"], r["coolest"]
            head = [doc["name"], doc["id"], plan.years, case["label"], case["minutes"], r["temp_c"]]
            metrics = [
                ("paths with a shaded side (%)", 100 * r["precinct"]["shaded_share"][0], 100 * r["precinct"]["shaded_share"][1]),
                ("precinct Comfort Score (0-100)", *r["precinct"]["comfort"]),
                ("sunlit path length (km)", *r["precinct"]["sunlit_km"]),
                ("usual routes: sun minutes, all trips", *u["sun_min"]),
                ("usual routes: walking minutes, all trips", *u["walk_min"]),
                ("Lumen coolest routes: sun minutes, all trips", *c["sun_min"]),
                ("Lumen coolest routes: walking minutes, all trips", *c["walk_min"]),
            ]
            for name, b, a in metrics:
                w.writerow(head + [name, round(b, 2), round(a, 2), round(a - b, 2)])
            cost = r["cost"]
            w.writerow(head + ["capital cost, low (A$, indicative)", "", cost["low"], cost["low"]])
            w.writerow(head + ["capital cost, high (A$, indicative)", "", cost["high"], cost["high"]])
            if cost["closure_per_day"]:
                w.writerow(head + ["closure traffic management per day (A$, indicative)", "",
                                   f"{cost['closure_per_day'][0]}-{cost['closure_per_day'][1]}", ""])
            if cost["value"]["aud_per_route_improved"]:
                w.writerow(head + ["A$ (mid cost) per station->workplace route improved", "",
                                   cost["value"]["aud_per_route_improved"], ""])
            for name, v in (("station->workplace trips that benefit", r["trips_benefit"]),
                            ("usual-route trips detoured by closures", u["trips_detoured"]),
                            ("person-minutes of sun saved on usual routes (10,000 workers, one walk each)",
                             u["person_sun_min_saved"])):
                w.writerow(head + [name, "", v, v])
            if case["key"] == "hot_1530":
                detail += [{"plan": doc["name"], **row} for row in r["rows"]]
    buf.write("\n# Interventions\n")
    w.writerow(["plan", "kind", "size", "lon", "lat", "removed_tree_index", "cost_low_aud", "cost_high_aud", "cost_basis"])
    for doc in plans:
        for it in doc["items"]:
            lo, hi = whatif_mod.item_cost({"size": "medium", **it})
            w.writerow([doc["name"], it.get("kind"), it.get("size", ""), it.get("lon", ""), it.get("lat", ""), it.get("tree", ""),
                        lo, hi, "per day" if it.get("kind") == "closure" else "installed"])
    buf.write(f"# {whatif_mod.COST_NOTE}\n")
    buf.write("\n# Trips that change, hot day 3:30pm\n")
    if detail:
        dw = csv.DictWriter(buf, fieldnames=list(detail[0].keys()), lineterminator="\n")
        dw.writeheader()
        dw.writerows(detail)
    return PlainTextResponse(buf.getvalue(), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=lumen-whatif-plans.csv"})


# ---------------------------------------------------------------------- phone app (personal)
def _hhmm(v: str, default: int) -> int:
    try:
        h, m = (int(x) for x in v.split(":"))
        return max(0, min(1439, h * 60 + m))
    except (ValueError, AttributeError):
        return default


@app.get("/api/me/commuter")
def me_commuter(stop: str = "train-richmond", office: str | None = None, arrive: str = "09:00",
                scenario: str = "hot", meeting: str | None = None, llm: bool = True):
    try:
        return fast(personal.commuter(lumen, stop, office or _default_office(), _hhmm(arrive, 540), scenario, meeting, llm))
    except (ValueError, KeyError) as exc:
        raise HTTPException(400, f"unknown place: {exc}")


@app.get("/api/me/driver")
def me_driver(streets: str = "Swan Street,Cremorne Street", scenario: str = "hot", llm: bool = True):
    return fast(personal.driver(lumen, [s.strip() for s in streets.split(",") if s.strip()], scenario, llm))


@app.get("/api/me/merchant")
def me_merchant(node: str = "node-04", open: str = "07:00", close: str = "16:00", scenario: str = "hot", llm: bool = True):
    return fast(personal.merchant(lumen, node, _hhmm(open, 420), _hhmm(close, 960), scenario, llm))


@app.get("/api/me/council")
def me_council(scenario: str = "hot"):
    return fast(personal.council(lumen, scenario))


class SmsBody(BaseModel):
    session: str
    text: str


@app.post("/api/sms")
def sms_inbound(body: SmsBody, request: Request):
    """Simulated SMS gateway: the phone screen plays both sides. No phone numbers are involved."""
    base = f"{request.url.scheme}://{request.url.netloc}"
    return {"replies": sms.handle(lumen, body.session[:64], body.text[:320], base)}


# ---------------------------------------------------------------------- live nodes
@app.post("/api/live/ingest")
def live_ingest(r: Reading):
    return hub.ingest(r)


@app.post("/api/live/reset")
def live_reset(node_id: str | None = None):
    hub.reset(node_id)
    return {"ok": True}


@app.get("/api/live/state")
def live_state():
    return hub.snapshot()


@app.get("/api/live/stream")
async def live_stream():
    return StreamingResponse(hub.stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _default_office() -> str:
    named = {o["name"]: o["id"] for o in lumen.p.offices if o["name"]}
    return named.get("Dover House") or lumen.p.offices[0]["id"]


# ---------------------------------------------------------------------- frontend
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        f = DIST / path
        if path and f.is_file():
            return FileResponse(f)
        return FileResponse(DIST / "index.html")


if __name__ == "__main__":
    uvicorn.run(app, host=os.environ.get("LUMEN_HOST", "0.0.0.0"), port=int(os.environ.get("LUMEN_PORT", 8000)))
