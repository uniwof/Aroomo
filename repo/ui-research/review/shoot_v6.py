#!/usr/bin/env python3
"""v6 评审截图：1440/768/390 × 浅/深，外加 390 抽屉打开。页面加载后用 getComputedStyle 读抽屉「新项目」按钮和 Logo 颜色，并截图取色。
中文字体：~/.fonts 下放 NotoSansSC / NotoSansCJKsc（来自 /workspace/tools/fonts 和 /workspace/work/promo/fonts），避免豆腐块。
用法：python3 localproxy.py & ; python3 ui-research/review/shoot_v6.py [输出目录]"""
import asyncio, json, subprocess, os, sys, time, base64, urllib.request, websockets, io
import shutil
FD = os.path.expanduser('~/.fonts'); os.makedirs(FD, exist_ok=True)
for f in ('/workspace/tools/fonts/NotoSansSC.ttf', '/workspace/work/promo/fonts/NotoSansCJKsc-Regular.otf', '/workspace/work/promo/fonts/NotoSansCJKsc-Bold.otf'):
    if os.path.exists(f) and not os.path.exists(os.path.join(FD, os.path.basename(f))): shutil.copy(f, FD)   # 沙盒 home 会被重置，每次截图前补装中文字体
R = "/workspace/rb"; HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'v6-shots'); os.makedirs(OUT, exist_ok=True)
TOKEN = json.load(open('/workspace/storage/secrets/ai-groupchat.json'))['ACCESS_TOKEN']
BASE = 'https://chat.pcmanai.com'
env = dict(os.environ, PATH=f"{R}/root/usr/bin:{R}/bin:" + os.environ["PATH"],
           LD_LIBRARY_PATH=f"{R}/root/usr/lib/aarch64-linux-gnu:{R}/root/lib/aarch64-linux-gnu:{R}/root/usr/lib/chromium",
           FONTCONFIG_PATH=f"{R}/root/etc/fonts")
argv = [f"{R}/root/usr/lib/chromium/chromium", "--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=9362",
        "--user-data-dir=/tmp/agc_v6shot", "--ignore-certificate-errors", "--proxy-server=http://127.0.0.1:8899", "--lang=zh-CN", "about:blank"]
p = subprocess.Popen(argv, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(30):
    try:
        t = json.load(urllib.request.build_opener(urllib.request.ProxyHandler({})).open("http://127.0.0.1:9362/json")); break
    except Exception: time.sleep(1)
ws_url = [x for x in t if x["type"] == "page"][0]["webSocketDebuggerUrl"]
STY = """(()=>{const g=(s,ps)=>{const e=document.querySelector(s);if(!e)return null;const c=getComputedStyle(e);const o={};ps.forEach(p=>o[p]=c.getPropertyValue(p));const r=e.getBoundingClientRect();o.rect=[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)];return o};
return {theme:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light',head:getComputedStyle(document.documentElement).getPropertyValue('--head').trim(),ink:getComputedStyle(document.documentElement).getPropertyValue('--ink').trim(),
btn:g('#drawerNew',['background-color','color','box-shadow']),logo:g('.dhead .dlogo',['color','width']),logoPath:(()=>{const e=document.querySelector('.dhead .dlogo path');return e?getComputedStyle(e).fill:null})(),
fav:[...document.querySelectorAll('link[rel=icon]')].map(l=>l.getAttribute('href')+'|'+(l.type||'')),fonts:document.fonts.check('16px "Noto Sans SC"')}})()"""
async def main():
    res = {}
    async with websockets.connect(ws_url, max_size=80_000_000, proxy=None) as ws:
        n = [0]
        async def cmd(m, **pa):
            n[0] += 1; i = n[0]; await ws.send(json.dumps({"id": i, "method": m, "params": pa}))
            while True:
                r = json.loads(await ws.recv())
                if r.get("id") == i: return r.get("result", r)
        async def ev(js): return (await cmd("Runtime.evaluate", expression=js, awaitPromise=True, returnByValue=True))["result"].get("value")
        async def shot(name):
            r = await cmd("Page.captureScreenshot", format="png"); b = base64.b64decode(r["data"]); open(f"{OUT}/{name}", "wb").write(b); return b
        await cmd("Page.enable"); await cmd("Runtime.enable")
        first = True
        for theme in ('light', 'dark'):
            for w, h in ((1440, 900), (768, 1024), (390, 844)):
                await cmd("Emulation.setDeviceMetricsOverride", width=w, height=h, deviceScaleFactor=1 if w > 400 else 2, mobile=w < 800)
                await cmd("Emulation.setEmulatedMedia", features=[{"name": "prefers-color-scheme", "value": theme}])
                await cmd("Page.navigate", url=f"{BASE}/?k={TOKEN}" if first else f"{BASE}/"); first = False
                await asyncio.sleep(5)
                await ev("localStorage.removeItem('theme')")
                await shot(f"v6-{theme}-{w}.png")
                if w == 390:
                    await ev("document.querySelector('#menuBtn').click()"); await asyncio.sleep(.8)
                    b = await shot(f"v6-{theme}-390-drawer.png")
                    st = await ev(STY)
                    # 截图取色：按钮中心偏左（避开文字）与 Logo 中心
                    try:
                        from PIL import Image
                        im = Image.open(io.BytesIO(b)).convert('RGB'); sc = 2
                        bx, by, bw, bh = st['btn']['rect']; st['px_btn'] = '#%02x%02x%02x' % im.getpixel((int((bx + 10) * sc), int((by + bh / 2) * sc)))
                        lx, ly, lw, lh = st['logo']['rect']; st['px_logo_center'] = '#%02x%02x%02x' % im.getpixel((int((lx + lw * 0.30) * sc), int((ly + lh / 2) * sc)))
                    except Exception as e: st['px_err'] = str(e)
                    res[theme] = st
                elif w == 1440:
                    res[theme + '-1440'] = await ev(STY)
    print(json.dumps(res, ensure_ascii=False, indent=1))
    json.dump(res, open(f"{OUT}/styles.json", "w"), ensure_ascii=False, indent=1)
try: asyncio.run(main())
finally: p.terminate()
