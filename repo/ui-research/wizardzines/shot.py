import os
from playwright.sync_api import sync_playwright
px=os.environ.get('HTTPS_PROXY') or os.environ.get('HTTP_PROXY')
with sync_playwright() as p:
    b=p.chromium.launch(args=["--no-sandbox"], proxy={"server":px} if px else None)
    for w,h in ((390,844),(1440,900)):
        for url,n in (("https://wizardzines.com/","home"),):
            c=b.new_context(viewport={"width":w,"height":h},device_scale_factor=1,ignore_https_errors=True)
            pg=c.new_page(); pg.route("**/*", lambda r: r.abort() if ("wizardzines.com" not in r.request.url) else r.continue_()); pg.goto(url,timeout=40000,wait_until="commit"); pg.wait_for_timeout(9000)
            pg.screenshot(path=f"wz-{n}-{w}.png",full_page=False)
            c.close()
    b.close()
