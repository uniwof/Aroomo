#!/usr/bin/env python3
"""部署 AI 群聊 Worker「ai-groupchat」（v2：多模块 worker.js + members.json + logos.json + page.html）。
直接调 Cloudflare API（不需要 wrangler）。主账号 API 走 /workspace/work/vltest/cfapi.sh（自建 SOCKS；沙盒 HTTP 代理会替换 api.cloudflare.com 的 Authorization）。
先要启动 SOCKS：bash /workspace/rb/socks/socks_start.sh
用法：
  python3 deploy.py [all|upload|domain|cron]            # 主账号 tifni023，chat.pcmanai.com
  python3 deploy.py temp-up / temp-down                  # 独立账号 james.carter8742 上的临时副本 ai-groupchat-test（workers.dev），测完 down 删除
绑定：AI（Workers AI）、DB（SQLite 版 Durable Object ChatStore）、ACCESS_TOKEN（secret）、PUBLIC_ORIGIN（plain_text）。
外部 AI成员 的密钥：secrets 文件里出现下列字段就作为 secret_text 上传，没有就不绑（成员页显示「缺密钥：需在 secrets 文件加 XXX」）：
  GROQ_API_KEY NVIDIA_API_KEY GEMINI_API_KEY AGNES_API_KEY POKE_API_KEY HAPPYCODING_API_KEY VYCE_API_KEY PM_API_KEY
  TELEGRAM_BOT_TOKEN AGENT_MUSE_URL AGENT_MUSE_TOKEN 以及任意 AGENT_ 开头的字段（自定义外部成员用）。
令牌文件：/workspace/storage/secrets/ai-groupchat.json（600）。脚本不打印任何密钥值。
"""
import os, sys, json, secrets, subprocess, tempfile
ACC = '46166ff180d3b5542a1e79ca5ddd8d26'
ZONE = 'de5893f3140629977807d98b3ac767ac'
NAME = 'ai-groupchat'
HOST = 'chat.pcmanai.com'
API = 'https://api.cloudflare.com/client/v4'
CFAPI = '/workspace/work/vltest/cfapi.sh'
HERE = os.environ.get('AGC_SRC', '/workspace/projects-src/ai-groupchat')   # fix1：源码目录（含 caps.js）
SECRETS = '/workspace/storage/secrets/ai-groupchat.json'
# 独立账号（临时副本测试用）
T_ACC = '7ef18e421e8d1580dd184e9bb762519b'
T_NAME = 'ai-groupchat-test'
T_CFAPI = '/workspace/storage/沙盒节点测试/cf-gateway/cfnew.sh'
EXT_KEYS = ['GROQ_API_KEY', 'NVIDIA_API_KEY', 'GEMINI_API_KEY', 'AGNES_API_KEY', 'POKE_API_KEY', 'HAPPYCODING_API_KEY', 'VYCE_API_KEY', 'PM_API_KEY',
            'TELEGRAM_BOT_TOKEN']
CRON = '17 * * * *'  # 每小时探测一次（只调免费的 /models、计费、心跳接口）


def cf(*args, api=CFAPI):
    out = subprocess.run(['bash', api, *args], capture_output=True, text=True, timeout=120).stdout
    try:
        return json.loads(out)
    except Exception:
        print('RAW', out[:300]); raise


def load_secrets():
    if os.path.exists(SECRETS):
        return json.load(open(SECRETS))
    os.makedirs(os.path.dirname(SECRETS), exist_ok=True)
    d = {'worker': NAME, 'url': f'https://{HOST}/', 'ACCESS_TOKEN': secrets.token_urlsafe(32)}
    d['login_link'] = f"https://{HOST}/?k={d['ACCESS_TOKEN']}"
    old = os.umask(0o077)
    try:
        with open(SECRETS, 'w') as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
    finally:
        os.umask(old)
    os.chmod(SECRETS, 0o600)
    print('生成了新的访问令牌 →', SECRETS)
    return d


def migration_tag(acc, name, api):
    r = cf(f'{API}/accounts/{acc}/workers/scripts', api=api)
    for s in r.get('result') or []:
        if s.get('id') == name:
            return s.get('migration_tag'), True
    return None, False


