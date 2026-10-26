#!/usr/bin/env python3
"""Aroomo（ai-groupchat）端到端测试。用法：
  python3 test_live.py                      # 默认（不变）：测 https://chat.pcmanai.com，令牌读 /workspace/storage/secrets/ai-groupchat.json
  python3 test_live.py BASE TOKEN_FILE      # 测别的部署（TOKEN_FILE 里是纯令牌或含 ACCESS_TOKEN 的 JSON）
  环境变量切换：AGC_BASE=http://127.0.0.1:8787 AGC_TOKEN=<本机 .dev.vars 里的 ACCESS_TOKEN> python3 test_live.py --no-ai
  （也可 AGC_TOKEN_FILE；AGC_MCP_PYTHON=装了 mcp+httpx 的 python）
  加 --no-ai 跳过会消耗 Workers AI 额度的测试。输出原始结果，最后打印 PASS/FAIL 计数。不打印令牌。
"""
import re, json, subprocess, sys, hmac, hashlib

args = [a for a in sys.argv[1:] if not a.startswith('--')]
NO_AI = '--no-ai' in sys.argv
import os
BASE = (args[0] if args else os.environ.get('AGC_BASE', 'https://chat.pcmanai.com')).rstrip('/')   # 默认值不变；AGC_BASE 可切到本机 wrangler dev
TF = args[1] if len(args) > 1 else os.environ.get('AGC_TOKEN_FILE', '/workspace/storage/secrets/ai-groupchat.json')
raw = (os.environ.get('AGC_TOKEN', '').strip() if not args[1:] else '') or open(TF).read().strip()   # AGC_TOKEN 直接给令牌（优先于默认令牌文件）
TOKEN = json.loads(raw)['ACCESS_TOKEN'] if raw.startswith('{') else raw
results = []
import time as _time0
_T0 = int(_time0.time() * 1000)


def curl(*a, timeout=240):
    p = subprocess.run(['curl', '-s', '-m', str(timeout), '-w', '\n__HTTP__%{http_code}', *a], capture_output=True, text=True)
    body, _, code = p.stdout.rpartition('\n__HTTP__')
    return int(code or 0), body


def J(b):
    try: return json.loads(b)
    except Exception: return {}


_MASK_RES = [
    re.compile(r'\b(op_[0-9a-f]{4})[0-9a-f]{8,}'),                  # 操作员令牌
    re.compile(r'((?:token|operator_token|Bearer)["\']?\s*[:=]?\s*["\']?)([A-Za-z0-9_\-]{4})[A-Za-z0-9_\-]{8,}', re.I),
    re.compile(r'\b([0-9a-f]{4})[0-9a-f]{28,}\b'),                  # 成员令牌等长十六进制串
]
def mask(t):
    """令牌一律打码，只保留前 4 位（线上输出也要交给审核）。"""
    t = str(t)
    if TOKEN: t = t.replace(TOKEN, TOKEN[:4] + '…<已打码>')
    t = _MASK_RES[0].sub(lambda m: m.group(1) + '…<已打码>', t)
    t = _MASK_RES[1].sub(lambda m: m.group(1) + m.group(2) + '…<已打码>', t)
    t = _MASK_RES[2].sub(lambda m: m.group(1) + '…<已打码>', t)
    return t


def check(name, ok, detail=''):
    results.append((name, ok))
    print(mask(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f"\n    {detail}" if detail else '')), flush=True)


AUTH = ['-H', f'Authorization: Bearer {TOKEN}']
JS = ['-H', 'content-type: application/json']
mtok = lambda mid: hmac.new(TOKEN.encode(), ('member:' + mid).encode(), hashlib.sha256).hexdigest()[:40]

# 0. 测试模式：快照负责人/设置/每周汇总等 kv，测试期间写进资源管家私聊的消息打 test 标记、不发手机推送；结束时删除标记消息并还原 kv
import atexit
_TMC = ['-H', f'Cookie: agc={TOKEN}', '-H', f'Origin: {BASE}', '-H', 'content-type: application/json']
_tm = {'done': False}
def _tm_end():
    if _tm['done']: return {}
    _tm['done'] = True
    return J(curl(*_TMC, '-d', '{"on":false}', f'{BASE}/api/testmode')[1])
atexit.register(_tm_end)
c, b = curl(*_TMC, '-d', '{"on":true}', f'{BASE}/api/testmode'); check('测试模式开启（不污染用户数据）', c == 200 and J(b).get('ok'), b[:120])

# 1. 鉴权 / 安全
c, b = curl(f'{BASE}/'); check('GET / 无令牌 → 401', c == 401, c)
c, b = curl(f'{BASE}/api/members'); check('GET /api/members 无令牌 → 401', c == 401 and '未授权' in b, f'{c} {b[:80]}')
c, b = curl('-H', 'Authorization: Bearer wrong-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', f'{BASE}/api/rooms'); check('错误令牌 → 401', c == 401, c)
c, b = curl(*JS, '-d', '{"message":"x"}', f'{BASE}/api/round'); check('POST /api/round 无令牌 → 401', c == 401, c)
c, b = curl(f'{BASE}/?k=wrong'); check('/?k=错误令牌 → 401', c == 401, c)
c, b = curl('-i', f'{BASE}/?k={TOKEN}'); h = b.lower()
check('/?k=令牌 → 302 + HttpOnly Secure cookie', c == 302 and 'set-cookie: agc=' in h and 'httponly' in h and 'secure' in h, c)
c, b = curl('-H', f'Cookie: agc={TOKEN}', f'{BASE}/')
check('带 cookie 打开 UI → 200（AI成员 / 搜索框 / 资源库，已无「工具库」字样）', c == 200 and 'AI成员' in b and 'id="q"' in b and '资源库' in b and '工具库' not in b and '__TERM__' not in b, f'{c} len={len(b)}')
c, b = curl('-i', '-H', f'Cookie: agc={TOKEN}', f'{BASE}/'); check('CSP 头存在', "default-src 'none'" in b, '')
c, b = curl('-H', f'Cookie: agc={TOKEN}', *JS, '-d', '{"message":"csrf"}', f'{BASE}/api/start'); check('cookie 写请求无 Origin → 403', c == 403, c)
c, b = curl('-H', f'Cookie: agc={TOKEN}', '-H', 'Origin: https://evil.example', *JS, '-d', '{"message":"csrf"}', f'{BASE}/api/start'); check('cookie 写请求跨站 Origin → 403', c == 403, c)
c, b = curl(*JS, '-d', '{"task":"aaaaaaaaaaaaaaaa","text":"x"}', f'{BASE}/hook/reply'); check('/hook/reply 无令牌 → 401', c == 401, c)
c, b = curl('-H', 'Authorization: Bearer nope', f'{BASE}/bridge/pull?member=cccc'); check('/bridge/pull 错令牌 → 401', c == 401, c)
c, b = curl('-X', 'POST', f'{BASE}/hook/tg/' + '0' * 32); check('/hook/tg 错路径 → 401', c == 401, c)
c, b = curl(*AUTH, f'{BASE}/nope'); check('未知路径 → 404', c == 404, c)

# 2. 成员 / 工具库 / 状态 / 额度
c, b = curl(*AUTH, f'{BASE}/api/members'); d = J(b); ms = d.get('members', [])
by = {m['id']: m for m in ms}
check(f'GET /api/members → {len(ms)} 位 AI成员 + {len(d.get("tools", []))} 个工具', c == 200 and len(ms) >= 20 and len(d.get('tools', [])) >= 6, c)
print('    成员状态：' + '；'.join(f"{m['name']}={'绿' if m['state']=='ok' else '红' if m['state']=='down' else '灰'}" for m in ms))
g = by.get('gpt-oss-120b', {})
check('gpt-oss-120b 一张卡、多个来源（Workers AI + Groq + 自建端点标注）', len(g.get('sources', [])) >= 2 and any('Workers AI' in s['via'] for s in g['sources']) and any('Groq' in s['via'] for s in g['sources']), [s['via'] for s in g.get('sources', [])])
check('额度带数值+单位+来源', bool(re.search(r'\d[\d,]*\s*/\s*[\d,]+\s*(neurons|次|token)', (g.get('quota') or {}).get('text', ''))) and bool(g['quota'].get('source')), g.get('quota', {}).get('text'))
check('缺密钥成员标红并写明去哪填（资源库 → API 密钥 · Poke）', by.get('poke', {}).get('state') == 'down' and 'API 密钥' in by.get('poke', {}).get('why', '') and 'Poke' in by.get('poke', {}).get('why', ''), by.get('poke', {}).get('why'))
check('Hark 是黑色负责人', by.get('hark', {}).get('color') == '#000000' and by['hark'].get('lead'), '')
c, b = curl(*AUTH, f'{BASE}/api/member/gpt-oss-120b'); dm = J(b)
check('成员详情：岗位/来源/限制/隐私/历史', c == 200 and dm.get('jobs') and dm.get('sources') and 'history' in dm and dm.get('privacy'), [j['t'] for j in dm.get('jobs', [])])
c, b = curl(*AUTH, *JS, '-X', 'POST', '-d', '{}', f'{BASE}/api/probe'); check('立即探测 → 200', c == 200, b[:200])

# 3. Hark 派工（规则，不耗额度）
c, b = curl(*AUTH, *JS, '-d', json.dumps({'topic': '帮我写一段 Python 脚本批量重命名文件', 'mode': 'debate'}), f'{BASE}/api/plan'); p = J(b)
check('plan：代码题第一个角色是程序员', c == 200 and p.get('roles', [''])[0] == '程序员', p.get('note'))
c, b = curl(*AUTH, *JS, '-d', json.dumps({'topic': '帮我注册一个网站账号', 'mode': 'debate'}), f'{BASE}/api/plan'); p = J(b)
check('plan：注册题只派有执行能力的成员（没有就空）', c == 200 and p.get('roles', [''])[0] == '执行者', p.get('note'))

# 4. 外部成员校验（SSRF / 密钥名）
c, b = curl(*AUTH, *JS, '-d', json.dumps({'conn': 'webhook', 'id': 'x-t', 'name': 'T', 'url': 'http://127.0.0.1/x'}), f'{BASE}/api/agents'); check('SSRF：拒 http/本机地址', c == 400, b[:120])
c, b = curl(*AUTH, *JS, '-d', json.dumps({'conn': 'webhook', 'id': 'x-t', 'name': 'T', 'url': 'https://example.com/h', 'secret': 'ACCESS_TOKEN'}), f'{BASE}/api/agents'); check('拒引用非 AGENT_ 密钥', c == 400, b[:120])
c, b = curl(*AUTH, *JS, '-d', json.dumps({'conn': 'bridge', 'id': 'x-livetest', 'name': 'LiveTestBot', 'jobs': '代码'}), f'{BASE}/api/agents'); check('添加拉取模式外部成员', c == 200, b[:120])

# 5. 拉取模式全链路（不耗 AI 额度）：上线 → 建项目只放它 → pending → 拉取 → 回调写回
tk = mtok('x-livetest')
c, b = curl('-H', f'Authorization: Bearer {tk}', f'{BASE}/bridge/pull?member=x-livetest'); check('小桥上线（拉取 200）', c == 200, b[:120])
c, b = curl(*AUTH, *JS, '-d', json.dumps({'message': '小桥链路测试', 'members': [{'id': 'x-livetest', 'role': '程序员'}]}), f'{BASE}/api/start'); st = J(b); room = st.get('room')
check('start：指定成员建项目', c == 200 and room, b[:200])
c, b = curl(*AUTH, *JS, '-d', json.dumps({'room': room, 'member': 'x-livetest'}), f'{BASE}/api/turn'); t = J(b)
check('turn → pending 任务', c == 200 and t.get('pending'), b[:200])
c, b = curl('-H', f'Authorization: Bearer {tk}', f'{BASE}/bridge/pull?member=x-livetest'); pl = J(b)
check('小桥拉到任务', c == 200 and any(x['task'] == t.get('task') for x in pl.get('tasks', [])), len(pl.get('tasks', [])))
c, b = curl('-H', f'Authorization: Bearer {tk}', *JS, '-d', json.dumps({'task': t.get('task'), 'text': '小桥回复 OK'}), f'{BASE}/hook/reply'); check('回调写回 200', c == 200, b)
c, b = curl('-H', f'Authorization: Bearer {tk}', *JS, '-d', json.dumps({'task': t.get('task'), 'text': '重复'}), f'{BASE}/hook/reply'); check('重复回调 409', c == 409, b)
c, b = curl(*AUTH, f'{BASE}/api/room/{room}'); r = J(b)
check('房间里出现回调消息（Hark 分工说明 + 回复）', any(m['text'] == '小桥回复 OK' for m in r.get('messages', [])), [m['kind'] for m in r.get('messages', [])])
c, b = curl(*AUTH, *JS, '-d', json.dumps({'status': '已完成'}), f'{BASE}/api/room/{room}/status'); check('项目状态改为已完成', c == 200, b)
c, b = curl(*AUTH, *JS, '-d', json.dumps({'member': 'x-livetest', 'job': '代码', 'score': 5}), f'{BASE}/api/room/{room}/rate'); check('用户打分', c == 200, b)
c, b = curl(*AUTH, f'{BASE}/api/member/x-livetest'); dm = J(b)
check('成员参与历史含该项目（时间/角色/状态）', any(h['room'] == room and h['role'] == '程序员' for h in dm.get('history', [])), dm.get('history'))
c, b = curl(*AUTH, '--get', '--data-urlencode', 'q=小桥', f'{BASE}/api/search'); s = J(b)
check('全局搜索：项目 + 消息', c == 200 and s.get('projects') and s.get('messages'), f"{len(s.get('projects', []))} 项目 / {len(s.get('messages', []))} 消息")
curl(*AUTH, '-X', 'DELETE', f'{BASE}/api/room/{room}')
c, b = curl(*AUTH, '-X', 'DELETE', f'{BASE}/api/agents/x-livetest'); check('删除测试成员和房间', c == 200, b)
c, b = curl(*AUTH, f'{BASE}/api/rooms'); n_rooms = len(J(b).get('rooms', []))
check('房间列表可读', c == 200 and isinstance(J(b).get('rooms'), list), f'{n_rooms} 个项目')

