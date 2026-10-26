#!/usr/bin/env python3
"""生成 resources.json（资源库：技能 + 学习与网站资源）。
核实规则：官方页能打开且出现 evidence 原文 → 已核实；能打开但没有原文/没有 evidence → 未核实；到期日已过 → 已过期。
GitHub 来源链接打不开（404）的直接去掉链接，不编。不含任何密钥/邮箱/手机号。"""
import json, re, sys, subprocess, concurrent.futures as cf, datetime, pathlib
HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE)); from sites import SITES
TODAY = datetime.date.today().isoformat()
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
def get(url):
    try:
        p = subprocess.run(['curl', '-sL', '-m', '20', '-A', UA, '-w', '\n%{http_code}', url], capture_output=True, timeout=30)
        out = p.stdout.decode('utf-8', 'ignore'); body, _, code = out.rpartition('\n')
        return int(code or 0), body
    except Exception:
        return 0, ''
def head(url):
    try:
        p = subprocess.run(['curl', '-s', '-o', '/dev/null', '-L', '-m', '15', '-A', UA, '-w', '%{http_code}', url], capture_output=True, timeout=25)
        return int(p.stdout or 0)
    except Exception:
        return 0
def tsv(name):
    rows = []
    for line in (HERE / name).read_text().splitlines():
        if not line.strip() or line.startswith('#'): continue
        rows.append((line.split('\t') + [''] * 5)[:5])
    return rows
skills = [dict(id='s-' + n, name=n, group=g, purpose=p, src=s.strip(), status='已安装', who=['hark'], who_note='Hark 已装为专长；其他成员可读来源仓库里的 SKILL.md') for n, g, p, s, _ in tsv('skills.tsv')]
skills += [dict(id='r-' + re.sub(r'[^a-z0-9]+', '-', n.lower()), name=n, group=g, purpose=p, src=s.strip(), status='只记录', who=[], who_note='未安装：' + w) for n, g, p, s, w in tsv('recorded.tsv')]
def chk_src(x):
    if x['src'] and 'github.com' in x['src']:
        c = head(x['src'])
        if c == 404: x['src_dropped'] = x['src']; x['src'] = ''
        x['src_code'] = c
    return x
with cf.ThreadPoolExecutor(16) as ex: skills = list(ex.map(chk_src, skills))
def chk_site(s):
    code, body = get(s['url'])
    s['http'] = code
    ok = 200 <= code < 400
    if s.get('evidence') and ok and re.search(s['evidence'], body): s['verify_state'] = '已核实'; s['verified'] = TODAY; s['evidence_hit'] = True
    else: s['verify_state'] = '未核实'; s['verified'] = None
    if s.get('expires') and s['expires'] < TODAY: s['verify_state'] = '已过期'
    s['reachable'] = ok
    return s
with cf.ThreadPoolExecutor(12) as ex: sites = list(ex.map(chk_site, [dict(x) for x in SITES]))
out = {'version': 1, 'built': TODAY, 'note': '资源库静态数据：技能 + 学习与网站资源。免费额度/期限只在官方页出现原文时标「已核实」。',
       'skills': skills, 'sites': [{k: v for k, v in s.items() if k not in ('evidence',)} for s in sites]}
(HERE.parent / 'resources.json').write_text(json.dumps(out, ensure_ascii=False, indent=1))
print('skills', len(skills), 'installed', sum(x['status'] == '已安装' for x in skills), 'dropped src', [x['name'] for x in skills if x.get('src_dropped')])
for s in sites: print(s['verify_state'], s['http'], s['name'], s.get('expires') or '')
