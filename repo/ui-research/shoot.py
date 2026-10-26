#!/usr/bin/env python3
"""截图：每个样稿 1440 / 768 / 390，浅色 + 深色（深色只截 1440 和 390）。输出 shots/*.png。
运行：见 hub-pages-diagrams §6 的环境变量（LD_LIBRARY_PATH 等），用 /workspace/tools/xhs-venv/bin/python。"""
import pathlib, sys
from playwright.sync_api import sync_playwright
HERE = pathlib.Path(__file__).resolve().parent
M = HERE / "mockups"; S = HERE / "shots"; S.mkdir(exist_ok=True)
pages = sys.argv[1:] or ["00-ia-map", "01-chat", "02-member", "03-roster", "04-settings"]
with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"])
    for name in pages:
        for w, h in ((1440, 900), (768, 1024), (390, 844)):
            for theme in ("", "dark"):
                if theme == "dark" and w == 768: continue
                ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1 if w > 500 else 2)
                pg = ctx.new_page(); pg.goto((M / f"{name}.html").as_uri()); pg.wait_for_timeout(600)
                if theme: pg.evaluate("document.documentElement.dataset.theme='dark'")
                pg.wait_for_timeout(200)
                out = S / f"{name}{'-dark' if theme else ''}-{w}.png"
                pg.screenshot(path=str(out), full_page=(name == "00-ia-map"))
                if w == 390 and name != "00-ia-map": pg.screenshot(path=str(out).replace(".png","-full.png"), full_page=True)
                # 横向溢出检查
                ov = pg.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
                print(out.name, "overflowX=", ov)
                ctx.close()
    b.close()
