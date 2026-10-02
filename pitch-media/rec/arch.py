"""Render arch.html to pitch-media/arch.png (3000x800)."""
import asyncio, pathlib
from playwright.async_api import async_playwright
HERE = pathlib.Path(__file__).parent


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome")
        page = await b.new_page(viewport={"width": 1500, "height": 400}, device_scale_factor=2)
        await page.goto((HERE / "arch.html").as_uri())
        await page.evaluate("document.fonts.ready")
        await page.wait_for_timeout(500)
        await page.screenshot(path=str(HERE.parent / "arch.png"))
        await b.close()

asyncio.run(main())