def put_script(acc, name, api, token, origin, with_ext=True):
    sec = load_secrets()
    bindings = [
        {'type': 'ai', 'name': 'AI'},
        {'type': 'durable_object_namespace', 'name': 'DB', 'class_name': 'ChatStore'},
        {'type': 'secret_text', 'name': 'ACCESS_TOKEN', 'text': token},
        {'type': 'plain_text', 'name': 'PUBLIC_ORIGIN', 'text': origin},
    ]
    bound = []
    if with_ext:
        for k in EXT_KEYS + sorted(k for k in sec if k.startswith('AGENT_')):
            if sec.get(k):
                bindings.append({'type': 'secret_text', 'name': k, 'text': sec[k]}); bound.append(k)
    meta = {'main_module': 'worker.js', 'compatibility_date': '2025-06-01', 'compatibility_flags': ['nodejs_als'], 'bindings': bindings, 'observability': {'enabled': False}}
    tag, _ = migration_tag(acc, name, api)
    if not tag:
        meta['migrations'] = {'new_tag': 'v1', 'new_sqlite_classes': ['ChatStore']}
    d = tempfile.mkdtemp(); mp = os.path.join(d, 'metadata.json')
    old = os.umask(0o077); open(mp, 'w').write(json.dumps(meta)); os.umask(old)
    # 上传 API 不收 JSON 模块：把 members.json / logos.json 包成 ES 模块（先校验 JSON 合法）
    _prod = json.load(open(f'{HERE}/members.json')).get('product', {})
    _sk = open(f'{HERE}/skills/ai-groupchat-operator.md').read().replace('{{PRODUCT}}', _prod.get('name', 'AI 群聊')).replace('{{PRODUCT_SHORT}}', _prod.get('short', 'AI 群聊'))
    open(os.path.join(d, 'opskill.js'), 'w').write('export default ' + json.dumps(_sk, ensure_ascii=False) + ';\n')
    tp = f'{HERE}/docs-training/负责人培训手册.md'
    open(os.path.join(d, 'training.js'), 'w').write('export default ' + json.dumps(open(tp).read() if os.path.exists(tp) else '', ensure_ascii=False) + ';\n')
    for nm in ('members', 'logos', 'resources'):
        data = json.load(open(f'{HERE}/{nm}.json'))
        open(os.path.join(d, f'{nm}.js'), 'w').write('export default ' + json.dumps(data, ensure_ascii=False) + ';\n')
    try:
        r = cf('-X', 'PUT', '-F', f'metadata=<{mp};type=application/json',
               '-F', f'worker.js=@{HERE}/worker.js;filename=worker.js;type=application/javascript+module',
               '-F', f'members.js=@{d}/members.js;filename=members.js;type=application/javascript+module',
               '-F', f'logos.js=@{d}/logos.js;filename=logos.js;type=application/javascript+module',
               '-F', f'resources.js=@{d}/resources.js;filename=resources.js;type=application/javascript+module',
               '-F', f'page.html=@{HERE}/page.html;filename=page.html;type=text/plain',
               '-F', f'pwa.js=@{HERE}/pwa.js;filename=pwa.js;type=application/javascript+module',
               '-F', f'toolgw.js=@{HERE}/toolgw.js;filename=toolgw.js;type=application/javascript+module',
               *(['-F', f'caps.js=@{HERE}/caps.js;filename=caps.js;type=application/javascript+module'] if os.path.exists(f'{HERE}/caps.js') else []),
               *(['-F', f'p1.js=@{HERE}/p1.js;filename=p1.js;type=application/javascript+module'] if os.path.exists(f'{HERE}/p1.js') else []),
               '-F', f'opskill.js=@{d}/opskill.js;filename=opskill.js;type=application/javascript+module',
               '-F', f'training.js=@{d}/training.js;filename=training.js;type=application/javascript+module',
               f'{API}/accounts/{acc}/workers/scripts/{name}', api=api)
    finally:
        for f in os.listdir(d): os.unlink(os.path.join(d, f))
        os.rmdir(d)
    print('script put', name, r.get('success'), json.dumps(r.get('errors'), ensure_ascii=False)[:600], '| migration_tag(before)=', tag, '| 外部密钥已绑:', bound or '无')
    if not r.get('success'):
        sys.exit(1)
    return r


def cron(acc, name, api):
    r = cf('-X', 'PUT', '-H', 'Content-Type: application/json', '--data', json.dumps([{'cron': CRON}]),
           f'{API}/accounts/{acc}/workers/scripts/{name}/schedules', api=api)
    print('cron', CRON, r.get('success'), json.dumps(r.get('errors'), ensure_ascii=False)[:300])


def upload():
    sec = load_secrets()
    put_script(ACC, NAME, CFAPI, sec['ACCESS_TOKEN'], f'https://{HOST}')
    r2 = cf('-X', 'POST', '-H', 'Content-Type: application/json', '--data', '{"enabled":false}', f'{API}/accounts/{ACC}/workers/scripts/{NAME}/subdomain')
    print('workers.dev disabled', r2.get('success'), json.dumps(r2.get('errors'))[:200])
    cron(ACC, NAME, CFAPI)


def domain():
    r = cf('-X', 'PUT', '-H', 'Content-Type: application/json',
           '--data', json.dumps({'hostname': HOST, 'service': NAME, 'zone_id': ZONE, 'environment': 'production'}),
           f'{API}/accounts/{ACC}/workers/domains')
    print('domain', r.get('success'), json.dumps(r.get('errors') or {k: r['result'].get(k) for k in ('hostname', 'service')}, ensure_ascii=False)[:600])


TEMP_TOKEN = '/workspace/work/agc2/temp_token.txt'


def temp_up():
    tok = secrets.token_urlsafe(32)
    old = os.umask(0o077); open(TEMP_TOKEN, 'w').write(tok); os.umask(old)
    sub = 'emberthistle32'
    put_script(T_ACC, T_NAME, T_CFAPI, tok, f'https://{T_NAME}.{sub}.workers.dev', with_ext=False)
    r = cf('-X', 'POST', '-H', 'Content-Type: application/json', '--data', '{"enabled":true}', f'{API}/accounts/{T_ACC}/workers/scripts/{T_NAME}/subdomain', api=T_CFAPI)
    print('temp workers.dev', r.get('success'), f'https://{T_NAME}.{sub}.workers.dev  token→{TEMP_TOKEN}')


def temp_down():
    r = cf('-X', 'DELETE', f'{API}/accounts/{T_ACC}/workers/scripts/{T_NAME}?force=true', api=T_CFAPI)
    print('temp deleted', r.get('success'), json.dumps(r.get('errors'))[:200])
    if os.path.exists(TEMP_TOKEN): os.unlink(TEMP_TOKEN)


if __name__ == '__main__':
    step = sys.argv[1] if len(sys.argv) > 1 else 'all'
    if step in ('all', 'upload'): upload()
    if step in ('all', 'domain'): domain()
    if step == 'cron': cron(ACC, NAME, CFAPI)
    if step == 'temp-up': temp_up()
    if step == 'temp-down': temp_down()
