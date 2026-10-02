"""Record the README phone clips (today, nearby, ask) with the same setup as record.py; build with build.py --prefix phone_.

    python phone.py [today|nearby|ask|shots ...]
"""
import asyncio, datetime, json, pathlib, sys
from playwright.async_api import async_playwright
from record_lib import Rec

URL = "http://127.0.0.1:8020/m"
HERE = pathlib.Path(__file__).parent
SHOTS = pathlib.Path(r"C:/Users/fyh68/AppData/Local/Temp/claude/E--Workspace-personal-cremorne/88f286c2-2bd2-424f-a123-a7aa76087d17/scratchpad")
ONLY = set(sys.argv[1:])
# Mia: Richmond Station -> The Comfort Shop, starts at 9
SETTINGS = {"role": "commuter", "stop": "train-richmond", "office": "b338795749", "arrive": "09:00",
            "streets": [], "node": "node-03", "open": "07:00", "close": "16:00"}


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", args=["--force-device-scale-factor=2", "--window-size=746,1008"])
        ctx = await b.new_context(no_viewport=True)
        page = await ctx.new_page()
        await page.clock.set_fixed_time(datetime.datetime(2026, 10, 1, 8, 20))
        await page.add_init_script(path=str(HERE / "fx.js"))
        await page.add_init_script(f"localStorage.setItem('lumen.phone.settings', {json.dumps(json.dumps(SETTINGS))})")
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

        async def swipe_to(sel, margin=110):
            """Swipe until the element's top sits `margin` px below the top of the scroll area."""
            dy = await ev("""([s, m]) => document.querySelector(s).getBoundingClientRect().top
                - document.querySelector('.m-body').getBoundingClientRect().top - m""", [sel, margin])
            await swipe(dy, 1300)

        async def home():
            await page.goto(URL)
            await page.wait_for_selector(".today", timeout=120000)
            await page.wait_for_selector(".maplibregl-canvas", timeout=30000)
            await S(3.0)

        box = None

        async def phone_box():
            return await page.locator(".m-phone").bounding_box()

        async def tab(label):
            await tap(page.locator(".m-nav button", has_text=label).first)

        if "shots" in ONLY:
            await home()
            await page.screenshot(path=str(SHOTS / "ph_home.png"))
            await ev("document.querySelector('.ow').scrollIntoView()")
            await S(1)
            await page.screenshot(path=str(SHOTS / "ph_ow.png"))

        # 1. Today card: when to leave, which way to walk, and Cremorne's own places beside the walk
        if not ONLY or "today" in ONLY:
            await home()
            box = await phone_box()
            await rec.start()
            await S(2.6)
            await swipe_to(".pref", 10)
            await S(1.4)
            prefs = page.locator(".today ~ .m-card .pref button, .m-card .pref button")
            for k in (2,):
                await tap(prefs.nth(k))
                await S(2.6)
            await swipe_to(".ow", 140)
            await S(2.5)
            await rec.stop("phone_today", box)

        # 2. On your way -> Nearby opens on that shop, then walk it step by step
        if not ONLY or "nearby" in ONLY:
            await home()
            box = await phone_box()
            await ev("""() => { const b = document.querySelector('.m-body'), o = document.querySelector('.ow');
                b.scrollTop += o.getBoundingClientRect().top - b.getBoundingClientRect().top - 140; }""")
            await S(1.5)
            await rec.start()
            await S(1.5)
            await tap(page.locator(".ow-row").nth(1))
            await page.wait_for_selector(".nb-best", timeout=60000)
            await S(3.0)
            await swipe_to(".nb-best", 10)
            await S(2.6)
            await swipe_to(".nb-go", 380)
            await S(1.6)
            await tap(page.locator(".nb-go"))
            await page.wait_for_selector(".wk-now", timeout=30000)
            await S(2.4)
            for _ in range(2):
                await tap(page.locator(".wk-ctl .next"))
                await S(2.1)
            await rec.stop("phone_nearby", box)

        # 3. Ask Lumen on the phone, then follow the answer in Walk
        if not ONLY or "ask" in ONLY:
            await home()
            box = await phone_box()
            await rec.start()
            await S(1.2)
            await tab("Ask")
            await page.wait_for_selector(".ask-sug button", timeout=30000)
            await S(1.6)
            await tap(page.locator(".ask-sug button", has_text="Coffee"))
            await page.wait_for_function("[...document.querySelectorAll('.ask-b.lumen')].some(e => !e.classList.contains('typing'))", timeout=60000)
            await S(3.6)
            go = page.locator(".ask-go")
            if await go.count():
                await tap(go.last)
                await page.wait_for_selector(".maplibregl-canvas", timeout=30000)
                await S(4.5)
            await rec.stop("phone_ask", box)
        await b.close()


asyncio.run(main())