# 6. API 密钥区：未登录不能写 / 只认页面 cookie / 保存不回显 / 错误 Key 显示验证失败（用一个当前未填的来源，测完删除）
FAKE = 'agc-test-invalid-key-' + 'Q' * 12 + 'WXYZ'
c, b = curl(*AUTH, f'{BASE}/api/keys'); kl = J(b).get('keys', [])
check('GET /api/keys 列出每个来源（名称/免费额度/状态）', c == 200 and len(kl) >= 15 and all('free' in k and 'label' in k for k in kl), f'{len(kl)} 个来源')
check('密钥列表不含任何明文字段', all(set(k) <= {'env','name','group','free','free_src','console','console_note','can','paid','keyless','state','label','last4','saved','vmsg','vat','verifiable','usedBy'} for k in kl), '')
check('算力来源齐全（Modal/Kaggle/Lightning/Lambda/Beam/E2B/Daytona）', {'MODAL_TOKEN','KAGGLE_API_TOKEN','LIGHTNING_API_KEY','LAMBDA_API_KEY','BEAM_API_KEY','E2B_API_KEY','DAYTONA_API_KEY'} <= {k['env'] for k in kl}, '')
check('免 Key 来源（Pollinations）显示已接通', any(k.get('keyless') and k['state'] == 'ok' for k in kl), '')
tgt = next((k['env'] for k in kl if k['env'] == 'LAMBDA_API_KEY' and k['state'] == 'empty'), None) or next((k['env'] for k in kl if k['state'] == 'empty' and k['verifiable'] and k['env'] in ('BEAM_API_KEY','LAMBDA_API_KEY','DAYTONA_API_KEY','E2B_API_KEY')), None)
COOK = ['-H', f'Cookie: agc={TOKEN}', '-H', f'Origin: {BASE}']
c, b = curl(*JS, '-d', json.dumps({'name': tgt or 'LAMBDA_API_KEY', 'value': FAKE}), f'{BASE}/api/keys'); check('未登录不能写 Key → 401', c == 401, c)
c, b = curl(*AUTH, *JS, '-d', json.dumps({'name': tgt or 'LAMBDA_API_KEY', 'value': FAKE}), f'{BASE}/api/keys'); check('Bearer（非页面 cookie）不能写 Key → 403', c == 403, b[:80])
c, b = curl('-H', f'Cookie: agc={TOKEN}', '-H', 'Origin: https://evil.example', *JS, '-d', json.dumps({'name': tgt or 'LAMBDA_API_KEY', 'value': FAKE}), f'{BASE}/api/keys'); check('跨站来源不能写 Key → 403', c == 403, b[:80])
c, b = curl(*COOK, *JS, '-d', json.dumps({'name': 'ACCESS_TOKEN', 'value': FAKE}), f'{BASE}/api/keys'); check('不能写非白名单变量（ACCESS_TOKEN）→ 400', c == 400, b[:80])
c, b = curl(*COOK, *JS, '-d', json.dumps({'name': tgt or 'LAMBDA_API_KEY', 'value': 'a b'}), f'{BASE}/api/keys'); check('格式不对的 Key → 400', c == 400, b[:80])
if tgt:
    c, b = curl(*COOK, *JS, '-d', json.dumps({'name': tgt, 'value': FAKE}), f'{BASE}/api/keys'); d = J(b)
    check(f'保存 Key（{tgt}）不回显明文，只回末 4 位', c == 200 and FAKE not in b and d.get('last4') == 'WXYZ', b[:200])
    check('错误 Key 当场显示验证失败', d.get('verify', {}).get('state') in ('bad', 'err') and '验证' in d.get('verify', {}).get('msg', ''), d.get('verify'))
    c, b = curl(*AUTH, f'{BASE}/api/keys'); row = next((k for k in J(b).get('keys', []) if k['env'] == tgt), {})
    check('列表里只显示末 4 位 + 验证失败', FAKE not in b and row.get('last4') == 'WXYZ' and row.get('label') == '验证失败', {x: row.get(x) for x in ('label', 'last4', 'vmsg')})
    c, b = curl(*COOK, '-X', 'POST', *JS, '-d', '{}', f'{BASE}/api/keys/{tgt}/verify'); check('重新验证不回显明文', c == 200 and FAKE not in b, b[:160])
    c, b = curl(*COOK, '-X', 'DELETE', f'{BASE}/api/keys/{tgt}'); check('删除测试 Key', c == 200, b)
    c, b = curl(*AUTH, f'{BASE}/api/keys'); row = next((k for k in J(b).get('keys', []) if k['env'] == tgt), {})
    check('删除后恢复「未填」', row.get('state') == 'empty', row.get('label'))
else:
    check('有可用于测试的空来源', False, '所有候选来源都已填，跳过写入测试以免覆盖真实 Key')
c, b = curl(*AUTH, f'{BASE}/api/members'); ms = J(b).get('members', [])
g = next((m for m in ms if m['id'] == 'gpt-oss-20b'), {})
check('gpt-oss-20b 有 Pollinations 免 Key 来源', any('Pollinations' in (s.get('via') or '') for s in g.get('sources', [])), [s.get('via') for s in g.get('sources', [])])
check('开源模型成员标出「自建 GPU 端点」来源', sum(1 for m in ms if any(s.get('kind') == 'selfhost' for s in m.get('sources', []))) >= 8, '')
miss = [s['why'] for m in ms for s in m.get('sources', []) if '缺密钥' in (s.get('why') or '')]
check('缺 Key 的来源提示去「资源库 → API 密钥」填', all('API 密钥' in w for w in miss), miss[:2])
check('成员来源显示真实来源（非 CF 来源保留各自 via）', any(s.get('kind') == 'openai' and 'Groq' in s.get('via', '') for m in ms for s in m.get('sources', [])), '')

if not NO_AI:
    c, b = curl(*AUTH, *JS, '-d', json.dumps({'message': '议题：城市里应该全面禁止燃油车，只允许电动车上路。', 'mode': 'debate'}), f'{BASE}/api/round')
    print(mask('---- /api/round 原始返回 ----\n' + b + '\n----'))
    d = J(b); reps = d.get('replies') or []
    check('/api/round：Hark 自动派工 + 每个角色有回复/跳过说明', c == 200 and d.get('plan') and len(reps) >= 2, f"{len(reps)} 条")
    ans = [x for x in reps if not x.get('skipped') and not x.get('pending')]
    check(f'作答 {len(ans)} 个，作答内容是中文', not ans or all(any('\u4e00' <= ch <= '\u9fff' for ch in x['text']) for x in ans))
    if d.get('room'):
        c, b = curl(*AUTH, *JS, '-X', 'POST', '-d', '{}', f"{BASE}/api/room/{d['room']}/review"); check('成员互评（裁判打分）', c in (200, 400), b[:300])

