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
import threading
import time
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, PlainTextResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from lumen import brief as brief_mod
from lumen import evaluate
from lumen.engine import SCENARIOS, Lumen
from lumen.live import LiveHub, Reading
from lumen.router import MODES

mimetypes.add_type("text/javascript", ".mjs")  # Windows registries often map .mjs wrongly; module workers need JS
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
        "center": [144.9942, -37.8282],
        "stats": {
            "buildings": len(p.buildings), "trees": int(len(p.tree_xy)),
            "segments": int(p.graph.number_of_edges()), "network_km": round(float(p.e_len.sum()) / 1000, 1),
        },
        "llm": brief_mod.ollama_available(),
    }


@app.get("/api/layers/{name}")
def layer(name: str):
    if name not in STATIC:
        raise HTTPException(404)
    return Response(STATIC[name], media_type="application/json")


@app.get("/api/state")
def state(scenario: str = "hot", t: int = 525, temp: float | None = None):
    return fast(lumen.state(scenario, _minutes(t), temp))


@app.get("/api/shadows")
def shadows(scenario: str = "hot", t: int = 525):
    return fast(lumen.shade.shadow_geojson(lumen.scenario(scenario)["date"], _minutes(t)))


@app.get("/api/route")
def route(src: str = Query(..., alias="from"), dst: str = Query(..., alias="to"),
          scenario: str = "hot", t: int = 525, temp: float | None = None):
    try:
        return fast(lumen.routes(src, dst, scenario, _minutes(t), temp))
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
