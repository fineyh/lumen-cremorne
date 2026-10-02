"""Record Mia's four phone clips from the local app with a CDP screencast (frames + timestamps)."""
import asyncio, datetime, pathlib, sys
from playwright.async_api import async_playwright
from record_lib import Rec

URL = "http://localhost:5181/m"
HERE = pathlib.Path(__file__).parent
STOP, OFFICE = "train-richmond", "b338795749"  # Richmond Station -> The Comfort Shop
ONLY = set(sys.argv[1:])


async def main():
    async with async_playwright() as p:
        # a real 2x device (not emulation) so the screencast frames come at full resolution
        b = await p.chromium.launch(channel="chrome", args=["--force-device-scale-factor=2", "--window-size=746,1008"])
        ctx = await b.new_context(no_viewport=True)
        page = await ctx.new_page()
        await page.clock.set_fixed_time(datetime.datetime(2026, 10, 1, 8, 20))
        await page.add_init_script(path=str(HERE / "fx.js"))
        await page.add_init_script("""document.addEventListener('DOMContentLoaded', () => {
            const t = document.createElement('div'); t.id = 'fx-tick';
            t.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;background:#0b1324;z-index:1'; document.body.appendChild(t); });""")
        cdp = await ctx.new_cdp_session(page)
        rec = Rec(page, cdp)
        S = asyncio.sleep
        ev = page.evaluate

        async def fx_tap(x, y, real=True):
            await ev("([x,y]) => __fx.show(x,y)", [x, y])
            await S(0.5)
            await ev("__fx.press(true)")
            await S(0.13)
            if real:
                await page.mouse.click(x, y)
            await ev("__fx.press(false)")
            await S(0.22)
            await ev("__fx.hide()")

        async def tap(loc, real=True, dx=0.5):
            bb = await loc.bounding_box()
            await fx_tap(bb["x"] + bb["width"] * dx, bb["y"] + bb["height"] / 2, real)

        async def swipe(dy, ms):
            bb = await page.locator(".m-screen").bounding_box()
            y0 = bb["y"] + bb["height"] * (0.72 if dy > 0 else 0.3)
            await ev("([dy,ms,x,y]) => __fx.swipe('.m-body', dy, ms, x, y)", [dy, ms, bb["x"] + bb["width"] * 0.62, y0])

        async def pick(sel_loc, title, value):
            opts = await sel_loc.evaluate("s => [[...s.options].map(o => o.text), [...s.options].map(o => o.value), s.selectedIndex]")
            texts, values, cur = opts
            want, now = texts[values.index(value)], texts[cur]
            texts = list(dict.fromkeys(texts))  # a few buildings share a name; list each once
            target, cur = texts.index(want), texts.index(now)
            await tap(sel_loc, real=False)
            await ev("([t,items,c]) => __fx.sheet(t,items,c)", [title, texts, cur])
            await S(0.9)
            if abs(target - cur) > 3:
                await ev("([i,ms]) => __fx.sheetSwipe(i,ms)", [target, 1500])
                await S(0.5)
            x, y = await ev("i => __fx.rowRect(i)", target)
            await fx_tap(x, y, real=False)
            await ev("i => __fx.pick(i)", target)
            await S(0.45)
            await ev("__fx.closeSheet()")
            await sel_loc.select_option(value)
            await S(0.25)
            await sel_loc.evaluate("s => { s.classList.remove('fx-flash'); s.offsetWidth; s.classList.add('fx-flash'); }")
            await S(1.0)

        await page.goto(URL)
        await page.wait_for_selector(".ob-roles", timeout=60000)
        await S(1.5)
        box = await page.locator(".m-phone").bounding_box()
        print("viewport", await ev("[innerWidth, innerHeight, devicePixelRatio]"), box)

        # 1. who are you
        await rec.start()
        await S(2.2)
        await tap(page.locator(".ob-role").first, dx=0.45)
        await page.wait_for_selector(".ob-form")
        await S(1.6)
        await rec.stop("1_role", box)

        # 2. a few places: Richmond Station -> The Comfort Shop, start 9am
        await rec.start()
        await S(0.9)
        sels = page.locator(".ob-form select")
        await pick(sels.nth(0), "Station or tram stop", STOP)
        await pick(sels.nth(1), "Your building", OFFICE)
        await S(0.4)
        await tap(page.locator(".m-btn.primary"))
        await page.wait_for_selector(".today", timeout=120000)
        await page.wait_for_selector(".m-map, .maplibregl-canvas", timeout=30000)
        await S(3.0)
        await rec.stop("2_settings", box)

        # 3. four ways to walk
        await rec.start()
        await S(2.4)
        dy = await ev("() => document.querySelector('.pref').getBoundingClientRect().top - document.querySelector('.m-body').getBoundingClientRect().top - 10")
        await swipe(dy, 1200)
        await S(1.4)
        prefs = page.locator(".pref button")
        for k in (1, 2, 3, 0):
            await tap(prefs.nth(k))
            await S(2.7)
        await rec.stop("3_routes", box)

        # 4. walk it step by step
        await rec.start()
        await S(0.8)
        dy = await ev("""() => { const b = document.querySelector('.go-start.primary').getBoundingClientRect();
            const m = document.querySelector('.m-body').getBoundingClientRect(); return b.bottom - m.bottom + 120; }""")
        await swipe(dy, 1300)
        await S(0.7)
        await tap(page.locator(".go-start.primary"))
        await page.wait_for_selector(".wk-now")
        await S(2.4)
        for _ in range(2):
            await tap(page.locator(".wk-ctl .next"))
            await S(2.1)
        await swipe(2400, 2600)
        await S(1.8)
        await rec.stop("4_guide", box)
        await b.close()


asyncio.run(main())
