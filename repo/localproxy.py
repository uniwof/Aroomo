#!/usr/bin/env python3
"""测试辅助：本机无认证 HTTP CONNECT 代理 127.0.0.1:8899 → 沙盒上游代理（自动加 Proxy-Authorization）。
无头 Chromium 不支持带账号密码的代理，ui_test.py 用它出网。只听 127.0.0.1，只做 CONNECT。"""
import asyncio, base64, os, urllib.parse as up
U = up.urlparse(os.environ.get('HTTPS_PROXY') or os.environ['https_proxy'])
AUTH = base64.b64encode(f"{up.unquote(U.username or '')}:{up.unquote(U.password or '')}".encode()).decode()

async def pipe(r, w):
    try:
        while (b := await r.read(65536)):
            w.write(b); await w.drain()
    except Exception:
        pass
    finally:
        try: w.close()
        except Exception: pass

async def handle(cr, cw):
    try:
        head = await cr.readuntil(b'\r\n\r\n')
        line = head.split(b'\r\n')[0].decode()
        meth, target, _ = line.split(' ', 2)
        if meth != 'CONNECT':
            cw.write(b'HTTP/1.1 405 Only CONNECT\r\n\r\n'); await cw.drain(); cw.close(); return
        ur, uw = await asyncio.open_connection(U.hostname, U.port)
        uw.write(f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\nProxy-Authorization: Basic {AUTH}\r\n\r\n".encode()); await uw.drain()
        resp = await ur.readuntil(b'\r\n\r\n')
        cw.write(resp); await cw.drain()
        if b' 200' not in resp.split(b'\r\n')[0]:
            cw.close(); uw.close(); return
        await asyncio.gather(pipe(cr, uw), pipe(ur, cw))
    except Exception:
        try: cw.close()
        except Exception: pass

async def main():
    s = await asyncio.start_server(handle, '127.0.0.1', 8899)
    async with s: await s.serve_forever()

asyncio.run(main())
