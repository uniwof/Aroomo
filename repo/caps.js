// caps.js — 模型能力分类与负责人资格（P1-1）。纯函数、无网络、无模型调用，worker.js 与 node 单测共用。
// 两类负责人（详见 docs/P1-1-改动说明.md）：
//   · 配对/外部智能体负责人（kind=paired|agent）：资格来自配对或接入本身，不看模型能力；
//   · 模型成员负责人（kind=model）：必须 chat + context_window≥32000 + tool_call===true + capability_status==='verified'；unknown 一律不合格。
export const CAP_TAGS = ['chat', 'vision', 'reason', 'code', 'write', 'image', 'video', 'audio'];
export const LEAD_MIN_CTX = 32000;
export const AGENT_KINDS = ['poke', 'webhook', 'tailscale', 'tunnel', 'telegram', 'bridge', 'hark', 'pair'];
// x-agent- / x-hark- 是配对专用的保留前缀：只有 /api/pair 兑换时服务端生成，自建成员（/api/agents）不能用。
// 注意：前缀只用于拒绝自建，不作为"是否配对"的判断依据——配对只认服务端写入的 paired:true 或 pair 来源。
export const isReservedId = id => /^x-(hark|agent)-/.test(String(id || '').toLowerCase());
const srcKind = s => (s && s.invoke && s.invoke.kind) || (s && s.kind) || '';
export const isPairedMember = m => !!m && (m.paired === true || (m.sources || []).some(s => srcKind(s) === 'pair'));

