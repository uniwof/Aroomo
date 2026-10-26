// p1.js — P1-2…P1-6 的纯函数（无网络、无模型调用、无存储），worker.js 与 node 单测共用。
// 每个函数只做「输入 → 输出」，存储和 HTTP 都在 worker.js 里。

// ───────────── P1-2 网页成员（代发） ─────────────
export const WEB_TIMEOUT_MS = 10 * 60000;   // 代发员领走后 10 分钟没回 → 自动改派
export const WEB_MAX_ATTEMPTS = 3;          // 最多派 3 次（含首次），还不行就标失败
export const RELAY_ONLINE_MS = 10 * 60000;  // 代发员 10 分钟内拉取过 = 在线
export const RELAY_ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

// 给网页模型的完整提示：前情 + 角色 + 输出格式。网页模型不必知道群聊产品的存在，所以这里不写产品名、不写接口地址。
export function webPrompt({ name, role, roleBrief, mode, roster, transcript, isImage, lastUser, maxChars, background }) {
  if (isImage) {
    return [
      '请根据下面的描述生成一张图片。',
      '【描述】' + String(lastUser || '').slice(0, 1500),
      '【输出格式】只回图片（或图片链接），不要附加解释。',
    ].join('\n\n');
  }
  const lim = maxChars || 150;
  return [
    `【背景】你在参与一场多人协作讨论（其他参与者有 AI，也有一位人类用户）。下面是讨论记录，请以「${role}」的身份接着发言。你在讨论里的名字是「${name}」。`,
    `【你的角色】${role}${roleBrief ? '：' + roleBrief : ''}${mode ? `（当前讨论方式：${mode}）` : ''}`,
    roster ? `【参与者】${roster}` : '',
    background ? '【项目背景】\n' + String(background).slice(0, 2000) : '',
    '【前情】\n' + String(transcript || '（还没有记录）').slice(-3500),
    `【输出格式】只输出你这次的发言正文，用简体中文，不超过 ${lim} 字；不要复述这段说明，不要寒暄，不要用 Markdown 标题。`,
  ].filter(Boolean).join('\n\n');
}

// 某个代发员能不能领这条任务
// relay: {id, kind:'hark'|'desktop', consent, seen}; task: {client, excluded:[], prefer, created}; relays: 全部代发员（判断首选是否在线）
export function relayCanTake(relay, task, now, relays) {
  if (!relay) return false;
  if (relay.kind === 'desktop' && relay.consent !== true) return false;   // 桌面桥接会操作用户电脑：用户没同意前一条都不领
  if (task.client && !(relay.kind === 'desktop' && relay.consent === true)) return false;   // 仅客户端型：必须是用户电脑桥接且用户已同意
  const ex = task.excluded || [];
  if (ex.includes(relay.id)) {
    // 超时改派过：除非已经没有别的在线、能接的代发员
    const others = (relays || []).filter((r) => r.id !== relay.id && !ex.includes(r.id) && now - (r.seen || 0) < RELAY_ONLINE_MS && (!task.client || (r.kind === 'desktop' && r.consent === true)));
    if (others.length) return false;
  }
  if (task.prefer && task.prefer !== relay.id && !ex.includes(task.prefer)) {
    // 同一项目复用同一网页会话：首选代发员在线时，先留给它 2 分钟
    const p = (relays || []).find((r) => r.id === task.prefer);
    if (p && now - (p.seen || 0) < RELAY_ONLINE_MS && now - (task.created || 0) < 2 * 60000) return false;
  }
  return true;
}

// 超时扫描：返回要改派 / 标失败的任务
// tasks: [{id, relay, claimed, attempts, excluded}]
export function webSweepPlan(tasks, now, timeoutMs = WEB_TIMEOUT_MS) {
  const out = [];
  for (const t of tasks || []) {
    if (!t.claimed || now - t.claimed < timeoutMs) continue;
    const attempts = (t.attempts || 0) + 1;
    const excluded = [...new Set([...(t.excluded || []), t.relay].filter(Boolean))];
    out.push({ id: t.id, action: attempts >= WEB_MAX_ATTEMPTS ? 'fail' : 'requeue', attempts, excluded, relay: t.relay });
  }
  return out;
}

