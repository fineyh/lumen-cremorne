"""Lumen Window Node (demo build): count people crossing a virtual line, send numbers only.

Frames are processed in memory and dropped immediately. Nothing is written to disk and no image
ever leaves this process; the payload schema has no field that could hold one.

    python window_node.py --mode yolo --show           # webcam + YOLOv8n + ByteTrack (pip install ultralytics)
    python window_node.py --mode motion --show         # webcam + OpenCV background subtraction (lighter)
    python window_node.py --mode simulate --rate 20    # no camera: Poisson arrivals, for rehearsals
    python window_node.py --mode keyboard              # press Enter per passer-by (manual counting / accuracy test)

Readings go to the Lumen server over HTTP (default) or MQTT (--mqtt host -> topic lumen/nodes/<id>).
"""
from __future__ import annotations

import argparse
import json
import math
import random
import sys
import threading
import time

import requests


# --------------------------------------------------------------------------- transport
class Sender:
    def __init__(self, args):
        self.args = args
        self.mqtt = None
        if args.mqtt:
            import paho.mqtt.client as mqtt

            self.mqtt = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
            self.mqtt.connect(args.mqtt, args.mqtt_port)
            self.mqtt.loop_start()

    def send(self, count_in: int, count_out: int, extra: dict | None = None):
        payload = {"node_id": self.args.node_id, "ts": time.time(), "count_in": count_in, "count_out": count_out}
        payload.update({k: v for k, v in (extra or {}).items() if v is not None})
        try:
            if self.mqtt:
                self.mqtt.publish(f"lumen/nodes/{self.args.node_id}", json.dumps(payload), qos=1)
            else:
                requests.post(f"{self.args.backend}/api/live/ingest", json=payload, timeout=3)
        except Exception as exc:
            print("send failed (will keep counting):", exc, file=sys.stderr)
        print(f"[{time.strftime('%H:%M:%S')}] -> in={count_in} out={count_out}", flush=True)


class Counter:
    """Accumulates crossings and flushes them every `interval` seconds."""

    def __init__(self, sender: Sender, interval: float):
        self.sender = sender
        self.interval = interval
        self.pending_in = 0
        self.pending_out = 0
        self.total_in = 0
        self.total_out = 0
        self.last = time.time()
        self.lock = threading.Lock()

    def add(self, direction: int):
        with self.lock:
            if direction > 0:
                self.pending_in += 1; self.total_in += 1
            else:
                self.pending_out += 1; self.total_out += 1

    def tick(self, extra: dict | None = None, force: bool = False):
        if not force and time.time() - self.last < self.interval:
            return
        with self.lock:
            i, o = self.pending_in, self.pending_out
            self.pending_in = self.pending_out = 0
        self.last = time.time()
        if i or o or force:
            self.sender.send(i, o, extra)


# --------------------------------------------------------------------------- line-crossing
class LineCrossing:
    """Counts a track when its centroid moves from one side of the line to the other."""

    def __init__(self, position: float, axis: str):
        self.position = position
        self.axis = axis
        self.side: dict[int, int] = {}
        self.seen: dict[int, float] = {}

    def update(self, track_id: int, cx: float, cy: float, w: int, h: int) -> int:
        v = (cx / w) if self.axis == "vertical" else (cy / h)
        side = 1 if v > self.position else -1
        prev = self.side.get(track_id)
        self.side[track_id] = side
        self.seen[track_id] = time.time()
        if prev is not None and prev != side:
            return side  # +1 crossed towards the far side ("in"), -1 back ("out")
        return 0

    def gc(self, max_age: float = 5.0):
        now = time.time()
        for k in [k for k, t in self.seen.items() if now - t > max_age]:
            self.side.pop(k, None); self.seen.pop(k, None)


