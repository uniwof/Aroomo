#!/usr/bin/env python3
"""无头 Chromium（CDP）界面测试 v3（Grok 底子：左抽屉 + 底部大输入栏 + 底部弹层；2026-10-23 起导航从底部 tab 改为抽屉，选择器随之更新，检查项只增不减）：iPhone 390×844。登录 → 对话页 → AI成员页 → 成员详情抽屉 → 新项目弹层（Hark 推荐）→ 资源库（4 个标签页）→ 设置页 → 资源管家私聊 → 搜索 → 深色模式。截图在 shots/。
默认不发言（不耗 Workers AI 额度）；加 --round 会真的跑一轮。
用法：python3 localproxy.py &  ;  python3 ui_test.py [BASE] [TOKEN_FILE] [--round]（默认值不变：https://chat.pcmanai.com）
环境变量切换：AGC_BASE=http://127.0.0.1:8787 AGC_TOKEN=<令牌> python3 ui_test.py；AGC_TOKEN_FILE 亦可。
可选：AGC_CHROMIUM=浏览器路径（默认 /workspace/rb 里的 chromium，没有就用 PATH 里的 chromium/google-chrome）、AGC_PROXY=代理（默认不变 http://127.0.0.1:8899，配合 localproxy.py；直连本机设为空）。
"""
import asyncio, re, json, subprocess, os, sys, time, base64, urllib.request, websockets
R = "/workspace/rb"; HERE = os.path.dirname(os.path.abspath(__file__)); SH = os.environ.get("AGC_SHOTS") or f"{HERE}/shots"; os.makedirs(SH, exist_ok=True)   # AGC_SHOTS：截图另存（不弄脏仓库里的基线截图）
args = [a for a in sys.argv[1:] if not a.startswith('--')]
import shutil
BASE = (args[0] if args else os.environ.get('AGC_BASE', 'https://chat.pcmanai.com')).rstrip('/')   # 默认值不变；AGC_BASE 可切到本机 wrangler dev
TF = args[1] if len(args) > 1 else os.environ.get('AGC_TOKEN_FILE', '/workspace/storage/secrets/ai-groupchat.json')
raw = (os.environ.get('AGC_TOKEN', '').strip() if not args[1:] else '') or open(TF).read().strip()   # AGC_TOKEN 直接给令牌（优先于默认令牌文件）
ROUND = '--round' in sys.argv
TOKEN = json.loads(raw)['ACCESS_TOKEN'] if raw.startswith('{') else raw
proxy = os.environ.get('AGC_PROXY', 'http://127.0.0.1:8899')   # 默认不变；本机直连设 AGC_PROXY=（空）
CHROME = os.environ.get('AGC_CHROMIUM') or (f"{R}/root/usr/lib/chromium/chromium" if os.path.exists(f"{R}/root/usr/lib/chromium/chromium") else (shutil.which('chromium') or shutil.which('google-chrome') or 'chromium'))
env = dict(os.environ, PATH=f"{R}/root/usr/bin:{R}/bin:" + os.environ["PATH"],
           LD_LIBRARY_PATH=f"{R}/root/usr/lib/aarch64-linux-gnu:{R}/root/lib/aarch64-linux-gnu:{R}/root/usr/lib/chromium",
           FONTCONFIG_PATH=f"{R}/root/etc/fonts")
argv = [CHROME, "--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=9352",
        "--user-data-dir=/tmp/agc_ui2", "--ignore-certificate-errors"] + ([f"--proxy-server={proxy}"] if proxy else []) + ["about:blank"]
