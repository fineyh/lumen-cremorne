"""CDP screencast recorder shared by record.py and phone.py: frames + wall-clock timestamps per clip."""
import asyncio, base64, json, pathlib, time

OUT = pathlib.Path(__file__).parent / "frames"


class Rec:
    def __init__(self, page, cdp):
        self.page, self.cdp, self.frames, self.on = page, cdp, [], False
        cdp.on("Page.screencastFrame", self._frame)

    def _frame(self, ev):
        if self.on:
            self.frames.append((ev["metadata"]["timestamp"], time.time(), ev["data"]))
        asyncio.ensure_future(self.cdp.send("Page.screencastFrameAck", {"sessionId": ev["sessionId"]}))

    async def start(self):
        self.frames = []
        self.on = True
        await self.cdp.send("Page.startScreencast", {"format": "jpeg", "quality": 93, "maxWidth": 4000, "maxHeight": 4000, "everyNthFrame": 1})
        await self.page.evaluate("document.getElementById('fx-tick').style.opacity = Math.random() * 0.02")

    async def stop(self, name, box):
        end = time.time()
        await asyncio.sleep(0.15)
        self.on = False
        await self.cdp.send("Page.stopScreencast")
        d = OUT / name
        d.mkdir(parents=True, exist_ok=True)
        for f in d.glob("*.jpg"):
            f.unlink()
        meta = []
        for k, (ts, wall, data) in enumerate(self.frames):
            if wall > end:
                break
            (d / f"{k:05d}.jpg").write_bytes(base64.b64decode(data))
            meta.append({"f": f"{k:05d}.jpg", "ts": ts, "wall": wall})
        json.dump({"frames": meta, "end": end, "box": box, "vw": await self.page.evaluate("innerWidth")}, open(d / "meta.json", "w"))
        print(name, len(meta), "frames", f"{end - meta[0]['wall']:.1f}s")
