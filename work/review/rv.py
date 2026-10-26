#!/usr/bin/env python3
# rv.py <name> <prompt_file> [groq|agnes|both] —— 对抗式复审：只挑错、不附和。输出 review/<name>_<model>.md
import json, sys, time, urllib.request, concurrent.futures as cf
name, pf = sys.argv[1], sys.argv[2]; which = sys.argv[3] if len(sys.argv) > 3 else 'both'
SYS = '你是苛刻的代码审查员（安全 + 正确性 + 规格符合度）。只挑错，不表扬、不附和；每条写：文件/函数、问题、为什么是问题、怎么改、把握度（高/中/低）。没发现真问题就写"未发现"，不要凑数。最后列"最反对的 3 点"。用简体中文。'
P = open(pf, encoding='utf-8', errors='replace').read()
EP = {'groq': ('https://api.groq.com/openai/v1/chat/completions', 'openai/gpt-oss-120b', 3000), 'agnes': ('https://apihub.agnes-ai.com/v1/chat/completions', 'agnes-3.0-flash', 4000)}
def run(k):
    url, model, mx = EP[k]; t = time.time()
    body = {'model': model, 'temperature': 0.2, 'max_tokens': mx, 'messages': [{'role': 'system', 'content': SYS}, {'role': 'user', 'content': P}]}
    out = f'/workspace/work/p1-rest/review/{name}_{k}.md'
    for attempt in range(3):
        try:
            r = urllib.request.urlopen(urllib.request.Request(url, data=json.dumps(body).encode(), headers={'content-type': 'application/json', 'user-agent': 'curl/8.5.0'}), timeout=300)
            d = json.load(r); txt = d['choices'][0]['message'].get('content') or ''
            open(out, 'w').write(f'<!-- model={model} secs={time.time()-t:.0f} usage={d.get("usage")} -->\n' + txt); return k, 'ok'
        except Exception as e:
            err = getattr(e, 'read', lambda: b'')().decode()[:300]; last = f'ERROR {e} {err}'; time.sleep(20)
    open(out, 'w').write(last); return k, last[:80]
ks = ['groq', 'agnes'] if which == 'both' else [which]
with cf.ThreadPoolExecutor(2) as ex: print(list(ex.map(run, ks)))
