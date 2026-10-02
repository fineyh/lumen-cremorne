"""Record the Console clips (sun, crowd, whatif, access) from a local server with a CDP screencast.

    python console.py [names...]      # default: all four; frames land in frames/c_<name>/
    python build_console.py [names...]
"""
import asyncio, base64, json, pathlib, sys, time
from playwright.async_api import async_playwright

URL = "http://127.0.0.1:8020/"
HERE = pathlib.Path(__file__).parent
OUT = HERE / "frames"
W, H = 1600, 900
ONLY = set(sys.argv[1:])


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
        await self.cdp.send("Page.startScreencast", {"format": "jpeg", "quality": 92, "maxWidth": 4000, "maxHeight": 4000, "everyNthFrame": 1})

    async def stop(self, name, speed=1.0):
        end = time.time()
        await asyncio.sleep(0.15)
        self.on = False
        await self.cdp.send("Page.stopScreencast")
        d = OUT / f"c_{name}"
        d.mkdir(parents=True, exist_ok=True)
        for f in d.glob("*.jpg"):
            f.unlink()
        meta = []
        for k, (ts, wall, data) in enumerate(self.frames):
            if wall > end:
                break
            (d / f"{k:05d}.jpg").write_bytes(base64.b64decode(data))
            meta.append({"f": f"{k:05d}.jpg", "ts": ts, "wall": wall})
        json.dump({"frames": meta, "end": end, "speed": speed}, open(d / "meta.json", "w"))
        print(name, len(meta), "frames", f"{end - meta[0]['wall']:.1f}s")


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        ctx = await b.new_context(viewport={"width": W, "height": H})
        page = await ctx.new_page()
        await page.add_init_script(path=str(HERE / "cursor.js"))
        cdp = await ctx.new_cdp_session(page)
        rec = Rec(page, cdp)
        S = asyncio.sleep
        ev = page.evaluate

        async def move(x, y):
            await ev("([x,y]) => __cur.move(x,y)", [x, y])
            await page.mouse.move(x, y)
            await S(0.6)

        async def click_at(x, y):
            await move(x, y)
            await ev("([x,y]) => __cur.ripple(x,y)", [x, y])
            await page.mouse.click(x, y)
            await S(0.25)

        async def click(loc):
            bb = await loc.bounding_box()
            await click_at(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2)

        async def settle():
            await page.wait_for_function("!document.querySelector('.timebar .spinner')", timeout=60000)
            await S(1.2)

        async def set_time(m, show=False):
            # native range input: React picks the value up from a real click on the track
            bb = await page.locator(".tb-slider input[type=range]").bounding_box()
            x, y = bb["x"] + 8 + (bb["width"] - 16) * (m - 360) / 900, bb["y"] + bb["height"] / 2
            if show:
                await click_at(x, y)
            else:
                await page.mouse.click(x, y)

        async def chip(label, on):
            c = page.locator(".layerbar .chip-t", has_text=label).first
            if ("on" in (await c.get_attribute("class")).split()) != on:
                await c.click()

        async def fresh():
            await page.goto(URL)
            await page.wait_for_selector(".maplibregl-canvas", timeout=60000)
            await settle()
            await S(2.5)
            await ev("__cur.move(1100, 450, true)")

        async def shot(name):
            await page.screenshot(path=str(pathlib.Path(r"C:/Users/fyh68/AppData/Local/Temp/claude/E--Workspace-personal-cremorne/88f286c2-2bd2-424f-a123-a7aa76087d17/scratchpad") / f"shot_{name}.png"))

        # 1. shade sweeps with the sun, routes re-plan
        if not ONLY or "sun" in ONLY:
            await fresh()
            for c in ("Stops", "Access", "Poles"):
                await chip(c, False)
            await chip("3D", True)
            await S(2.5)
            await set_time(555)
            await settle()
            await rec.start()
            await S(1.0)
            await click(page.locator(".timebar .play"))
            await ev("__cur.hide()")
            await S(34)
            await click(page.locator(".timebar .play"))
            await S(1.5)
            await rec.stop("sun", speed=2.5)

        # 2. train arrivals push Swan St to LOS D at 8:45; the least crowded way skirts it
        if not ONLY or "crowd" in ONLY:
            await fresh()
            for c in ("Stops", "Access", "Poles"):
                await chip(c, False)
            await rec.start()
            await S(1.2)
            await click(page.locator(".layerbar .seg button", has_text="Crowding"))
            await settle()
            await S(1.5)
            await click(page.locator(".timebar .marks button", has_text="8:45 rush"))
            await settle()
            await S(2.0)
            await click(page.locator(".route-panel .cards > *").nth(2))
            await S(3.0)
            await move(1150, 520)
            await S(1.0)
            await click(page.locator(".timebar .play"))
            await ev("__cur.hide()")
            await S(4.2)
            await click(page.locator(".timebar .play"))
            await S(1.0)
            await click(page.locator(".timebar .marks button", has_text="8:45 rush"))
            await settle()
            await S(2.0)
            await rec.stop("crowd", speed=1.25)

        # 3. what-if: six large trees on Swan St, year 1 vs year 15, then before / after on the map
        if not ONLY or "whatif" in ONLY:
            await fresh()
            for c in ("Stops", "Access", "Poles"):
                await chip(c, False)
            await page.locator("nav.tabs button", has_text="What-if").click()
            await S(2.5)
            await rec.start()
            await S(1.0)
            await click(page.locator(".tool", has_text="Plant tree"))
            await S(0.6)
            await click(page.locator(".tree-size .seg button").nth(2))
            await S(0.5)
            for x in (790, 830, 870, 910, 950, 990):
                y = 237 + (x - 760) * 0.22 + 10
                await click_at(x, y)
                await S(0.45)
            await page.wait_for_selector(".results:not(.stale)", timeout=60000)
            await S(1.5)
            await click(page.locator(".hint-pill.edit button", has_text="Done"))
            await S(2.5)
            # maturity: year 1 -> year 15
            mat = page.locator(".maturity input[type=range]")
            bb = await mat.bounding_box()
            px = lambda yr: bb["x"] + 8 + (bb["width"] - 16) * (yr - 1) / 19
            y = bb["y"] + bb["height"] / 2
            await move(px(1), y)
            await ev("__cur.drag(true)")
            await page.mouse.down()
            for k in range(1, 21):
                xx = px(1) + (px(15) - px(1)) * k / 20
                await ev("([x,y]) => __cur.move(x,y)", [xx, y])
                await page.mouse.move(xx, y)
                await S(0.05)
            await page.mouse.up()
            await ev("__cur.drag(false)")
            await S(0.5)
            await page.wait_for_selector(".results:not(.stale)", timeout=60000)
            await S(3.0)
            ba = page.locator("button", has_text="Before")
            if await ba.count():
                await click(ba.first)
                await S(2.2)
                await click(page.locator("button", has_text="After").first)
                await S(2.2)
            await move(220, 700)
            await page.mouse.wheel(0, 380)
            await S(3.0)
            await rec.stop("whatif", speed=1.15)

        # 4. step-free: East Richmond -> The Comfort Shop avoids a flight of steps; Access and Local layers
        if not ONLY or "access" in ONLY:
            await fresh()
            await chip("Poles", False)
            sels = page.locator(".route-panel .place select")
            await sels.nth(0).select_option("train-east-richmond")
            await sels.nth(1).select_option("b338795749")
            await settle()
            await S(2.0)
            # the station end, where the steps are, sits under the layer bar: pull the map down
            await page.mouse.move(1150, 300)
            await page.mouse.down()
            await page.mouse.move(1150, 380, steps=8)
            await page.mouse.move(1150, 440, steps=8)
            await page.mouse.up()
            await S(0.5)
            await page.mouse.move(1000, 330)
            for _ in range(3):
                await page.mouse.wheel(0, 70)
                await S(0.1)
            await S(2.5)
            await rec.start()
            await S(2.0)
            await move(1000, 470)
            await S(1.0)
            await click(page.locator(".sf-toggle"))
            await settle()
            await S(3.5)
            await click(page.locator(".route-panel .cards > *").nth(0))
            await S(2.5)
            await click(page.locator(".layerbar .chip-t", has_text="Local"))
            await S(1.0)
            await click(page.locator(".layerbar .chip-t", has_text="Access"))
            await S(3.0)
            await rec.stop("access", speed=1.0)

        if "shots" in ONLY:
            await fresh()
            for c in ("Stops", "Access", "Poles"):
                await chip(c, False)
            await page.locator(".tabs button, nav button", has_text="What-if").first.click()
            await S(1.5)
            await page.locator(".tool", has_text="Plant tree").first.click()
            await S(1)
            await shot("whatif")


asyncio.run(main())