p = subprocess.Popen(argv, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(30):
    try:
        t = json.load(urllib.request.build_opener(urllib.request.ProxyHandler({})).open("http://127.0.0.1:9352/json")); break
    except Exception: time.sleep(1)
ws_url = [x for x in t if x["type"] == "page"][0]["webSocketDebuggerUrl"]
fails = []
def check(l, c, x=""):
    out = ("PASS " if c else "FAIL ") + l + (f"  [{x}]" if x != "" else "")
    out = out.replace(TOKEN, TOKEN[:4] + '…<已打码>') if TOKEN else out
    out = re.sub(r'\b(op_[0-9a-f]{4})[0-9a-f]{8,}', r'\1…<已打码>', out); out = re.sub(r'\b([0-9a-f]{4})[0-9a-f]{28,}\b', r'\1…<已打码>', out)
    print(out, flush=True)
    if not c: fails.append(l)

async def main():
    async with websockets.connect(ws_url, max_size=80_000_000, proxy=None) as ws:
        n = [0]
        async def cmd(m, **pa):
            n[0] += 1; i = n[0]; await ws.send(json.dumps({"id": i, "method": m, "params": pa}))
            while True:
                r = json.loads(await ws.recv())
                if r.get("id") == i: return r.get("result", r)
        async def ev(js): return (await cmd("Runtime.evaluate", expression=js, awaitPromise=True, returnByValue=True))["result"].get("value")
        async def tap_ok(where):
            r = await ev("(()=>{const bad=[...document.querySelectorAll('button,select,input:not([type=hidden]),a.btn,[role=button]')].filter(e=>{const r=e.getBoundingClientRect();if(!r.width||!r.height)return false;if(e.closest('#drawer:not(.open)')&&innerWidth<1000)return false;if(r.bottom<0||r.top>innerHeight)return false;if(e.classList.contains('copy'))return false;if(e.matches('input[type=checkbox]'))return false;return r.height<43.5}).map(e=>(e.id||e.className||e.tagName)+':'+Math.round(e.getBoundingClientRect().height));return {bad,ov:document.documentElement.scrollWidth-innerWidth}})()")
            check(f"{where}：可见可点控件 ≥44px、无横向溢出", not r['bad'] and r['ov'] <= 0, r)
        async def shot(name): r = await cmd("Page.captureScreenshot", format="png"); open(f"{SH}/{name}", "wb").write(base64.b64decode(r["data"]))
        await cmd("Page.enable"); await cmd("Runtime.enable")
        await cmd("Emulation.setDeviceMetricsOverride", width=390, height=844, deviceScaleFactor=2, mobile=True)
        await cmd("Emulation.setEmulatedMedia", features=[{"name": "prefers-color-scheme", "value": "light"}])
        await cmd("Page.navigate", url=f"{BASE}/?k={TOKEN}"); await asyncio.sleep(5)
        href = await ev("location.href")
        check("登录后地址栏无令牌", TOKEN not in href, href.replace(TOKEN, '<T>'))
        fs = await ev("parseFloat(getComputedStyle(document.body).fontSize)"); check("正文字号 ≥18px", fs >= 18, fs)
        st = await ev("document.querySelector('#status').textContent"); check("成员已加载", 'AI成员' in (st or ''), st)
        check("顶部有全局搜索框", await ev("!!document.querySelector('#q')"))
        # v3 新增：PWA、主题色、输入栏、抽屉、无横向溢出、可见按钮点按区
        pwa = await ev("(async()=>{const l=document.querySelector('link[rel=manifest]');if(!l)return null;const r=await fetch(l.href);const m=await r.json();const ic=await fetch('/apple-touch-icon.png');return {ok:r.ok,disp:m.display,icons:(m.icons||[]).length,maskable:(m.icons||[]).some(i=>i.purpose==='maskable'),apple:ic.ok&&ic.headers.get('content-type')==='image/png',tc:document.querySelectorAll('meta[name=theme-color]').length,cap:!!document.querySelector('meta[name=apple-mobile-web-app-capable]')}})()")
        check("PWA：manifest 可读、standalone、有 maskable 图标、apple-touch-icon、theme-color", bool(pwa) and pwa['ok'] and pwa['disp'] == 'standalone' and pwa['icons'] >= 3 and pwa['maskable'] and pwa['apple'] and pwa['tc'] >= 1 and pwa['cap'], pwa)
        cmp_ = await ev("(()=>{const i=document.querySelector('#inp'),s=document.querySelector('#sendBtn'),b=document.querySelector('.cbox');return {fs:parseFloat(getComputedStyle(i).fontSize),sh:s.getBoundingClientRect().height,sw:s.getBoundingClientRect().width,r:parseFloat(getComputedStyle(b).borderTopLeftRadius),bottom:Math.round(innerHeight-b.getBoundingClientRect().bottom)}})()")
        check("底部大输入栏：圆角胶囊 ≥20px、输入 ≥19px、发送钮 ≥44px、贴底", cmp_['r'] >= 20 and cmp_['fs'] >= 19 and cmp_['sh'] >= 44 and cmp_['sw'] >= 44 and cmp_['bottom'] < 80, cmp_)
        await ev("document.querySelector('#menuBtn').click()"); await asyncio.sleep(.6)
        dr = await ev("(()=>{const r=document.querySelector('#drawer').getBoundingClientRect();return {left:Math.round(r.left),w:Math.round(r.width),items:document.querySelectorAll('#sideNav button').length}})()")
        await shot("v3-00-drawer-light.png")
        await ev("document.querySelector('#setBtn').click()"); await asyncio.sleep(.8)
        await asyncio.sleep(1.5)
        st_ = await ev("(()=>{const p=document.querySelector('#v-settings');return {on:p.classList.contains('on'),seg:p.querySelectorAll('#themeSeg button').length,fs:p.querySelectorAll('.fsrow [data-fs]').length,rm:!!p.querySelector('#setRm'),logout:!!p.querySelector('#setOut'),route:!!p.querySelector('#setBlock'),push:!!p.querySelector('#setPush'),ar:!!p.querySelector('#setAr'),drawerClosed:!document.querySelector('#drawer').classList.contains('open')}})()")
        await asyncio.sleep(1.5)
        ld = await ev("({sel:document.querySelectorAll('#setLead select.sel').length,pair:document.querySelectorAll('#setLead [data-pair]').length,mcp:document.querySelector('#setLead').innerText.includes('/mcp'),charter:!!document.querySelector('#lsCharter'),to:!!document.querySelector('#lsTo')})")
        # P1-1：负责人下拉只列服务端 /api/lead/candidates 返回的合格成员
        p1 = await ev("""(async()=>{const r=await fetch('/api/lead/candidates',{credentials:'same-origin'});const j=await r.json();const ok=new Set(j.candidates.map(x=>x.id));const bad=new Set(j.ineligible.map(x=>x.id));
          const opts=[...document.querySelectorAll('#setLead select.sel option')].filter(o=>!o.disabled&&o.value&&!['none','keep','off','builtin'].includes(o.value));
          const ids=opts.map(o=>o.value.replace(/^m:/,''));const memberIds=ids.filter(v=>ok.has(v)||bad.has(v));
          return {n:ids.length,inCand:memberIds.filter(v=>ok.has(v)).length,leak:memberIds.filter(v=>bad.has(v)),sample:ids.slice(0,6),cand:j.candidates.length}})()""")
        check("P1-1 负责人下拉：可选成员都来自服务端候选、不合格成员（生图/网页/pending）一个都不出现", p1 and p1['inCand'] >= 1 and not p1['leak'], p1)
        check("设置·负责人：主/副两种模式（A 内置大脑下拉 + B 关联智能体配对码）、超时、MCP 地址、岗位说明书可编辑", ld['sel'] >= 3 and ld['pair'] >= 2 and ld['mcp'] and ld['charter'] and ld['to'], ld)
        check("设置页（独立页面）：外观三档、文字大小 4 档、减少动效、朗读、完成提醒、敏感来源路由、退出登录", st_['on'] and st_['seg'] == 3 and st_['fs'] == 4 and st_['rm'] and st_['logout'] and st_['route'] and st_['push'] and st_['ar'] and st_['drawerClosed'], st_)
        await asyncio.sleep(1.5); rl = await ev("(()=>{const b=document.querySelector('#setRelay');const a=document.querySelector('#rlAdd');return {box:!!b,txt:b?b.innerText.slice(0,60):'',add:a?Math.round(a.getBoundingClientRect().height):0}})()")
        check("P1-2 设置页有「网页代发员」：说明 + 登记按钮 ≥44px", rl['box'] and '代发' in rl['txt'] and rl['add'] >= 44, rl)
        await ev("show('ideas')"); await asyncio.sleep(2); idv = await ev("(()=>{const r=[...document.querySelectorAll('#ideaList [data-idea]')];return {n:r.length,h:r.length?Math.min(...r.map(x=>x.getBoundingClientRect().height)):0,seg:document.querySelectorAll('#ideaSeg button').length,fs:r.length?parseFloat(getComputedStyle(r[0].querySelector('.t')).fontSize):0,ov:document.documentElement.scrollWidth-document.documentElement.clientWidth}})()")
        check("P1-3 点子库页：预填 ≥6 个点子、按状态筛选 4 档、每行 ≥44px、标题 ≥19px、无横向溢出", idv['n'] >= 6 and idv['seg'] == 4 and idv['h'] >= 44 and idv['fs'] >= 19 and idv['ov'] <= 0, idv)
        await ev("document.querySelector('#ideaList [data-idea=\"seed-photo\"]').click()"); await asyncio.sleep(2); ids = await ev("(()=>({t:document.querySelector('#pTitle').textContent,b:!!document.querySelector('#ideaProj')}))()"); check("P1-3 点子详情：有想法/关联项目区、可「用这个点子新建项目」", '老照片' in ids['t'] and ids['b'], ids)
        await ev("document.querySelector('#ideaProj').click()"); await asyncio.sleep(2); npi = await ev("(()=>{const s=document.querySelector('#npIdea');return s?{n:s.options.length,v:s.value}:null})()"); check("P1-3 新建项目可关联点子（下拉预选了该点子）", bool(npi) and npi['n'] >= 6 and npi['v'] == 'seed-photo', npi); await ev("document.querySelector('#xBtn').click()"); await asyncio.sleep(.5); await ev("show('settings')"); await asyncio.sleep(1)
        await shot("v4-light-settings.png")
        await tap_ok("设置页")
        await ev("document.querySelector('#v-settings #themeSeg [data-t=dark]').click()"); await asyncio.sleep(.5)
        dk = await ev("getComputedStyle(document.body).backgroundColor")
        await shot("v4-dark-settings.png")
        await ev("document.querySelector('#v-settings #themeSeg [data-t=\"\"]').click()"); await asyncio.sleep(.3)
        check("手动切换深色生效（暖黑 #191815）、切回跟随系统", dk == "rgb(25, 24, 21)" and await ev("!document.documentElement.dataset.theme"), dk)
        for fsv in ('21', '25'):
            await ev(f"document.querySelector('[data-fs=\"{fsv}\"]').click()"); await asyncio.sleep(.5)
            z = await ev("({z:document.documentElement.style.zoom,ov:document.documentElement.scrollWidth-document.documentElement.clientWidth})")
            check(f"大字模式 {fsv}px：整页放大、无横向溢出", z['z'] and float(z['z']) > 1 and z['ov'] <= 0, z)
        await shot("v4-light-settings-25px.png")
        await ev("document.querySelector('#sideNav button[data-v=members]').click()"); await asyncio.sleep(1.5)
        ov25 = await ev("document.documentElement.scrollWidth-document.documentElement.clientWidth"); check("特大字下 AI成员页无横向溢出", ov25 <= 0, ov25)
        await shot("v4-light-members-25px.png")
        await ev("document.querySelector('#setBtn').click()"); await asyncio.sleep(1)
        await ev("document.querySelector('[data-fs=\"19\"]').click()"); await asyncio.sleep(.3)
        check("文字大小可调回标准（最小 19px）", await ev("!document.documentElement.style.zoom && parseFloat(getComputedStyle(document.body).fontSize)>=19"))
        rm0 = await ev("document.documentElement.classList.contains('rm')")
        rmInfo = await ev("JSON.stringify({n:document.querySelectorAll('#setRm').length,chk:document.querySelector('#setRm')&&document.querySelector('#setRm').checked,ls:localStorage.getItem('agc-rm')})")
        await ev("document.querySelector('#setRm').click()"); await asyncio.sleep(.4)
        rm1 = await ev("document.documentElement.classList.contains('rm')")
        check("减少动效开关生效", rm1 != rm0, [rm0, rm1, rmInfo])
        await ev("document.querySelector('#setRm').click()")
        await ev("document.querySelector('#menuBtn').click()"); await asyncio.sleep(.6)
        await ev("document.querySelector('#scrim').click()"); await asyncio.sleep(.6)
        dr2 = await ev("Math.round(document.querySelector('#drawer').getBoundingClientRect().right)")
        check("左抽屉：点 ☰ 滑出（五个入口：对话/项目/AI成员/点子/资源库）、点遮罩收回", dr['left'] >= -1 and dr['w'] >= 280 and dr['items'] == 5 and dr2 <= 2, [dr, dr2])
        await shot("v2-01-chat-light.png")
        # 打开一个已有项目（旧房间兼容）
        pin = await ev("(()=>{const f=document.querySelector('#roomList [data-room]');return f?{pin:f.classList.contains('pin'),t:f.textContent}:null})()")
        check("最近项目最上面是置顶的「资源管家 · 私聊」", bool(pin) and pin['pin'] and '资源管家' in pin['t'], pin)
        nrooms = await ev("document.querySelectorAll('#roomList .ritem:not(.pin)').length + 1")
        if nrooms > 1:
            await ev("document.querySelector('#roomList .ritem:not(.pin)').click()"); await ev("(async()=>{for(let i=0;i<30;i++){if(document.querySelector('#chat .msg'))break;await new Promise(r=>setTimeout(r,300))}})()")
            nm = await ev("document.querySelectorAll('#chat .msg').length"); check("打开已有项目显示消息", nm >= 1, nm)
            lay = await ev("(()=>{const m=document.querySelector('#chat .msg:not(.user)');if(!m)return null;const a=m.querySelector('.av').getBoundingClientRect(),w=m.querySelector('.who').getBoundingClientRect(),b=m.querySelector('.bubble').getBoundingClientRect();return {avLeft:a.left<w.left,stack:w.bottom<=b.top+2,alignL:Math.abs(w.left-b.left)<6,bg:getComputedStyle(m.querySelector('.bubble')).backgroundColor,fg:getComputedStyle(m.querySelector('.bubble')).color}})()")
            check("消息布局：头像左、名字在气泡上方左对齐、气泡品牌底色", bool(lay) and lay['avLeft'] and lay['stack'] and lay['alignL'], lay)
            await shot("v2-02-room-light.png")
        await tap_ok("对话页")
        cp = await ev("(()=>{const b=document.querySelector('#chat .msg .copy');if(!b)return null;const r=b.getBoundingClientRect(),a=getComputedStyle(b,'::before');return Math.round(r.height-2*parseFloat(a.top))})()")
        check("消息复制按钮点按区 ≥44px（含扩展热区）", cp is None or cp >= 44, cp)
        lu = await ev("(()=>{const s=[...document.querySelectorAll('#roomHead .slot')];return {n:s.length,ok:s.every(x=>x.querySelector('.av svg.ring')&&x.querySelector('.pill')&&/可用|不可用|未探测/.test(x.querySelector('.pill').textContent))}})()")
        check("阵容条：每张卡有带圆环头像 + 状态文字小框", lu['n'] >= 1 and lu['ok'], lu)
        # AI成员页
        await ev("document.querySelector('#sideNav button[data-v=members]').click()"); await asyncio.sleep(2)
        rows = await ev("document.querySelectorAll('#memList .row').length"); check("AI成员页统一列表", rows >= 20, rows)
        gs = await ev("(()=>{const r=[...document.querySelectorAll('#memList .row')].map(x=>{const a=x.querySelector('.av'),f=getComputedStyle(a.querySelector('.face')).filter,t=x.querySelector('.pill').textContent;return {on:a.classList.contains('on'),gray:f.includes('grayscale'),t}});return {n:r.length,okColor:r.filter(x=>x.t==='可用').every(x=>x.on&&!x.gray),offGray:r.filter(x=>x.t!=='可用').every(x=>!x.on&&x.gray),nOff:r.filter(x=>x.t!=='可用').length,dots:document.querySelectorAll('#memList .dot').length}})()")
        check("在线=彩色头像、离线=黑白头像（无单独状态点）", gs['okColor'] and gs['offGray'] and gs['nOff'] >= 1 and gs['dots'] == 0, gs)
        rings = await ev("[document.querySelectorAll('#memList .av').length, document.querySelectorAll('#memList .av svg.ring .trk').length, document.querySelectorAll('#memList .arc').length]")
        gap = await ev("(()=>{const a=document.querySelector('#memList .av'),f=a.querySelector('.face').getBoundingClientRect(),r=a.getBoundingClientRect(),sw=parseFloat(getComputedStyle(a.querySelector('.trk')).strokeWidth);return +(((20-sw/2)*r.width/44)-f.width/2).toFixed(2)})()")
        check("头像与额度圆环之间有细缝（2–3.5px）", gap is not None and 2 <= gap <= 3.5, gap)
        check("每个头像都有额度圆环", rings[0] >= 20 and rings[0] == rings[1] and rings[2] >= 1, rings)
        await tap_ok("AI成员页")
        await shot("v2-03-members-light.png")
        await ev("document.querySelector('#memList [data-mid=\"gpt-oss-120b\"]').click()"); await asyncio.sleep(2.5)
        # ── 角色卡（2026-10-23）──
        rc = await ev("(()=>{const w=document.querySelector('#panel .rc-wrap'),tl=document.querySelector('#panel [role=tablist]'),tabs=[...document.querySelectorAll('#panel [role=tab]')],pans=document.querySelectorAll('#panel [role=tabpanel]');return {card:!!w,av:!!w&&!!w.querySelector('.av.xl svg.ring'),pill:!!w&&/可用|不可用|未探测/.test(w.querySelector('.pill').textContent),bar:!!w&&!!w.querySelector('.bar'),spark:!!w&&!!w.querySelector('.spark'),tl:!!tl,n:tabs.length,minH:Math.min(...tabs.map(t=>t.getBoundingClientRect().height)),minW:Math.min(...tabs.map(t=>t.getBoundingClientRect().width)),labels:tabs.every(t=>t.getAttribute('aria-label')),ctl:tabs.every(t=>document.getElementById(t.getAttribute('aria-controls'))),pans:pans.length,title:document.querySelector('#mtTitle').textContent,titleFs:parseFloat(getComputedStyle(document.querySelector('#mtTitle')).fontSize),tags:document.querySelectorAll('#panel .rc .tag7:not([data-more])').length,tagFs:Math.min(...[...document.querySelectorAll('#panel .rc .tag7')].map(x=>parseFloat(getComputedStyle(x).fontSize))),hash:[...document.querySelectorAll('#panel .rc .tag7:not([data-more])')].every(x=>x.textContent.startsWith('#')),tabOv:tl?tl.scrollWidth-tl.clientWidth:9}})()")
        check("角色卡：固定卡片（带圆环大头像、文字状态、额度条、7 天调用图）", rc['card'] and rc['av'] and rc['pill'] and rc['bar'] and rc['spark'], rc)
        check("角色卡：#特征标签七彩 chip 在头像右边、≥19px、最多 5 个其余折叠 +N", 1 <= rc['tags'] <= 5 and rc['tagFs'] >= 19 and rc['hash'], rc)
        check("角色卡：图标分段栏 role=tablist/tab/tabpanel、5 个、每个 ≥44px、有 aria-label、不横向溢出、下方中文小标题 ≥19px", rc['tl'] and rc['n'] == 5 and rc['minH'] >= 44 and rc['minW'] >= 44 and rc['labels'] and rc['ctl'] and rc['pans'] == 5 and rc['tabOv'] <= 0 and rc['title'] and rc['titleFs'] >= 19, rc)
        await ev("document.querySelector('#panel [data-mt=hist]').click()"); await asyncio.sleep(.3)
        sw = await ev("({sel:document.querySelector('#panel [aria-selected=true]').dataset.mt,vis:[...document.querySelectorAll('#panel [role=tabpanel]')].filter(p=>!p.hidden).map(p=>p.id),t:document.querySelector('#mtTitle').textContent})")
        check("角色卡：点标签真切换（只显示一类）+ 小标题同步", sw['sel'] == 'hist' and sw['vis'] == ['mp-hist'] and sw['t'] == '历史项目', sw)
        await ev("(()=>{const b=document.querySelector('#panel [data-mt=hist]');b.focus();b.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))})()"); await asyncio.sleep(.3)
        check("角色卡：方向键左右切换", await ev("document.querySelector('#panel [aria-selected=true]').dataset.mt") == 'calls')
        await ev("document.querySelector('#panel [data-mt=quota]').click()"); await asyncio.sleep(.3)
        stk = await ev("(async()=>{const pb=document.querySelector('#pbody');pb.scrollTop=0;await new Promise(r=>setTimeout(r,200));const t0=document.querySelector('#panel .rc-wrap').getBoundingClientRect().top;pb.scrollTop=900;await new Promise(r=>setTimeout(r,300));const w=document.querySelector('#panel .rc-wrap').getBoundingClientRect(),p=pb.getBoundingClientRect();return {scrolled:pb.scrollTop,t0:Math.round(t0),top:Math.round(w.top),pbTop:Math.round(p.top),visible:w.bottom>p.top+20}})()")
        check("角色卡：滚动内容时卡片仍固定在顶部（sticky）", stk['scrolled'] > 50 and abs(stk['top'] - stk['pbTop']) <= 8 and stk['visible'], stk)
        await ev("document.querySelector('#panel .rc-wrap')&&(document.querySelector('#pbody').scrollTop=0)")
        await shot("v5-light-rolecard.png")
        await ev("document.querySelector('#xBtn').click()"); await asyncio.sleep(.5)
        await ev("document.querySelector('#memList [data-mid=\"gpt-oss-120b\"]').click()"); await asyncio.sleep(2.5)
        check("角色卡：记住上次打开的标签", await ev("document.querySelector('#panel [aria-selected=true]').dataset.mt") == 'quota')
        await ev("document.querySelector('#xBtn').click()"); await asyncio.sleep(.5)
        # 大字模式（最大档 25px）下角色卡不溢出
        await ev("localStorage.setItem('agc-fs','25');applyFs()"); await asyncio.sleep(.4)
        await ev("document.querySelector('#memList [data-mid=\"gpt-oss-120b\"]').click()"); await asyncio.sleep(2.5)
        big = await ev("(()=>{const P=document.querySelector('#pbody'),tl=document.querySelector('#panel [role=tablist]'),rc=document.querySelector('#panel .rc');const bad=[...document.querySelectorAll('#panel .rc *')].filter(e=>e.getBoundingClientRect().right>rc.getBoundingClientRect().right+1).length;return {ov:P.scrollWidth-P.clientWidth,tab:tl.scrollWidth-tl.clientWidth,bad,doc:document.documentElement.scrollWidth-document.documentElement.clientWidth,minTab:Math.min(...[...document.querySelectorAll('#panel [role=tab]')].map(t=>t.getBoundingClientRect().height))}})()")
        check("大字模式（25px）下角色卡与标签栏不横向溢出、标签仍 ≥44px", big['ov'] <= 0 and big['tab'] <= 0 and big['bad'] == 0 and big['doc'] <= 0 and big['minTab'] >= 44, big)
        await shot("v5-light-rolecard-25px.png")
        await ev("document.querySelector('#xBtn').click()"); await asyncio.sleep(.4)
        await ev("localStorage.setItem('agc-fs','19');applyFs()"); await asyncio.sleep(.3)
        # 减少动效：贴纸不旋转、按钮按下不位移
        await ev("document.documentElement.classList.add('rm')")
        rmc = await ev("(()=>{const b=document.querySelector('.btn');return getComputedStyle(b).transitionDuration})()")
        check("减少动效下无过渡动画", all(float(x.replace('s','')) < 0.01 for x in rmc.split(',')), rmc)
        await ev("document.documentElement.classList.remove('rm')")
        await ev("document.querySelector('#xBtn').click()"); await asyncio.sleep(.5)
        # 资源库：4 个分段标签页（真切换）
        await ev("document.querySelector('#sideNav button[data-v=tools]').click()"); await asyncio.sleep(2)
        tb = await ev("(()=>{const t=[...document.querySelectorAll('#rtabs [role=tab]')];return {n:t.length,role:document.querySelector('#rtabs').getAttribute('role'),labels:t.map(x=>x.textContent.replace(/[·\\d\\s]+$/,'').trim()),minH:Math.min(...t.map(x=>x.getBoundingClientRect().height)),fs:Math.min(...t.map(x=>parseFloat(getComputedStyle(x).fontSize))),title:document.querySelector('#v-tools h1').textContent,hash:location.hash}})()")
        check("资源库：标题已改名、4 个标签（role=tab）、每个 ≥44px、字号 ≥19px", tb['title'] == '资源库' and tb['n'] == 4 and tb['role'] == 'tablist' and tb['minH'] >= 44 and tb['fs'] >= 19, tb)
        for t in ('keys', 'tools', 'skills', 'sites'):
            await ev(f"document.querySelector('#rtabs [data-tab={t}]').click()"); await asyncio.sleep(2)
            vis = await ev("[...document.querySelectorAll('.rpanel')].filter(p=>!p.hidden&&p.getBoundingClientRect().height>0).map(p=>p.id)")
            sel = await ev("[...document.querySelectorAll('#rtabs [role=tab]')].filter(b=>b.getAttribute('aria-selected')==='true').map(b=>b.dataset.tab)")
            cards = await ev(f"document.querySelectorAll('#rp-{t} .keycard,#rp-{t} .toolcard,#rp-{t} .tcard,#rp-{t} .rcard').length")
            check(f"标签「{t}」：只显示这一类（不是锚点跳转）、选中态正确、有内容、地址 #res/{t}", vis == [f'rp-{t}'] and sel == [t] and cards >= 3 and await ev("location.hash") == f'#res/{t}', [vis, sel, cards])
            await tap_ok(f"资源库·{t}")
        await ev("document.querySelector('#rtabs [data-tab=tools]').click()"); await asyncio.sleep(1.5)
        tg = await ev("(()=>{const h=[...document.querySelectorAll('#toolList h2')].map(x=>x.textContent);const c=[...document.querySelectorAll('#toolList .tcard')];return {h,cf:h.some(x=>x.startsWith('算力')),sb:h.some(x=>x.startsWith('沙盒')),hark:h.includes('仅 Hark 可用'),noCf:!document.querySelector('#toolList').innerText.includes('Workers AI 算力'),st:c.filter(x=>x.querySelector('.sticker')).length,n:c.length,warn:document.querySelectorAll('#toolList .billwarn').length,src:document.querySelectorAll('#toolList .srcline a').length}})()")
        check("资源库「工具与算力」：分组正确（算力/沙盒/仅 Hark 可用）、Workers AI 已移出、每张角色卡式工具卡有状态贴纸、自动扣费醒目、核实来源", tg['cf'] and tg['sb'] and tg['hark'] and tg['noCf'] and tg['st'] == tg['n'] and tg['n'] >= 15 and tg['warn'] >= 3 and tg['src'] >= 10, tg)
        cellfs = await ev("Math.min(...[...document.querySelectorAll('#toolList .tcell .gv')].map(x=>parseFloat(getComputedStyle(x).fontSize)))"); check("工具卡数据格字号 ≥19px", cellfs >= 19, cellfs)
        await shot("v5-light-tools.png")
        await ev("document.querySelector('#rtabs [data-tab=sites]').click()"); await asyncio.sleep(1)
        gone = await ev("(()=>{const g=[...document.querySelectorAll('#siteList .rcard.gone')];return {n:g.length,pill:g.every(x=>/已过期/.test(x.textContent))}})()")
        check("过期条目标灰并写「已过期」", gone['n'] >= 1 and gone['pill'], gone)
        await ev("(()=>{const i=document.querySelector('[data-rq=sites]');i.value='配音';i.dispatchEvent(new Event('input'))})()"); await asyncio.sleep(.6)
        sr = await ev("document.querySelector('#siteList').innerText"); check("标签内搜索「配音」找到 Fish Audio", 'Fish Audio' in sr, sr[:80])
        await ev("(()=>{const i=document.querySelector('[data-rq=sites]');i.value='';i.dispatchEvent(new Event('input'))})()")
        await ev("document.querySelector('#rtabs [data-tab=keys]').click()"); await asyncio.sleep(.5)
        await ev("document.querySelector('#sideNav button[data-v=chat]').click()"); await asyncio.sleep(.5)
        await ev("location.hash='#res/skills'"); await asyncio.sleep(2.5)
        hv = await ev("({v:document.querySelector('#v-tools').classList.contains('on'),sel:document.querySelector('#rtabs [aria-selected=true]').dataset.tab})")
        check("网址 #res/skills 直达资源库「技能」标签", hv['v'] and hv['sel'] == 'skills', hv)
        await ev("history.back()"); await asyncio.sleep(1.5)
        check("浏览器后退：离开资源库或回到上一个标签", await ev("!document.querySelector('#v-tools').classList.contains('on') || document.querySelector('#rtabs [aria-selected=true]').dataset.tab!=='skills'"))
        await ev("document.querySelector('#sideNav button[data-v=tools]').click()"); await asyncio.sleep(1)
        check("记住上次选的标签", await ev("document.querySelector('#rtabs [aria-selected=true]').dataset.tab") in ('skills', 'keys'))
        await ev("document.querySelector('#rtabs [data-tab=keys]').click()"); await asyncio.sleep(2)
        await shot("v2-05-tools.png")
        nk = await ev("(async()=>{for(let i=0;i<20;i++){if(document.querySelectorAll('#keyList .keyrow').length)break;await new Promise(r=>setTimeout(r,300))}return document.querySelectorAll('#keyList .keyrow').length})()")
        check("资源库「API 密钥」标签：每个来源一行（含 Bark 推送）", nk >= 16, nk)
        sz = await ev("(()=>{const i=document.querySelector('#keyList .keyin'),b=document.querySelector('#keyList [data-ksave]');if(!i||!b)return null;return {fs:parseFloat(getComputedStyle(i).fontSize),ih:i.getBoundingClientRect().height,bh:b.getBoundingClientRect().height,bfs:parseFloat(getComputedStyle(b).fontSize),pw:i.type}})()")
        check("密钥输入框 19px、按钮 ≥44px、输入框遮挡明文", bool(sz) and sz['fs'] >= 19 and sz['ih'] >= 44 and sz['bh'] >= 44 and sz['pw'] == 'password', sz)
        tgt = await ev("(()=>{const r=[...document.querySelectorAll('#keyList .keyrow')].find(r=>['LAMBDA_API_KEY','BEAM_API_KEY'].includes(r.dataset.env)&&r.querySelector('[data-kstate=empty]')&&r.dataset.env==='LAMBDA_API_KEY');return r?r.dataset.env:null})()")
        if tgt:
            fake = 'agc-ui-test-invalid-' + 'Z' * 10 + 'LMNO'
            await ev(f"(()=>{{const r=document.querySelector('#keyList [data-env={tgt}]');r.querySelector('.keyin').value='{fake}';r.querySelector('[data-ksave]').click()}})()")
            res = await ev("(async()=>{for(let i=0;i<60;i++){const m=document.querySelector('#keyList [data-env=%s] .kmsg');if(m&&/验证失败|已验证|已保存|没保存|没通过/.test(m.textContent))return m.textContent;await new Promise(r=>setTimeout(r,500))}return ''})()" % tgt)
            html = await ev("document.body.innerHTML")
            check("页面保存错误 Key：显示验证失败、只显示末 4 位、不回显明文", '验证失败' in res and '…LMNO' in html and fake not in html, res[:80])
            await shot("v2-05b-keys.png")
            await ev(f"fetch('/api/keys/{tgt}',{{method:'DELETE',credentials:'same-origin'}}).then(r=>r.status)")
        else:
            check("UI 写入测试有空来源可用", False, 'LAMBDA_API_KEY 已填，跳过以免覆盖')
        # 新项目 + Hark 推荐
        await ev("document.querySelector('#sideNav button[data-v=chat]').click()"); await asyncio.sleep(.5)
        await ev("document.querySelector('#newBtn').click()"); await asyncio.sleep(1)
        await ev("document.querySelector('#npTopic').value='帮我写一段 Python 脚本批量重命名文件'")
        await ev("document.querySelector('#npPlan').click()"); await ev("(async()=>{for(let i=0;i<40;i++){if(!/正在挑人/.test(document.querySelector('#npNote').textContent))break;await new Promise(r=>setTimeout(r,500))}})()")
        note = await ev("document.querySelector('#npNote').textContent"); checked = await ev("document.querySelectorAll('[data-pk]:checked').length")
        avs = await ev("document.querySelectorAll('#npList .av').length")
        navail = await ev("D.members.filter(m=>m.state==='ok'&&m.id!=='hark'&&!m.steward).length")
        if navail:
            check("新项目：勾选成员 + 圆环 + Hark 推荐", '本轮分工' in (note or '') and checked >= 1 and avs > 5, f"{checked} 选中；{(note or '')[:80]}")
        else:  # 当下没有可用成员（如 Workers AI 当日额度用完、缺 Key）：应明确说明原因，列表照常可勾选
            check("新项目：无可用成员时 Hark 明说原因 + 列表可勾选", '没有可派' in (note or '') and avs > 5, f"可用 0 位；{(note or '')[:60]}")
        await shot("v2-06-new-project.png")
        # P1-5：代收条目在资源库标「来源：主负责人代收」+ 代收备注；配对成功提示「以后直接把链接发给负责人即可」（字 ≥19px）
        p15 = await ev("(()=>{const h=userCard({id:'t-0000000000000000',name:'代收样例',state:'未核实',from:'主负责人代收',via_note:'用户在外部 App 发的',via_src:'Hark 对话',model:'规则',updated:Date.now()});const d=document.createElement('div');d.className='billok';d.innerHTML='<p class=\"pairtip\">以后直接把链接发给负责人即可，它会收进资源库。</p>';document.body.appendChild(d);const fs=parseFloat(getComputedStyle(d.querySelector('.pairtip')).fontSize);d.remove();return {lab:h.includes('来源：主负责人代收'),note:h.includes('代收备注：Hark 对话 · 用户在外部 App 发的'),noVer:!h.includes('已核实'),plain:userCard({id:'u-0000000000000000',name:'普通',state:'未核实',model:'规则',updated:Date.now()}).includes('管家入库'),fs,src:document.documentElement.outerHTML.includes('以后直接把链接发给负责人即可')}})()")
        check("P1-5 代收条目卡片标「来源：主负责人代收」+ 代收备注、未核实不显示已核实；普通条目仍是「管家入库」；配对提示「以后直接把链接发给负责人即可」字 ≥19px", p15['lab'] and p15['note'] and p15['noVer'] and p15['plain'] and p15['fs'] >= 19 and p15['src'], p15)
        # P1-6：顶部用量胶囊（79% 正常 / 80% 提醒 / 100% 用完）+ 1027 识别 + 发件箱（断网发 3 条，恢复后各恰好一次）
        u6 = await ev("""(async()=>{const b=document.querySelector('#usageBtn');if(!b)return {none:1};const r=b.getBoundingClientRect();const o={h:r.height,fs:parseFloat(getComputedStyle(b).fontSize),top:r.top<80,al:b.getAttribute('aria-label')||''};
          renderUsage({requests:79000,limit:100000,pct:.79,level:'ok'});o.p79=[b.textContent.trim(),b.classList.contains('warn'),b.classList.contains('over'),!!document.querySelector('#cfBanner.on')];
          renderUsage({requests:80000,limit:100000,pct:.8,level:'warn'});o.p80=[b.textContent.trim(),b.classList.contains('warn'),(b.getAttribute('aria-label')||'').includes('80%')];
          renderUsage({requests:100000,limit:100000,pct:1,level:'over'});const bn=document.querySelector('#cfBanner');o.p100=[b.textContent.trim(),b.classList.contains('over'),!!(bn&&bn.classList.contains('on')),bn?bn.textContent:'',bn?parseFloat(getComputedStyle(bn).fontSize):0];
          hideCfBanner();renderUsage({requests:1000,limit:100000,pct:.01,level:'ok'});
          const F=window.fetch;window.fetch=async(u,o2)=>String(u).includes('/api/')?new Response('<html><title>Error 1027</title>error code: 1027</html>',{status:429,headers:{'content-type':'text/html'}}):F(u,o2);
          try{await api('/api/rooms')}catch(e){o.e1027=e.message}window.fetch=F;o.b1027=[!!document.querySelector('#cfBanner.on'),(document.querySelector('#cfBanner')||{}).textContent||''];hideCfBanner();
          window.fetch=async(u,o2)=>String(u).includes('/api/')?new Response(JSON.stringify({error:'服务器出错：Exceeded allowed volume of requests in Durable Objects free tier.'}),{status:500,headers:{'content-type':'application/json'}}):F(u,o2);
          try{await api('/api/rooms')}catch(e){o.edo=[e.message,!!e.net]}window.fetch=F;o.bdo=[!!document.querySelector('#cfBanner.on'),(document.querySelector('#cfBanner')||{}).textContent||''];hideCfBanner();return o})()""")
        check("P1-6 顶部用量胶囊 ≥44px、字 ≥18px；79% 不提醒、80% 变提醒样式（读屏标签写百分比）、100% 显示用完并出横幅（字 ≥19px，写明 UTC 0 点恢复）", not u6.get('none') and u6['h'] >= 44 and u6['fs'] >= 18 and u6['top'] and '79' in u6['p79'][0] and not u6['p79'][1] and not u6['p79'][2] and not u6['p79'][3] and u6['p80'][1] and u6['p80'][2] and u6['p100'][1] and u6['p100'][2] and '用完' in u6['p100'][3] and 'UTC' in u6['p100'][3] and u6['p100'][4] >= 19, u6)
        check("P1-6 识别 Cloudflare 1027：接口返回 1027 页面 → 错误提示写明额度用完、横幅出现", not u6.get('none') and '1027' in (u6.get('e1027') or '') and '额度' in (u6.get('e1027') or '') and u6['b1027'][0] and '1027' in u6['b1027'][1], u6.get('e1027'))
        check("P1-6 fix1 识别 Durable Object 免费额度用完（线上真实出现过的报错）→ 提示写明数据库额度、横幅出现、消息走发件箱", (u6.get('edo') or [''])[0].find('数据库') >= 0 and (u6.get('edo') or ['', False])[1] and (u6.get('bdo') or [False])[0] and 'UTC 0 点' in (u6.get('bdo') or ['', ''])[1], [u6.get('edo'), u6.get('bdo')])
        ob = await ev("""(async()=>{const st=await api('/api/start',{method:'POST',body:JSON.stringify({message:'P1-6 发件箱界面测试（自动删）',mode:'free',members:[{id:'gpt-oss-120b',role:'审查员'}]})});room=st.room;roomData=await api('/api/room/'+room);renderRoom();
          const F=window.fetch;let blocked=0;window.fetch=async(u,o2)=>{if(String(u).includes('/api/start')){blocked++;throw new TypeError('Failed to fetch')}return F(u,o2)};
          for(const t of ['离线一','离线二','离线三']){await send(t)}
          const pend=(await OB.all()).filter(x=>x.body&&x.body.room===room);const shown=[...document.querySelectorAll('.msg.pending')].map(e=>e.textContent);
          window.fetch=F;await flushOutbox();roomData=await api('/api/room/'+room);renderRoom();
          const tx=roomData.messages.filter(m=>m.kind==='user').map(m=>m.text);const left=(await OB.all()).filter(x=>x.body&&x.body.room===room).length;
          const r0=room;await fetch('/api/room/'+r0,{method:'DELETE',headers:{'content-type':'application/json'}});room=null;roomData=null;
          return {blocked,pend:pend.length,pstate:pend.map(x=>x.state),shown:shown.length,shownTxt:shown.join('|').slice(0,200),counts:['离线一','离线二','离线三'].map(t=>tx.filter(x=>x===t).length),left,store:OB.kind()}})()""")
        ob = ob or {}
        check("P1-6 发件箱：断网时发 3 条 → 都进发件箱、页面上标「待发送」；恢复后补发，每条在项目里恰好出现一次、发件箱清空", ob.get('pend') == 3 and all(x == 'pending' for x in ob.get('pstate', [])) and ob.get('shown') == 3 and '待发送' in ob.get('shownTxt', '') and ob.get('counts') == [1, 1, 1] and ob.get('left') == 0, ob)
        qb = await ev("(()=>{const b=document.querySelector('#npQuick');return b?{h:b.getBoundingClientRect().height,t:b.textContent,fs:parseFloat(getComputedStyle(b).fontSize)}:null})()")
        check("P1-4 新项目弹层有「快速建项目（全员加入）」按钮 ≥44px、字 ≥18px，不强制选成员", bool(qb) and qb['h'] >= 44 and qb['fs'] >= 18 and '全员' in qb['t'], qb)
        if ROUND:
            await ev("document.querySelector('#npGo').click()")
            for _ in range(90):
                await asyncio.sleep(2)
                if await ev("!busy&&!RUNNING"): break   # P1-4 起讨论进行中发送键是可点的「暂停」，改为等 busy 结束
            await shot("v2-07-round.png")
        else:
            await ev("document.querySelector('#xBtn').click()")
        # 资源管家置顶私聊
        await ev("document.querySelector('#menuBtn').click()"); await asyncio.sleep(.6)
        await ev("document.querySelector('#roomList .ritem.pin').click()"); await asyncio.sleep(3)
        sh = await ev("({t:document.querySelector('#roomHead').innerText,btn:!!document.querySelector('#stGather')&&!!document.querySelector('#stCheck'),mode:getComputedStyle(document.querySelector('#modeBtn')).display==='none',ph:document.querySelector('#inp').placeholder,msgs:document.querySelectorAll('#chat .msg').length})")
        check("资源管家私聊：头部说明、检查到期/搜集羊毛按钮、无模式切换、输入框提示贴链接", '资源管家' in sh['t'] and sh['btn'] and sh['mode'] and '链接' in sh['ph'] and sh['msgs'] >= 1, sh)
        await tap_ok("资源管家私聊")
        await shot("v4-light-steward.png")
        mic = await ev("(()=>{const b=document.querySelector('#micBtn').getBoundingClientRect();return {h:b.height,w:b.width}})()"); check("输入栏有语音输入按钮（≥44px）", mic['h'] >= 44 and mic['w'] >= 44, mic)
        say = await ev("document.querySelectorAll('#chat .msg .say').length"); check("每条成员消息有朗读按钮", say >= 1, say)
        # 新项目：敏感开关 + 路由预览
        await ev("document.querySelector('#newBtn').click()"); await asyncio.sleep(1)
        await ev("(()=>{const t=document.querySelector('#npTopic');t.value='帮我检查这个 API Key 是否泄露';t.dispatchEvent(new Event('input'))})()"); await asyncio.sleep(.5)
        np_ = await ev("({sens:document.querySelector('#npSens').checked,route:/将用：/.test(document.querySelector('#npList').innerText),steward:!!document.querySelector('[data-pk=steward]')})")
        check("新项目：题目含 API Key 自动勾「敏感项目」、每位成员显示将用的来源与级别、列表里没有资源管家", np_['sens'] and np_['route'] and not np_['steward'], np_)
        await shot("v4-light-newproject-sensitive.png")
        await ev("document.querySelector('#xBtn').click()"); await asyncio.sleep(.5)
        # 搜索
        await ev("(()=>{const q=document.querySelector('#q');q.value='议题';q.dispatchEvent(new Event('input'))})()"); await asyncio.sleep(2.5)
        res = await ev("document.querySelectorAll('#searchRes .row').length"); check("全局搜索有结果并高亮", res >= 1 and await ev("!!document.querySelector('#searchRes mark')"), res)
        await shot("v2-08-search.png")
        # P1-4：模式弹层（L7）、暂停按钮（N2）、决策按钮（N3）
        await ev("closeSheet&&closeSheet()"); await asyncio.sleep(.5)
        await ev("document.querySelector('#sideNav button[data-v=chat]').click()"); await asyncio.sleep(.5)
        await ev("document.querySelector('#modeBtn').click()"); await asyncio.sleep(.8)
        md = await ev("(()=>{const g=document.querySelector('#panel [role=radiogroup]');const r=[...document.querySelectorAll('#panel [role=radio]')];const d=r.map(x=>x.querySelector('.d'));return {g:!!g,n:r.length,checked:r.filter(x=>x.getAttribute('aria-checked')==='true').map(x=>x.textContent),dfs:d.length&&d.every(Boolean)?Math.min(...d.map(x=>parseFloat(getComputedStyle(x).fontSize))):0,ic:new Set(r.map(x=>(x.querySelector('use')||{}).getAttribute?x.querySelector('use').getAttribute('href'):'')).size,hid:r.every(x=>{const s=x.querySelector('svg');return s&&s.getAttribute('aria-hidden')==='true'}),host:r.some(x=>/主持人决定谁说话/.test(x.textContent)),h:r.length?Math.min(...r.map(x=>x.getBoundingClientRect().height)):0}})()")
        check("P1-4/L7 模式弹层：单选组 5 个模式（含主持）、每个一句可见说明 ≥17px、图标各不相同且 aria-hidden、当前项打勾写「当前」、每行 ≥44px", md['g'] and md['n'] == 5 and len(md['checked']) == 1 and '当前' in md['checked'][0] and md['dfs'] >= 17 and md['ic'] == 5 and md['hid'] and md['host'] and md['h'] >= 44, md)
        await shot("p14-mode-sheet.png"); await ev("closeSheet()"); await asyncio.sleep(.4)
        pz = await ev("(()=>{setBusy(true,'测试中',true);const b=document.querySelector('#sendBtn');const a={dis:b.disabled,al:b.getAttribute('aria-label'),t:b.textContent};setBusy(false,'');const c={al:b.getAttribute('aria-label')};return {a,c}})()")
        check("P1-4/N2 讨论进行中「发送」原位变「暂停」（可点、读屏标签同步），结束后变回「发言」", pz['a']['dis'] is False and pz['a']['al'] == '暂停' and '暂停' in pz['a']['t'] and pz['c']['al'] == '发言', pz)
        droom = await ev("(async()=>{const h={'content-type':'application/json'};const r=await fetch('/api/start',{method:'POST',headers:h,body:JSON.stringify({message:'UI 决策按钮测试 P14',quick:true})}).then(r=>r.json());await fetch('/api/room/'+r.room+'/ask',{method:'POST',headers:h,body:JSON.stringify({question:'UI 测试：要付费买吗？',options:['同意','不同意','先给我看看']})});return r.room})()")
        await ev(f"openRoom('{droom}')"); await asyncio.sleep(2)
        dc = await ev("(()=>{const b=[...document.querySelectorAll('#chat .decision button')];return {n:b.length,h:b.length?Math.min(...b.map(x=>x.getBoundingClientRect().height)):0,fs:b.length?parseFloat(getComputedStyle(b[0]).fontSize):0}})()")
        await ev("document.querySelector('#chat .decision button').click()"); await asyncio.sleep(2.5)
        dc2 = await ev("(()=>{const c=document.querySelector('#chat .decision');const b=c?[...c.querySelectorAll('button')]:[];return {dis:b.length>0&&b.every(x=>x.disabled),t:c?c.textContent:'',foc:document.activeElement&&document.activeElement.tagName!=='BUTTON'}})()")
        check("P1-4/N3 消息内决策按钮：3 个、每个 ≥48px、字 ≥18px；点后整组禁用、写「你选了：同意 · 时间」、焦点移出按钮", dc['n'] == 3 and dc['h'] >= 48 and dc['fs'] >= 18 and dc2['dis'] and '你选了：同意' in dc2['t'] and dc2['foc'], [dc, dc2])
        await shot("p14-decision.png")
        await ev(f"fetch('/api/room/{droom}',{{method:'DELETE'}}).then(r=>r.status)"); await ev("room=null;roomData=null;loadRooms('')"); await asyncio.sleep(.5)
        # 深色
        await cmd("Emulation.setEmulatedMedia", features=[{"name": "prefers-color-scheme", "value": "dark"}]); await asyncio.sleep(1)
        bg = await ev("getComputedStyle(document.body).backgroundColor"); check("深色模式（wizardzines 暖黑画布 #191815）", bg == "rgb(25, 24, 21)", bg)
        abc = await ev("(()=>{const cs=getComputedStyle(document.documentElement);const st=document.querySelector('#status');return {head:cs.getPropertyValue('--head').trim().toLowerCase(),line:cs.getPropertyValue('--line').trim().toLowerCase(),hb:getComputedStyle(document.querySelector('header.top')).backgroundColor,stfs:st?parseFloat(getComputedStyle(st).fontSize):0}})()")
        check("设计项 A/B/C：深色帘子 #c4651a、深色描边 #efe9dc、底部状态行 16px", abc['head'] == '#c4651a' and abc['line'] == '#efe9dc' and abc['hb'] == 'rgb(196, 101, 26)' and abc['stfs'] == 16, abc)
        await ev("document.querySelector('#sideNav button[data-v=members]').click()"); await asyncio.sleep(1)
        inv = await ev("document.querySelectorAll('#memList .av.inv').length"); check("深色下黑色系头像反转为描边", inv >= 1, inv)
        await shot("v2-09-members-dark.png")
        await ev("document.querySelector('#sideNav button[data-v=chat]').click()"); await asyncio.sleep(1); await shot("v2-10-chat-dark.png")
        # 交付截图：手机 390×844，浅色/深色各 3 张（主对话、成员详情、工具库）
        for th in ("light", "dark"):
            await cmd("Emulation.setEmulatedMedia", features=[{"name": "prefers-color-scheme", "value": th}]); await asyncio.sleep(.8)
            # v6：抽屉「新项目」= 帘子色 --head + 墨色字；抽屉 Logo 颜色 = --ink（浅黑深白）；导航 aria-current；对话页有 h1（页面加载后 getComputedStyle 读取）
            dv = await ev("(()=>{const rs=v=>{const d=document.createElement('i');d.style.color='var('+v+')';document.body.appendChild(d);const c=getComputedStyle(d).color;d.remove();return c};const b=document.querySelector('#drawerNew'),l=document.querySelector('.dhead .dlogo'),lp=l&&l.querySelector('path');return {head:rs('--head'),ink:rs('--ink'),bg:getComputedStyle(b).backgroundColor,fg:getComputedStyle(b).color,logo:lp?getComputedStyle(lp).fill:null,logoW:l?l.getBoundingClientRect().width:0,cur:document.querySelectorAll('#sideNav [aria-current=page],#setBtn[aria-current=page]').length,h1:!!document.querySelector('#v-chat h1')}})()")
            check(f"{th}：抽屉新项目按钮底色 = --head、字色墨色 #151412", dv['bg'] == dv['head'] and dv['fg'] == 'rgb(21, 20, 18)', dv)
            check(f"{th}：抽屉 Logo 已渲染且颜色 = --ink（浅色黑 / 深色白）", dv['logo'] == dv['ink'] and dv['logoW'] >= 32 and (dv['ink'] == ('rgb(21, 20, 18)' if th == 'light' else 'rgb(245, 239, 227)')), dv)
            check(f"{th}：侧栏当前项有 aria-current=page、对话页有 h1", dv['cur'] == 1 and dv['h1'], dv)
            if th == 'light':
                fv = await ev("(async()=>{const a=await (await fetch('/favicon.svg')).text(),b=await (await fetch('/icon.svg')).text();const P=t=>(t.match(/ d=\"[^\"]+\"/g)||[]).join('|');const l=document.querySelector('link[rel=icon][type=\"image/svg+xml\"]');return {dark:/prefers-color-scheme:\\s*dark/.test(a)&&/fill:#fff/.test(a),light:/fill:#000/.test(a),same:P(a)===P(b)&&P(a).length>100,link:l&&l.getAttribute('href'),png:document.querySelectorAll('link[rel=icon][type=\"image/png\"]').length}})()")
                check("favicon：SVG 内 prefers-color-scheme 深色白/浅色黑、图形路径与原图完全一致、PNG 版保留", fv['dark'] and fv['light'] and fv['same'] and fv['link'] == '/favicon.svg' and fv['png'] >= 3, fv)
            await ev("document.querySelectorAll('#toasts .toast button').forEach(b=>b.click());document.querySelector('#q').value='';document.querySelector('#sideNav button[data-v=chat]').click()"); await asyncio.sleep(.5)
            if await ev("!!document.querySelector('#roomList [data-room]')"):
                await ev("document.querySelector('#roomList [data-room]').click()"); await asyncio.sleep(3)
            await ev("window.scrollTo(0,0)"); await asyncio.sleep(.4); await shot(f"v3-{th}-1-chat.png")
            await ev("document.querySelector('#sideNav button[data-v=members]').click()"); await asyncio.sleep(1)
            await ev("document.querySelector('#memList [data-mid=\"gpt-oss-120b\"]').click()"); await asyncio.sleep(2.5)
            await shot(f"v5-{th}-rolecard.png")
            await ev("document.querySelector('#xBtn').click()"); await asyncio.sleep(.6)
            for t in ('keys', 'tools', 'skills', 'sites'):
                await ev(f"location.hash='#res/{t}'"); await asyncio.sleep(2.5); await ev("window.scrollTo(0,0)"); await asyncio.sleep(.3)
                await shot(f"v4-{th}-res-{t}.png" if t != "tools" else f"v5-{th}-tools.png")
            await ev("document.querySelector('#roomList .ritem.pin').click()"); await asyncio.sleep(3); await shot(f"v4-{th}-steward.png")
            await ev("document.querySelector('#setBtn').click()"); await asyncio.sleep(2.5); await shot(f"v4-{th}-settings.png")
            await ev("document.querySelector('#setLead').scrollIntoView({block:'start'})"); await asyncio.sleep(.5); await shot(f"v5-{th}-settings-lead.png")
        # L1（P0）：桌面六个宽度——≥1200 侧栏常驻且内容不被盖住（h1 左边 ≥ 侧栏右边 + 16）；<1200 用抽屉（收起、不占位）；消息列与输入框中心线差 ≤4px
        await cmd("Emulation.setEmulatedMedia", features=[{"name": "prefers-color-scheme", "value": "light"}])
        for W in (1000, 1100, 1199, 1200, 1280, 1440):
            await cmd("Emulation.setDeviceMetricsOverride", width=W, height=900, deviceScaleFactor=1, mobile=False); await asyncio.sleep(.8)
            for v in ('members', 'chat'):
                await ev(f"show('{v}');window.scrollTo(0,0)"); await asyncio.sleep(.6)
                L = await ev("(()=>{const d=document.querySelector('#drawer').getBoundingClientRect();const vis=getComputedStyle(document.querySelector('#scrim')).display!=='none'?false:true;const h=[...document.querySelectorAll('.view.on h1')].find(x=>x.getBoundingClientRect().width>2);const mn=document.querySelector('main').getBoundingClientRect();const cb=document.querySelector('.cbox').getBoundingClientRect();return {dRight:Math.round(d.right),dOpen:document.querySelector('#drawer').classList.contains('open'),h1:h?Math.round(h.getBoundingClientRect().left):null,mainL:Math.round(mn.left),mc:Math.round(mn.left+mn.width/2),cc:cb.width>0?Math.round(cb.left+cb.width/2):null,ov:document.documentElement.scrollWidth-document.documentElement.clientWidth}})()")
                if W >= 1200:
                    ok = L['dRight'] > 200 and (L['h1'] is None or L['h1'] >= L['dRight'] + 16) and L['mainL'] >= L['dRight'] and (L['cc'] is None or abs(L['mc'] - L['cc']) <= 4) and L['ov'] <= 0
                    check(f"L1 {W}px {v}：侧栏常驻、内容不被盖住（h1 ≥ 侧栏右边+16）、消息列与输入框中心线差 ≤4px", ok, L)
                else:
                    ok = L['dRight'] <= 0 and not L['dOpen'] and L['mainL'] >= 0 and (L['cc'] is None or abs(L['mc'] - L['cc']) <= 4) and L['ov'] <= 0 and (L['h1'] is None or L['h1'] >= 16)
                    check(f"L1 {W}px {v}：用抽屉（收起不占位）、内容完整、消息列与输入框中心线差 ≤4px", ok, L)
        await cmd("Emulation.setDeviceMetricsOverride", width=390, height=844, deviceScaleFactor=2, mobile=True)

try:
    asyncio.run(main())
finally:
    p.terminate()
print("UI 结果：", "全部通过" if not fails else f"{len(fails)} 项失败：{fails}")
sys.exit(1 if fails else 0)