# 7. 第二批：资源库数据 / 资源管家 / 设置 / 敏感路由（不耗模型额度：只发问题，不发链接）
c, b = curl(f'{BASE}/api/resources'); check('资源库 GET 未登录 → 401', c == 401, c)
c, b = curl(*AUTH, f'{BASE}/api/resources'); R = J(b)
check('资源库：技能 ≥100 条、网站 ≥30 条，含已安装/只记录', c == 200 and len(R.get('skills', [])) >= 100 and len(R.get('sites', [])) >= 30 and {'已安装', '只记录'} <= {x['status'] for x in R.get('skills', [])}, f"{len(R.get('skills', []))}/{len(R.get('sites', []))}")
check('资源库：网站条目状态只有 已核实/未核实/已过期，且有已过期示例', {x['state'] for x in R.get('sites', [])} <= {'已核实', '未核实', '已过期'} and any(x['state'] == '已过期' for x in R.get('sites', [])), {x['state'] for x in R.get('sites', [])})
check('资源库：过期判定按到期日（到期日 < 今天 ⇒ 已过期）', all((x['state'] == '已过期') == bool(x.get('expires') and x['expires'] < R.get('today', '')) for x in R.get('sites', [])))
import re as _re
check('资源库数据里没有密钥/邮箱/手机号明文', not _re.search(r'(sk-[A-Za-z0-9]{16,}|gsk_[A-Za-z0-9]{10,}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}|\+\d{10,})', b), _re.findall(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}', b)[:3])
check('工具数据里没有手机号/邮箱明文', not _re.search(r'(\+\d{10,}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,})', json.dumps(R.get('tools', []), ensure_ascii=False)))
c, b = curl(*AUTH, f'{BASE}/api/rooms'); rooms = J(b).get('rooms', [])
check('资源管家私聊置顶（rooms 里 steward pinned）', any(r.get('id') == 'steward' and r.get('pinned') for r in rooms))
c, b = curl(*AUTH, '-X', 'DELETE', f'{BASE}/api/room/steward'); check('置顶私聊不能删', c in (400, 403), c)
c, b = curl(*AUTH, *JS, '-d', '{"text":"有没有免费配音"}', f'{BASE}/api/steward/msg'); check('Bearer 不能和资源管家说话（只认页面 cookie）→ 403', c == 403, c)
c, b = curl(*COOK, *JS, '-d', '{"text":"有没有免费配音"}', f'{BASE}/api/steward/msg'); check('问资源管家（cookie）→ 200', c == 200 and J(b).get('ok'), b[:120])
c, b = curl(*AUTH, f'{BASE}/api/room/steward'); msgs = J(b).get('messages', [])
last = [m for m in msgs if m.get('member') == 'steward'][-1:] 
check('资源管家回答里有免费配音条目（Fish Audio），且免费优先', bool(last) and 'Fish Audio' in last[0]['text'], (last[0]['text'][:200] if last else ''))
c, b = curl(*AUTH, f'{BASE}/api/members'); mm = {m['id']: m for m in J(b).get('members', [])}
check('资源管家是 AI成员（可用、有额度环文字）', 'steward' in mm and mm['steward']['state'] == 'ok' and '整理' in (mm['steward']['quota'].get('text') or ''), (mm.get('steward') or {}).get('quota'))
check('每个来源带级别（官方 API/中转站/公共接口…）', all(x.get('level') for m in mm.values() for x in m.get('sources', [])))
c, b = curl(*AUTH, *JS, '-d', json.dumps({'message': '敏感测试', 'members': [{'id': 'steward', 'role': '审查员'}]}), f'{BASE}/api/plan'); 
c, b = curl(*AUTH, *JS, '-d', '{"topic":"写一首诗","mode":"debate"}', f'{BASE}/api/plan'); check('Hark 推荐阵容不会选资源管家', c == 200 and all(x['id'] != 'steward' for x in J(b).get('members', [])), [x['id'] for x in J(b).get('members', [])])
# v6：资源管家两档调用 + 每周汇总
c, b = curl(*AUTH, f'{BASE}/api/steward/tiers'); TI = J(b)
check('资源管家两档：小档链以便宜小模型开头（Groq gpt-oss-20b → PM → Workers AI）、上限 60', c == 200 and TI.get('small', {}).get('cap') == 60 and 'gpt-oss-20b' in (TI['small'].get('chain') or [''])[0] and len(TI['small']['chain']) == 3, b[:200])
check('资源管家两档：强档单独计数、上限 20、失败降级写明', TI.get('strong', {}).get('cap') == 20 and isinstance(TI['strong'].get('used'), int) and '小档' in TI['strong'].get('fallback', '') and '规则' in TI['strong'].get('fallback', ''), TI.get('strong'))
BAD = {'agnes-image-2.5', 'agnes-image-2.1-flash', 'gpt-image-2.5', 'poke', 'muse', 'cccc', 'claude-code', 'zen-free', 'hark', 'steward', 'cf-paid-only'}
rk = [x['id'] for x in TI.get('strong', {}).get('ranked', [])]
check('强档候选排除生图/视频模型、外部关联智能体、资源管家自己、付费来源', not (set(rk) & BAD) and BAD - {'cf-paid-only'} <= set(TI.get('excluded', [])), {'ranked': rk})
pk = TI.get('strong', {}).get('pick')
check('强档挑的是候选里分最高的那个（没有可用强档时为空，会降级）', (pk is None and not rk) or (pk and rk and pk['id'] == rk[0] and all(pk['score'] >= x['score'] for x in TI['strong']['ranked'])), pk)
c, b = curl(*AUTH, *JS, '-X', 'POST', '-d', '{}', f'{BASE}/api/steward/weekly'); check('每周汇总手动生成只认页面 cookie（Bearer → 403）', c == 403, c)
c, b = curl(*COOK, *JS, '-X', 'POST', '-d', '{}', f'{BASE}/api/steward/weekly'); WK = J(b)
check('每周汇总：含新增/更新/核实失败/快到期四项计数和周号', c == 200 and re.match(r'^\d{4}-W\d\d$', WK.get('week', '')) and {'added', 'updated', 'failed', 'soon'} <= set(WK.get('counts', {})) and all(k in WK.get('text', '') for k in ('新增', '更新', '核实失败', '到期')), b[:200])
c, b = curl(*AUTH, f'{BASE}/api/room/steward'); sm = J(b).get('messages', [])
check('每周汇总发到资源管家私聊 + 通知主负责人', any('每周汇总' in (m.get('text') or '') and m.get('member') == 'steward' for m in sm) and any('通知主负责人' in (m.get('text') or '') for m in sm), '')
c, b = curl(*AUTH, f'{BASE}/api/members'); mm2 = {m['id']: m for m in J(b).get('members', [])}
check('资源管家额度文字分两档显示', '小档' in (mm2.get('steward', {}).get('quota', {}).get('text') or '') and '强档' in (mm2.get('steward', {}).get('quota', {}).get('text') or ''), (mm2.get('steward') or {}).get('quota'))
c, b = curl(*AUTH, f'{BASE}/api/settings'); S = J(b); check('设置读取：默认敏感项目不发中转站', c == 200 and S.get('route', {}).get('blockRelay') is True, b[:160])
c, b = curl(*AUTH, *JS, '-d', '{"route":{"blockRelay":false}}', f'{BASE}/api/settings'); check('Bearer 不能改设置 → 403', c == 403, c)
c, b = curl(*COOK, *JS, '-d', '{"notify":{"on":false,"tg":"abc"}}', f'{BASE}/api/settings'); check('Telegram chat_id 非数字 → 400', c == 400, c)
c, b = curl(*COOK, *JS, '-d', '{"route":{"blockRelay":true},"notify":{"on":false,"tg":""}}', f'{BASE}/api/settings'); check('cookie 保存设置 → 200', c == 200, c)
c, b = curl(*AUTH, *JS, '-d', '{"message":"x"}', f'{BASE}/api/resources/item/u-0000000000000000', '-X', 'DELETE'); check('Bearer 不能删资源库条目 → 403', c == 403, c)

# ── 2026-10-23 角色卡 / 分类纠错 / 工具网关 / 负责人设置 ──
import time as _t
CFG = json.load(open(__import__('os').path.join(__import__('os').path.dirname(__import__('os').path.abspath(__file__)), 'members.json')))
tids = {t['id']: t for t in CFG['tools']}
check('分类：Workers AI 不在「工具与算力」（是模型来源）', 'tool-cf-ai' not in tids and any(k.get('binding') and 'Workers AI' in k['name'] for k in CFG['keys']))
gpu = sorted(t['id'] for t in CFG['tools'] if str(t.get('group', '')).startswith('算力'))
check('分类：真算力只有 Modal/Kaggle/Lightning/Lambda/Beam', gpu == sorted(['tool-modal', 'tool-kaggle', 'tool-lightning', 'tool-lambda', 'tool-beam']), gpu)
check('Hark 专属工具标「仅 Hark 可用」', all(tids[i]['gw']['status'] == 'hark' for i in ['tool-hark-sandbox', 'tool-browser', 'tool-remote-desktop', 'tool-mail', 'tool-poke-phone']))
check('每张网关工具卡都有核实日期 + 官方来源链接 + 计费规则', all(t['gw'].get('card', {}).get('src', '').startswith('https://') and t['gw']['card'].get('verified') and t['gw']['card'].get('billing') for t in CFG['tools'] if t['gw']['status'] != 'hark'))
check('会自动扣费的（Modal/Lambda/Beam）标 billing_auto=true', all(tids[i]['gw']['card']['billing_auto'] is True for i in ['tool-modal', 'tool-lambda', 'tool-beam']))
c, b = curl(*AUTH, f'{BASE}/api/tools'); TV = J(b); tv = {t['id']: t for t in TV.get('tools', [])}
check('GET /api/tools：查网页免 Key 已接，函数里有 fetch_url', c == 200 and tv.get('tool-fetch', {}).get('keyFilled') and 'fetch_url' in TV.get('fns', []), TV.get('fns'))
check('GET /api/tools：E2B/Daytona 状态「已接」、其余有 API 的「待测」', tv['tool-e2b']['status'] == 'ok' and tv['tool-daytona']['status'] == 'ok' and all(tv[i]['status'] == 'todo' for i in ['tool-modal', 'tool-lambda', 'tool-phonebox', 'tool-airtap', 'tool-freestyle', 'tool-phone', 'tool-instabox', 'tool-kaggle', 'tool-lightning', 'tool-beam']))
c, b = curl(*AUTH, *JS, '-d', '{"tool":"tool-fetch","action":"fetch_url","args":{"url":"https://example.com/"}}', f'{BASE}/api/tools/run'); check('Bearer 不能直接调工具 → 403', c == 403, c)
c, b = curl(*COOK, *JS, '-d', '{"tool":"tool-fetch","action":"fetch_url","args":{"url":"https://example.com/"}}', f'{BASE}/api/tools/run'); r = J(b)
check('工具网关端到端：查网页 example.com → 成功并有正文', c == 200 and r.get('ok') and 'Example Domain' in r.get('text', ''), b[:160])
c, b = curl(*COOK, *JS, '-d', '{"tool":"tool-fetch","action":"fetch_url","args":{"url":"http://169.254.169.254/"}}', f'{BASE}/api/tools/run'); check('工具网关：内网/非 https 地址被拒（SSRF）', c == 200 and not J(b).get('ok'), b[:120])
c, b = curl(*AUTH, f'{BASE}/api/calls'); cl = J(b).get('calls', [])
check('调用记录：刚才的查网页写进 calls（成功 + 失败各一条）', any(x['name'] == 'tool-fetch' and x['ok'] == 1 for x in cl) and any(x['name'] == 'tool-fetch' and x['ok'] == 0 for x in cl), [(x['name'], x['ok']) for x in cl[:3]])
c, b = curl(*COOK, *JS, '-d', '{"tool":"tool-browser","action":"x"}', f'{BASE}/api/tools/run'); check('仅 Hark 可用的工具不能经网关调用', '仅 Hark' in J(b).get('text', ''), b[:120])
c, b = curl(*COOK, *JS, '-d', '{"tool":"tool-lambda","action":"launch_instance"}', f'{BASE}/api/tools/run'); check('没填 Key 的工具明说缺 Key', '还没填 Key' in J(b).get('text', ''), b[:120])
# 确认流程：临时填一个假 Saperly Key（无验证接口），发短信=不可逆 → 等确认 → 拒绝/确认（执行器待测，不对外发请求）→ 删 Key
curl(*COOK, *JS, '-d', '{"name":"SAPERLY_API_KEY","value":"test-dummy-key-0000"}', f'{BASE}/api/keys')
c, b = curl(*COOK, *JS, '-d', '{"tool":"tool-phone","action":"send_sms","args":{"to":"test","text":"hi"}}', f'{BASE}/api/tools/run'); r = J(b); pid = r.get('pending')
check('不可逆动作（发短信）先进「等你确认」，不执行', bool(pid) and not r.get('ok'), b[:160])
c, b = curl(*AUTH, *JS, '-d', json.dumps({'id': pid, 'approve': True}), f'{BASE}/api/tools/confirm'); check('Bearer 不能代点确认 → 403', c == 403, c)
c, b = curl(*COOK, *JS, '-d', json.dumps({'id': pid, 'approve': True}), f'{BASE}/api/tools/confirm'); r = J(b)
check('页面确认后才执行（骨架返回「待测」，没真发）', c == 200 and r.get('result', {}).get('todo') and '待测' in r.get('result', {}).get('text', ''), b[:200])
c, b = curl(*COOK, *JS, '-d', '{"tool":"tool-phone","action":"buy_number"}', f'{BASE}/api/tools/run'); pid2 = J(b).get('pending')
c, b = curl(*COOK, *JS, '-d', json.dumps({'id': pid2, 'approve': False}), f'{BASE}/api/tools/confirm'); check('花钱动作（买号码）可以拒绝', c == 200 and J(b).get('rejected'), b[:120])
curl(*COOK, '-X', 'DELETE', f'{BASE}/api/keys/SAPERLY_API_KEY')
# 敏感项目：工具调用被拦
c, b = curl(*AUTH, *JS, '-d', json.dumps({'message': '敏感工具测试（自动删）', 'mode': 'free', 'members': [{'id': 'gpt-oss-120b', 'role': '审查员'}], 'sensitive': True}), f'{BASE}/api/start'); srm = J(b).get('room')
c, b = curl(*COOK, *JS, '-d', json.dumps({'tool': 'tool-fetch', 'action': 'fetch_url', 'args': {'url': 'https://example.com/'}, 'room': srm}), f'{BASE}/api/tools/run'); check('敏感项目里工具调用被路由规则拦下', J(b).get('blocked') is True, b[:140])
curl(*AUTH, '-X', 'DELETE', f'{BASE}/api/room/{srm}')
# 角色卡数据
c, b = curl(*AUTH, f'{BASE}/api/member/gpt-oss-120b'); M = J(b)
check('成员详情带角色卡数据：7 天调用、成功率字段、调用记录、函数调用能力', len(M.get('stats', {}).get('days', [])) == 7 and 'rate' in M.get('stats', {}) and isinstance(M.get('calls'), list) and M.get('fc') is True, M.get('stats'))
# 负责人设置
c, b = curl(*AUTH, f'{BASE}/api/lead'); check('负责人设置默认空（用 Hark 规则）、超时 180 秒', c == 200 and J(b).get('p') is None and J(b).get('timeoutSec') == 180, b[:160])
c, b = curl(*AUTH, *JS, '-d', '{"p":{"type":"member","id":"gpt-oss-120b"}}', f'{BASE}/api/lead'); check('Bearer 不能改负责人 → 403', c == 403, c)
c, b = curl(*COOK, *JS, '-d', '{"p":{"type":"custom","base":"http://10.0.0.1/v1","model":"x"}}', f'{BASE}/api/lead'); check('自定义负责人端点只收公网 https', c == 400, b[:120])
c, b = curl(*COOK, *JS, '-d', '{"p":{"type":"custom","name":"测试端点","base":"https://example.com/v1","model":"test-model","key":"lead-test-key-9876"},"s":{"type":"member","id":"gpt-oss-120b"}}', f'{BASE}/api/lead')
check('保存主（自定义端点 + Key）/副（成员）负责人 → 200', c == 200, b[:160])
c, b = curl(*AUTH, f'{BASE}/api/lead'); L = J(b)
check('Key 不回显，只给末 4 位', L.get('p', {}).get('keyLast4') == '9876' and 'lead-test-key' not in b, b[:200])
c, b = curl(*COOK, *JS, '-d', '{"slot":"p"}', f'{BASE}/api/lead/test'); check('测试连接：坏端点明说失败', c == 200 and J(b).get('ok') is False, b[:160])
c, b = curl(*AUTH, *JS, '-d', '{"topic":"写一首短诗","mode":"debate"}', f'{BASE}/api/plan'); P = J(b); note = P.get('note', '')
check('主负责人出错 → 文字说明切到副负责人', '切到副负责人' in note, note[:300])
# 副负责人（Workers AI gpt-oss-120b）能否用取决于当天免费额度：额度用完 → 回退内置规则；额度在 → 副负责人接手。两种都算对，但都必须给出阵容。
check('主出错后：副可用则副负责人派工，副也不可用则回退 Hark 内置规则（都给出阵容）', len(P.get('members', [])) >= 1 and ('回退' in note or ('副负责人' in note and '安排' in note)), note[:300])
# 外部智能体负责人（拉取模式小桥）：等回复 → 回 JSON 应用阵容；超时 → 交给副负责人/回退
curl(*AUTH, *JS, '-d', '{"conn":"bridge","id":"x-leadtest","name":"LeadTestBridge","jobs":"派工"}', f'{BASE}/api/agents')
lt = mtok('x-leadtest'); curl('-H', f'Authorization: Bearer {lt}', f'{BASE}/bridge/pull?member=x-leadtest')
c, b = curl(*COOK, *JS, '-d', '{"p":{"type":"member","id":"x-leadtest"},"s":null,"timeoutSec":20}', f'{BASE}/api/lead'); check('主负责人可选外部智能体（小桥）+ 超时 20 秒', c == 200, b[:120])
c, b = curl(*AUTH, *JS, '-d', '{"message":"负责人回复测试（自动删）","mode":"debate"}', f'{BASE}/api/start'); st = J(b); r1 = st.get('room')
check('外部智能体负责人：项目进入「等负责人分工」', bool(st.get('leadWait')) and st['leadWait'].get('name') == 'LeadTestBridge', b[:200])
c, b = curl('-H', f'Authorization: Bearer {lt}', f'{BASE}/bridge/pull?member=x-leadtest'); tk = [x for x in J(b).get('tasks', []) if x.get('role') == '负责人']
check('小桥拉到负责人任务', bool(tk), b[:160])
if tk:
    c, b = curl('-H', f'Authorization: Bearer {lt}', *JS, '-d', json.dumps({'task': tk[0]['task'], 'text': '[{"id":"gpt-oss-120b","role":"提议者","reason":"测试"},{"id":"llama-4-scout-17b","role":"裁判","reason":"测试"}]'}), f'{BASE}/hook/reply')
    c, b = curl(*AUTH, f'{BASE}/api/room/{r1}'); R1 = J(b)
    check('负责人回 JSON → 阵容按它设置、群里写明「负责人安排」', any('负责人安排' in m['text'] for m in R1.get('messages', [])) and [x['id'] for x in R1.get('lineup', [])] == ['gpt-oss-120b', 'llama-4-scout-17b'] and not R1.get('leadWait'), [x['id'] for x in R1.get('lineup', [])])
curl('-H', f'Authorization: Bearer {lt}', f'{BASE}/bridge/pull?member=x-leadtest')
c, b = curl(*AUTH, *JS, '-d', '{"message":"负责人超时测试（自动删）","mode":"debate"}', f'{BASE}/api/start'); r2 = J(b).get('room')
_t.sleep(23)
c, b = curl(*AUTH, f'{BASE}/api/room/{r2}'); R2 = J(b); txt = '\n'.join(m['text'] for m in R2.get('messages', []))
check('负责人超时 → 群里文字说明，并回退（没设副负责人时用 Hark 规则）', not R2.get('leadWait') and '没回复' in txt and '回退' in txt, txt[-300:])
for rr in (r1, r2):
    if rr: curl(*AUTH, '-X', 'DELETE', f'{BASE}/api/room/{rr}')
curl(*AUTH, '-X', 'DELETE', f'{BASE}/api/agents/x-leadtest')
c, b = curl(*COOK, *JS, '-d', '{"p":null,"s":null,"timeoutSec":180}', f'{BASE}/api/lead'); check('还原负责人设置', c == 200 and J(curl(*AUTH, f'{BASE}/api/lead')[1]).get('p') is None, b[:100])

# ── 关联智能体（配对码）/ 操作员令牌 / 岗位说明书 / MCP ──
OPH = lambda t: ['-H', f'Authorization: Bearer {t}']
c, b = curl(*AUTH, *JS, '-d', '{"slot":"p"}', f'{BASE}/api/pair/new'); check('Bearer 不能生成配对码 → 403', c == 403, c)
c, b = curl(*COOK, *JS, '-d', '{"slot":"p"}', f'{BASE}/api/pair/new'); codeA = J(b).get('code', '')
c, b = curl(*COOK, *JS, '-d', '{"slot":"p"}', f'{BASE}/api/pair/new'); PN = J(b); code = PN.get('code', ''); ph = PN.get('phrase', '')
check('配对开场白：完整自我说明（网址、技能链接、配对码、权限范围、先问用户、10 分钟），不含个人信息', all(x in ph for x in [BASE, '/skills/ai-groupchat-operator.md', code, '不能查看或导出任何 Key', '先问我', '10 分钟', '/api/lead/brief']) and not re.search(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}|\+\d{10,}', ph), ph[:160])
c, b = curl(*AUTH, f'{BASE}/api/pair/status?code={codeA}'); check('生成新码 → 之前未用的码作废', J(b).get('state') == 'void', b[:80])
c, b = curl(*JS, '-d', json.dumps({'code': codeA, 'name': 'x', 'platform': 'y'}), f'{BASE}/api/pair'); check('作废的旧码兑换 → 410', c == 410, c)
c, b = curl(f'{BASE}/skills/ai-groupchat-operator.md'); check('操作技能文件可公开读取（不含密钥），写了交接流程和 MCP', c == 200 and '交接流程' in b and '/mcp' in b and 'Bearer' in b and not re.search(r'op_[0-9a-f]{48}', b), c)
c, b = curl(*JS, '-d', json.dumps({'code': code, 'name': '测试甲', 'platform': 'Hark'}), f'{BASE}/api/pair'); PR = J(b); hid = PR.get('member', ''); htok = PR.get('token', ''); OPT = PR.get('operator_token', '')
check('配对成功：成员令牌 + 操作员令牌 + MCP 地址 + 接入说明', c == 200 and hid.startswith('x-agent-') and htok == mtok(hid) and OPT.startswith('op_') and PR.get('mcp', {}).get('url', '').endswith('/mcp') and '/bridge/pull' in PR.get('instructions', ''), b[:120].replace(OPT, '<OP>') if OPT else b[:160])
c, b = curl(*JS, '-d', json.dumps({'code': code, 'name': '再来', 'platform': 'x'}), f'{BASE}/api/pair'); check('配对码用过即作废 → 410', c == 410, c)
# P1-1：配对来的外部负责人不受模型能力规则约束
c, b = curl(*AUTH, f'{BASE}/api/lead/candidates'); LC = J(b); pc = [x for x in LC.get('candidates', []) if x['id'] == hid]
check('P1-1 配对负责人：在候选里、kind=paired、资格来自配对（rule=pairing）', bool(pc) and pc[0]['kind'] == 'paired' and pc[0]['rule'] == 'pairing' and hid not in [x['id'] for x in LC.get('ineligible', [])], pc)
c, b = curl(*AUTH, f'{BASE}/api/lead'); LP = J(b); check('P1-1 配对负责人：GET /api/lead 资格=合格、没有不合格通知', (LP.get('eligibility', {}).get('p') or {}).get('eligible') is True and not LP.get('notices'), json.dumps(LP.get('eligibility'), ensure_ascii=False)[:200])
c, b = curl(*COOK, *JS, '-d', json.dumps({'p': {'type': 'member', 'id': hid}}), f'{BASE}/api/lead'); c2, _ = curl(*AUTH, f'{BASE}/api/member/{hid}')
check('P1-1 配对负责人：重新保存不被拒绝、成员不被删除', c == 200 and c2 == 200, f'{c} {c2} {b[:120]}')
c, b = curl(*COOK, *JS, '-d', json.dumps({'id': hid, 'conn': 'openai', 'name': 'Overwrite', 'url': 'https://example.com/v1', 'model': 'tiny-1b', 'secret': 'AGENT_TEST_KEY', 'paired': True}), f'{BASE}/api/agents')
MH = J(curl(*AUTH, f'{BASE}/api/member/{hid}')[1]); LCH = [x for x in J(curl(*AUTH, f'{BASE}/api/lead/candidates')[1]).get('candidates', []) if x['id'] == hid]
check('P1-1 fix：自建成员不能覆盖已配对成员（4xx，配对成员原样、仍是 paired）', 400 <= c < 500 and 'Overwrite' not in json.dumps(MH, ensure_ascii=False) and bool(LCH) and LCH[0]['kind'] == 'paired', f'{c} {b[:100]}')
c, b = curl(*AUTH, f'{BASE}/api/pair/status?code={code}'); check('网页显示「已关联：名称（平台）」', J(b).get('state') == 'done' and '测试甲（Hark）' == J(b).get('name'), b[:120])
c, b = curl(*OPH(OPT), f'{BASE}/api/members'); check('操作员令牌复述确认前不能操作（未激活）→ 403', c == 403 and '岗位说明书' in J(b).get('error', ''), b[:120])
c, b = curl(*OPH(OPT), f'{BASE}/api/lead/brief'); BR = J(b)
check('岗位说明书接口：说明书四部分 + 培训手册 + 状态快照（成员与额度、项目、任务、交接备注）', c == 200 and all(x in BR.get('charter', '') for x in ['项目是干什么的', '负责人职责清单', '权限边界', '当前状态快照']) and len(BR.get('training', '')) > 200 and {'members', 'projects', 'tasks', 'handoffNote'} <= set(BR.get('snapshot', {})), b[:120])
c, b = curl(*OPH(OPT), *JS, '-d', '{"summary":"好"}', f'{BASE}/api/lead/ack'); check('复述太短 → 400', c == 400, c)
c, b = curl(*OPH(OPT), *JS, '-d', '{"summary":"我是主负责人：这个群把免费模型组成 AI 公司，我负责拆任务派活、让成员互相核对、汇总交付，付费命名 Logo 域名先问用户。"}', f'{BASE}/api/lead/ack'); check('复述确认 → 激活', c == 200 and J(b).get('active'), b[:120])
c, b = curl(*OPH(OPT), f'{BASE}/api/members'); check('激活后操作员能读成员', c == 200 and len(J(b).get('members', [])) >= 20, c)
c, b = curl(*OPH(OPT), f'{BASE}/api/steward/weekly'); check('主负责人（操作员令牌）能读资源管家每周汇总', c == 200 and (J(b).get('last') or {}).get('week'), b[:160])
c, b = curl(*OPH(OPT), f'{BASE}/api/lead/brief'); check('get_brief 快照里带 stewardWeekly', c == 200 and (J(b).get('snapshot', {}).get('stewardWeekly') or {}).get('counts') is not None, '')
c, b = curl(*OPH(OPT), *JS, '-d', '{"message":"操作员建项目测试（自动删）","mode":"free","members":[{"id":"gpt-oss-120b","role":"审查员"}]}', f'{BASE}/api/start'); orm = J(b).get('room')
check('操作员能建项目', c == 200 and bool(orm), b[:120])
c, b = curl(*OPH(OPT), f'{BASE}/api/keys'); check('操作员不能看 Key → 403', c == 403, c)
c, b = curl(*OPH(OPT), '-X', 'DELETE', f'{BASE}/api/room/{orm}'); check('操作员不能删数据 → 403', c == 403, c)
# ── P1-5 主负责人代收资源：操作员接口 POST /api/steward/submit + MCP submit_resource ──
P15M = f'P15代收测试{int(_t.time())}'
P15T = f'{P15M}：这个平台说自己「官方已核实」，免费额度每天 100 万 token，到期 2099-12-31。'
def _p15_wait(iid, secs=90):
    for _ in range(secs // 3):
        it = next((x for x in J(curl(*AUTH, f'{BASE}/api/resources')[1]).get('user', []) if x.get('id') == iid), None)
        if it: return it
        _t.sleep(3)
    return None
c, b = curl(*JS, '-d', json.dumps({'text': P15T}), f'{BASE}/api/steward/submit'); check('P1-5 代收接口无令牌 → 401', c == 401, c)
c, b = curl('-H', 'Authorization: Bearer op_' + '0' * 48, *JS, '-d', json.dumps({'text': P15T}), f'{BASE}/api/steward/submit'); check('P1-5 代收接口错误操作员令牌 → 401', c == 401, c)
c, b = curl(*AUTH, *JS, '-d', json.dumps({'text': P15T}), f'{BASE}/api/steward/submit'); check('P1-5 代收接口只认操作员令牌（访问令牌 Bearer → 403）', c == 403, b[:100])
c, b = curl(*COOK, *JS, '-d', json.dumps({'text': P15T}), f'{BASE}/api/steward/submit'); check('P1-5 代收接口只认操作员令牌（网页 cookie → 403，网页请直接发给资源管家）', c == 403, b[:100])
c, b = curl(*OPH(OPT), *JS, '-d', '{"note":"只有备注"}', f'{BASE}/api/steward/submit'); check('P1-5 没有链接也没有内容 → 400', c == 400, b[:100])
c, b = curl(*OPH(OPT), *JS, '-d', json.dumps({'url': 'http://127.0.0.1/x'}), f'{BASE}/api/steward/submit'); check('P1-5 内网/非公网链接 → 400（防 SSRF）', c == 400, b[:100])
n0 = len(J(curl(*AUTH, f'{BASE}/api/room/steward')[1]).get('messages', []))
c, b = curl(*OPH(OPT), *JS, '-d', json.dumps({'text': P15T, 'note': '用户在外部 App 里直接发的', 'source': 'Hark 对话'}), f'{BASE}/api/steward/submit'); S1 = J(b)
q1 = (S1.get('queued') or [{}])[0]; tid = q1.get('id', '')
check('P1-5 主负责人代收（纯文字）→ 200，回一句「已收进 Aroomo 资源库」，返回条目 id', c == 200 and S1.get('reply') == '已收进 Aroomo 资源库' and tid.startswith('t-') and not S1.get('duplicates'), b[:200])
IT = _p15_wait(tid)
check('P1-5 代收条目走资源管家流水线入库：标「来源：主负责人代收」+ 备注/来源', bool(IT) and IT.get('from') == '主负责人代收' and IT.get('via_note') == '用户在外部 App 里直接发的' and IT.get('via_src') == 'Hark 对话' and (IT.get('via_by') or '').startswith('测试甲'), IT)
check('P1-5 文字里自称「已核实」也不算：官方页没逐字对上 → 状态不是「已核实」、没有核实页', bool(IT) and IT.get('state') != '已核实' and IT.get('vstate') != '已核实' and not IT.get('verified_url'), {k: (IT or {}).get(k) for k in ('state', 'vstate', 'verified_url')})
nres = len(J(curl(*AUTH, f'{BASE}/api/resources')[1]).get('user', []))
c, b = curl(*OPH(OPT), *JS, '-d', json.dumps({'text': P15T}), f'{BASE}/api/steward/submit'); S2 = J(b)
check('P1-5 重复投递 → 去重（duplicates 里是同一条，不排队、不新增条目），仍只回一句', c == 200 and not S2.get('queued') and (S2.get('duplicates') or [{}])[0].get('id') == tid and S2.get('reply') == '已收进 Aroomo 资源库' and len(J(curl(*AUTH, f'{BASE}/api/resources')[1]).get('user', [])) == nres, b[:200])
u15 = f'https://example.com/?p15={int(_t.time())}'
c, b = curl(*OPH(OPT), *JS, '-d', json.dumps({'url': u15, 'text': '同一个链接写两遍 ' + u15 + ' ' + u15.replace('https:', 'http:')}), f'{BASE}/api/steward/submit'); S3 = J(b)
check('P1-5 一次投递里同一链接（含 http/https 写法）只排一次', c == 200 and len(S3.get('queued') or []) == 1 and (S3.get('queued') or [{}])[0].get('id', '').startswith('u-'), b[:200])
uid = (S3.get('queued') or [{}])[0].get('id', '')
c, b = curl(*OPH(OPT), *JS, '-d', json.dumps({'url': u15}), f'{BASE}/api/steward/submit'); S4 = J(b)
check('P1-5 同一链接处理中再投 → 去重（不重复抓取）', c == 200 and not S4.get('queued') and (S4.get('duplicates') or [{}])[0].get('id') == uid, b[:200])
_t.sleep(2); n1 = len(J(curl(*AUTH, f'{BASE}/api/room/steward')[1]).get('messages', []))
check('P1-5 不刷屏：代收不往资源管家私聊发消息', n1 == n0, [n0, n1])
c, b = curl(*AUTH, f'{BASE}/api/steward/submissions'); SL = J(b)
check('P1-5 代收记录可查（GET /api/steward/submissions：排队/重复/结果）', c == 200 and any(x.get('id') == tid for x in SL.get('items', [])) and any(x.get('status') == 'duplicate' for x in SL.get('items', [])), b[:200])
c, b = curl(*COOK, *JS, '-X', 'POST', '-d', '{}', f'{BASE}/api/steward/weekly'); WK5 = J(b)
check('P1-5 每周汇总把代收算进新增，并写「其中主负责人代收 N 条」', (WK5.get('counts') or {}).get('lead', 0) >= 1 and '主负责人代收' in (WK5.get('text') or ''), (WK5.get('counts'), (WK5.get('text') or '')[:120]))
c, b = curl(*OPH(OPT), f'{BASE}/api/lead/brief'); SR = J(b).get('standingRules') or []
check('P1-5 get_brief 有常驻规则 standingRules：链接/文件默认 submit_resource、只回「已收进 Aroomo 资源库」、不追问', any('submit_resource' in r and '已收进 Aroomo 资源库' in r and '不追问' in r for r in SR), SR)
c, b = curl(f'{BASE}/skills/ai-groupchat-operator.md'); check('P1-5 操作技能文件写了常驻规则与 submit_resource 接口', c == 200 and '常驻规则' in b and 'submit_resource' in b and '已收进 Aroomo 资源库' in b and '/api/steward/submit' in b, c)
check('P1-5 配对开场白写了常驻规则（链接默认 submit_resource，只回一句）', 'submit_resource' in ph and '已收进 Aroomo 资源库' in ph, ph[-200:])
c, b = curl(*OPH(OPT), *JS, '-d', '{"jsonrpc":"2.0","id":51,"method":"tools/list"}', f'{BASE}/mcp'); T5 = next((t for t in (J(b).get('result') or {}).get('tools', []) if t['name'] == 'submit_resource'), {})
check('P1-5 MCP 有 submit_resource（url/text/note/source）', set((T5.get('inputSchema') or {}).get('properties', {})) >= {'url', 'text', 'note', 'source'}, T5)
c, b = curl(*OPH(OPT), *JS, '-d', json.dumps({'jsonrpc': '2.0', 'id': 52, 'method': 'tools/call', 'params': {'name': 'submit_resource', 'arguments': {'text': P15T}}}), f'{BASE}/mcp'); MR = J(b).get('result') or {}
check('P1-5 MCP submit_resource 调用成功（重复 → 去重）', c == 200 and MR.get('isError') is False and tid in json.dumps(MR, ensure_ascii=False) and '已收进 Aroomo 资源库' in json.dumps(MR, ensure_ascii=False), b[:200])
c, b = curl(*AUTH, f'{BASE}/api/operator'); check('P1-5 代收写审计日志', any(a.get('path') == '/api/steward/submit' for a in J(b).get('audit', [])), '')
P15_IDS = [tid, uid]
c, b = curl(*OPH(OPT), *JS, '-d', '{"id":1,"approve":true}', f'{BASE}/api/tools/confirm'); check('操作员不能代确认付费动作 → 403', c == 403, c)
c, b = curl(*OPH(OPT), *JS, '-d', '{"p":{"type":"custom","base":"https://example.com/v1","model":"m","key":"zzzzzzzzzzzz"}}', f'{BASE}/api/lead'); check('操作员不能写入 Key → 403', c == 403, c)
c, b = curl(*OPH(OPT), f'{BASE}/api/operator'); check('操作员不能看/吊销令牌 → 403', c == 403, c)
c, b = curl(*OPH(OPT), *JS, '-d', '{"note":"测试交接备注：进行中的项目见快照"}', f'{BASE}/api/lead/handoff-note'); check('操作员能写交接备注', c == 200, c)
# P1-1 fix1：操作员也不能用保留前缀建成员；不能改自定义负责人端点（防 Key 外泄）；确认候选池写审计
c, b = curl(*OPH(OPT), *JS, '-d', '{"id":"x-agent-opevil","conn":"openai","name":"OpEvil","url":"https://example.com/v1","model":"tiny-1b","secret":"AGENT_TEST_KEY"}', f'{BASE}/api/agents')
check('P1-1 fix：操作员 POST /api/agents 用保留前缀 x-agent- → 400', c == 400, f'{c} {b[:120]}')
c, b = curl(*OPH(OPT), *JS, '-d', '{"id":"x-p1opleak","conn":"webhook","name":"OpLeak","url":"https://evil.example.net/hook","secret":"AGENT_TEST_KEY"}', f'{BASE}/api/agents')
check('P1-1 fix（同类 Key 外泄）：操作员建成员时引用 AGENT_ 密钥 → 403', c == 403, f'{c} {b[:120]}')
curl(*COOK, *JS, '-d', '{"id":"x-p1usr","conn":"webhook","name":"UserHook","url":"https://user.example.com/hook","secret":"AGENT_TEST_KEY"}', f'{BASE}/api/agents')
c, b = curl(*OPH(OPT), *JS, '-d', '{"id":"x-p1usr","conn":"webhook","name":"UserHook","url":"https://evil.example.net/hook"}', f'{BASE}/api/agents'); MU = J(curl(*AUTH, f'{BASE}/api/member/x-p1usr')[1])
check('P1-1 fix（同类 Key 外泄）：操作员不能覆盖已有成员（改地址）→ 403，原地址不变', c == 403 and 'evil.example.net' not in json.dumps(MU), f'{c} {b[:120]}')
curl(*AUTH, '-X', 'DELETE', f'{BASE}/api/agents/x-p1usr')
c, b = curl(*COOK, *JS, '-d', '{"s":{"type":"custom","base":"https://lead-a.example.com/v1","model":"m-a","key":"kkkkkkkkkkkk1234"}}', f'{BASE}/api/lead'); c0 = c
c, b = curl(*OPH(OPT), *JS, '-d', '{"s":{"type":"custom","base":"https://evil.example.net/v1","model":"m-a"}}', f'{BASE}/api/lead'); LK = J(curl(*AUTH, f'{BASE}/api/lead')[1]).get('s') or {}
check('P1-1 fix：操作员改自定义负责人端点 base → 403，端点和已存 Key 不变', c0 == 200 and c == 403 and LK.get('base') == 'https://lead-a.example.com/v1' and LK.get('keyLast4') == '1234', f'{c0} {c} {LK}')
c, b = curl(*OPH(OPT), *JS, '-d', '{"s":{"type":"custom","base":"https://lead-a.example.com/v1","model":"other-model"}}', f'{BASE}/api/lead')
check('P1-1 fix：操作员改自定义负责人 model → 403', c == 403, f'{c} {b[:120]}')
curl(*COOK, *JS, '-d', '{"s":null}', f'{BASE}/api/lead')
curl(*COOK, *JS, '-d', json.dumps({'relay': 'relay-vyce', 'models': ['p1op/Op-Confirm-Model']}), f'{BASE}/api/models/sync')
c, b = curl(*OPH(OPT), *JS, '-d', '{"norm":"op-confirm-model"}', f'{BASE}/api/models/pool/confirm'); opid = J(b).get('id', '')
AU = J(curl(*AUTH, f'{BASE}/api/operator')[1]).get('audit', [])
check('P1-1 已知问题4：操作员确认候选池模型保持可用，且审计日志写明模型与新成员 id', c == 200 and any(a.get('path') == '/api/models/pool/confirm' and 'op-confirm-model' in (a.get('note') or '') and opid in (a.get('note') or '') for a in AU), f'{c} {opid} {[a for a in AU if "confirm" in (a.get("path") or "")][:2]}')
if opid: curl(*AUTH, '-X', 'DELETE', f'{BASE}/api/agents/{opid}')
check('P1-1 fix：操作员确认的 pool- 成员已清理（删后 404）', bool(opid) and curl(*AUTH, f'{BASE}/api/member/{opid}')[0] == 404, opid)
curl(*AUTH, '-X', 'DELETE', f'{BASE}/api/room/{orm}')
c, b = curl(*AUTH, f'{BASE}/api/operator'); OA = J(b)
check('网页能看到操作员令牌和审计日志（含被拒的调用）', any(t['member'] == hid and t['active'] for t in OA.get('tokens', [])) and any('拒绝' in (a.get('note') or '') for a in OA.get('audit', [])), [a.get('path') for a in OA.get('audit', [])[:5]])
# MCP（用官方 Python MCP 客户端实测）
import subprocess as _sp
mcp_out = _sp.run([os.environ.get('AGC_MCP_PYTHON', sys.executable), '-c', f"""
import asyncio, json
from mcp import ClientSession
import httpx
from mcp.client.streamable_http import streamable_http_client
async def main():
    async with httpx.AsyncClient(headers={{'Authorization':'Bearer {OPT}'}}, timeout=60) as hc, streamable_http_client('{BASE}/mcp', http_client=hc) as st:
        r, w = st[0], st[1]
        async with ClientSession(r, w) as s:
            await s.initialize()
            tl = await s.list_tools()
            res = await s.call_tool('get_brief', {{}})
            k = await s.call_tool('search', {{'q':'测试'}})
            print(json.dumps({{'tools':[t.name for t in tl.tools], 'brief':'项目是干什么的' in res.content[0].text, 'err':getattr(res,'is_error',getattr(res,'isError',None)), 'search_ok': not getattr(k,'is_error',getattr(k,'isError',None))}}, ensure_ascii=False))
asyncio.run(main())
"""], capture_output=True, text=True, timeout=90)
mo = J(mcp_out.stdout.strip().splitlines()[-1] if mcp_out.stdout.strip() else '{}')
check('MCP 客户端实测：initialize + tools/list（≥20 个工具）+ 调 get_brief / search 成功', len(mo.get('tools', [])) >= 20 and mo.get('brief') and mo.get('err') is False and mo.get('search_ok'), (mcp_out.stdout + mcp_out.stderr)[-300:].replace(OPT, '<OP>'))
c, b = curl(*JS, '-d', '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', f'{BASE}/mcp'); check('MCP 无令牌 → 401', c == 401, c)
c, b = curl(*OPH(OPT), *JS, '-d', '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_settings","arguments":{}}}', f'{BASE}/mcp'); check('MCP 调用同样写审计、权限一致（get_settings 成功）', c == 200 and J(b).get('result', {}).get('isError') is False, b[:120])
# 副负责人配对：待命只读
c, b = curl(*COOK, *JS, '-d', '{"slot":"s"}', f'{BASE}/api/pair/new'); codeS = J(b).get('code')
c, b = curl(*JS, '-d', json.dumps({'code': codeS, 'name': '测试乙', 'platform': 'Poke'}), f'{BASE}/api/pair'); PS = J(b); sid = PS.get('member', ''); STK = PS.get('operator_token', '')
c, b = curl(*OPH(STK), *JS, '-d', '{"summary":"我是副负责人：平时待命只读，主负责人失联或超时时接手派活，付费命名先问用户。"}', f'{BASE}/api/lead/ack'); check('副负责人复述确认 → 待命', c == 200, b[:100])
c, b = curl(*OPH(STK), f'{BASE}/api/members'); check('副负责人待命：能读', c == 200, c)
c, b = curl(*OPH(STK), *JS, '-d', '{"message":"x"}', f'{BASE}/api/start'); check('副负责人待命：不能写 → 403', c == 403 and '待命' in J(b).get('error', ''), b[:100])
c, b = curl(*OPH(STK), *JS, '-d', json.dumps({'text': P15T + '（副）'}), f'{BASE}/api/steward/submit'); check('P1-5 副负责人待命时不能代收 → 403', c == 403 and '待命' in J(b).get('error', ''), b[:100])
c, b = curl(*AUTH, f'{BASE}/api/lead'); LL = J(b); check('主/副各自配对、各自令牌', LL.get('p', {}).get('id') == hid and LL.get('s', {}).get('id') == sid, b[:160])
# 主失联/超时 → 副自动升为主并通知
curl(*COOK, *JS, '-d', '{"timeoutSec":20}', f'{BASE}/api/lead')
curl('-H', f'Authorization: Bearer {htok}', f'{BASE}/bridge/pull?member={hid}')
c, b = curl(*AUTH, *JS, '-d', '{"message":"负责人超时升级测试（自动删）","mode":"debate"}', f'{BASE}/api/start'); pr = J(b).get('room')
check('主负责人（配对智能体）进入等待分工', bool(J(b).get('leadWait')), b[:160])
_t.sleep(23)
c, b = curl(*AUTH, f'{BASE}/api/room/{pr}'); txt = '\n'.join(m['text'] for m in J(b).get('messages', []))
c2, b2 = curl(*AUTH, f'{BASE}/api/lead'); L2 = J(b2)
check('主超时 → 群里说明并交给副；副自动升为主（原主降为副）', '没回复' in txt and L2.get('p', {}).get('id') == sid and L2.get('s', {}).get('id') == hid, txt[-200:])
c, b = curl(*AUTH, f'{BASE}/api/room/steward'); check('升级后在资源管家私聊里通知用户', any('自动升为主负责人' in m['text'] for m in J(b).get('messages', [])), '')
c, b = curl(*OPH(STK), *JS, '-d', '{"message":"升主后建项目（自动删）","mode":"free","members":[{"id":"gpt-oss-120b","role":"审查员"}]}', f'{BASE}/api/start'); pr2 = J(b).get('room')
check('升为主后，原副负责人的令牌获得写权限', c == 200 and bool(pr2), b[:100])
c, b = curl(*OPH(STK), *JS, '-d', json.dumps({'text': P15T + '（副负责人接班后代收）'}), f'{BASE}/api/steward/submit'); S5 = J(b); P15_IDS += [x.get('id') for x in S5.get('queued') or []]
check('P1-5 副负责人接班后也能代收', c == 200 and S5.get('reply') == '已收进 Aroomo 资源库' and len(S5.get('queued') or []) == 1, b[:160])
for rr in (pr, pr2):
    if rr: curl(*AUTH, '-X', 'DELETE', f'{BASE}/api/room/{rr}')
# 现任操作员为接任者生成配对码 → 新智能体配对成功 → 旧令牌作废 + 通知
c, b = curl(*OPH(STK), *JS, '-d', '{"slot":"p"}', f'{BASE}/api/pair/new'); codeN = J(b).get('code'); check('现任操作员能为接任者生成配对码（返回完整开场白）', c == 200 and BASE in J(b).get('phrase', ''), b[:100])
c, b = curl(*OPH(STK), f'{BASE}/api/members'); check('新码配对成功前，现任令牌不受影响', c == 200, c)
c, b = curl(*JS, '-d', json.dumps({'code': codeN, 'name': '测试丙', 'platform': 'Manus'}), f'{BASE}/api/pair'); NT = J(b).get('operator_token', ''); nid = J(b).get('member', '')
c, b = curl(*OPH(STK), f'{BASE}/api/members'); check('接任者配对成功 → 旧主负责人令牌作废', c == 401, c)
c, b = curl(*AUTH, f'{BASE}/api/room/steward'); check('接任通知写进资源管家私聊', any('测试丙' in m['text'] and '接替' in m['text'] for m in J(b).get('messages', [])), '')
c, b = curl(*OPH(NT), f'{BASE}/api/lead/brief'); check('接任者读到上一任的交接备注', '测试交接备注' in json.dumps(J(b).get('snapshot', {}).get('handoffNote'), ensure_ascii=False), b[:80])
c, b = curl(*AUTH, f'{BASE}/api/operator'); nt = [t for t in J(b).get('tokens', []) if t['member'] == nid]
c, b = curl(*COOK, *JS, '-d', json.dumps({'member': nid}), f'{BASE}/api/operator/revoke'); c2, _ = curl(*OPH(NT), f'{BASE}/api/lead/brief')
check('网页一键吊销 → 令牌立即失效', c == 200 and c2 == 401, f'{c} {c2}')
# 敏感项目不派给关联智能体（用副=测试甲）
curl('-H', f'Authorization: Bearer {htok}', f'{BASE}/bridge/pull?member={hid}')
c, b = curl(*AUTH, *JS, '-d', json.dumps({'message': '敏感关联智能体测试（自动删）', 'mode': 'free', 'members': [{'id': hid, 'role': '审查员'}], 'sensitive': True}), f'{BASE}/api/start'); hr = J(b).get('room')
c, b = curl(*AUTH, *JS, '-d', json.dumps({'room': hr, 'member': hid}), f'{BASE}/api/turn'); T1 = J(b)
check('敏感项目默认不派给外部关联智能体（暂停并说明）', T1.get('skipped') and not T1.get('pending'), json.dumps(T1, ensure_ascii=False)[:200])
curl(*AUTH, '-X', 'DELETE', f'{BASE}/api/room/{hr}')
c, b = curl('-H', f'Authorization: Bearer {htok}', f'{BASE}/api/rooms'); check('成员令牌不能读房间（作用域不变）', c == 401, c)
c, b = curl(*COOK, *JS, '-d', '{"p":null,"s":null,"timeoutSec":180}', f'{BASE}/api/lead'); c2, _ = curl(*AUTH, f'{BASE}/api/member/{hid}'); c3, _ = curl(*AUTH, f'{BASE}/api/member/{nid}')
check('解除关联 → 配对智能体成员删除（令牌失效），设置还原', c == 200 and c2 == 404 and c3 == 404, f'{c} {c2} {c3}')
codes = [curl(*JS, '-d', '{"code":"AAAA-AAAA","name":"x"}', f'{BASE}/api/pair')[0] for _ in range(9)]
check('配对接口限速（同一 IP 一分钟最多 8 次）', 429 in codes, codes)
c, b = curl(*AUTH, f'{BASE}/api/members'); check('「添加外部成员」有 Hark 连接器模板', 'hark' in J(b).get('connectors', {}), list(J(b).get('connectors', {}).keys()))


# ── P1-1 模型能力分类与负责人资格 ──
c, b = curl(*AUTH, f'{BASE}/api/lead/candidates'); LC = J(b); cid = [x['id'] for x in LC.get('candidates', [])]; bad = {x['id']: x for x in LC.get('ineligible', [])}
check('P1-1 候选接口：合格模型在、生图/网页/pending/工具未知的不在', 'gpt-oss-120b' in cid and all(x in bad for x in ['agnes-image-2.5', 'gpt-image-2.5', 'llama-3.3-70b', 'kimi-k3']) and not set(cid) & set(bad), {'cand': cid[:12], 'bad': list(bad)[:12]})
check('P1-1 候选接口：hark/资源管家不进下拉', 'hark' not in cid and 'steward' not in cid, '')
check('P1-1 外部智能体连接器（poke）按接入取得资格', 'poke' in cid and next(x for x in LC['candidates'] if x['id'] == 'poke')['kind'] == 'agent', '')
L0 = J(curl(*AUTH, f'{BASE}/api/lead')[1])
c, b = curl(*COOK, *JS, '-d', '{"p":{"type":"member","id":"agnes-image-2.5"}}', f'{BASE}/api/lead')
check('P1-1 不合格成员（生图）设为负责人 → 400 lead_ineligible、设置不变', c == 400 and J(b).get('code') == 'lead_ineligible' and J(curl(*AUTH, f'{BASE}/api/lead')[1]).get('p') == L0.get('p'), b[:160])
c, b = curl(*COOK, *JS, '-d', '{"s":{"type":"member","id":"gpt-image-2.5"}}', f'{BASE}/api/lead'); check('P1-1 网页成员设为副负责人 → 400', c == 400 and '网页成员' in b, b[:160])
c, b = curl(*COOK, *JS, '-d', '{"p":{"type":"member","id":"kimi-k3"}}', f'{BASE}/api/lead'); check('P1-1 工具调用 unknown → 按不合格 400', c == 400 and '未知' in b, b[:160])
c, b = curl(*COOK, *JS, '-d', '{"p":{"type":"member","id":"llama-4-scout-17b"}}', f'{BASE}/api/lead'); check('P1-1 pending 不能当负责人 → 400', c == 400 and 'pending' in b, b[:160])
c, b = curl(*AUTH, *JS, '-d', '{"capability_status":"verified","source":"x"}', f'{BASE}/api/member/llama-4-scout-17b/caps'); check('P1-1 Bearer 不能改能力 → 403', c == 403, c)
c, b = curl(*COOK, *JS, '-d', '{"capability_status":"verified"}', f'{BASE}/api/member/llama-4-scout-17b/caps'); check('P1-1 标 verified 必须写来源 → 400', c == 400, b[:100])
c, b = curl(*COOK, *JS, '-d', '{"capability_status":"verified","source":"测试：Workers AI 模型页 131K + tools"}', f'{BASE}/api/member/llama-4-scout-17b/caps')
check('P1-1 用户核实后（verified）→ 合格', c == 200 and J(b).get('leadElig', {}).get('eligible') is True, b[:200])
c, b = curl(*COOK, *JS, '-d', '{"p":{"type":"member","id":"llama-4-scout-17b"},"s":{"type":"member","id":"gpt-oss-120b"}}', f'{BASE}/api/lead'); check('P1-1 合格模型设为主负责人 → 200', c == 200, b[:120])
curl(*COOK, *JS, '-d', '{"capability_status":"pending"}', f'{BASE}/api/member/llama-4-scout-17b/caps')
c, b = curl(*AUTH, f'{BASE}/api/lead'); LI = J(b)
check('P1-1 现任变不合格：不静默替换（p 不变）、给出通知并提示由副负责人按接任规则临时派工', (LI.get('p') or {}).get('id') == 'llama-4-scout-17b' and (LI.get('eligibility', {}).get('p') or {}).get('eligible') is False and any('副负责人' in n and '决定' in n for n in LI.get('notices', [])), json.dumps(LI.get('notices'), ensure_ascii=False)[:240])
c, b = curl(*AUTH, f'{BASE}/api/lead/candidates'); check('P1-1 变 pending 后从候选里消失', 'llama-4-scout-17b' not in [x['id'] for x in J(b).get('candidates', [])], '')
curl(*COOK, *JS, '-d', '{"reset":true}', f'{BASE}/api/member/llama-4-scout-17b/caps')
curl(*COOK, *JS, '-d', json.dumps({'p': L0.get('p'), 's': L0.get('s')}) if not (L0.get('p') or {}).get('type') == 'custom' else '{"p":null,"s":null}', f'{BASE}/api/lead')
# P1-1 fix1：保留前缀 / paired 字段 / 撤下自建负责人不误删 / 用户改 base 清 Key
c, b = curl(*COOK, *JS, '-d', '{"id":"x-agent-evil","conn":"openai","name":"EvilModel","url":"https://example.com/v1","model":"tiny-1b","secret":"AGENT_TEST_KEY"}', f'{BASE}/api/agents')
CE = [x['id'] for x in J(curl(*AUTH, f'{BASE}/api/lead/candidates')[1]).get('candidates', [])]
check('P1-1 fix：自建成员用 x-agent- 前缀 → 400，且不出现在负责人候选里', c == 400 and 'x-agent-evil' not in CE, f'{c} {b[:120]}')
c, b = curl(*COOK, *JS, '-d', '{"id":"x-hark-evil","conn":"webhook","name":"EvilHook","url":"https://example.com/hook"}', f'{BASE}/api/agents'); check('P1-1 fix：自建成员用 x-hark- 前缀 → 400', c == 400, f'{c} {b[:120]}')
c, b = curl(*COOK, *JS, '-d', '{"id":"x-p1plain","conn":"openai","name":"PlainModel","url":"https://example.com/v1","model":"tiny-1b","secret":"AGENT_TEST_KEY","paired":true}', f'{BASE}/api/agents')
CP = J(curl(*AUTH, f'{BASE}/api/lead/candidates')[1]); inel = {x['id']: x for x in CP.get('ineligible', [])}
check('P1-1 fix：请求体里的 paired 字段被忽略（自建模型成员仍按能力规则判不合格）', c == 200 and 'x-p1plain' in inel and inel['x-p1plain']['kind'] == 'model', f'{c} {inel.get("x-p1plain")}')
curl(*AUTH, '-X', 'DELETE', f'{BASE}/api/agents/x-p1plain')
c, b = curl(*COOK, *JS, '-d', '{"id":"x-p1hook","conn":"webhook","name":"P1Hook","url":"https://example.com/hook"}', f'{BASE}/api/agents'); c1 = c
c, b = curl(*COOK, *JS, '-d', '{"s":{"type":"member","id":"x-p1hook"}}', f'{BASE}/api/lead'); c2 = c
c, b = curl(*COOK, *JS, '-d', '{"s":null}', f'{BASE}/api/lead'); c3, _ = curl(*AUTH, f'{BASE}/api/member/x-p1hook')
check('P1-1 fix：撤下自建成员（负责人）后，该成员仍然存在', c1 == 200 and c2 == 200 and c == 200 and c3 == 200, f'{c1} {c2} {c} {c3}')
curl(*AUTH, '-X', 'DELETE', f'{BASE}/api/agents/x-p1hook')
c, b = curl(*COOK, *JS, '-d', '{"s":{"type":"custom","base":"https://lead-b.example.com/v1","model":"m-b","key":"kkkkkkkkkkkk5678"}}', f'{BASE}/api/lead'); k1 = (J(curl(*AUTH, f'{BASE}/api/lead')[1]).get('s') or {}).get('keyLast4')
c, b = curl(*COOK, *JS, '-d', '{"s":{"type":"custom","base":"https://lead-c.example.com/v1","model":"m-b"}}', f'{BASE}/api/lead'); RB = J(b); k2 = (J(curl(*AUTH, f'{BASE}/api/lead')[1]).get('s') or {}).get('keyLast4')
check('P1-1 fix：用户改 base 不给新 Key → 旧 Key 被清空并提示重新填写', k1 == '5678' and c == 200 and k2 == '' and 'Key' in (RB.get('notice') or ''), f'{k1} {c} {k2} {RB.get("notice")}')
c, b = curl(*COOK, *JS, '-d', '{"s":{"type":"custom","base":"https://lead-c.example.com/v1","model":"m-b","key":"kkkkkkkkkkkk9999"}}', f'{BASE}/api/lead'); c2, b2 = curl(*COOK, *JS, '-d', '{"s":{"type":"custom","base":"https://lead-c.example.com/v1","model":"m-b2"}}', f'{BASE}/api/lead'); k3 = (J(curl(*AUTH, f'{BASE}/api/lead')[1]).get('s') or {}).get('keyLast4')
check('P1-1 fix：用户只改模型名（base 不变）→ Key 保留', c == 200 and c2 == 200 and k3 == '9999', f'{c} {c2} {k3}')
curl(*COOK, *JS, '-d', '{"s":null}', f'{BASE}/api/lead')
# 配对码生成不调用任何模型：生成前后所有来源的今日调用次数不变
def _calls(): return sum((sv.get('quota') or {}).get('used_today', 0) or 0 for m in J(curl(*AUTH, f'{BASE}/api/members')[1]).get('members', []) for sv in m.get('sources', []))
n0 = _calls(); c, b = curl(*COOK, *JS, '-d', '{"slot":"s"}', f'{BASE}/api/pair/new'); n1 = _calls()
check('P1-1 生成配对码不调用任何模型（今日调用数不变）', c == 200 and J(b).get('code') and n0 == n1, f'{n0}->{n1}')
# /v1/models 同步：不建成员卡；归一化去重；已有模型只补来源
nm0 = len(J(curl(*AUTH, f'{BASE}/api/members')[1]).get('members', []))
c, b = curl(*COOK, *JS, '-d', json.dumps({'relay': 'relay-vyce', 'models': ['deepseek-ai/DeepSeek-V4.1-Flash', 'deepseek-v4.1-flash:free', 'p1test/Brand-New-Model-X', 'brand_new_model_x', 'brand-new-model-x-instruct']}), f'{BASE}/api/models/sync'); SY = J(b)
PO = J(curl(*AUTH, f'{BASE}/api/models/pool')[1]); bn = [x for x in PO.get('pool', []) if x['norm'] == 'brand-new-model-x']
check('P1-1 同步：新模型进候选池且归一化去重（3 种写法 → 1 条）', c == 200 and len(bn) == 1 and SY.get('added') == ['brand-new-model-x'], b[:200])
check('P1-1 同步：已有模型（deepseek-ai/DeepSeek-V4.1-Flash == deepseek-v4.1-flash）只补来源、不进候选池', any(x['member'] == 'deepseek-v4.1-flash' for x in SY.get('merged', [])) and not [x for x in PO.get('pool', []) if x['norm'] == 'deepseek-v4.1-flash'], SY.get('merged'))
MB = J(curl(*AUTH, f'{BASE}/api/members')[1]); check('P1-1 同步不建成员卡（成员数不变）', len(MB.get('members', [])) == nm0, f"{nm0}->{len(MB.get('members', []))}")
c, b = curl(*AUTH, *JS, '-d', '{"norm":"brand-new-model-x"}', f'{BASE}/api/models/pool/confirm'); check('P1-1 Bearer 不能确认候选 → 403', c == 403, c)
c, b = curl(*COOK, *JS, '-d', '{"norm":"brand-new-model-x"}', f'{BASE}/api/models/pool/confirm'); nid2 = J(b).get('id', '')
c2, b2 = curl(*AUTH, f'{BASE}/api/member/{nid2}'); MV = J(b2)
check('P1-1 用户确认后才成为成员，能力 pending、不能当负责人', c == 200 and c2 == 200 and MV.get('caps', {}).get('capability_status') == 'pending' and MV.get('leadElig', {}).get('eligible') is False, b2[:200])
check('P1-1 fix：候选池确认的成员 id 以 pool- 开头（确定性，不含随机数）', nid2 == 'pool-brand-new-model-x', nid2)
c, b = curl(*AUTH, '-X', 'DELETE', f'{BASE}/api/agents/{nid2}'); c2, _ = curl(*AUTH, f'{BASE}/api/member/{nid2}')
check('P1-1 fix：候选池确认的 pool- 成员可以删除（删后 404，不留测试数据）', c == 200 and c2 == 404, f'{c} {c2}')

c, b = curl(*COOK, *JS, '-d', json.dumps({'relay': 'relay-vyce', 'models': ['gpt-oss-120b-preview', 'p1t/Foo-Model-X', 'p1t/foo-model-x-latest']}), f'{BASE}/api/models/sync'); SP = J(b)
check('P1-1 fix：normModel 不去 -preview / -latest（preview 不并进正式版成员，-latest 单独一条）', c == 200 and 'gpt-oss-120b-preview' in SP.get('added', []) and not any(x['member'] == 'gpt-oss-120b' for x in SP.get('merged', [])) and {'foo-model-x', 'foo-model-x-latest'} <= set(SP.get('added', [])), b[:240])
curl(*COOK, *JS, '-d', json.dumps({'relay': 'relay-vyce', 'models': ['p1t/Dismiss-Me-X']}), f'{BASE}/api/models/sync')
c, b = curl(*COOK, *JS, '-d', '{"norm":"dismiss-me-x"}', f'{BASE}/api/models/pool/dismiss')
c1, b1 = curl(*COOK, *JS, '-d', json.dumps({'relay': 'relay-vyce', 'models': ['p1t/Dismiss-Me-X']}), f'{BASE}/api/models/sync')
c2, b2 = curl(*COOK, *JS, '-d', json.dumps({'relay': 'relay-pm', 'models': ['other/dismiss-me-x']}), f'{BASE}/api/models/sync')
check('P1-1 fix：dismissed 按「中转站 + 原名」记录（同站同名不再出现，别的中转站的同名模型仍进候选池）', c == 200 and J(b1).get('added') == [] and J(b2).get('added') == ['dismiss-me-x'], f'{c} {b1[:100]} {b2[:100]}')
# ── P1-2 网页成员（代发）：代发员登记 → 网页成员建卡 → 派活进 kind=web 队列 → 代发员领取（完整提示）→ 回传标「经代发」→ 超时改派 → 会话复用 → 仅客户端型要用户同意 → 签到 ──
rtok = lambda rid_: hmac.new(TOKEN.encode(), ('relay:' + rid_).encode(), hashlib.sha256).hexdigest()[:40]
RH = lambda rid_: ['-H', f'Authorization: Bearer {rtok(rid_)}']
c, b = curl(*AUTH, *JS, '-d', '{"id":"r-t-bearer","name":"x","kind":"hark"}', f'{BASE}/api/relays'); check('P1-2 Bearer 不能登记代发员 → 403', c == 403, c)
c, b = curl(*COOK, *JS, '-d', '{"id":"r-t-h1","name":"测试代发甲","kind":"hark"}', f'{BASE}/api/relays'); RL = J(b)
check('P1-2 网页登记代发员（Hark 远程浏览器）→ 200，返回代发员令牌', c == 200 and RL.get('token') == rtok('r-t-h1'), b[:100])
c, b = curl(*COOK, *JS, '-d', '{"id":"r-t-h2","name":"测试代发乙","kind":"hark"}', f'{BASE}/api/relays')
c2, b2 = curl(*COOK, *JS, '-d', '{"id":"r-t-d1","name":"测试桌面桥","kind":"desktop","consent":false}', f'{BASE}/api/relays')
check('P1-2 再登记一个 Hark 代发员 + 一个未同意的桌面桥接', c == 200 and c2 == 200, f'{c} {c2}')
c, b = curl(*COOK, *JS, '-d', json.dumps({'id': 'x-webt', 'conn': 'web', 'name': '网页测试模型', 'site': 'https://chat.example.com/', 'checkin': True}), f'{BASE}/api/agents'); check('P1-2 添加网页成员（conn=web + 网址）→ 200', c == 200, b[:120])
c, b = curl(*COOK, *JS, '-d', json.dumps({'id': 'x-webbad', 'conn': 'web', 'name': '坏网址', 'site': 'http://127.0.0.1/'}), f'{BASE}/api/agents'); check('P1-2 网页成员网址只收公网 https → 400', c == 400, b[:120])
MB = J(curl(*AUTH, f'{BASE}/api/members')[1]); WM = next((m for m in MB.get('members', []) if m['id'] == 'x-webt'), {})
check('P1-2 网页成员出现在成员列表：caps.web=true、不能当负责人、来源写明「经代发」', WM.get('caps', {}).get('web') is True and WM.get('leadElig', {}).get('eligible') is False and any('代发' in (x.get('via') or '') for x in WM.get('sources', [])), {k: WM.get(k) for k in ('state', 'why')})
check('P1-2 gpt-image-2.5 走网页代发队列（kind=web）', any(x.get('kind') == 'web' for m in MB.get('members', []) if m['id'] == 'gpt-image-2.5' for x in m.get('sources', [])), '')
LC2 = J(curl(*AUTH, f'{BASE}/api/lead/candidates')[1]); check('P1-2 网页成员不在负责人候选里', 'x-webt' not in [x['id'] for x in LC2.get('candidates', [])], '')
c, b = curl(*COOK, *JS, '-d', '{"s":{"type":"member","id":"x-webt"}}', f'{BASE}/api/lead'); check('P1-2 网页成员设为负责人 → 400 网页成员', c == 400 and '网页成员' in b, b[:120])
BRW = J(curl(*AUTH, f'{BASE}/api/lead/brief')[1]); bw = next((m for m in BRW.get('snapshot', {}).get('members', []) if m['id'] == 'x-webt'), {})
check('P1-2 负责人视图（brief）里有网页成员并标 web=true、经代发', bw.get('web') is True and '代发' in (bw.get('via') or ''), bw)
c, b = curl('-H', 'Authorization: Bearer ' + 'f' * 40, f'{BASE}/bridge/web/pull?relay=r-t-h1'); check('P1-2 代发员错令牌 → 401', c == 401, c)
c, b = curl(*RH('r-t-h1'), f'{BASE}/bridge/web/pull?relay=r-t-h1'); P0 = J(b); check('P1-2 代发员拉取 200（上线）', c == 200 and isinstance(P0.get('tasks'), list), b[:120])
check('P1-2 签到也由代发员执行：拉取结果里列出今天要签到的网页成员', any(x.get('member') == 'x-webt' for x in P0.get('checkins', [])), P0.get('checkins'))
c, b = curl(*RH('r-t-h1'), *JS, '-d', json.dumps({'member': 'x-webt', 'ok': True, 'note': '已签到'}), f'{BASE}/bridge/web/checkin?relay=r-t-h1'); c2, b2 = curl(*RH('r-t-h1'), f'{BASE}/bridge/web/pull?relay=r-t-h1')
check('P1-2 签到回报 200，之后当天不再列出', c == 200 and not any(x.get('member') == 'x-webt' for x in J(b2).get('checkins', [])), f'{c} {b[:80]}')
_w2 = json.dumps({'id': 'x-webt2', 'conn': 'web', 'name': '网页签到复用测试', 'site': 'https://chat.example.com/', 'checkin': True}); curl(*COOK, *JS, '-d', _w2, f'{BASE}/api/agents')
curl(*RH('r-t-h1'), *JS, '-d', json.dumps({'member': 'x-webt2', 'ok': True}), f'{BASE}/bridge/web/checkin?relay=r-t-h1'); curl(*COOK, '-X', 'DELETE', f'{BASE}/api/agents/x-webt2'); curl(*COOK, *JS, '-d', _w2, f'{BASE}/api/agents')
c, b = curl(*RH('r-t-h1'), f'{BASE}/bridge/web/pull?relay=r-t-h1'); curl(*COOK, '-X', 'DELETE', f'{BASE}/api/agents/x-webt2')
check('P1-2 删掉再新建同 id 的网页成员：不继承旧的「今天已签到」，重新列出', any(x.get('member') == 'x-webt2' for x in J(b).get('checkins', [])), J(b).get('checkins'))
MB = J(curl(*AUTH, f'{BASE}/api/members')[1]); WM = next((m for m in MB.get('members', []) if m['id'] == 'x-webt'), {}); check('P1-2 有代发员在线 → 网页成员在线', WM.get('state') == 'ok' and '代发员' in (WM.get('why') or ''), WM.get('why'))
c, b = curl(*AUTH, *JS, '-d', json.dumps({'message': '网页成员链路测试：请评价这个点子', 'members': [{'id': 'x-webt', 'role': '审查员'}]}), f'{BASE}/api/start'); wroom = J(b).get('room')
c, b = curl(*AUTH, *JS, '-d', json.dumps({'room': wroom, 'member': 'x-webt'}), f'{BASE}/api/turn'); WT = J(b)
check('P1-2 派活 → 进代发队列（pending，提示等代发员）', c == 200 and WT.get('pending') and '代发' in (WT.get('notice') or ''), b[:160])
c, b = curl('-H', f'Authorization: Bearer {mtok("x-webt")}', f'{BASE}/bridge/pull?member=x-webt'); check('P1-2 复审修复：成员令牌的小桥拉取拿不到网页任务（网页任务只走代发员队列）', c == 200 and not any(x.get('task') == WT.get('task') for x in J(b).get('tasks', [])), b[:100])
c, b = curl(*RH('r-t-d1'), f'{BASE}/bridge/web/pull?relay=r-t-d1'); c2, b2 = curl(*RH('r-t-h1'), f'{BASE}/bridge/web/pull?relay=r-t-h1'); PT = J(b2).get('tasks', [])
tk1 = next((x for x in PT if x.get('task') == WT.get('task')), {})
check('P1-2 代发员领到任务：完整提示含前情/角色/输出格式，不含产品名和回调地址', bool(tk1) and all(k in tk1.get('prompt', '') for k in ('【前情】', '网页成员链路测试', '审查员', '【输出格式】')) and 'Aroomo' not in tk1.get('prompt', '') and '/hook/' not in tk1.get('prompt', '') and tk1.get('site') == 'https://chat.example.com/', {k: tk1.get(k) for k in ('task', 'site', 'session')})
check('P1-2 未同意的桌面桥接领不到任何任务；同一任务不会同时派给两个代发员', not any(x.get('task') == WT.get('task') for x in J(b).get('tasks', [])), '')
c, b = curl(*RH('r-t-h2'), *JS, '-d', json.dumps({'task': WT.get('task'), 'text': '抢答'}), f'{BASE}/bridge/web/reply'); check('P1-2 非领取者回传被拒（401 令牌不是领取者 / 409）', c in (401, 409), f'{c} {b[:80]}')
c, b = curl(*COOK, *JS, '-d', json.dumps({'advanceMs': 11 * 60000}), f'{BASE}/api/testmode/websweep'); SW = J(b)
check('P1-2 超时 10 分钟自动改派（测试模式里快进时间）', c == 200 and any(x.get('id') == WT.get('task') and x.get('action') == 'requeue' for x in SW.get('plan', [])), b[:200])
RM = J(curl(*AUTH, f'{BASE}/api/room/{wroom}')[1]); check('P1-2 改派写进房间提示（不静默）', any('改派' in (m.get('text') or '') for m in RM.get('messages', [])), [m.get('text', '')[:30] for m in RM.get('messages', [])][-3:])
c, b = curl(*RH('r-t-h1'), f'{BASE}/bridge/web/pull?relay=r-t-h1'); c2, b2 = curl(*RH('r-t-h2'), f'{BASE}/bridge/web/pull?relay=r-t-h2')
check('P1-2 改派后：超时的代发员领不到，另一位在线代发员领到', not any(x.get('task') == WT.get('task') for x in J(b).get('tasks', [])) and any(x.get('task') == WT.get('task') for x in J(b2).get('tasks', [])), '')
c, b = curl(*RH('r-t-h2'), *JS, '-d', json.dumps({'task': WT.get('task'), 'text': '网页模型的回复：这个点子可行', 'session': 'https://chat.example.com/c/abc123'}), f'{BASE}/bridge/web/reply'); check('P1-2 代发员回传 200', c == 200, b[:100])
c, b = curl(*RH('r-t-h2'), *JS, '-d', json.dumps({'task': WT.get('task'), 'text': '重复'}), f'{BASE}/bridge/web/reply'); check('P1-2 重复回传 → 409', c == 409, c)
RM = J(curl(*AUTH, f'{BASE}/api/room/{wroom}')[1]); wm_ = next((m for m in RM.get('messages', []) if m.get('text') == '网页模型的回复：这个点子可行'), {})
check('P1-2 回复进群聊并标「经代发」', wm_.get('member') == 'x-webt' and '经代发' in (wm_.get('model') or ''), wm_)
c, b = curl(*AUTH, *JS, '-d', json.dumps({'room': wroom, 'member': 'x-webt'}), f'{BASE}/api/turn'); WT2 = J(b)
c, b = curl(*RH('r-t-h1'), f'{BASE}/bridge/web/pull?relay=r-t-h1'); c2, b2 = curl(*RH('r-t-h2'), f'{BASE}/bridge/web/pull?relay=r-t-h2'); tk2 = next((x for x in J(b2).get('tasks', []) if x.get('task') == WT2.get('task')), {})
check('P1-2 同一项目复用同一网页会话（同一代发员 + 会话链接）', not any(x.get('task') == WT2.get('task') for x in J(b).get('tasks', [])) and tk2.get('session') == 'https://chat.example.com/c/abc123', {'h1': len(J(b).get('tasks', [])), 'tk2': tk2.get('session')})
curl(*RH('r-t-h2'), *JS, '-d', json.dumps({'task': WT2.get('task'), 'text': '第二次回复'}), f'{BASE}/bridge/web/reply')
c, b = curl(*AUTH, *JS, '-d', json.dumps({'message': '敏感网页测试', 'members': [{'id': 'x-webt', 'role': '审查员'}], 'sensitive': True}), f'{BASE}/api/start'); sroom = J(b).get('room')
c, b = curl(*AUTH, *JS, '-d', json.dumps({'room': sroom, 'member': 'x-webt'}), f'{BASE}/api/turn'); ST_ = J(b)
check('P1-2 复审修复：敏感项目不发给网页成员（第三方网页），写明原因、不排队', not ST_.get('pending') and ('网页' in json.dumps(ST_, ensure_ascii=False) or ST_.get('replaced')), b[:200])
curl(*AUTH, '-X', 'DELETE', f'{BASE}/api/room/{sroom}')
c, b = curl(*COOK, *JS, '-d', json.dumps({'id': 'x-webcli', 'conn': 'web', 'name': '仅客户端测试', 'site': 'https://client.example.com/', 'client': True}), f'{BASE}/api/agents'); check('P1-2 添加仅客户端型网页成员', c == 200, b[:100])
c, b = curl(*AUTH, *JS, '-d', json.dumps({'message': '仅客户端链路', 'members': [{'id': 'x-webcli', 'role': '审查员'}]}), f'{BASE}/api/start'); croom = J(b).get('room')
MB3 = J(curl(*AUTH, f'{BASE}/api/members')[1]); WC = next((m for m in MB3.get('members', []) if m['id'] == 'x-webcli'), {})
check('P1-2 仅客户端型：没有你同意过的桌面桥接时显示离线并写明原因（不会派给 Hark 远程浏览器）', WC.get('state') == 'down' and '同意' in (WC.get('why') or ''), WC.get('why'))
c, b = curl(*AUTH, *JS, '-d', '{"id":"r-t-d1","consent":true}', f'{BASE}/api/relays/consent'); check('P1-2 同意操作电脑只能在网页里点（Bearer → 403）', c == 403, c)
c, b = curl(*COOK, *JS, '-d', '{"id":"r-t-d1","consent":true}', f'{BASE}/api/relays/consent'); curl(*RH('r-t-d1'), f'{BASE}/bridge/web/pull?relay=r-t-d1')
WT3 = J(curl(*AUTH, *JS, '-d', json.dumps({'room': croom, 'member': 'x-webcli'}), f'{BASE}/api/turn')[1])
ga = lambda r: any(x.get('task') == WT3.get('task') for x in J(curl(*RH(r), f'{BASE}/bridge/web/pull?relay={r}')[1]).get('tasks', []))
g1 = ga('r-t-h1'); g2 = ga('r-t-d1')
check('P1-2 用户在网页同意后：仅客户端型任务排队，Hark 远程浏览器领不到、桌面桥接领到', c == 200 and WT3.get('pending') and not g1 and g2, f'{c} {WT3.get("notice")} h1={g1} d1={g2}')
RLS = J(curl(*COOK, f'{BASE}/api/relays')[1]); check('P1-2 代发员列表（网页）显示类型/是否同意/最近在线', {'r-t-h1', 'r-t-h2', 'r-t-d1'} <= {x['id'] for x in RLS.get('relays', [])} and next(x for x in RLS['relays'] if x['id'] == 'r-t-d1').get('consent') is True, [x.get('id') for x in RLS.get('relays', [])])
c, b = curl(*AUTH, f'{BASE}/api/relays'); check('P1-2 Bearer 读代发员列表不含令牌', c == 200 and 'token' not in b, b[:80])
for r_ in (wroom, croom): curl(*AUTH, '-X', 'DELETE', f'{BASE}/api/room/{r_}')
for a_ in ('x-webt', 'x-webcli'): curl(*AUTH, '-X', 'DELETE', f'{BASE}/api/agents/{a_}')
cs = [curl(*COOK, '-X', 'DELETE', f'{BASE}/api/relays/{r_}')[0] for r_ in ('r-t-h1', 'r-t-h2', 'r-t-d1')]
c, b = curl(*RH('r-t-h1'), f'{BASE}/bridge/web/pull?relay=r-t-h1'); check('P1-2 清理：测试代发员已删（令牌失效 401）、测试成员与房间已删', cs == [200, 200, 200] and c == 401 and curl(*AUTH, f'{BASE}/api/member/x-webt')[0] == 404, f'{cs} {c}')

# ── P1-3 点子库：点子与项目分开；预填 6 个；新建项目可关联；关联后背景注入所有成员上下文；项目结论可回写点子 ──
c, b = curl(*AUTH, f'{BASE}/api/ideas'); ID0 = J(b); ids0 = [x['id'] for x in ID0.get('ideas', [])]
check('P1-3 点子库可读，预填 6 个（老照片/提示词/古风/激光/新词/pcmanai）', c == 200 and {'seed-photo', 'seed-prompt', 'seed-guofeng', 'seed-laser', 'seed-newterm', 'seed-pcman'} <= set(ids0) and ID0.get('statuses') == ['正在做', '暂时收藏', '已放弃'], ids0[:8])
c, b = curl(*AUTH, f'{BASE}/api/rooms'); check('P1-3 点子不是项目（项目列表里没有点子）', not any((r.get('title') or '') == '老照片修复定制服务' for r in J(b).get('rooms', [])), '')
c, b = curl(*COOK, *JS, '-d', json.dumps({'title': '测试点子 P13', 'thought': '当时的想法：测试注入', 'plan': '计划形式甲', 'expect': '预期效果乙', 'summary': '沟通摘要丙', 'source': '测试', 'tags': ['测试'], 'status': '进行中'}), f'{BASE}/api/ideas'); check('P1-3 状态只能 正在做/暂时收藏/已放弃 → 400', c == 400, b[:100])
c, b = curl(*COOK, *JS, '-d', json.dumps({'title': '测试点子 P13', 'thought': '当时的想法：测试注入 ZQX', 'plan': '计划形式甲', 'expect': '预期效果乙', 'summary': '沟通摘要丙', 'source': '测试', 'tags': ['测试'], 'status': '暂时收藏'}), f'{BASE}/api/ideas'); tid = J(b).get('id', '')
check('P1-3 新建点子 → 200（含当时想法/计划/预期/摘要/来源/标签/状态）', c == 200 and tid, b[:100])
c, b = curl(*COOK, *JS, '-d', json.dumps({'id': tid, 'status': '正在做'}), f'{BASE}/api/ideas'); IT = J(curl(*AUTH, f'{BASE}/api/idea/{tid}')[1])
check('P1-3 改状态（暂时收藏 → 正在做），其他字段保留', c == 200 and IT.get('status') == '正在做' and IT.get('plan') == '计划形式甲', {k: IT.get(k) for k in ('status', 'plan')})
curl(*COOK, *JS, '-d', '{"id":"x-p13","conn":"bridge","name":"点子测试小桥"}', f'{BASE}/api/agents')
c, b = curl(*AUTH, *JS, '-d', json.dumps({'message': '点子关联测试：怎么推进', 'idea': tid, 'members': [{'id': 'x-p13', 'role': '审查员'}]}), f'{BASE}/api/start'); iroom = J(b).get('room')
RI = J(curl(*AUTH, f'{BASE}/api/room/{iroom}')[1]); check('P1-3 新建项目关联点子：房间带 idea（名字/状态）', (RI.get('idea') or {}).get('id') == tid and (RI.get('idea') or {}).get('title') == '测试点子 P13', RI.get('idea'))
curl('-H', f'Authorization: Bearer {mtok("x-p13")}', f'{BASE}/bridge/pull?member=x-p13')
T13 = J(curl(*AUTH, *JS, '-d', json.dumps({'room': iroom, 'member': 'x-p13'}), f'{BASE}/api/turn')[1])
PL = J(curl('-H', f'Authorization: Bearer {mtok("x-p13")}', f'{BASE}/bridge/pull?member=x-p13')[1]); pr = next((x.get('prompt', '') for x in PL.get('tasks', []) if x.get('task') == T13.get('task')), '')
check('P1-3 关联后点子背景注入成员上下文（想法/计划/预期都在派给成员的提示里）', all(k in pr for k in ('测试点子 P13', '测试注入 ZQX', '计划形式甲', '预期效果乙')), pr[:160])
c, b = curl(*AUTH, *JS, '-d', json.dumps({'room': iroom, 'text': '结论：先做 3 个样例再定价'}), f'{BASE}/api/idea/{tid}/writeback'); IT = J(curl(*AUTH, f'{BASE}/api/idea/{tid}')[1])
check('P1-3 项目结论回写点子（点子详情里有结论和来源项目）、点子详情列出关联项目', c == 200 and any('先做 3 个样例' in (n.get('text') or '') and n.get('room') == iroom for n in IT.get('notes', [])) and any(r.get('id') == iroom for r in IT.get('rooms', [])), b[:120])
c, b = curl(*AUTH, *JS, '-d', json.dumps({'room': 'aaaaaaaaaa', 'text': 'x'}), f'{BASE}/api/idea/{tid}/writeback'); check('P1-3 没关联这个点子的项目不能回写 → 4xx', 400 <= c < 500, c)
c, b = curl(*AUTH, *JS, '-d', json.dumps({'message': '坏点子关联', 'idea': 'no-such-idea'}), f'{BASE}/api/start'); check('P1-3 关联不存在的点子 → 400', c == 400, b[:100])
c, b = curl(*AUTH, '-X', 'DELETE', f'{BASE}/api/idea/{tid}'); check('P1-3 删点子只能在网页里（Bearer → 403）', c == 403, c)
curl('-H', f'Authorization: Bearer {mtok("x-p13")}', *JS, '-d', json.dumps({'task': T13.get('task'), 'text': 'ok'}), f'{BASE}/hook/reply')
curl(*AUTH, '-X', 'DELETE', f'{BASE}/api/room/{iroom}'); curl(*AUTH, '-X', 'DELETE', f'{BASE}/api/agents/x-p13')
IT = J(curl(*AUTH, f'{BASE}/api/idea/{tid}')[1]); IL = next((x for x in J(curl(*AUTH, f'{BASE}/api/ideas')[1]).get('ideas', []) if x.get('id') == tid), {})
check('P1-3 删项目不留孤儿关联：点子详情不再列出已删项目、点子列表项目数归 0、回写的结论保留为历史', not any(r.get('id') == iroom for r in IT.get('rooms', [])) and not IL.get('projects') and any(n.get('room') == iroom for n in IT.get('notes', [])), {'rooms': len(IT.get('rooms', [])), 'projects': IL.get('projects'), 'notes': len(IT.get('notes', []))})
c, b = curl(*COOK, '-X', 'DELETE', f'{BASE}/api/idea/{tid}'); c2 = curl(*AUTH, f'{BASE}/api/idea/{tid}')[0]; check('P1-3 清理：测试点子已删（删后 404），预填点子还在', c == 200 and c2 == 404 and 'seed-photo' in [x['id'] for x in J(curl(*AUTH, f'{BASE}/api/ideas')[1]).get('ideas', [])], f'{c} {c2}')

# ── P1-4 主持模式 + 快速建项目（全员加入）+ @ 点名 + 暂停/继续（N2）+ 消息内决策按钮（N3，幂等）+ 模式说明（L7）──
MB4 = J(curl(*AUTH, f'{BASE}/api/members')[1])
check('P1-4 模式里有「主持」，并带每个模式一句说明（主持：主持人决定谁说话，你随时可暂停）', (MB4.get('modes') or {}).get('host') == '主持' and '主持人决定谁说话' in ((MB4.get('modeInfo') or {}).get('host') or '') and all((MB4.get('modeInfo') or {}).get(k) for k in ('debate', 'review', 'free', 'task')), {'modes': MB4.get('modes'), 'info': MB4.get('modeInfo')})
exp4 = [m['id'] for m in MB4.get('members', []) if not m.get('lead') and not m.get('steward') and not m.get('retired') and not m.get('leadOnly') and m.get('state') != 'down' and m['id'] != 'hark' and not m['id'].startswith('lead-')][:20]
c, b = curl(*AUTH, *JS, '-d', json.dumps({'message': '快速项目测试 P14：各位怎么看', 'quick': True}), f'{BASE}/api/start'); Q4 = J(b); qroom = Q4.get('room', '')
RQ = J(curl(*AUTH, f'{BASE}/api/room/{qroom}')[1]); ros = [x['id'] for x in RQ.get('lineup', [])]
check('P1-4 快速建项目：不用选成员，全员加入（排除负责人/资源管家/退役/离线），角色「成员」，模式=主持', c == 200 and RQ.get('mode') == 'host' and sorted(ros) == sorted(exp4) and all(x.get('role') == '成员' for x in RQ.get('lineup', [])), {'c': c, 'mode': RQ.get('mode'), 'n': len(ros), 'exp': len(exp4)})
sp = [x['id'] for x in Q4.get('lineup', [])]
check('P1-4 主持模式：本轮只由主持人点名 1–3 位（都在项目里），房间里有「主持人点名」说明', 1 <= len(sp) <= 3 and set(sp) <= set(ros) and any('主持人点名' in (m.get('text') or '') for m in RQ.get('messages', [])), {'sp': sp, 'msgs': [m.get('text', '')[:40] for m in RQ.get('messages', [])]})
tgt = next((m for m in MB4.get('members', []) if m['id'] == (ros[-1] if ros else '')), {})
c, b = curl(*AUTH, *JS, '-d', json.dumps({'room': qroom, 'message': f"@{tgt.get('name', '')} 请你一个人回答这个"}), f'{BASE}/api/start'); M4 = J(b)
RQ = J(curl(*AUTH, f'{BASE}/api/room/{qroom}')[1])
check('P1-4 用户 @ 指定成员：本轮只请被点名的这位发言，房间里写明「你点名了」', c == 200 and [x['id'] for x in M4.get('lineup', [])] == [tgt.get('id')] and any('你点名了' in (m.get('text') or '') for m in RQ.get('messages', [])), {'lineup': M4.get('lineup'), 'name': tgt.get('name')})
c, b = curl(*AUTH, *JS, '-d', '{"paused":true}', f'{BASE}/api/room/{qroom}/pause'); RQ = J(curl(*AUTH, f'{BASE}/api/room/{qroom}')[1]); n0 = len(RQ.get('messages', []))
check('P1-4 暂停：POST pause → 200，房间显示已暂停', c == 200 and RQ.get('paused') is True, b[:100])
c, b = curl(*AUTH, *JS, '-d', json.dumps({'room': qroom, 'member': tgt.get('id')}), f'{BASE}/api/turn'); T4 = J(b); RQ = J(curl(*AUTH, f'{BASE}/api/room/{qroom}')[1])
check('P1-4 暂停后下一位不启动：turn 返回 paused、不调模型、不新增发言', T4.get('paused') is True and T4.get('skipped') is True and len(RQ.get('messages', [])) == n0, {'t': T4, 'n': [n0, len(RQ.get('messages', []))]})
c, b = curl(*AUTH, *JS, '-d', '{"paused":false}', f'{BASE}/api/room/{qroom}/pause'); RQ = J(curl(*AUTH, f'{BASE}/api/room/{qroom}')[1])
check('P1-4 继续：POST pause=false → 房间不再暂停', c == 200 and RQ.get('paused') is False, b[:100])
curl(*AUTH, *JS, '-d', '{"paused":true}', f'{BASE}/api/room/{qroom}/pause'); curl(*AUTH, *JS, '-d', json.dumps({'room': qroom, 'message': '新的一句话会自动继续'}), f'{BASE}/api/start')
check('P1-4 用户发新消息自动解除暂停', J(curl(*AUTH, f'{BASE}/api/room/{qroom}')[1]).get('paused') is False, '')
curl(*AUTH, *JS, '-d', '{"paused":true}', f'{BASE}/api/room/{qroom}/pause'); curl(*AUTH, *JS, '-d', json.dumps({'room': qroom}), f'{BASE}/api/start')
check('P1-4 点「再来一轮」（不带新消息）也解除暂停', J(curl(*AUTH, f'{BASE}/api/room/{qroom}')[1]).get('paused') is False, '')
c, b = curl(*AUTH, *JS, '-d', json.dumps({'question': '要付费买这个吗？', 'options': ['同意']}), f'{BASE}/api/room/{qroom}/ask'); check('P1-4 决策题只有 1 个选项 → 400', c == 400, b[:100])
c, b = curl(*AUTH, *JS, '-d', json.dumps({'question': '要付费买这个吗？ P14', 'options': ['同意', '不同意', '先给我看看']}), f'{BASE}/api/room/{qroom}/ask'); dmid = J(b).get('msg')
RQ = J(curl(*AUTH, f'{BASE}/api/room/{qroom}')[1]); DM = next((m for m in RQ.get('messages', []) if m.get('id') == dmid), {})
check('P1-4 负责人发决策题 → 房间里出现决策消息（3 个选项，还没选）', c == 200 and DM.get('kind') == 'decision' and (DM.get('decision') or {}).get('options') == ['同意', '不同意', '先给我看看'] and (DM.get('decision') or {}).get('choice') is None, DM)
c, b = curl(*AUTH, *JS, '-d', json.dumps({'msg': dmid, 'choice': '随便'}), f'{BASE}/api/room/{qroom}/decide'); check('P1-4 选项外的答案 → 400', c == 400, b[:100])
curl(*COOK, *JS, '-d', '{"id":"x-p14","conn":"bridge","name":"决策测试小桥"}', f'{BASE}/api/agents')
c, b = curl('-H', f'Authorization: Bearer {mtok("x-p14")}', *JS, '-d', json.dumps({'msg': dmid, 'choice': '同意'}), f'{BASE}/api/room/{qroom}/decide'); check('P1-4 成员令牌不能替用户拍板 → 401/403', c in (401, 403), c)
curl(*AUTH, '-X', 'DELETE', f'{BASE}/api/agents/x-p14')
c, b = curl(*COOK, *JS, '-d', json.dumps({'msg': dmid, 'choice': '同意'}), f'{BASE}/api/room/{qroom}/decide'); D1 = J(b)
c2, b2 = curl(*COOK, *JS, '-d', json.dumps({'msg': dmid, 'choice': '不同意'}), f'{BASE}/api/room/{qroom}/decide'); D2 = J(b2)
RQ = J(curl(*AUTH, f'{BASE}/api/room/{qroom}')[1]); DM = next((m for m in RQ.get('messages', []) if m.get('id') == dmid), {})
check('P1-4 用户拍板 → 200；重复点（换答案）只记第一次（幂等，already=true）', c == 200 and D1.get('choice') == '同意' and c2 == 200 and D2.get('already') is True and D2.get('choice') == '同意' and (DM.get('decision') or {}).get('choice') == '同意' and (DM.get('decision') or {}).get('at'), {'d1': D1, 'd2': D2, 'dm': DM.get('decision')})
check('P1-4 拍板结果写进房间（负责人能看到「用户选择：同意」），只写一次', sum(1 for m in RQ.get('messages', []) if '用户选择：同意' in (m.get('text') or '')) == 1, '')
c, b = curl(*AUTH, *JS, '-d', '{"jsonrpc":"2.0","id":9,"method":"tools/list"}', f'{BASE}/mcp'); tn = [t['name'] for t in (J(b).get('result') or {}).get('tools', [])]
check('P1-4 MCP 有 ask_user（发决策题）和 pause_project（暂停/继续），create_project 支持 quick', 'ask_user' in tn and 'pause_project' in tn and 'quick' in json.dumps(next((t for t in (J(b).get('result') or {}).get('tools', []) if t['name'] == 'create_project'), {})), tn[-8:])
c, b = curl(*AUTH, '-X', 'DELETE', f'{BASE}/api/room/{qroom}'); check('P1-4 清理：测试项目已删', c == 200 and curl(*AUTH, f'{BASE}/api/room/{qroom}')[0] == 404, c)

# ── P1-6 Cloudflare 额度保险：用量显示 + 发件箱 cid 幂等 ──
c, b = curl(*AUTH, f'{BASE}/api/usage'); U0 = J(b)
check('P1-6 用量接口：今天 Worker 请求数、上限 100000、百分比、级别、UTC 0 点重置', c == 200 and U0.get('limit') == 100000 and isinstance(U0.get('requests'), int) and 0 <= U0.get('pct', -1) and U0.get('level') in ('ok', 'warn', 'over') and U0.get('warnAt') == 0.8 and 'UTC' in (U0.get('reset') or ''), b[:200])
for _ in range(30): curl(*AUTH, f'{BASE}/manifest.webmanifest')
c, b = curl(*AUTH, f'{BASE}/api/usage'); U1 = J(b)
check('P1-6 用量计数会增长（本站自己计数，约值）', U1.get('requests', 0) > U0.get('requests', 0), [U0.get('requests'), U1.get('requests')])
c, b = curl(f'{BASE}/api/usage'); check('P1-6 用量接口未登录 → 401', c == 401, c)
check('P1-6 fix1 用量接口同时给 Durable Object 请求数（免费 10 万次/天），按较高的算级别', isinstance((U1.get('do') or {}).get('requests'), int) and (U1.get('do') or {}).get('limit') == 100000 and U1.get('which') in ('Worker 请求', 'Durable Object 请求'), {k: U1.get(k) for k in ('do', 'which', 'pct')})
check('P1-6 fix1 一个请求只开一个 DO 会话：本实例 DO 会话数远少于 s.q 调用数', (U1.get('do') or {}).get('sessionsThisInstance', 0) > 0 and (U1.get('do') or {}).get('sessionsThisInstance', 0) * 3 <= (U1.get('do') or {}).get('callsThisInstance', 0), U1.get('do'))
import uuid as _uu
cid6 = 'p16-' + _uu.uuid4().hex[:20]
c, b = curl(*AUTH, *JS, '-d', json.dumps({'message': 'P1-6 发件箱幂等测试（自动删）', 'mode': 'free', 'members': [{'id': 'gpt-oss-120b', 'role': '审查员'}], 'cid': cid6}), f'{BASE}/api/start'); S6 = J(b); room6 = S6.get('room')
check('P1-6 带 cid 新建项目 → 200', c == 200 and bool(room6) and not S6.get('dup'), b[:160])
c, b = curl(*AUTH, *JS, '-d', json.dumps({'message': 'P1-6 发件箱幂等测试（自动删）', 'mode': 'free', 'members': [{'id': 'gpt-oss-120b', 'role': '审查员'}], 'cid': cid6}), f'{BASE}/api/start'); S6b = J(b)
check('P1-6 同一 cid 再发 → dup=true、返回同一项目，不新建', c == 200 and S6b.get('dup') is True and S6b.get('room') == room6, b[:160])
cids = ['p16-' + _uu.uuid4().hex[:20] for _ in range(3)]
for k, cc in enumerate(cids):
    for _ in range(2): curl(*AUTH, *JS, '-d', json.dumps({'room': room6, 'message': f'P1-6 补发第{k + 1}条', 'cid': cc}), f'{BASE}/api/start')
M6 = [m.get('text') for m in J(curl(*AUTH, f'{BASE}/api/room/{room6}')[1]).get('messages', []) if m.get('kind') == 'user']
check('P1-6 3 条消息各重发一次 → 每条恰好出现一次（服务端按 cid 幂等）', all(M6.count(f'P1-6 补发第{k + 1}条') == 1 for k in range(3)) and M6.count('P1-6 发件箱幂等测试（自动删）') == 1, M6)
c, b = curl(*AUTH, *JS, '-d', json.dumps({'room': room6, 'message': 'x', 'cid': 'bad cid!'}), f'{BASE}/api/start'); check('P1-6 cid 格式不对 → 400', c == 400, b[:100])
cfr = 'p16-failretry-' + _uu.uuid4().hex[:8]
c, b = curl(*AUTH, *JS, '-d', json.dumps({'room': 'zzzz99990000', 'message': 'P1-6 失败后重试', 'cid': cfr}), f'{BASE}/api/start'); c1 = c
c, b = curl(*AUTH, *JS, '-d', json.dumps({'room': room6, 'message': 'P1-6 失败后重试', 'cid': cfr}), f'{BASE}/api/start')
check('P1-6 失败的请求不占用 cid（4xx 后同一 cid 重试 → 正常写入、不是 dup）', c1 >= 400 and c == 200 and not J(b).get('dup'), [c1, c, b[:100]])
if room6: curl(*AUTH, '-X', 'DELETE', f'{BASE}/api/room/{room6}')
for _i in P15_IDS:
    if _i: curl(*COOK, '-X', 'DELETE', f'{BASE}/api/resources/item/{_i}')
_t.sleep(1)
check('P1-5 清理：代收测试条目已删', not [x for x in J(curl(*AUTH, f'{BASE}/api/resources')[1]).get('user', []) if x.get('id') in P15_IDS or P15M in (x.get('name') or '') + (x.get('via_note') or '') + (x.get('evidence') or '')], '')
# 收尾：关测试模式 → 删资源管家私聊里的测试消息、还原 kv
TE = _tm_end()
c, b = curl(*AUTH, f'{BASE}/api/room/steward'); left = [m for m in J(b).get('messages', []) if m.get('ts', 0) > _T0 and any(k in (m.get('text') or '') for k in ('测试甲', '测试乙', '测试丙', '每周汇总', '通知主负责人', '有没有免费配音'))]
check('测试结束：资源管家私聊里的测试消息已删除、负责人等设置已还原', TE.get('ok') and TE.get('purged', 0) >= 1 and not left and 'lead_cfg' in TE.get('restored', []), {'purged': TE.get('purged'), 'left': len(left)})
npass = sum(1 for _, ok in results if ok)
print(f'\n结果：{npass}/{len(results)} PASS  （BASE={BASE}{"，--no-ai" if NO_AI else ""}）')
sys.exit(0 if npass == len(results) else 1)