// 模型名归一化：deepseek-v4 == deepseek-ai/DeepSeek-V4 == @cf/deepseek-ai/deepseek-v4-instruct-fp8 == deepseek-v4:free
// -preview / -latest 不去掉：它们通常是不同的服务版本，不能并到正式版成员上。
export function normModel(name) {
  let n = String(name || '').trim().toLowerCase();
  if (!n) return '';
  n = n.replace(/^@cf\//, '').split('/').pop();
  n = n.split(':')[0];
  n = n.replace(/[\s_]+/g, '-');
  let prev;
  do {
    prev = n;
    n = n.replace(/-(fp8-fast|fp8|fp16|bf16|awq|gguf|int4|int8|instruct|it|chat-hf|hf)$/, '');
  } while (n !== prev);
  return n.replace(/-+/g, '-').replace(/^-|-$/g, '');
}

const triBool = v => (v === true || v === 'true') ? true : (v === false || v === 'false') ? false : 'unknown';
const numOrNull = v => (typeof v === 'number' && isFinite(v) && v > 0) ? Math.round(v) : (typeof v === 'string' && /^\d+$/.test(v) ? +v : null);

// 规范化成员能力；override（kv caps:<id>）字段优先
export function capsOf(m, override) {
  const base = (m && m.caps) || {};
  const o = override || {};
  const pick = k => (o[k] !== undefined ? o[k] : base[k]);
  const tags = (Array.isArray(pick('tags')) ? pick('tags') : []).filter(t => CAP_TAGS.includes(t));
  return {
    kind: pick('kind') || null,
    web: !!pick('web') || (m && (m.sources || []).some(x => srcKind(x) === 'web')),   // P1-2：网页来源一律是网页成员
    tags: [...new Set(tags)],
    context_window: numOrNull(pick('context_window')),
    tool_call: triBool(pick('tool_call')),
    capability_status: (pick('kind') === 'builtin') ? 'n/a' : pick('capability_status') === 'verified' ? 'verified' : 'pending',   // builtin 不参与能力判定
    source: String(pick('source') || '').slice(0, 300),
  };
}

// 校验用户/管家提交的能力覆盖值；返回 {ok, caps|error}
export function validateCaps(x) {
  if (!x || typeof x !== 'object') return { ok: false, error: '缺少能力字段' };
  const out = {};
  if (x.tags !== undefined) {
    if (!Array.isArray(x.tags) || x.tags.some(t => !CAP_TAGS.includes(t))) return { ok: false, error: '能力标签只能是 ' + CAP_TAGS.join('/') };
    out.tags = [...new Set(x.tags)];
  }
  if (x.context_window !== undefined) {
    if (x.context_window !== null && numOrNull(x.context_window) === null) return { ok: false, error: 'context_window 须是正整数或 null' };
    out.context_window = x.context_window === null ? null : numOrNull(x.context_window);
  }
  if (x.tool_call !== undefined) {
    if (![true, false, 'unknown', 'true', 'false'].includes(x.tool_call)) return { ok: false, error: 'tool_call 只能是 true/false/unknown' };
    out.tool_call = triBool(x.tool_call);
  }
  if (x.capability_status !== undefined) {
    if (!(['verified', 'pending'].includes(x.capability_status) || (x.capability_status === 'n/a' && x.kind === 'builtin'))) return { ok: false, error: 'capability_status 只能是 verified/pending' };
    out.capability_status = x.capability_status;
  }
  if (x.source !== undefined) out.source = String(x.source).slice(0, 300);
  if (out.capability_status === 'verified' && !(out.source || '').trim()) return { ok: false, error: '标记 verified 必须写来源说明' };
  return { ok: true, caps: out };
}

// 成员属于哪类负责人：builtin | paired | agent | custom-endpoint | model
export function leadKind(m, override) {
  if (!m) return 'model';
  const c = capsOf(m, override);
  const kinds = (m.sources || []).map(srcKind);
  if (m.steward || kinds.includes('lead') || kinds.includes('steward') || c.kind === 'builtin') return 'builtin';
  if (isPairedMember(m)) return 'paired';
  if (m.leadOnly) return 'custom-endpoint';
  if (c.kind === 'agent') return 'agent';
  if (c.kind === 'model') return 'model';
  if (m.custom && kinds.length && kinds.every(k => AGENT_KINDS.includes(k))) return 'agent';
  return 'model';
}

// 负责人资格。返回 {eligible, kind, rule, reasons[]}
export function leadEligibility(m, override) {
  if (!m) return { eligible: false, kind: 'model', rule: 'missing', reasons: ['成员不存在'] };
  const kind = leadKind(m, override);
  if (m.retired) return { eligible: false, kind, rule: 'retired', reasons: ['已下架'] };
  if (kind === 'builtin') return { eligible: false, kind, rule: 'builtin', reasons: ['内置角色（Hark 是兜底规则、资源管家管资源），不作为下拉候选'] };
  if (kind === 'paired') return { eligible: true, kind, rule: 'pairing', reasons: [] };
  if (kind === 'agent') return { eligible: true, kind, rule: 'connector', reasons: [] };
  if (kind === 'custom-endpoint') return { eligible: true, kind, rule: 'user-endpoint', reasons: [] };
  const c = capsOf(m, override), r = [];
  const media = c.tags.filter(t => ['image', 'video', 'audio'].includes(t));
  if (c.web) r.push('网页成员只能当执行成员');
  if (!c.tags.includes('chat')) r.push(media.length ? '生图/视频/语音成员只能当执行成员' : c.tags.includes('write') ? '只写作的成员只能当执行成员' : '不能文字对话（缺 chat）');
  if (c.context_window === null) r.push('上下文长度未知（按不合格）');
  else if (c.context_window < LEAD_MIN_CTX) r.push('上下文 ' + c.context_window + ' < ' + LEAD_MIN_CTX);
  if (c.tool_call === 'unknown') r.push('工具调用未知（按不合格）');
  else if (c.tool_call !== true) r.push('不支持工具调用');
  if (c.capability_status !== 'verified') r.push('能力待核实（pending）');
  return { eligible: r.length === 0, kind, rule: 'capability', reasons: r };
}

// /v1/models 同步计划：不建成员卡。已有模型（归一化后同名）只补来源，新模型进候选池（按归一化名去重，上限 500）。
// members: [{id, sources:[{invoke:{model}}]}]; pool: [{norm, name, relays:[], firstSeen}]; extra: {memberId:[{relay, model}]}
export function planModelSync(members, pool, extra, relayId, models, now = 0) {
  const known = new Map();
  for (const m of members || []) {
    known.set(normModel(m.id), m.id);
    for (const s of m.sources || []) { const mm = s && s.invoke && s.invoke.model; if (mm) known.set(normModel(mm), m.id); }
  }
  const P = (pool || []).map(x => ({ ...x, relays: [...(x.relays || [])] }));
  const byNorm = new Map(P.map(x => [x.norm, x]));
  const E = extra && typeof extra === "object" && !Array.isArray(extra) ? JSON.parse(JSON.stringify(extra)) : {};
  const added = [], merged = [], seen = new Set();
  for (const raw of models || []) {
    const name = String(raw || '').trim(); const n = normModel(name);
    if (!n || seen.has(n)) continue; seen.add(n);
    const mid = known.get(n);
    if (mid) {
      const hasNative = (members.find(x => x.id === mid).sources || []).some(s => s && s.invoke && s.invoke.relay === relayId && normModel(s.invoke && s.invoke.model) === n);
      const list = E[mid] || (E[mid] = []);
      if (!hasNative && !list.some(x => x.relay === relayId)) { list.push({ relay: relayId, model: name }); merged.push({ member: mid, relay: relayId, model: name }); }
      continue;
    }
    const p = byNorm.get(n);
    if (p) { if (!p.relays.includes(relayId)) p.relays.push(relayId); if (!p.models) p.models = {}; p.models[relayId] = name; continue; }
    if (P.length >= 500) continue;
    const e = { norm: n, name, relays: [relayId], models: { [relayId]: name }, firstSeen: now };
    P.push(e); byNorm.set(n, e); added.push(n);
  }
  return { pool: P, extra: E, added, merged };
}

// 换负责人建议：当前负责人不合格时不静默替换，只给通知文本与建议（按副负责人接任规则）
export function leadNotice(slot, member, elig, deputy, deputyElig) {
  if (!member || elig.eligible) return null;
  const lab = slot === 'p' ? '主负责人' : '副负责人';
  let t = lab + '「' + (member.name || member.id) + '」现在不符合负责人条件：' + elig.reasons.join('；') + '。设置没有被自动修改。';
  if (slot === 'p') t += deputy && deputyElig && deputyElig.eligible ? '本轮按接任规则由副负责人「' + (deputy.name || deputy.id) + '」临时派工；要不要正式换人由你决定（设置 → 负责人）。' : '副负责人也不可用，本轮回退 Hark 内置规则；请到 设置 → 负责人 重新选择。';
  return t;
}
