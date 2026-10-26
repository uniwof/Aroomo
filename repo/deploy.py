#!/usr/bin/env python3
"""部署 Aroomo Worker（多模块 worker.js + caps.js + members.json + logos.json + page.html …）。
直接调 Cloudflare API（urllib，不需要 wrangler、不依赖任何沙盒路径/代理脚本）。脚本绝不打印令牌或密钥值。

所需环境变量（全部从环境读取，代码和仓库里不写任何密钥）：
  CF_API_TOKEN      Cloudflare API 令牌。建议用只对「你自己的测试 Worker」有 Workers Scripts:Edit 权限的受限令牌。
  CF_ACCOUNT_ID     Cloudflare 账号 ID
  CF_WORKER_NAME    Worker 名字（例如 aroomo-test-你的名字）
  AGC_ACCESS_TOKEN  这个实例的访问令牌（网页登录 ?k= 用；测试实例用自己生成的，绝不要用线上的）
可选：
  PUBLIC_ORIGIN     对外地址（默认 https://<CF_WORKER_NAME>.<CF_WORKERS_SUBDOMAIN>.workers.dev）
  CF_WORKERS_SUBDOMAIN  账号的 workers.dev 子域（只用于拼默认 PUBLIC_ORIGIN）
  CF_ZONE_ID, AGC_HOST  只有 domain 步骤需要（绑定自定义域名）
  外部成员密钥：GROQ_API_KEY NVIDIA_API_KEY GEMINI_API_KEY AGNES_API_KEY POKE_API_KEY HAPPYCODING_API_KEY VYCE_API_KEY PM_API_KEY
               TELEGRAM_BOT_TOKEN 以及任意 AGENT_ 开头的变量——环境里有就作为 secret_text 绑定，没有就不绑。
  AGC_ALLOW_PRODUCTION=1  显式允许对线上名字（ai-groupchat / chat.pcmanai.com）操作；默认拒绝。

用法：
  python3 deploy.py build            # 只在本地打包到 ./build/（不联网，用于检查/本地测试）
  python3 deploy.py upload           # 上传脚本 + cron
  python3 deploy.py workers-dev on|off
  python3 deploy.py domain           # 绑定 AGC_HOST（需要 CF_ZONE_ID）
  python3 deploy.py cron
  python3 deploy.py delete           # 删除 CF_WORKER_NAME（只给测试 Worker 用）
绑定：AI（Workers AI）、DB（SQLite 版 Durable Object ChatStore）、ACCESS_TOKEN（secret）、PUBLIC_ORIGIN（plain_text）。
"""
import os, sys, json, uuid, urllib.request, urllib.error

API = 'https://api.cloudflare.com/client/v4'
HERE = os.path.dirname(os.path.abspath(__file__))
EXT_KEYS = ['GROQ_API_KEY', 'NVIDIA_API_KEY', 'GEMINI_API_KEY', 'AGNES_API_KEY', 'POKE_API_KEY', 'HAPPYCODING_API_KEY', 'VYCE_API_KEY', 'PM_API_KEY',
            'TELEGRAM_BOT_TOKEN']
CRON = '17 * * * *'  # 每小时探测一次（只调免费的 /models、计费、心跳接口）
PROD_NAMES = {'ai-groupchat'}
PROD_HOSTS = {'chat.pcmanai.com'}
JS = 'application/javascript+module'


def env(name, required=True):
    v = os.environ.get(name, '').strip()
    if required and not v:
        sys.exit(f'缺少环境变量 {name}（见 deploy.py 顶部说明）')
    return v


def guard(name, host=''):
    if (name in PROD_NAMES or host in PROD_HOSTS) and os.environ.get('AGC_ALLOW_PRODUCTION') != '1':
        sys.exit(f'拒绝：{name or host} 是线上资源。要操作线上必须显式设置 AGC_ALLOW_PRODUCTION=1（测试请用自己的 Worker 名）。')


def cf(method, path, body=None, ctype=None):
    req = urllib.request.Request(API + path, data=body, method=method)
    req.add_header('Authorization', 'Bearer ' + env('CF_API_TOKEN'))
    if ctype: req.add_header('Content-Type', ctype)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        try: return json.loads(e.read() or b'{}')
        except Exception: return {'success': False, 'errors': [{'code': e.code, 'message': 'HTTP %d' % e.code}]}


def modules():
    """返回 [(字段名, 文件名, 内容bytes, content-type)]；JSON 包成 ES 模块（上传 API 不收 JSON 模块）。"""
    out = []
    rd = lambda p: open(os.path.join(HERE, p), 'rb').read()
    out.append(('worker.js', 'worker.js', rd('worker.js'), JS))
    for nm in ('members', 'logos', 'resources'):
        data = json.load(open(os.path.join(HERE, f'{nm}.json')))
        out.append((f'{nm}.js', f'{nm}.js', ('export default ' + json.dumps(data, ensure_ascii=False) + ';\n').encode(), JS))
    prod = json.load(open(os.path.join(HERE, 'members.json'))).get('product', {})
    sk = open(os.path.join(HERE, 'skills/ai-groupchat-operator.md')).read().replace('{{PRODUCT}}', prod.get('name', 'Aroomo')).replace('{{PRODUCT_SHORT}}', prod.get('short', 'Aroomo'))
    out.append(('opskill.js', 'opskill.js', ('export default ' + json.dumps(sk, ensure_ascii=False) + ';\n').encode(), JS))
    tp = os.path.join(HERE, 'docs-training/负责人培训手册.md')
    out.append(('training.js', 'training.js', ('export default ' + json.dumps(open(tp).read() if os.path.exists(tp) else '', ensure_ascii=False) + ';\n').encode(), JS))
    out.append(('page.html', 'page.html', rd('page.html'), 'text/plain'))
    for f in ('pwa.js', 'toolgw.js', 'caps.js', 'p1.js'):
        out.append((f, f, rd(f), JS))
    return out


