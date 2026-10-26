#!/usr/bin/env python3
"""AI 群聊「拉取模式小桥」——让内网 / 本机 / Tailscale tailnet 里的智能体（CCCC、OpenCode、Claude Code、浏览器代发的网页工具…）
作为 AI成员 进群，不用开端口、不用公网 IP：小桥只发出站 HTTPS。

流程：每 N 秒 GET https://chat.pcmanai.com/bridge/pull?member=<成员ID>（Authorization: Bearer <成员令牌>）
      → 拿到任务（prompt）→ 交给本机命令或本机 HTTP 端点处理 → POST /hook/reply {"task":..., "text":...} 写回房间。
成员令牌：在网页「AI成员」→ 点头像 → 详情里的「回调 / 小桥令牌」（只能给这个成员写回复/拉它的任务）。

用法（Python 3.8+，只用标准库）：
  export AGC_TOKEN=<成员令牌>
  # A) 交给命令（prompt 从 stdin 进，stdout 当回复）：
  python3 bridge.py --member cccc --cmd "opencode run"
  python3 bridge.py --member claude-code --cmd "claude -p"
  # B) 交给本机 HTTP 端点（POST JSON {"prompt": "..."}，返回 {"text": "..."} 或纯文本）：
  python3 bridge.py --member cccc --http http://127.0.0.1:8848/your-endpoint
  # Tailscale：在 tailnet 里任意一台机器上跑本脚本，--http 指向 tailnet 内地址（http://100.x.y.z:端口/…），无需 Funnel。
可选：--base https://chat.pcmanai.com  --interval 15  --once
"""
import argparse, json, os, shlex, subprocess, sys, time, urllib.request


def req(url, token, data=None, timeout=30):
    r = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None,
                               headers={'authorization': 'Bearer ' + token, 'content-type': 'application/json', 'user-agent': 'agc-bridge/1'},
                               method='POST' if data is not None else 'GET')
    with urllib.request.urlopen(r, timeout=timeout) as f:
        return json.loads(f.read().decode() or '{}')


def handle(prompt, a):
    if a.cmd:
        p = subprocess.run(shlex.split(a.cmd), input=prompt, capture_output=True, text=True, timeout=a.timeout)
        return (p.stdout or p.stderr).strip()[:8000]
    r = urllib.request.Request(a.http, data=json.dumps({'prompt': prompt}).encode(), headers={'content-type': 'application/json'}, method='POST')
    with urllib.request.urlopen(r, timeout=a.timeout) as f:
        body = f.read().decode()
    try:
        d = json.loads(body); return str(d.get('text') or d.get('reply') or d.get('output') or body)[:8000]
    except Exception:
        return body.strip()[:8000]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--member', required=True)
    ap.add_argument('--base', default='https://chat.pcmanai.com')
    ap.add_argument('--cmd'); ap.add_argument('--http')
    ap.add_argument('--interval', type=int, default=15); ap.add_argument('--timeout', type=int, default=600)
    ap.add_argument('--once', action='store_true')
    a = ap.parse_args()
    tok = os.environ.get('AGC_TOKEN') or ''
    if not tok or not (a.cmd or a.http):
        sys.exit('需要环境变量 AGC_TOKEN，以及 --cmd 或 --http 之一')
    while True:
        try:
            d = req(f'{a.base}/bridge/pull?member={a.member}', tok)
            for t in d.get('tasks', []):
                print(time.strftime('%H:%M:%S'), '任务', t['task'], t.get('role'), flush=True)
                try:
                    text = handle(t['prompt'], a) or '（本机没有返回内容）'
                except Exception as e:
                    text = f'（本机处理出错：{type(e).__name__}）'
                print('  →', req(d.get('reply_url') or f'{a.base}/hook/reply', tok, {'task': t['task'], 'text': text}), flush=True)
        except Exception as e:
            print(time.strftime('%H:%M:%S'), '拉取失败：', type(e).__name__, str(e)[:120], flush=True)
        if a.once:
            break
        time.sleep(a.interval)


if __name__ == '__main__':
    main()
