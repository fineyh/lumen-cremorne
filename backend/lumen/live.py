"""Live window-node readings: HTTP ingest, optional MQTT bridge, server-sent events out.

A reading is numbers only - there is deliberately no field that could carry an image:
    {node_id, ts, count_in, count_out, temp_c, rh, noise_db}
"""
from __future__ import annotations

import asyncio
import json
import os
import threading
import time
from collections import deque

from pydantic import BaseModel, Field


class Reading(BaseModel):
    node_id: str = Field(max_length=32)
    ts: float | None = None
    count_in: int = Field(0, ge=0, le=10_000)
    count_out: int = Field(0, ge=0, le=10_000)
    temp_c: float | None = None
    rh: float | None = None
    noise_db: float | None = None
    model_config = {"extra": "forbid"}


class LiveHub:
    def __init__(self):
        self.totals: dict[str, dict] = {}
        self.recent: dict[str, deque] = {}
        self.subscribers: set[asyncio.Queue] = set()
        self.loop: asyncio.AbstractEventLoop | None = None

    def ingest(self, r: Reading) -> dict:
        ts = r.ts or time.time()
        t = self.totals.setdefault(r.node_id, {"node_id": r.node_id, "in": 0, "out": 0, "first_ts": ts})
        t["in"] += r.count_in
        t["out"] += r.count_out
        t["last_ts"] = ts
        for k in ("temp_c", "rh", "noise_db"):
            v = getattr(r, k)
            if v is not None:
                t[k] = v
        q = self.recent.setdefault(r.node_id, deque(maxlen=360))
        q.append((ts, r.count_in + r.count_out))
        t["per_min"] = self._per_min(r.node_id, ts)
        event = {"type": "reading", **t, "delta": r.count_in + r.count_out}
        self._broadcast(event)
        return event

    def _per_min(self, node_id: str, now: float) -> float:
        q = self.recent.get(node_id, ())
        n = sum(c for ts, c in q if now - ts <= 60)
        return float(n)

    def reset(self, node_id: str | None = None):
        if node_id:
            self.totals.pop(node_id, None); self.recent.pop(node_id, None)
        else:
            self.totals.clear(); self.recent.clear()
        self._broadcast({"type": "reset", "node_id": node_id})

    def snapshot(self) -> dict:
        now = time.time()
        out = {}
        for k, v in self.totals.items():
            out[k] = {**v, "per_min": self._per_min(k, now), "online": now - v.get("last_ts", 0) < 30}
        return out

    def _broadcast(self, event: dict):
        if not self.loop:
            return
        for q in list(self.subscribers):
            self.loop.call_soon_threadsafe(q.put_nowait, event)

    async def stream(self):
        q: asyncio.Queue = asyncio.Queue()
        self.subscribers.add(q)
        try:
            yield f"data: {json.dumps({'type': 'snapshot', 'nodes': self.snapshot()})}\n\n"
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=15)
                    yield f"data: {json.dumps(ev)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
        finally:
            self.subscribers.discard(q)

    # ------------------------------------------------------------------ MQTT bridge
    def start_mqtt(self):
        """Subscribe to lumen/nodes/+ if LUMEN_MQTT is set and paho-mqtt is installed."""
        host = os.environ.get("LUMEN_MQTT")
        if not host:
            return "off"
        try:
            import paho.mqtt.client as mqtt
        except ImportError:
            return "paho-mqtt not installed"

        def on_message(_c, _u, msg):
            try:
                self.ingest(Reading(**json.loads(msg.payload)))
            except Exception as exc:  # malformed payloads are dropped, never stored
                print("mqtt: dropped reading:", exc)

        def run():
            c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
            c.on_connect = lambda cl, *_: cl.subscribe("lumen/nodes/+")
            c.on_message = on_message
            c.connect(host, int(os.environ.get("LUMEN_MQTT_PORT", 1883)))
            c.loop_forever()

        threading.Thread(target=run, daemon=True).start()
        return f"subscribed to {host}"