def draw_overlay(cv2, frame, args, counter, boxes):
    h, w = frame.shape[:2]
    if args.axis == "vertical":
        x = int(args.line * w); cv2.line(frame, (x, 0), (x, h), (0, 200, 255), 2)
    else:
        y = int(args.line * h); cv2.line(frame, (0, y), (w, y), (0, 200, 255), 2)
    for (x1, y1, x2, y2, tid) in boxes:
        cv2.rectangle(frame, (int(x1), int(y1)), (int(x2), int(y2)), (80, 220, 120), 2)
        cv2.putText(frame, f"#{tid}", (int(x1), int(y1) - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (80, 220, 120), 1)
    cv2.rectangle(frame, (0, 0), (w, 34), (20, 20, 20), -1)
    cv2.putText(frame, f"IN {counter.total_in}   OUT {counter.total_out}   preview only - no images leave this device",
                (10, 23), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1)


def run_yolo(args, counter):
    import cv2
    from ultralytics import YOLO

    model = YOLO(args.model)
    cap = cv2.VideoCapture(args.camera)
    line = LineCrossing(args.line, args.axis)
    while True:
        ok, frame = cap.read()
        if not ok:
            time.sleep(0.1); continue
        h, w = frame.shape[:2]
        res = model.track(frame, persist=True, classes=[0], tracker="bytetrack.yaml", conf=args.conf, verbose=False)[0]
        boxes = []
        if res.boxes is not None and res.boxes.id is not None:
            for (x1, y1, x2, y2), tid in zip(res.boxes.xyxy.tolist(), res.boxes.id.int().tolist()):
                d = line.update(tid, (x1 + x2) / 2, (y1 + y2) / 2, w, h)
                if d:
                    counter.add(d)
                boxes.append((x1, y1, x2, y2, tid))
        line.gc()
        counter.tick()
        if args.show:
            draw_overlay(cv2, frame, args, counter, boxes)
            cv2.imshow("Lumen window node (preview)", frame)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                break
        del frame  # explicit: the frame is gone after this iteration


def run_motion(args, counter):
    """No-ML fallback: background subtraction + nearest-neighbour centroid tracking."""
    import cv2

    cap = cv2.VideoCapture(args.camera)
    sub = cv2.createBackgroundSubtractorMOG2(history=300, varThreshold=40, detectShadows=False)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    line = LineCrossing(args.line, args.axis)
    tracks: dict[int, tuple[float, float]] = {}
    next_id = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            time.sleep(0.1); continue
        h, w = frame.shape[:2]
        small = cv2.GaussianBlur(frame, (9, 9), 0)
        mask = sub.apply(small)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
        mask = cv2.dilate(mask, kernel, iterations=2)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        min_area = args.min_area * w * h
        dets = [cv2.boundingRect(c) for c in contours if cv2.contourArea(c) > min_area]
        new_tracks, boxes = {}, []
        for (x, y, bw, bh) in dets:
            cx, cy = x + bw / 2, y + bh / 2
            best, best_d = None, 0.15 * max(w, h)
            for tid, (tx, ty) in tracks.items():
                d = math.hypot(cx - tx, cy - ty)
                if d < best_d and tid not in new_tracks:
                    best, best_d = tid, d
            if best is None:
                best = next_id; next_id += 1
            new_tracks[best] = (cx, cy)
            d = line.update(best, cx, cy, w, h)
            if d:
                counter.add(d)
            boxes.append((x, y, x + bw, y + bh, best))
        tracks = new_tracks
        line.gc()
        counter.tick()
        if args.show:
            draw_overlay(cv2, frame, args, counter, boxes)
            cv2.imshow("Lumen window node (preview)", frame)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                break
        del frame, small, mask


def run_simulate(args, counter):
    """Poisson passers-by at --rate people/min, plus plausible sensor values."""
    print(f"simulating {args.rate} people/min (label this node 'replayed' if you show it)")
    while True:
        time.sleep(random.expovariate(args.rate / 60.0))
        counter.add(1 if random.random() < 0.6 else -1)
        counter.tick(extra={"temp_c": round(random.gauss(24, 0.3), 1), "rh": round(random.gauss(45, 2)),
                            "noise_db": round(random.gauss(62, 3), 1)})


def run_keyboard(args, counter):
    print("Press Enter for each person walking IN, type o + Enter for OUT, q to quit.")
    for line in sys.stdin:
        s = line.strip().lower()
        if s == "q":
            break
        counter.add(-1 if s == "o" else 1)
        counter.tick(force=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mode", choices=["yolo", "motion", "simulate", "keyboard"], default="yolo")
    ap.add_argument("--node-id", default="node-00")
    ap.add_argument("--backend", default="http://localhost:8000")
    ap.add_argument("--mqtt", help="MQTT broker host (instead of HTTP)")
    ap.add_argument("--mqtt-port", type=int, default=1883)
    ap.add_argument("--camera", type=int, default=0)
    ap.add_argument("--model", default="yolov8n.pt")
    ap.add_argument("--conf", type=float, default=0.35)
    ap.add_argument("--line", type=float, default=0.5, help="line position as a fraction of the frame")
    ap.add_argument("--axis", choices=["vertical", "horizontal"], default="vertical",
                    help="vertical line = people walking left/right across the view")
    ap.add_argument("--interval", type=float, default=2.0, help="seconds between uploads (10 in production)")
    ap.add_argument("--min-area", type=float, default=0.01, help="motion mode: min blob area, fraction of frame")
    ap.add_argument("--rate", type=float, default=20, help="simulate mode: people per minute")
    ap.add_argument("--show", action="store_true", help="show a local preview window (never saved)")
    args = ap.parse_args()

    counter = Counter(Sender(args), args.interval)
    runner = {"yolo": run_yolo, "motion": run_motion, "simulate": run_simulate, "keyboard": run_keyboard}[args.mode]
    try:
        runner(args, counter)
    except KeyboardInterrupt:
        pass
    finally:
        counter.tick(force=True)


if __name__ == "__main__":
    main()
