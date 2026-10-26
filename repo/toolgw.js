// 工具网关执行器（2026-10-23）：AI成员（支持函数调用的模型）经 OpenAI 格式 tools 调用；页面「试一下」也走这里。
// 纯函数：调用方传入 fetch（带超时）、key 和参数；不碰数据库。权限/上限/确认/敏感路由/记录都在 worker.js 的 gatewayCall 里做。
// 已接（端到端跑通）：fetch_url（免 Key）、run_code via E2B、run_code via Daytona。其余工具只有骨架：返回「待测」，不对外发请求。

const MAX_OUT = 4000;
const cut = (t, n = MAX_OUT) => { t = String(t ?? ''); return t.length > n ? t.slice(0, n) + `\n…（已截断，共 ${t.length} 字）` : t; };
const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

// 给模型看的函数定义（OpenAI tools 格式）。只发「已填 Key 且已接/待测」的工具对应的函数。
export const FUNCTIONS = {
  fetch_url: {
    type: 'function',
    function: { name: 'fetch_url', description: '读取一个公网 https 网页的正文文字（最多约 4000 字）。用于查资料、核对官方页面。', parameters: { type: 'object', properties: { url: { type: 'string', description: 'https 开头的网址' } }, required: ['url'] } },
  },
  run_code: {
    type: 'function',
    function: { name: 'run_code', description: '在云端一次性沙盒里运行一段代码并返回输出（无 GPU，最长约 60 秒，运行完沙盒立即删除）。适合算数、验证代码、处理小数据。', parameters: { type: 'object', properties: { language: { type: 'string', enum: ['python', 'bash'] }, code: { type: 'string', description: '要运行的代码' }, provider: { type: 'string', enum: ['e2b', 'daytona'], description: '可选；不填自动挑' } }, required: ['language', 'code'] } },
  },
  use_tool: {
    type: 'function',
    function: { name: 'use_tool', description: '调用资源库里的其他工具（云手机、GPU 平台、电话号码等）。花钱或不可逆的动作会先等用户在页面确认。', parameters: { type: 'object', properties: { tool: { type: 'string', description: '工具 id，如 tool-lambda' }, action: { type: 'string', description: '动作名，见工具说明' }, args: { type: 'object', description: '动作参数' } }, required: ['tool', 'action'] } },
  },
};