def build():
    d = os.path.join(HERE, 'build'); os.makedirs(d, exist_ok=True)
    for _, fn, data, _ in modules():
        open(os.path.join(d, fn), 'wb').write(data)
    print('built →', d, sorted(os.listdir(d)))


def multipart(parts):
    b = uuid.uuid4().hex; buf = []
    for field, fn, data, ct in parts:
        h = f'--{b}\r\nContent-Disposition: form-data; name="{field}"' + (f'; filename="{fn}"' if fn else '') + f'\r\nContent-Type: {ct}\r\n\r\n'
        buf += [h.encode(), data, b'\r\n']
    buf.append(f'--{b}--\r\n'.encode())
    return b''.join(buf), f'multipart/form-data; boundary={b}'


def upload():
    acc, name = env('CF_ACCOUNT_ID'), env('CF_WORKER_NAME'); guard(name)
    origin = env('PUBLIC_ORIGIN', False) or (f"https://{name}.{env('CF_WORKERS_SUBDOMAIN')}.workers.dev")
    guard(name, origin.split('//')[-1].split('/')[0])
    bindings = [
        {'type': 'ai', 'name': 'AI'},
        {'type': 'durable_object_namespace', 'name': 'DB', 'class_name': 'ChatStore'},
        {'type': 'secret_text', 'name': 'ACCESS_TOKEN', 'text': env('AGC_ACCESS_TOKEN')},
        {'type': 'plain_text', 'name': 'PUBLIC_ORIGIN', 'text': origin},
    ]
    bound = []
    for k in EXT_KEYS + sorted(k for k in os.environ if k.startswith('AGENT_')):
        if os.environ.get(k):
            bindings.append({'type': 'secret_text', 'name': k, 'text': os.environ[k]}); bound.append(k)
    meta = {'main_module': 'worker.js', 'compatibility_date': '2025-06-01', 'bindings': bindings, 'observability': {'enabled': False}}
    r = cf('GET', f'/accounts/{acc}/workers/scripts/{name}/settings')
    if not r.get('success'):   # 新脚本：建 SQLite DO 迁移
        meta['migrations'] = {'new_tag': 'v1', 'new_sqlite_classes': ['ChatStore']}
    body, ct = multipart([('metadata', None, json.dumps(meta).encode(), 'application/json')] + modules())
    r = cf('PUT', f'/accounts/{acc}/workers/scripts/{name}', body, ct)
    print('script put', name, r.get('success'), json.dumps(r.get('errors'), ensure_ascii=False)[:600], '| 外部密钥已绑:', bound or '无')
    if not r.get('success'): sys.exit(1)
    cron()


def cron():
    acc, name = env('CF_ACCOUNT_ID'), env('CF_WORKER_NAME'); guard(name)
    r = cf('PUT', f'/accounts/{acc}/workers/scripts/{name}/schedules', json.dumps([{'cron': CRON}]).encode(), 'application/json')
    print('cron', CRON, r.get('success'), json.dumps(r.get('errors'), ensure_ascii=False)[:300])


def workers_dev(on):
    acc, name = env('CF_ACCOUNT_ID'), env('CF_WORKER_NAME'); guard(name)
    r = cf('POST', f'/accounts/{acc}/workers/scripts/{name}/subdomain', json.dumps({'enabled': on}).encode(), 'application/json')
    print('workers.dev', 'on' if on else 'off', r.get('success'), json.dumps(r.get('errors'))[:200])


def domain():
    acc, name, host, zone = env('CF_ACCOUNT_ID'), env('CF_WORKER_NAME'), env('AGC_HOST'), env('CF_ZONE_ID'); guard(name, host)
    r = cf('PUT', f'/accounts/{acc}/workers/domains', json.dumps({'hostname': host, 'service': name, 'zone_id': zone, 'environment': 'production'}).encode(), 'application/json')
    print('domain', r.get('success'), json.dumps(r.get('errors'), ensure_ascii=False)[:600])


def delete():
    acc, name = env('CF_ACCOUNT_ID'), env('CF_WORKER_NAME'); guard(name)
    r = cf('DELETE', f'/accounts/{acc}/workers/scripts/{name}?force=true')
    print('deleted', name, r.get('success'), json.dumps(r.get('errors'))[:200])


if __name__ == '__main__':
    step = sys.argv[1] if len(sys.argv) > 1 else 'build'
    if step == 'build': build()
    elif step == 'upload': upload()
    elif step == 'cron': cron()
    elif step == 'workers-dev': workers_dev((sys.argv[2] if len(sys.argv) > 2 else 'on') == 'on')
    elif step == 'domain': domain()
    elif step == 'delete': delete()
    else: sys.exit(__doc__)