// 网页会话引用：只收 https 链接或简单的会话 id（不收脚本、不收超长串）
export function cleanSession(x) {
  const s = String(x == null ? '' : x).trim();
  if (!s) return '';
  if (s.length > 400) return '';
  if (/^https:\/\/[^\s<>"']+$/.test(s)) return s;
  if (/^[A-Za-z0-9._:-]{4,120}$/.test(s)) return s;
  return '';
}

// ───────────── P1-3 点子库 ─────────────
// 点子 ≠ 项目：点子只是存档（当时的想法、计划形式、预期效果、沟通摘要、来源、标签、状态）。新建项目可以关联点子，关联后点子内容作为背景注入所有成员上下文。
export const IDEA_STATUS = ['正在做', '暂时收藏', '已放弃'];
const IDEA_FIELDS = { title: 60, thought: 2000, plan: 1000, expect: 1000, summary: 2000, source: 300 };
export function validateIdea(b, prev) {
  if (!b || typeof b !== 'object') return { ok: false, error: '缺少点子内容' };
  const o = { ...(prev || {}) };
  for (const [k, lim] of Object.entries(IDEA_FIELDS)) if (b[k] !== undefined) o[k] = String(b[k] == null ? '' : b[k]).trim().slice(0, lim);
  if (b.tags !== undefined) {
    const t = Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(/[,，、\s]+/);
    o.tags = [...new Set(t.map((x) => String(x).trim().slice(0, 12)).filter(Boolean))].slice(0, 8);
  }
  if (b.status !== undefined) { if (!IDEA_STATUS.includes(b.status)) return { ok: false, error: '状态只能是 ' + IDEA_STATUS.join(' / ') }; o.status = b.status; }
  if (!o.title) return { ok: false, error: '点子需要一个名字' };
  if (!o.status) o.status = '暂时收藏';
  if (!o.tags) o.tags = [];
  return { ok: true, idea: o };
}
// 注入成员上下文的背景（只放点子内容，不放内部 id / 接口）
export function ideaContext(it) {
  if (!it) return '';
  const L = [`点子「${it.title}」（状态：${it.status}）`];
  if (it.thought) L.push('当时的想法：' + it.thought);
  if (it.plan) L.push('计划形式：' + it.plan);
  if (it.expect) L.push('预期效果：' + it.expect);
  if (it.summary) L.push('沟通摘要：' + it.summary);
  if ((it.tags || []).length) L.push('标签：' + it.tags.join('、'));
  const notes = (it.notes || []).slice(-3);
  if (notes.length) L.push('以前项目的结论：' + notes.map((n) => `「${n.title || ''}」${n.text}`).join('；'));
  return L.join('\n').replace(/【/g, '「').replace(/】/g, '」').slice(0, 2000);   // 复核采纳：用户内容不能伪造【】提示分隔块
}
// 预填（用户 2026-10-24 列的 6 个）：只写想法层面的内容，不写账号/客户信息
export const IDEA_SEEDS = [
  { id: 'seed-photo', title: '老照片修复定制服务', status: '正在做', tags: ['接单', '修图', '视频'], thought: '接单做老照片修复、人脸修复、多人合成（透视要对），以后可能加「老照片动起来」。', plan: '接单服务 + 9:16 宣传短视频（悬念开头 → 亮出需求和原图 → 揭晓成品）。', expect: '用案例视频带来订单；公开案例前先拿到客户肖像授权。', summary: '宣传视频模板已做好（24 秒主模板 + 15 秒备选），过程画面标注「示意」。', source: '用户 2026-10-14' },
  { id: 'seed-prompt', title: '提示词策展站', status: '暂时收藏', tags: ['网站', '视频', '变现'], thought: '收集公开免费的提示词（注明作者来源）分享出去，靠视频收益或自建网站变现。', plan: '网站 + 视频一起做；效果图自己实测生成、链接原帖。', expect: '差异化：按效果反查、标注模型和日期、多模型对比、中英双语。', summary: '还没定先做网站还是视频。', source: '用户 2026-10-11' },
  { id: 'seed-guofeng', title: '古风助眠 YouTube 频道', status: '暂时收藏', tags: ['YouTube', '音乐', '出海'], thought: '面向海外听众的中国古风 AI 纯音乐长视频（助眠、冥想），零成本落地。', plan: '开源作曲模型在免费 GPU 上跑，每期新曲 + 主题变化，1–2 小时长视频。', expect: '靠广告收入；避开 YouTube「重复/模板化内容」不可变现规则，不搬运现成音乐。', summary: '等决定是否先做 1 小时样片；用户可提供 3–5 首参考曲（只学风格）。', source: '用户 2026-10-11' },
  { id: 'seed-laser', title: '激光切割拼装图纸', status: '正在做', tags: ['设计', 'Etsy', '出海'], thought: '用 AI 流水线（图片 → 分层/3D → 激光切割 DXF/SVG）做拼装图纸，以设计师身份卖图纸。', plan: '只卖设计文件；切割、调机、材料、组装由买家负责。', expect: '先海外（Etsy、Cults3D），国内（淘宝/闲鱼）其次（待确认）。', summary: '流水线已做好并做过两个真实需求的样例；先做哪种结构还没定。', source: '用户 2026-10-15' },
  { id: 'seed-newterm', title: '新词站 / AI 出海', status: '正在做', tags: ['出海', '网站', 'SEO'], thought: '抓刚冒头的 AI 新名词，抢先做工具站拿搜索流量。', plan: '新词雷达每天挑候选词；配合 Gumroad 榜、vercel.app 新流量、Stripe 收银台反查找需求。', expect: '首日出单式的小站；只用免费信号。', summary: '新词雷达已在用户自己的 Cloudflare 上每天运行。', source: '用户 2026-10-11 / 10-20' },
  { id: 'seed-pcman', title: 'pcmanai.com：电脑维修 / 数据恢复 / AI 服务', status: '暂时收藏', tags: ['本地服务', '网站'], thought: '用 pcmanai.com 做电脑维修、数据恢复和 AI 服务的门面。', plan: '域名已注册并接入 Cloudflare；服务形式未定。', expect: '待定。', summary: '目前域名主要用来挂各种自建服务。', source: '用户 2026-10-07' },
];

// ── P1-4 主持模式 + 快速建项目 + 暂停 + 决策按钮 ──
export const MODE_INFO = {
  debate: '两方对立，裁判最后给结论',
  review: '一位写方案，其他人逐条挑错、核查',
  free: '大家自由发言，不分输赢',
  task: '分工合作，做出成品',
  host: '主持人决定谁说话，你随时可暂停；也可以 @ 某位成员直接点名',
};
// @ 点名：@名字 或 @id；@ 前面是字母数字（邮箱）不算；长的先匹配；只认本项目成员
export function parseMentions(text, roster) {
  const t = String(text || ''); if (!t.includes('@') || !Array.isArray(roster) || !roster.length) return [];
  const keys = [];
  for (const r of roster) for (const k of [r.name, r.id]) if (k && String(k).trim()) keys.push({ k: String(k).trim().toLowerCase(), r });
  keys.sort((a, b) => b.k.length - a.k.length);
  const out = []; const seen = new Set(); const low = t.toLowerCase();
  for (let i = low.indexOf('@'); i >= 0; i = low.indexOf('@', i + 1)) {
    if (i > 0 && /[a-z0-9._-]/i.test(t[i - 1])) continue;
    const rest = low.slice(i + 1);
    const hit = keys.find(({ k }) => rest.startsWith(k) && !/[a-z0-9_-]/i.test(rest[k.length] || ''));
    if (hit && !seen.has(hit.r.id)) { seen.add(hit.r.id); out.push(hit.r); }
  }
  return out;
}
// 快速建项目：全员加入（负责人、资源管家、退役、只当负责人、离线的不算），角色统一「成员」，最多 20 位
export function quickLineup(all) {
  return (all || []).filter((m) => m && m.id && !String(m.id).startsWith('lead-') && !m.lead && !m.steward && !m.retired && !m.leadOnly && m.state !== 'down' && m.id !== 'hark').slice(0, 20).map((m) => ({ id: m.id, role: '成员' }));
}
// 主持人点名：按规则推荐顺序挑本项目成员，最多 3 位；推荐里一个都不在项目里 → 按项目顺序前 2 位
export function hostPick(roster, rankedIds) {
  const R = Array.isArray(roster) ? roster : []; if (!R.length) return [];
  const out = []; for (const id of rankedIds || []) { const r = R.find((x) => x.id === id); if (r && !out.includes(r)) out.push(r); if (out.length >= 3) break; }
  return out.length ? out : R.slice(0, 2);
}
// 决策题：负责人请用户拍板（付费、命名、代收资源确认）
export function validateDecision(b) {
  const question = String((b && b.question) || '').trim();
  if (!question || question.length > 300) return { ok: false, error: '问题必填，最多 300 字' };
  const opts = (Array.isArray(b.options) ? b.options : []).map((x) => String(x || '').trim()).filter(Boolean);
  if (opts.length < 2 || opts.length > 3) return { ok: false, error: '选项要 2–3 个' };
  if (new Set(opts).size !== opts.length) return { ok: false, error: '选项不能重复' };
  if (opts.some((x) => x.length > 12)) return { ok: false, error: '每个选项最多 12 字' };
  return { ok: true, question, options: opts };
}