// ── 执行器 ──
async function e2bRun(fetchT, key, language, code) {
  const H = { 'X-API-Key': key, 'content-type': 'application/json' };
  const c = await fetchT('https://api.e2b.dev/sandboxes', { method: 'POST', headers: H, body: JSON.stringify({ templateID: 'code-interpreter-v1', timeout: 120, secure: true }) }, 30000);
  if (!c.ok) throw new Error(`E2B 建沙盒失败 ${c.status} ${(await c.text()).slice(0, 120)}`);
  const sb = await c.json();
  try {
    const src = language === 'bash' ? `import subprocess\nr=subprocess.run(${JSON.stringify(code)},shell=True,capture_output=True,text=True,timeout=55)\nprint(r.stdout,end='')\nprint(r.stderr,end='')\nprint('\\n[exit',r.returncode,']')` : code;
    const r = await fetchT(`https://49999-${sb.sandboxID}.e2b.app/execute`, { method: 'POST', headers: { 'content-type': 'application/json', ...(sb.envdAccessToken ? { 'X-Access-Token': sb.envdAccessToken } : {}) }, body: JSON.stringify({ code: src, language: 'python' }) }, 70000);
    if (!r.ok) throw new Error(`E2B 执行失败 ${r.status}`);
    const out = []; let err = '';
    for (const line of (await r.text()).split('\n')) {
      if (!line.trim()) continue; let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.type === 'stdout' || j.type === 'stderr') out.push(j.text);
      else if (j.type === 'result' && j.text) out.push(j.text);
      else if (j.type === 'error') err = `${j.name || 'Error'}: ${j.value || ''}`;
    }
    return { ok: !err, text: cut(out.join('') + (err ? '\n' + err : '')) || '（没有输出）', meta: { provider: 'E2B', sandbox: sb.sandboxID } };
  } finally {
    try { await fetchT(`https://api.e2b.dev/sandboxes/${sb.sandboxID}`, { method: 'DELETE', headers: { 'X-API-Key': key } }, 10000); } catch {}
  }
}
async function daytonaRun(fetchT, key, language, code) {
  const H = { authorization: 'Bearer ' + key, 'content-type': 'application/json' };
  const c = await fetchT('https://app.daytona.io/api/sandbox', { method: 'POST', headers: H, body: JSON.stringify({ autoStopInterval: 5, autoDeleteInterval: 10, labels: { agc: '1' } }) }, 30000);
  if (!c.ok) throw new Error(`Daytona 建沙盒失败 ${c.status} ${(await c.text()).slice(0, 120)}`);
  const sb = await c.json(); const proxy = (sb.toolboxProxyUrl || 'https://proxy.app.daytona.io/toolbox').replace(/\/+$/, '');
  try {
    for (let i = 0; i < 15 && sb.state !== 'started'; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const g = await fetchT(`https://app.daytona.io/api/sandbox/${sb.id}`, { headers: H }, 10000); if (g.ok) sb.state = (await g.json()).state;
      if (sb.state === 'error') throw new Error('Daytona 沙盒启动出错');
    }
    if (sb.state !== 'started') throw new Error('Daytona 沙盒 30 秒内没启动');
    const cmd = language === 'bash' ? `bash -c "$(echo ${b64(code)} | base64 -d)"` : `python3 -c "import base64;exec(base64.b64decode('${b64(code)}'))"`;
    const r = await fetchT(`${proxy}/${sb.id}/process/execute`, { method: 'POST', headers: H, body: JSON.stringify({ command: cmd, timeout: 55 }) }, 70000);
    if (!r.ok) throw new Error(`Daytona 执行失败 ${r.status}`);
    const d = await r.json();
    return { ok: d.exitCode === 0, text: cut((d.result || '') + (d.exitCode ? `\n[exit ${d.exitCode}]` : '')) || '（没有输出）', meta: { provider: 'Daytona', sandbox: sb.id } };
  } finally {
    try { await fetchT(`https://app.daytona.io/api/sandbox/${sb.id}`, { method: 'DELETE', headers: H }, 10000); } catch {}
  }
}

// tool 定义来自 members.json tools[].gw；keys = 已解密的 Key（只在内存里）
export async function execute(ctx, tool, action, args) {
  const { fetchT, safeFetchText, keys } = ctx;
  const gw = tool.gw || {};
  if (action === 'fetch_url') {
    const r = await safeFetchText(String(args.url || ''), 10000);
    if (!r || r.error) throw new Error((r && r.error) || '读不到这个网页');
    return { ok: true, text: cut(r.text), meta: { url: r.url || args.url } };
  }
  if (action === 'run_code') {
    const lang = args.language === 'bash' ? 'bash' : 'python';
    const code = String(args.code || ''); if (!code.trim()) throw new Error('没有代码');
    if (tool.id === 'tool-e2b') return e2bRun(fetchT, keys[gw.key], lang, code);
    if (tool.id === 'tool-daytona') return daytonaRun(fetchT, keys[gw.key], lang, code);
  }
  // 骨架：动作已登记（风险等级、确认、上限、记录都生效），执行器待测，不对外发请求
  const a = (gw.actions || []).find((x) => x.name === action);
  return { ok: false, todo: true, text: `「${tool.name}」的「${a ? a.label || a.name : action}」已接入网关骨架（Key 填写、确认、上限、记录都已生效），执行器待测，这次没有真正调用。`, meta: { endpoint: gw.endpoint || '' } };
}
