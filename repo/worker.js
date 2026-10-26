// AI 群聊 v2（ai-groupchat）— Cloudflare Worker + Workers AI + Durable Object(SQLite)
// 「AI成员」= 一个能干活的模型/智能体，一张卡；它的多个渠道（Workers AI / Groq / 中转站 / 网页 / 本机）是 sources，调用时自动挑可用的那个。
// 沙盒、浏览器、代理、邮箱、号码、算力是「资源库 → 工具与算力」(tools)，不是成员。资源库还含 API 密钥、技能、学习与网站资源（resources.json + 资源管家写入的 res_items）。
// 配置：members.json（唯一权威来源）；logos.json（simple-icons，CC0）；page.html（前端）。部署：python3 deploy.py。说明见 README.md。
import { DurableObject, RpcTarget } from 'cloudflare:workers';
import { AsyncLocalStorage } from 'node:async_hooks';   // P1-6 fix1：一个 Worker 请求只开一个 DO RPC 会话（需要 compatibility_flags nodejs_als）
import CONFIG from './members.js';   // deploy.py 把 members.json 包成 JS 模块（上传 API 不收 JSON 模块）
import LOGOS from './logos.js';
import PAGE from './page.html';
import { MANIFEST, ICON_SVG, PNG } from './pwa.js';
// 浏览器标签页图标：图形与 ICON_SVG 完全相同，只把填充色交给 <style>：浅色标签栏黑、深色标签栏白（prefers-color-scheme）
const FAVICON_SVG = ICON_SVG.replace(/ fill="#000000"/g, '').replace('>', '><style>path,circle,rect{fill:#000}@media (prefers-color-scheme:dark){path,circle,rect{fill:#fff}}</style>');
import RES from './resources.js';
import * as TG from './toolgw.js';
import OPSKILL from './opskill.js';
import * as CAPS from './caps.js';
import * as P1 from './p1.js';   // P1-2…P1-6 纯函数（代发队列、点子、主持模式、额度保险）   // P1-1 模型能力分类与负责人资格（纯函数，不调模型）
import TRAINING from './training.js';   // docs-training/负责人培训手册.md（主 Hark 撰写；deploy 时打包，缺失则为空串）   // skills/ai-groupchat-operator.md（deploy 时打包成字符串）   // 工具网关执行器（E2B / Daytona / 查网页 + 骨架）   // 资源库静态数据（技能 + 学习与网站资源），data/build_resources.py 生成

const TERM = CONFIG.term || 'AI成员';
const PRODUCT = { name: 'Aroomo', short: 'Aroomo', zh: 'Aroomo', ...(CONFIG.product || {}) };   // 产品名唯一配置：members.json product
const COOKIE = 'agc';
const MAX_MSG = 4000;
const CTX_CHARS = 9000;
const CF_DAILY = 10000;
const ROLES = CONFIG.roles;
const MODES = { debate: '辩论', review: '审查', free: '自由聊', task: '任务', host: '主持' };   // P1-4：主持 = 负责人点名谁说话，用户可 @ 指定
const RELAYS = Object.fromEntries((CONFIG.relays || []).map((r) => [r.id, r]));
const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const ROOM_RE = /^[a-z0-9]{6,16}$/;
const PROJECT_STATUS = ['进行中', '已完成', '失败'];
const ASYNC_KINDS = ['poke', 'webhook', 'tailscale', 'tunnel', 'telegram', 'bridge', 'hark', 'pair', 'web'];

// 品牌主色：头像底色 = 气泡底色 = 额度环颜色（文字黑/白按对比度自动选）
const BRANDS = {
  hark: { name: 'Hark', color: '#000000', letter: 'H' }, openai: { name: 'OpenAI', color: '#0d0d0d' }, meta: { name: 'Meta', color: '#0866FF' },
  mistral: { name: 'Mistral AI', color: '#FA520F' }, qwen: { name: 'Qwen', color: '#615CED' }, ibm: { name: 'IBM', color: '#0F62FE' },
  nvidia: { name: 'NVIDIA', color: '#76B900' }, google: { name: 'Google', color: '#4285F4' }, gemini: { name: 'Gemini', color: '#1C69FF' },
  moonshot: { name: 'Moonshot', color: '#16191E' }, deepseek: { name: 'DeepSeek', color: '#4D6BFE' }, zhipu: { name: '智谱', color: '#3859FF', letter: 'Z' },
  minimax: { name: 'MiniMax', color: '#E73562' }, anthropic: { name: 'Anthropic', color: '#D97757' }, agnes: { name: 'Agnes', color: '#4B4FC4', letter: 'A' },
  poke: { name: 'Poke', color: '#1F1F1F', letter: 'P' }, muse: { name: 'Muse', color: '#5B3FD9', letter: 'M' }, cccc: { name: 'CCCC', color: '#2F4A6D', letter: 'C' },
  opencode: { name: 'OpenCode', color: '#111111' }, cloudflare: { name: 'Cloudflare', color: '#F38020' }, groq: { name: 'Groq', color: '#F55036', letter: 'G' },
  telegram: { name: 'Telegram', color: '#26A5E4' }, tailscale: { name: 'Tailscale', color: '#242424' }, xai: { name: 'xAI / Grok', color: '#000000', letter: 'X' },
  steward: { name: '资源管家', color: '#1F5F4A', letter: '管' },
  custom: { name: '自定义', color: '#5C5F66', letter: '?' },
};

// 连接器模板（外部 AI成员 的连接方式；新增只改配置/表单，不改代码）
const CONNECTORS = {
  'workers-ai': { label: 'Cloudflare Workers AI（Worker 内绑定）', how: 'env.AI.run，免费额度 10,000 neurons/天，整个主账号共用。' },
  openai: { label: 'OpenAI 兼容 API（直连 / 中转站）', how: 'POST {base}/chat/completions，Bearer 密钥（Worker secret）。' },
  gemini: { label: 'Google Gemini API', how: 'generateContent，x-goog-api-key。' },
  'image-openai': { label: '生图 API（OpenAI 兼容 images/generations）', how: '把最近一条用户消息当提示词出图，房间里只存图片链接。' },
  poke: { label: 'Poke API（即时唤醒，回调写回）', how: 'POST https://poke.com/api/v1/inbound/api-message（V2 Key），消息里带回调地址和成员令牌；Poke 处理后 POST /hook/reply 写回房间。' },
  webhook: { label: '通用 Webhook（HTTPS，同步或异步回调）', how: 'POST JSON 任务到你的 https 地址（X-AGC-Timestamp + X-AGC-Signature = HMAC-SHA256(密钥, 时间戳.正文)）；直接返回 {"text":"…"} 就是同步回复，否则稍后 POST /hook/reply。' },
  tailscale: { label: 'Tailscale（Funnel 端点 或 tailnet 内小桥）', how: 'Worker 进不了 tailnet：① tailnet 机器上 `tailscale funnel <端口>`，把 https://<机器>.<tailnet>.ts.net 填进地址（协议同 Webhook）；② 不填地址 = 拉取模式，在 tailnet 内跑 bridge.py（只出站 HTTPS，不开端口）。' },
  tunnel: { label: '本机/局域网（Cloudflare Tunnel 暴露 HTTP）', how: 'cloudflared tunnel 把本机服务暴露成 https 子域名填进地址；协议同 Webhook。' },
  telegram: { label: 'Telegram Bot（发到指定聊天，引用回复即写回）', how: 'Bot（TELEGRAM_BOT_TOKEN）把任务发到指定 chat；对方引用该消息回复或带 #任务号，经 /hook/tg/… webhook 写回。注意：Bot 收不到别的 Bot 的消息。' },
  bridge: { label: '拉取模式小桥（bridge.py）', how: '在能访问该智能体的机器上跑 bridge.py：定时 GET /bridge/pull 拉任务，处理后 POST /hook/reply 写回（成员令牌鉴权）。适合内网、本机、网页工具（浏览器代发）。' },
  pair: { label: '关联智能体（配对码接入，拉取模式）', how: '设置页「关联智能体」生成一次性配对码；对方（Hark、Poke、Manus 等任何能发 HTTPS 请求的智能体）调 POST /api/pair 换到成员令牌（主负责人另得操作员令牌）。' },
  hark: { label: 'Hark（另一个 Hark 账号，拉取模式）', how: '对方 Hark 用成员令牌定时 GET /bridge/pull 取任务、POST /hook/reply 交回答（Hark 没有对外 API/OAuth，所以走拉取）。保存后会生成一段可复制给对方 Hark 的中文接入说明；设置页「关联 Hark」可用一次性配对码自动接入。敏感项目默认不派给外部 Hark。' },
  web: { label: '网页成员（经代发：代发员用浏览器代发）', how: '网页/客户端里的模型（例如各家网页聊天、arena 出图）。任务进入代发队列，由「设置 → 网页代发员」里登记的代发员（Hark 远程浏览器，或用户电脑上的桌面桥接智能体）领取，打开该网址把完整提示（前情 + 角色 + 输出格式）发过去，再把回复回传，群聊里标「经代发」。同一项目复用同一网页会话；10 分钟没回自动改派；签到也由代发员做。勾「仅客户端型」的只派给你同意过的桌面桥接。' },
  lead: { label: '内置负责人', how: '派工规则在 Worker 内运行；AI 复核用 gpt-oss-120b（Workers AI → Groq）。' },
  none: { label: '不可调用', how: '' },
};
const CUSTOM_KINDS = ['hark', 'poke', 'webhook', 'tailscale', 'tunnel', 'telegram', 'bridge', 'openai', 'web'];

// ───────────────────────── Durable Object ─────────────────────────
export class ChatStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, title TEXT, mode TEXT, created INTEGER, updated INTEGER);
      CREATE TABLE IF NOT EXISTS msgs(id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT, kind TEXT, member TEXT, model TEXT, text TEXT, ts INTEGER);
      CREATE INDEX IF NOT EXISTS msgs_room ON msgs(room, id);
      CREATE TABLE IF NOT EXISTS status(member TEXT PRIMARY KEY, state TEXT, checked INTEGER, err TEXT, info TEXT);
      CREATE TABLE IF NOT EXISTS usage(member TEXT, day TEXT, calls INTEGER, tin INTEGER, tout INTEGER, neurons REAL, PRIMARY KEY(member, day));
      CREATE TABLE IF NOT EXISTS custom(id TEXT PRIMARY KEY, json TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, room TEXT, member TEXT, role TEXT, status TEXT, created INTEGER, prompt TEXT, ext TEXT);
      CREATE INDEX IF NOT EXISTS tasks_member ON tasks(member, status);
      CREATE TABLE IF NOT EXISTS parts(room TEXT, member TEXT, role TEXT, joined INTEGER, PRIMARY KEY(room, member));
      CREATE INDEX IF NOT EXISTS parts_member ON parts(member, joined);
      CREATE TABLE IF NOT EXISTS ratings(id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT, member TEXT, job TEXT, score INTEGER, src TEXT, rater TEXT, note TEXT, ts INTEGER);
      CREATE INDEX IF NOT EXISTS ratings_member ON ratings(member, job);
      CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS apikeys(name TEXT PRIMARY KEY, iv TEXT, ct TEXT, last4 TEXT, saved INTEGER, vstate TEXT, vmsg TEXT, vat INTEGER);
      CREATE TABLE IF NOT EXISTS res_items(id TEXT PRIMARY KEY, cat TEXT, name TEXT, purpose TEXT, free TEXT, expires TEXT, url TEXT, src_url TEXT, official_url TEXT, evidence TEXT, vstate TEXT, verified_at INTEGER, verified_url TEXT, paid INTEGER, model TEXT, added INTEGER, updated INTEGER, note TEXT);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT, member TEXT, via TEXT, level TEXT, action TEXT, note TEXT, ts INTEGER);
      CREATE INDEX IF NOT EXISTS audit_room ON audit(room, id);
      CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, member TEXT, room TEXT, kind TEXT, name TEXT, action TEXT, ok INTEGER, ms INTEGER, tin INTEGER, tout INTEGER, detail TEXT, args TEXT, result TEXT);
      CREATE INDEX IF NOT EXISTS calls_member ON calls(member, id);
      CREATE INDEX IF NOT EXISTS calls_name ON calls(kind, name, ts);
      CREATE TABLE IF NOT EXISTS ideas(id TEXT PRIMARY KEY, title TEXT, thought TEXT, plan TEXT, expect TEXT, summary TEXT, source TEXT, tags TEXT, status TEXT, created INTEGER, updated INTEGER, notes TEXT);
      CREATE TABLE IF NOT EXISTS opaudit(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, member TEXT, method TEXT, path TEXT, note TEXT);`);
    // 兼容 v1 旧库：补列，旧房间/消息原样保留
    const cols = (t) => this.sql.exec(`PRAGMA table_info(${t})`).toArray().map((c) => c.name);
    const rc = cols('rooms');
    if (!rc.includes('members')) this.sql.exec('ALTER TABLE rooms ADD COLUMN members TEXT');
    if (!rc.includes('status')) this.sql.exec("ALTER TABLE rooms ADD COLUMN status TEXT DEFAULT '进行中'");
    if (!cols('msgs').includes('role')) this.sql.exec('ALTER TABLE msgs ADD COLUMN role TEXT');
    if (!cols('msgs').includes('test')) this.sql.exec('ALTER TABLE msgs ADD COLUMN test INTEGER DEFAULT 0');
    if (!rc.includes('sens')) this.sql.exec('ALTER TABLE rooms ADD COLUMN sens INTEGER DEFAULT 0');
    if (!rc.includes('idea')) this.sql.exec('ALTER TABLE rooms ADD COLUMN idea TEXT');   // P1-3：项目关联的点子（可空）
    const tc = cols('tasks');   // P1-2 代发队列：kind=web 的任务记录领取者 / 领取时间 / 派了几次
    if (!tc.includes('kind')) this.sql.exec("ALTER TABLE tasks ADD COLUMN kind TEXT DEFAULT ''");
    if (!tc.includes('relay')) this.sql.exec('ALTER TABLE tasks ADD COLUMN relay TEXT');
    if (!tc.includes('claimed')) this.sql.exec('ALTER TABLE tasks ADD COLUMN claimed INTEGER');
    if (!tc.includes('attempts')) this.sql.exec('ALTER TABLE tasks ADD COLUMN attempts INTEGER DEFAULT 0');
    this.sql.exec('CREATE INDEX IF NOT EXISTS tasks_kind ON tasks(kind, status)');
    const xc = cols('res_items');   // P1-5：主负责人代收 → via='lead'、代收人、用户给的备注/来源；test=测试模式写入（结束时删）
    for (const c of ['via', 'via_by', 'via_note', 'via_src']) if (!xc.includes(c)) this.sql.exec(`ALTER TABLE res_items ADD COLUMN ${c} TEXT`);
    if (!xc.includes('test')) this.sql.exec('ALTER TABLE res_items ADD COLUMN test INTEGER DEFAULT 0');
    this.sql.exec('CREATE TABLE IF NOT EXISTS subs(id INTEGER PRIMARY KEY AUTOINCREMENT, rid TEXT, ts INTEGER, who TEXT, url TEXT, text TEXT, note TEXT, source TEXT, status TEXT, why TEXT, name TEXT, state TEXT, test INTEGER DEFAULT 0)');   // P1-5 代收记录（逐行 INSERT，避免并发读改写丢记录）
    this.sql.exec("UPDATE calls SET ok=7 WHERE ok=1 AND detail='你已确认，见下一条执行记录'");
  }
  // 仅供本 Worker 内部 RPC 调用（DO 不对外暴露 fetch）
  q(sql, ...args) { return this.sql.exec(sql, ...args).toArray(); }
  batch(list) { for (const [sql, args] of list) this.sql.exec(sql, ...(args || [])); return true; }
  session() { return new StoreSession(this); }   // P1-6 fix1：返回 RpcTarget，之后在它上面的调用都算同一个 RPC 会话（Cloudflare 只计 1 次 DO 请求）
}
class StoreSession extends RpcTarget { constructor(o) { super(); this.o = o; } q(sql, ...args) { return this.o.q(sql, ...args); } batch(list) { return this.o.batch(list); } }
// P1-6 fix1（2026-10-24 线上 DO 免费额度 10 万次/天被用穿）：原来每个 s.q() 都是一次独立 RPC = 一次计费的 DO 请求，一个页面请求要几十次。
// 现在每个 Worker 请求（fetch / scheduled）在 ALS 里懒开一个会话，所有 s.q 共用；没有 ALS 上下文时退回旧做法。
const ALS = new AsyncLocalStorage();
const stubOf = (env) => env.DB.get(env.DB.idFromName('main'));
const store = (env) => {
  const c = ALS.getStore();
  if (!c) { const st = stubOf(env); return { q: (sql, ...a) => { RQ.dos++; RQ.calls++; return st.q(sql, ...a); }, batch: (l) => { RQ.dos++; return st.batch(l); } }; }   // 没有 ALS 上下文（不应发生）：退回每次一个 RPC，但照样计数
  if (!c.s) {
    const st = stubOf(env); let p = null;
    const open = () => p || (p = (RQ.dos++, st.session()));   // 同一请求里开会话失败就一直用这个失败结果，不反复重试（复审采纳：防重试风暴）
    c.s = { q: async (sql, ...a) => { RQ.calls++; return (await open()).q(sql, ...a); }, batch: async (l) => (await open()).batch(l) };
  }
  return c.s;
};

// ───────────────────────── 工具 ─────────────────────────
const SEC_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'x-robots-tag': 'noindex, nofollow' };
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SEC_HEADERS } });
}
function timingSafeEqual(a, b) {
  const ea = new TextEncoder().encode(String(a)); const eb = new TextEncoder().encode(String(b));
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ (eb[i % (eb.length || 1)] || 0);
  return diff === 0;
}
function getCookie(req, name) {
  for (const part of (req.headers.get('cookie') || '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) { try { return decodeURIComponent(part.slice(i + 1)); } catch { return null; } }
  }
  return null;
}
function authKind(req, env) {
  const tok = env.ACCESS_TOKEN;
  if (!tok || tok.length < 32) return null;
  const h = req.headers.get('authorization') || '';
  if (h.startsWith('Bearer ') && timingSafeEqual(h.slice(7).trim(), tok)) return 'bearer';
  const c = getCookie(req, COOKIE);
  if (c && timingSafeEqual(c, tok)) return 'cookie';
  return null;
}
function unauthorized(isApi) {
  if (isApi) return json({ error: '未授权：需要访问令牌' }, 401);
  return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>401</title><meta name="theme-color" content="#121211"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><body style="font:20px/1.6 -apple-system,system-ui,sans-serif;padding:max(2em,env(safe-area-inset-top)) 1.2em 2em;background:#121211;color:#ecebe7;max-width:640px;margin:0 auto"><h1 style="font-size:28px">需要登录</h1><p>这个页面需要访问链接才能打开。如果你是从主屏幕图标打开的，把 Hark 发你的登录链接粘贴到下面一次即可。</p><form method="get" action="/" onsubmit="var v=this.k.value.trim();var m=v.match(/[?&]k=([^&#\\s]+)/);if(m)this.k.value=decodeURIComponent(m[1]);"><input name="k" type="password" autocomplete="off" placeholder="粘贴登录链接" aria-label="登录链接" style="width:100%;font-size:19px;min-height:56px;border-radius:14px;border:1px solid #3c3c38;background:#1c1c1a;color:#ecebe7;padding:0 14px;box-sizing:border-box"><button style="margin-top:12px;width:100%;min-height:56px;border:0;border-radius:999px;background:#ff7f50;color:#141413;font:700 19px system-ui">登录</button></form></body>',
    { status: 401, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SEC_HEADERS } });
}
function rid(n = 10) { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map((x) => 'abcdefghijkmnpqrstuvwxyz23456789'[x % 32]).join(''); }
async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return [...new Uint8Array(s)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// 每个 AI成员 的回调/拉取令牌：由 ACCESS_TOKEN 派生；只能给该成员自己的待办任务写回复、拉它自己的任务
const memberToken = async (env, id) => (await hmacHex(env.ACCESS_TOKEN, 'member:' + id)).slice(0, 40);
const tgPath = async (env) => (await hmacHex(env.ACCESS_TOKEN, 'telegram-webhook')).slice(0, 32);
const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const nextUtcMidnight = () => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.getTime(); };
const isQuotaError = (m) => /4006|neuron|daily free allocation|quota|exceeded your|rate.?limit|\b429\b|insufficient|余额|额度/i.test(m || '');
const fmtN = (n) => Math.round(n).toLocaleString('en-US');
function untilText(ts) { const ms = ts - Date.now(); if (ms <= 0) return '已到'; const h = Math.floor(ms / 3600000), m = Math.round((ms % 3600000) / 60000); return h ? `${h} 小时 ${m} 分` : `${m} 分`; }
const londonTime = (ts) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Europe/London', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts));

// SSRF 防护（借鉴 yout0703/ai-debate）：外部地址只允许 https + 公网主机名
function safeUrl(u) {
  let x; try { x = new URL(String(u)); } catch { return null; }
  if (x.protocol !== 'https:' || x.username || x.password) return null;
  const h = x.hostname.toLowerCase();
  if (!h.includes('.') || h === 'localhost' || /\.(localhost|local|internal|lan|home|corp)$/.test(h)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return null;
  }
  if (h.includes(':') || h.startsWith('[')) return null;
  if (h === 'chat.pcmanai.com') return null;
  return x.toString();
}
const SECRET_NAME_RE = /^AGENT_[A-Z0-9_]{2,40}$/; // 自定义成员只能引用 AGENT_ 开头的 secret，防止把 ACCESS_TOKEN / 别家 Key 发到任意地址

// ───────────────────────── API 密钥库（用户在页面粘贴 → AES-GCM 加密存 DO；取值优先 env secret，其次 DO） ─────────────────────────
// 加密密钥由 ACCESS_TOKEN 派生（HMAC-SHA256(ACCESS_TOKEN, "agc-keystore-v1")）；附加数据 = 变量名，防止密文挪用到别的来源。
// 明文只在 Worker 内存里用于调用；接口只回末 4 位，永不回显；Workers 日志已关闭。
const KEYDEFS = Object.fromEntries((CONFIG.keys || []).filter((k) => k.env).map((k) => [k.env, k]));
const KEY_NAME_RE = /^[A-Z][A-Z0-9_]{2,40}$/;
async function ksKey(env) {
  const raw = await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', new TextEncoder().encode(env.ACCESS_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), new TextEncoder().encode('agc-keystore-v1'));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
const b64 = (u8) => btoa(String.fromCharCode(...new Uint8Array(u8)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function ksPut(env, s, name, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(name) }, await ksKey(env), new TextEncoder().encode(value));
  await s.q('INSERT INTO apikeys(name,iv,ct,last4,saved,vstate,vmsg,vat) VALUES(?,?,?,?,?,NULL,NULL,NULL) ON CONFLICT(name) DO UPDATE SET iv=excluded.iv, ct=excluded.ct, last4=excluded.last4, saved=excluded.saved, vstate=NULL, vmsg=NULL, vat=NULL',
    name, b64(iv), b64(ct), value.slice(-4), Date.now());
}
async function ksAll(env, s) {
  const rows = await s.q('SELECT name, iv, ct FROM apikeys'); const out = {};
  if (!rows.length) return out;
  const k = await ksKey(env);
  for (const r of rows) {
    try { out[r.name] = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(r.iv), additionalData: new TextEncoder().encode(r.name) }, k, unb64(r.ct))); } catch {}
  }
  return out;
}
// 给本次请求用的 env：Worker secret 优先，缺的才用 DO 里的
async function withKeys(env, s) {
  const stored = await ksAll(env, s); const extra = {};
  for (const [n, v] of Object.entries(stored)) if (!env[n] && (KEYDEFS[n] || n === 'LEAD_P_KEY' || n === 'LEAD_S_KEY')) extra[n] = v;
  return Object.keys(extra).length ? Object.assign(Object.create(env), extra) : env;
}
async function verifyKey(def, value) {
  const v = def.verify || { type: 'none' };
  if (v.type === 'none') return { state: 'filled', msg: v.why || '这个来源没有可用的验证接口' };
  const h = {};
  let opt = { method: 'GET', redirect: 'manual', headers: h };
  if (v.type === 'bearer-get') h.authorization = 'Bearer ' + value;
  else if (v.type === 'xkey-get') h['x-api-key'] = value;
  else if (v.type === 'goog-get') h['x-goog-api-key'] = value;
  else if (v.type === 'kaggle') h.authorization = value.includes(':') ? 'Basic ' + btoa(value) : 'Bearer ' + value;
  else if (v.type === 'bearer-chat') { h.authorization = 'Bearer ' + value; h['content-type'] = 'application/json'; opt = { ...opt, method: 'POST', body: JSON.stringify({ model: v.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }) }; }
  try {
    const r = await fetchT(v.url, opt, 15000);
    if (r.status >= 200 && r.status < 300) return { state: 'ok', msg: `已验证：${new URL(v.url).host} 接受了这个 Key（${r.status}）` };
    if (r.status === 401 || r.status === 403) return { state: 'bad', msg: `验证失败：Key 无效或没有权限（${r.status}）` };
    if (r.status === 429) return { state: 'ok', msg: 'Key 有效，但当前限流（429）' };
    if (r.status === 402) return { state: 'bad', msg: 'Key 有效但余额/额度不足（402）' };
    return { state: 'err', msg: `验证没通过：接口返回 ${r.status}` };
  } catch (e) { return { state: 'err', msg: '连不上验证接口：' + String((e && e.message) || e).slice(0, 80) }; }
}
async function keysView(env, s) {
  const rows = Object.fromEntries((await s.q('SELECT name,last4,saved,vstate,vmsg,vat FROM apikeys')).map((r) => [r.name, r]));
  const used = {};
  for (const m of CONFIG.members) for (const src of m.sources || []) { const iv = srcInvoke({}, src); if (iv.secret) (used[iv.secret] ||= new Set()).add(m.name); }
  for (const t of CONFIG.tools || []) if (t.key) (used[t.key] ||= new Set()).add('工具：' + t.name + '（所有支持函数调用的成员经工具网关可用）');
  return (CONFIG.keys || []).map((k) => {
    const r = k.env ? rows[k.env] : null;
    let state = 'empty', label = '未填';
    if (k.binding) { state = 'ok'; label = '账号绑定，已接通（不用填 Key）'; }
    else if (k.keyless) { state = 'ok'; label = '免 Key，已接通'; }
    else if (env[k.env]) { state = 'env'; label = '已填（部署时绑定的 Worker secret，优先使用）'; }
    else if (r) { state = r.vstate === 'ok' ? 'ok' : r.vstate === 'bad' || r.vstate === 'err' ? 'bad' : 'filled'; label = r.vstate === 'ok' ? '已验证' : r.vstate === 'bad' || r.vstate === 'err' ? '验证失败' : '已填（未验证）'; }
    return { env: k.env, name: k.name, group: k.group, free: k.free, free_src: k.free_src || '', console: k.console || '', console_note: k.console_note || '', can: k.can || '', paid: !!k.paid, keyless: !!k.keyless,
      state, label, last4: r ? r.last4 : '', saved: r ? r.saved : null, vmsg: r ? r.vmsg || '' : '', vat: r ? r.vat : null, verifiable: ((k.verify || {}).type || 'none') !== 'none',
      usedBy: [...(used[k.env] || [])] };
  });
}
async function keyVerifyStore(env, s, name, value) {
  const res = await verifyKey(KEYDEFS[name], value);
  await s.q('UPDATE apikeys SET vstate=?, vmsg=?, vat=? WHERE name=?', res.state, res.msg, Date.now(), name);
  return res;
}

// ───────────────────────── AI成员 与 来源 ─────────────────────────
function srcInvoke(env, src) {
  const iv = src.invoke || {};
  const relay = iv.relay ? RELAYS[iv.relay] : null;
  let base = iv.base || (relay && relay.base) || '';
  if (!base && relay && relay.base_secret && env[relay.base_secret] && safeUrl(env[relay.base_secret])) base = env[relay.base_secret].replace(/\/+$/, '');
  return { ...iv, base, secret: iv.secret || (relay && relay.secret) || '', relay };
}
function srcMissing(env, src) {
  if (src.retired) return ['已下架'];
  const iv = srcInvoke(env, src);
  if (iv.relay && iv.relay.offline) return ['中转站离线：' + iv.relay.offline];
  const need = [];
  switch (iv.kind) {
    case 'workers-ai': if (!env.AI) need.push('Workers AI 绑定 AI'); break;
    case 'openai': case 'image-openai': if (!iv.base) need.push('接口地址'); if (iv.secret && !env[iv.secret]) need.push(iv.secret); break;
    case 'gemini': if (!env[iv.secret || 'GEMINI_API_KEY']) need.push(iv.secret || 'GEMINI_API_KEY'); break;
    case 'poke': if (!env[iv.secret || 'POKE_API_KEY']) need.push(iv.secret || 'POKE_API_KEY'); break;
    case 'webhook': case 'tunnel': if (!(iv.url || (iv.url_secret && env[iv.url_secret]))) need.push(iv.url_secret || '端点地址'); break;
    case 'telegram': if (!env.TELEGRAM_BOT_TOKEN) need.push('TELEGRAM_BOT_TOKEN'); if (!iv.chat) need.push('chat_id'); break;
    case 'tailscale': case 'bridge': case 'hark': case 'pair': case 'lead': case 'steward': break;
    case 'web': if (!iv.site) need.push('网址'); break;
    case 'selfhost': need.push('待部署：先在算力平台部署推理端点'); break;
    default: need.push('不可调用');
  }
  return need;
}
const isPull = (env, iv) => iv.kind === 'bridge' || iv.kind === 'hark' || iv.kind === 'pair' || (iv.kind === 'tailscale' && !(iv.url || (iv.url_secret && env[iv.url_secret])));
const skey = (m, i) => `${m.id}@${i}`; // 状态/用量按「成员@来源序号」记

async function kvGet(s, k) { const r = (await s.q('SELECT v FROM kv WHERE k=?', k))[0]; if (!r) return null; try { return JSON.parse(r.v); } catch { return null; } }
async function kvSet(s, k, v) { await s.q('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, JSON.stringify(v)); }
// 报错信息里可能夹带长串密钥/令牌，存库前打码
const redact = (t) => String(t || '').replace(/(sk-|pk_|Bearer\s+)?[A-Za-z0-9_\-]{28,}/g, '…');
async function setStatus(s, key, state, err, infoPatch) {
  err = redact(err);
  const cur = (await s.q('SELECT info FROM status WHERE member=?', key))[0];
  let info = {}; try { info = JSON.parse((cur && cur.info) || '{}'); } catch {}
  Object.assign(info, infoPatch || {});
  await s.q('INSERT INTO status(member,state,checked,err,info) VALUES(?,?,?,?,?) ON CONFLICT(member) DO UPDATE SET state=excluded.state, checked=excluded.checked, err=excluded.err, info=excluded.info',
    key, state, Date.now(), (err || '').slice(0, 300), JSON.stringify(info));
}
async function addUsage(s, key, tin, tout, neurons) {
  await s.q('INSERT INTO usage(member,day,calls,tin,tout,neurons) VALUES(?,?,1,?,?,?) ON CONFLICT(member,day) DO UPDATE SET calls=calls+1, tin=tin+excluded.tin, tout=tout+excluded.tout, neurons=neurons+excluded.neurons',
    key, utcDay(), tin | 0, tout | 0, neurons || 0);
}

async function loadMembers(s) {
  const custom = (await s.q('SELECT json FROM custom ORDER BY created')).map((r) => { try { return JSON.parse(r.json); } catch { return null; } }).filter(Boolean);
  const lc = (await kvGet(s, 'lead_cfg')) || {};
  const pseudo = ['p', 's'].filter((k) => lc[k] && lc[k].type === 'custom').map((k) => leadPseudo(k, lc[k]));
  const ov = await capsOverrides(s); const extra = (await kvGet(s, 'model_extra')) || {};
  return [...CONFIG.members, ...custom, ...pseudo].map((m) => {
    const ex = (extra[m.id] || []).filter((x) => RELAYS[x.relay]);
    if (!ov[m.id] && !ex.length) return m;
    const o = { ...m };
    if (ov[m.id]) o.caps = { ...(m.caps || {}), ...ov[m.id] };
    if (ex.length) o.sources = [...(m.sources || []), ...ex.map((x) => ({ via: (RELAYS[x.relay].name || x.relay) + '（/v1/models 同步补充的来源）', synced: true, invoke: { kind: 'openai', relay: x.relay, model: x.model }, quota: { kind: 'relay-balance', source: 'live', unit: '站点余额' }, limits: {} }))];
    return o;
  });
}
// 能力覆盖值（用户/资源管家核实后写入 kv caps:<id>）
async function capsOverrides(s) {
  const out = {}; for (const r of await s.q("SELECT k,v FROM kv WHERE k LIKE 'caps:%'")) { try { out[r.k.slice(5)] = JSON.parse(r.v); } catch {} } return out;
}
// /v1/models 同步：不建成员卡。已有模型（归一化后同名）只补来源（kv model_extra），新模型进候选池（kv model_pool），用户或资源管家确认后才成为成员。
async function syncRelayModels(s, relayId, models) {
  const members = await s.q('SELECT json FROM custom').then((rs) => [...CONFIG.members, ...rs.map((r) => { try { return JSON.parse(r.json); } catch { return null; } }).filter(Boolean)]);
  const dismissed = new Set((await kvGet(s, 'model_pool_dismissed')) || []);   // 按「中转站|原名」记录，不按归一化名一刀切
  const r = CAPS.planModelSync(members, (await kvGet(s, 'model_pool')) || [], (await kvGet(s, 'model_extra')) || {}, relayId, (models || []).filter((x) => !dismissed.has(relayId + '|' + String(x).trim())), Date.now());
  await kvSet(s, 'model_pool', r.pool); await kvSet(s, 'model_extra', r.extra);
  return { added: r.added, merged: r.merged, pool: r.pool.length };
}
async function poolConfirm(s, norm, by, op) {
  const pool = (await kvGet(s, 'model_pool')) || []; const e = pool.find((x) => x.norm === norm); if (!e) return { error: '候选池里没有这个模型' };
  // 确定性 id：pool-<归一化名>，冲突时加中转站 id；永远不会落进配对保留前缀（x-agent- / x-hark-）
  const slug = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '');
  const taken = new Set((await loadMembers(s)).map((m) => m.id));
  let id = ('pool-' + (slug(norm) || 'model')).slice(0, 63);
  if (taken.has(id)) { const r0 = (e.relays || [])[0] || 'relay'; id = ('pool-' + (slug(norm) || 'model').slice(0, 40) + '-' + slug(r0)).slice(0, 63); }
  if (taken.has(id)) return { error: '已有同名成员（' + id + '）', status: 409 };
  const sources = e.relays.filter((r) => RELAYS[r]).map((r) => ({ via: (RELAYS[r].name || r) + '（候选池确认）', invoke: { kind: 'openai', relay: r, model: (e.models || {})[r] || e.name }, quota: { kind: 'relay-balance', source: 'live', unit: '站点余额' }, limits: {} }));
  if (!sources.length) return { error: '这个模型的中转站已不在配置里' };
  const m = { id, name: e.name.split('/').pop().slice(0, 40), brand: 'custom', custom: true, fromPool: true, intro: `从中转站 /v1/models 发现、由${by}确认加入的模型。`, tags: [], tags_note: '暂无社区评价', jobs: [], weak: [], jobs_note: '擅长岗位待定：等打分/互评',
    exec: { tags: [], note: '能力待核实' }, tools: [], limits: {}, privacy: '指令和聊天记录会发到中转站。', sources,
    caps: { kind: 'model', tags: ['chat'], context_window: null, tool_call: 'unknown', capability_status: 'pending', source: `候选池确认（${by}，${utcDay()}）；能力待核实` } };
  await s.q('INSERT INTO custom(id,json,created) VALUES(?,?,?)', id, JSON.stringify(m), Date.now());
  await kvSet(s, 'model_pool', pool.filter((x) => x.norm !== norm));
  await s.q('INSERT INTO opaudit(ts,member,method,path,note) VALUES(?,?,?,?,?)', Date.now(), op ? op.member : '', op ? 'POST' : 'WEB', '/api/models/pool/confirm', `${by}确认候选池模型 ${norm} → 成员 ${id}（能力 pending，不能当负责人）`.slice(0, 200));
  return { ok: true, id };
}
// 中转站自动发现的新模型 → 「候选」，不自动入群（入选门槛见 members.json admission）
async function candidates(s, members) {   // 候选池（归一化去重）；已有成员（归一化同名）不再列为候选
  const known = new Set(); for (const m of members) { known.add(CAPS.normModel(m.id)); for (const sc of m.sources || []) if (sc.invoke && sc.invoke.model) known.add(CAPS.normModel(sc.invoke.model)); }
  return ((await kvGet(s, 'model_pool')) || []).filter((e) => !known.has(e.norm)).slice(0, 80)
    .map((e) => ({ norm: e.norm, model: String(e.name).slice(0, 80), relay: e.relays.map((r) => (RELAYS[r] || {}).name || r).join('、'), relays: e.relays }));
}

// 额度：{pct(0..1|null), text, source, reset, deadline, more, low}
function srcQuota(env, m, i, src, st, usage, ctx) {
  const q = src.quota || {};
  const SRC = { live: '实查', official: '官方免费额度', est: '估算', unverified: '未核实' };
  const u = usage[skey(m, i)] || { calls: 0 };
  const out = { pct: null, text: q.text || '', source: SRC[q.source] || '', reset: q.reset || '', deadline: q.deadline || '', more: q.more || [], src_url: q.src || '', used_today: u.calls };
  if (q.kind === 'steward') {
    const used = ctx.stewardCalls || 0; const left = Math.max(0, STEWARD_DAILY - used); const vl = Math.max(0, STEWARD_STRONG_DAILY - (ctx.stewardVCalls || 0));
    out.pct = left / STEWARD_DAILY; out.source = '估算';
    out.text = `小档（分类/抽取整理）今天还剩 ${left} / ${STEWARD_DAILY} 次；强档（官方页核实）还剩 ${vl} / ${STEWARD_STRONG_DAILY} 次。都是自设上限，只走免费来源；用完降级到小档或规则，不花钱`;
    out.reset = '每天 00:00 UTC';
  } else if (q.kind === 'cf-neurons') {
    const left = ctx.cfExhausted ? 0 : Math.max(0, CF_DAILY - ctx.cfUsed);
    out.pct = left / CF_DAILY; out.source = '估算';
    out.text = `剩 ${fmtN(left)} / ${fmtN(CF_DAILY)} neurons（本群本地记账${ctx.cfExhausted ? '；今天已收到额度用完错误' : ''}；整个主账号共用，其他 Worker 的用量算不进来）`;
    out.reset = `每天 00:00 UTC（英国 ${londonTime(nextUtcMidnight())}，还有 ${untilText(nextUtcMidnight())}）`;
  } else if (q.kind === 'groq-rpd') {
    const rl = st && st.info && st.info.rl;
    if (rl && rl.limit && Date.now() - rl.at < 6 * 3600000) {
      out.pct = Math.max(0, Math.min(1, rl.remaining / rl.limit)); out.source = '实查';
      out.text = `剩 ${fmtN(rl.remaining)} / ${fmtN(rl.limit)} 次/天（Groq 响应头，${londonTime(rl.at)} 读取）`;
      if (rl.reset) out.reset = `请求额度 ${rl.reset} 后恢复（滚动窗口）`;
    } else {
      const lim = q.limit || 1000; const left = Math.max(0, lim - u.calls);
      out.pct = left / lim; out.source = '估算';
      out.text = `约剩 ${fmtN(left)} / ${fmtN(lim)} 次/天（官方免费档 − 本群今天已用 ${u.calls} 次）`;
    }
  } else if (q.kind === 'relay-balance') {
    const b = ctx.relayBal[(src.invoke || {}).relay];
    if (b && b.total > 0) { out.pct = Math.max(0, Math.min(1, b.remaining / b.total)); out.source = '实查'; out.text = `站点额度 ${b.remaining.toFixed(2)} / ${b.total.toFixed(2)} ${b.unit}（${b.via}，${londonTime(b.at)}）`; }
    else if (b && b.unit) { out.source = '实查'; out.text = `站点额度：${b.unit}（${b.via}）；本群今天已用 ${u.calls} 次`; }
    else { out.source = '未核实'; out.text = `查不到站点余额（没开放计费接口或缺密钥）；本群今天已用 ${u.calls} 次`; }
  } else if (q.kind === 'deadline') {
    if (q.deadline) {
      const days = Math.ceil((Date.parse(q.deadline + 'T23:59:59Z') - Date.now()) / 86400000);
      out.pct = days > 0 ? Math.min(1, days / 14) : 0; out.source = (SRC[q.source] || '') + ' · 按剩余天数估（满 14 天为满格）';
      out.text = `${q.text || ''}；${days > 0 ? `还剩 ${days} 天` : '已过期'}`;
    } else out.text = q.text || '限时免费，截止日未公布';
  } else if (q.kind === 'calls') {
    out.text = `${q.text || '额度规则未核实'}；本群今天已用 ${u.calls} 次`;
  } else if (q.kind === 'none') out.text = q.text || '—';
  out.low = out.pct != null && out.pct < 0.2;
  return out;
}
function srcState(env, m, src, st, need, ctx) {
  if (need.length) return { state: 'down', why: (need[0].startsWith('已下架') || need[0].startsWith('中转站离线') || need[0] === '不可调用' || need[0].startsWith('待部署')) ? need.join('、') : '缺密钥：到「资源库 → API 密钥」填 ' + need.map((n) => (KEYDEFS[n] ? KEYDEFS[n].name : n)).join('、') };
  if (src.known_issue) return { state: 'down', why: src.known_issue };
  const iv = srcInvoke(env, src);
  if (iv.kind === 'lead') return { state: 'ok', why: '内置' };
  if (iv.kind === 'steward') return { state: 'ok', why: '内置：规则随时可用；有免费模型时整理更准' };
  if (iv.kind === 'workers-ai' && ctx.cfExhausted) return { state: 'down', why: `今天 Workers AI 额度用完（英国 ${londonTime(nextUtcMidnight())} 重置）` };
  if (iv.kind === 'web') {   // P1-2：在线 = 有能接它的代发员 10 分钟内拉取过
    const onT = (ctx.relays || []).filter((r) => Date.now() - (r.seen || 0) < P1.RELAY_ONLINE_MS && (!iv.client || (r.kind === 'desktop' && r.consent === true)));
    if (onT.length) return { state: 'ok', why: `代发员在线（${onT.map((r) => r.name).slice(0, 3).join('、')}）` };
    return { state: 'down', why: iv.client ? '仅客户端型：没有在线、且你同意过的桌面桥接代发员（设置 → 网页代发员）' : '没有在线的代发员（设置 → 网页代发员）' };
  }
  if (isPull(env, iv)) {
    const seen = st && st.info && st.info.bridge_seen;
    if (seen && Date.now() - seen < 10 * 60000) return { state: 'ok', why: `小桥在线（${londonTime(seen)} 拉取过）` };
    return { state: 'down', why: seen ? `小桥离线（最近一次 ${londonTime(seen)}）` : '小桥未连接（还没运行过 bridge.py）' };
  }
  if (st && st.state) return { state: st.state, why: st.err || '正常' };
  if (iv.kind === 'workers-ai') return src.untested ? { state: 'unknown', why: '本群未实测（Workers AI 不探测，探测也耗额度）' } : { state: 'ok', why: '按最近调用判断（Workers AI 不探测，探测也耗额度）' };
  return { state: 'unknown', why: '还没探测' };
}
const RANK = { ok: 0, unknown: 1, down: 2 };
async function enrichAll(env, s) {
  const members = await loadMembers(s);
  const st = {}; for (const r of await s.q('SELECT member,state,checked,err,info FROM status')) { let info = {}; try { info = JSON.parse(r.info || '{}'); } catch {} st[r.member] = { ...r, info }; }
  const usage = {}; for (const r of await s.q('SELECT member,calls,tin,tout,neurons FROM usage WHERE day=?', utcDay())) usage[r.member] = r;
  let cfUsed = 0;
  for (const [k, u] of Object.entries(usage)) {
    const [mid, idx] = k.split('@'); const m = members.find((x) => x.id === mid);
    const sc = m && m.sources && m.sources[+idx];
    if ((sc && sc.invoke.kind === 'workers-ai') || mid === 'hark' || mid === 'probe') cfUsed += u.neurons || 0;
  }
  const ctx = { cfUsed, cfExhausted: (await kvGet(s, 'cf_exhausted')) === utcDay(), relayBal: {}, stewardCalls: (await kvGet(s, 'steward_calls:' + utcDay())) || 0, stewardVCalls: (await kvGet(s, 'steward_vcalls:' + utcDay())) || 0 };
  for (const r of CONFIG.relays || []) ctx.relayBal[r.id] = await kvGet(s, 'relay_balance:' + r.id);
  ctx.relays = Object.values((await kvGet(s, 'web_relays')) || {});
  const learned = await learnedTags(s);
  return members.map((m) => {
    const srcs = (m.sources || []).map((src, i) => {
      const need = srcMissing(env, src);
      const S = srcState(env, m, src, st[skey(m, i)], need, ctx);
      const quota = srcQuota(env, m, i, src, st[skey(m, i)], usage, ctx);
      if (quota.pct === 0 && S.state === 'ok') { S.state = 'down'; S.why = '额度用完'; }
      // 最高宗旨：默认只用免费来源；付费来源（paid:true）不自动使用，只作为推荐，需用户确认
      if (src.paid && S.state !== 'down') { S.state = 'down'; S.why = '付费来源：默认不用，需用户确认后才可使用'; }
      return { i, paid: !!src.paid, via: src.via, level: srcLevel(src), levelLabel: LEVELS[srcLevel(src)], kind: (src.invoke || {}).kind, model: (src.invoke || {}).model || '', need, state: S.state, why: S.why, checked: (st[skey(m, i)] || {}).checked || null, quota, untested: !!src.untested };
    });
    // 自动挑渠道：在线优先，其次额度高
    const order = [...srcs].sort((a, b) => (RANK[a.state] - RANK[b.state]) || ((b.quota.pct ?? 0.5) - (a.quota.pct ?? 0.5)));
    const best = order[0] || { state: 'down', why: '没有渠道', quota: { pct: null, text: '' }, need: [] };
    if (best.state === 'down' && srcs.length > 1) best.why = srcs.map((x) => `${x.via}：${x.why}`).join('；');
    const L = learned[m.id] || { jobs: [], weak: [] };
    return { ...m, srcs, order: order.map((x) => x.i), state: m.retired ? 'down' : best.state, why: m.retired ? (m.intro || '已下架') : best.why, quota: best.quota, active: best.i ?? null,
      jobsAll: [...(m.jobs || []), ...L.jobs], weakAll: [...(m.weak || []), ...L.weak], ratings: L.stats || {} };
  });
}
// 用户打分 + 成员互评 → 岗位标签（平均≥4 且≥2 次 → 擅长（实测）；平均≤2 且≥2 次 → 不擅长（实测））
async function learnedTags(s) {
  const out = {};
  for (const r of await s.q('SELECT member, job, src, COUNT(*) AS n, AVG(score) AS avg, MAX(ts) AS ts FROM ratings GROUP BY member, job, src')) {
    const o = out[r.member] || (out[r.member] = { jobs: [], weak: [], stats: {} });
    o.stats[`${r.job}·${r.src}`] = { n: r.n, avg: Math.round(r.avg * 10) / 10 };
    const tag = { t: r.job, from: r.src, src: `${r.n} 次平均 ${Math.round(r.avg * 10) / 10} 分`, date: utcDay(r.ts) };
    if (r.n >= 2 && r.avg >= 4) o.jobs.push(tag); else if (r.n >= 2 && r.avg <= 2) o.weak.push(tag);
  }
  return out;
}
const canTools = (m) => (m.sources || []).some((x) => (x.invoke || {}).kind === 'openai' && !x.retired) && (m.limits || {}).tools !== false && !m.leadOnly;
function publicView(m) {
  const b = BRANDS[m.brand] || BRANDS.custom;
  const tools = (m.tools || []).map((id) => (CONFIG.tools || []).find((t) => t.id === id)).filter(Boolean).map((t) => ({ id: t.id, name: t.name, kind: t.kind }));
  return {
    id: m.id, name: m.name, brand: m.brand || 'custom', brandName: b.name, color: b.color, letter: b.letter || (m.name || '?')[0].toUpperCase(), logo: LOGOS[m.brand] || null,
    intro: m.intro || '', tags: m.tags || [], tags_note: m.tags_note || '', jobs: m.jobsAll || [], weak: m.weakAll || [], jobs_note: m.jobs_note || '', ratings: m.ratings || {},
    exec: m.exec || { tags: [] }, tools, fc: canTools(m), caps: CAPS.capsOf(m), leadElig: CAPS.leadEligibility(m), leadOnly: !!m.leadOnly, limits: m.limits || {}, privacy: m.privacy || '', lead: (m.sources || [])[0]?.invoke?.kind === 'lead', steward: m.id === STEWARD, custom: !!m.custom, retired: !!m.retired,
    state: m.state, why: m.why, quota: m.quota, active: m.active,
    sources: m.srcs.map((x) => ({ ...x, kindLabel: (CONNECTORS[x.kind] || {}).label || x.kind, how: (CONNECTORS[x.kind] || {}).how || '' })),
  };
}

// ───────────────────────── 探测（每小时 cron；只用免费接口：/models、计费、心跳，不调模型） ─────────────────────────
async function fetchT(url, opt = {}, ms = 8000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort('timeout'), ms);
  try { return await fetch(url, { ...opt, signal: ac.signal }); } finally { clearTimeout(t); }
}
async function probeAll(env0) {
  const s = store(env0);
  const env = await withKeys(env0, s);
  const members = await loadMembers(s);
  const groups = new Map();
  for (const r of CONFIG.relays || []) {   // 中转站即使没有成员卡也探测，用于发现候选
    if (r.offline || !r.base || !env[r.secret]) continue;
    const key = r.base + '|' + r.secret; if (!groups.has(key)) groups.set(key, { iv: { base: r.base, secret: r.secret, relay: r }, list: [] });
  }
  for (const m of members) for (let i = 0; i < (m.sources || []).length; i++) {
    const src = m.sources[i];
    if (srcMissing(env, src).length) continue;
    const iv = srcInvoke(env, src); const k = skey(m, i);
    if ((iv.kind === 'openai' || iv.kind === 'image-openai') && !iv.secret && iv.health) {
      try { const r = await fetchT(iv.health, { redirect: 'manual' }, 8000); await setStatus(s, k, r.ok ? 'ok' : 'down', r.ok ? '' : `心跳 ${r.status}`, { probe: Date.now() }); }
      catch (e) { await setStatus(s, k, 'down', '心跳失败'); }
    } else if (iv.kind === 'openai' || iv.kind === 'image-openai') {
      const key = iv.base + '|' + iv.secret; if (!groups.has(key)) groups.set(key, { iv, list: [] });
      groups.get(key).list.push({ k, model: iv.model });
    } else if (iv.kind === 'gemini') {
      try { const r = await fetchT('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': env[iv.secret || 'GEMINI_API_KEY'] } }); await setStatus(s, k, r.ok ? 'ok' : 'down', r.ok ? '' : `探测 /models 返回 ${r.status}`); }
      catch (e) { await setStatus(s, k, 'down', '探测失败'); }
    } else if (['webhook', 'tunnel', 'tailscale'].includes(iv.kind) && !isPull(env, iv)) {
      const url = safeUrl(iv.health || iv.url || env[iv.url_secret]);
      if (!url) { await setStatus(s, k, 'down', '地址不合规（只允许公网 https）'); continue; }
      try { const r = await fetchT(url, { method: iv.health ? 'GET' : 'HEAD', redirect: 'manual' }, 5000); await setStatus(s, k, r.status < 500 ? 'ok' : 'down', r.status < 500 ? '' : `心跳 ${r.status}`); }
      catch (e) { await setStatus(s, k, 'down', '心跳失败'); }
    } else if (iv.kind === 'telegram') {
      try { const r = await fetchT(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`); await setStatus(s, k, r.ok ? 'ok' : 'down', r.ok ? '' : `getMe ${r.status}`); }
      catch (e) { await setStatus(s, k, 'down', 'Telegram 不通'); }
    }
  }
  for (const { iv, list } of groups.values()) {
    let models = null, state = 'down', err = '';
    try {
      const r = await fetchT(iv.base + '/models', { headers: { authorization: 'Bearer ' + env[iv.secret] }, redirect: 'manual' });
      if (r.ok) { const d = await r.json(); models = (d.data || []).map((x) => x.id).filter((x) => typeof x === 'string'); state = 'ok'; }
      else err = r.status === 401 || r.status === 403 ? `Key 无效或无权限（${r.status}）` : r.status === 429 ? '限流（429）' : `/models 返回 ${r.status}`;
    } catch (e) { err = '连不上'; }
    for (const x of list) {
      const bad = state === 'ok' && models && models.length && !models.includes(x.model);
      await setStatus(s, x.k, bad ? 'down' : state, bad ? '模型不在 /models 列表里（可能下架或改名）' : err, { probe: Date.now() });
    }
    if (iv.relay && models) { await kvSet(s, 'relay_models:' + iv.relay.id, models.slice(0, 80)); try { await syncRelayModels(s, iv.relay.id, models); } catch {} }
    if (iv.relay && iv.relay.panel === 'newapi' && state === 'ok') await probeBalance(env, s, iv);
  }
  await kvSet(s, 'last_probe', Date.now());
  return { ok: true, endpoints: groups.size };
}
// New API / One API 兼容计费接口（sk 令牌即可）：/dashboard/billing/subscription + /usage
async function probeBalance(env, s, iv) {
  const h = { authorization: 'Bearer ' + env[iv.secret] };
  try {
    const sub = await fetchT(iv.base + '/dashboard/billing/subscription', { headers: h, redirect: 'manual' });
    if (!sub.ok) return;
    const sd = await sub.json();
    const total = Number(sd.hard_limit_usd ?? sd.system_hard_limit_usd ?? 0);
    let used = null;
    const us = await fetchT(iv.base + '/dashboard/billing/usage', { headers: h, redirect: 'manual' });
    if (us.ok) { const ud = await us.json(); used = Number(ud.total_usage || 0) / 100; }
    if (total > 0 && total < 1e7) await kvSet(s, 'relay_balance:' + iv.relay.id, { total, remaining: used == null ? total : Math.max(0, total - used), unit: 'USD 额度', via: 'billing 接口', at: Date.now() });
    else if (total >= 1e7) await kvSet(s, 'relay_balance:' + iv.relay.id, { total: 0, remaining: null, unit: '令牌不限额（站点总余额看不到）', via: 'billing 接口', at: Date.now() });
  } catch {}
}

// ───────────────────────── 调用 ─────────────────────────
function extractText(r) {
  if (!r) return '';
  if (typeof r === 'string') return r;
  if (typeof r.response === 'string') return r.response;
  if (r.response && typeof r.response.text === 'string') return r.response.text;
  if (r.choices?.[0]?.message?.content) return r.choices[0].message.content;
  if (Array.isArray(r.output)) for (const o of r.output) if (o.type === 'message' && Array.isArray(o.content)) { const t = o.content.map((c) => c.text || '').join(''); if (t) return t; }
  return '';
}
function clean(t, name) {
  let x = String(t || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*?<\/think>/, '').trim();
  const esc = (name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (esc) x = x.replace(new RegExp('^[【\\[]?\\s*(\\*\\*)?' + esc + '(\\s*[（(][^）)]{1,16}[）)])?(\\*\\*)?\\s*[】\\]]?\\s*[:：]\\s*'), '');
  return x.trim();
}
const usageOf = (r) => { const u = r && r.usage; return u ? [u.prompt_tokens || u.input_tokens || 0, u.completion_tokens || u.output_tokens || 0] : null; };
async function callWorkersAI(env, src, system, user, maxTok) {
  const model = src.invoke.model;
  let r;
  if (model.startsWith('@cf/openai/gpt-oss')) r = await env.AI.run(model, { instructions: system, input: user, reasoning: { effort: 'low' }, max_output_tokens: maxTok + 400 });
  else {
    const thinking = model.includes('qwen3');
    r = await env.AI.run(model, { messages: [{ role: 'system', content: system }, { role: 'user', content: user + (thinking ? '\n/no_think' : '') }], max_tokens: thinking ? maxTok + 900 : maxTok, temperature: 0.7 });
  }
  const text = extractText(r);
  const u = usageOf(r) || [Math.ceil((system.length + user.length) / 1.5), Math.ceil(text.length / 1.2)];
  const [nin, nout] = src.neurons || [30000, 70000];
  return { text, tin: u[0], tout: u[1], neurons: (u[0] * nin + u[1] * nout) / 1e6 };
}
async function callOpenAI(env, iv, system, user, maxTok, retried, extra) {
  const messages = (extra && extra.messages) || [{ role: 'system', content: system }, { role: 'user', content: user }];
  const res = await fetchT(iv.base + '/chat/completions', {
    method: 'POST', redirect: 'manual', headers: { ...(iv.secret ? { authorization: `Bearer ${env[iv.secret]}` } : {}), 'content-type': 'application/json' },
    body: JSON.stringify({ model: iv.model, messages, max_tokens: maxTok + 600, ...(extra && extra.tools && extra.tools.length ? { tools: extra.tools, tool_choice: 'auto' } : {}) }),
  }, 60000);
  let rl = null;
  if (iv.rate_headers) { const lim = +res.headers.get('x-ratelimit-limit-requests'); if (lim) rl = { limit: lim, remaining: +res.headers.get('x-ratelimit-remaining-requests'), reset: res.headers.get('x-ratelimit-reset-requests') || '', at: Date.now() }; }
  if (!res.ok) {
    const body = await res.text();
    // 免 Key 公共端点（如 Pollinations 匿名档）按 IP 限速：「Retry after Ns」且 N ≤ 35 秒就等一次再试
    const ra = /retry after (\d+)\s*s/i.exec(body);
    if (!iv.secret && !retried && (res.status === 402 || res.status === 429) && ra && +ra[1] <= 35) { await new Promise((r) => setTimeout(r, (+ra[1] + 1) * 1000)); return callOpenAI(env, iv, system, user, maxTok, true, extra); }
    // 端点不支持 tools 参数：去掉 tools 再试一次（这次发言就不用工具）
    if (extra && extra.tools && extra.tools.length && res.status === 400 && /tool/i.test(body)) return callOpenAI(env, iv, system, user, maxTok, retried, { ...extra, tools: null, noTools: true });
    const e = new Error(`${res.status} ${body.slice(0, 200)}`); e.rl = rl; throw e;
  }
  const d = await res.json(); const u = usageOf(d) || [0, 0];
  const msg = d.choices?.[0]?.message || {};
  return { text: extractText(d), tin: u[0], tout: u[1], rl, toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [], msg, noTools: !!(extra && extra.noTools) };
}
async function callGemini(env, iv, system, user, maxTok) {
  const res = await fetchT(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(iv.model)}:generateContent`, {
    method: 'POST', headers: { 'x-goog-api-key': env[iv.secret || 'GEMINI_API_KEY'], 'content-type': 'application/json' },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { maxOutputTokens: maxTok + 600 } }),
  }, 60000);
  if (!res.ok) throw new Error(`gemini ${res.status}`);
  const d = await res.json(); const um = d.usageMetadata || {};
  return { text: (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join(''), tin: um.promptTokenCount || 0, tout: um.candidatesTokenCount || 0 };
}
async function callImage(env, iv, prompt) {
  const res = await fetchT(iv.base + '/images/generations', { method: 'POST', redirect: 'manual', headers: { authorization: `Bearer ${env[iv.secret]}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: iv.model, prompt: prompt.slice(0, 1500), n: 1 }) }, 90000);
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
  const d = await res.json(); const url = d.data?.[0]?.url;
  return { text: url && safeUrl(url) ? `生成了一张图：${url}` : '生成成功，但接口返回 base64 图片，本群暂不存图（只存链接）。', tin: 0, tout: 0 };
}

// ───────────────────────── 提示词 ─────────────────────────
const COMMON_RULES = `你在一个多 AI 群聊里，和其他 AI成员以及一位人类用户对话。规则：
1. 一律用简体中文回答。
2. 每次发言严格控制在 150 字以内（用户明确要求更长时除外）：最多 3 个要点，直接说重点，不要客套、不要复述别人的话、不要写总结段。
3. 你能看到完整聊天记录。不要随声附和：要指出具体的漏洞、反例、遗漏的条件或数据问题；只有被真正说服时才让步，并说清楚是被哪一点说服的。
4. 不要冒充其他成员，不要替别人发言，不要在开头写自己的名字。`;
const ROLE_BRIEF = {
  提议者: '你是提议者：对议题提出明确立场/方案和最有力的论据；后续轮次要正面回应质疑，不能回避。',
  挑错者: '你是挑错者：针对提议者（和其他人）的论点找具体漏洞、反例和隐藏前提，按严重程度排。',
  审查员: '你是审查员：不站队，逐条核查前面成员说法的事实和逻辑，指出谁的哪句话有问题、谁漏了什么。',
  裁判: '你是裁判，最后发言：给出明确结论，再列出仍有争议的点。格式：\n裁决：…\n理由：…\n仍有争议：…\n不超过 200 字。',
  写手: '你是写手：直接产出用户要的文字成品（不超过 600 字），文风贴合要求。',
  程序员: '你是程序员：给出可运行的代码或具体修改，代码之外的解释不超过 3 句。',
  翻译: '你是翻译：给出准确、自然的译文，必要时用一句话说明难译之处。',
  总结者: '你是总结者：把讨论或材料压缩成要点，标出结论和待办。',
  看图员: '你负责图片相关：描述/分析图片，或给出生图提示词。',
  执行者: '你是执行者：说明你会怎样完成这件需要动手的任务（注册/查资料/操作网页），完成后汇报结果。',
  成员: '你是被主持人点名的成员：直接回答主持人或用户点给你的问题，简洁具体；没点到的事别展开。',
  负责人: '你是负责人。',
};
function transcriptOf(messages, label) {
  const lines = [];
  for (const m of messages) {
    if (m.kind === 'user') lines.push(`【用户】${m.text}`);
    else if (m.kind === 'ai') lines.push(`【${label(m.member)}${m.role ? '（' + m.role + '）' : ''}】${m.text}`);
    else if (m.kind === 'lead') lines.push(`【Hark（负责人）】${m.text}`);
    else if (m.kind === 'note' && m.text.startsWith('—— 再')) lines.push(`（${m.text.replace(/—/g, '').trim()}）`);
  }
  let out = lines.join('\n\n');
  if (out.length > CTX_CHARS) { const first = lines.find((l) => l.startsWith('【用户】')) || ''; out = first.slice(0, 1500) + '\n\n……（中间省略）……\n\n' + out.slice(-(CTX_CHARS - 1600)); }
  return out;
}

// ───────────────────────── Hark：岗位标签 × 剩余额度 × 在线状态 → 自动派工 ─────────────────────────
const TOPIC_JOBS = [
  ['代码', /代码|编程|程序|bug|报错|函数|脚本|python|javascript|\bjs\b|sql|部署|重构|\bcode\b/i],
  ['长文写作', /小说|故事|文案|写作|作文|诗|剧本|文章|润色|标题|小红书|帖子/i],
  ['翻译', /翻译|英译|中译|译成|translate|英文版|日文版/i],
  ['推理裁判', /数学|计算|证明|概率|方程|为什么|原因|分析|推理|利弊|该不该|是否应该|评估|比较/i],
  ['总结', /总结|摘要|概括|长文|文档|会议纪要|提炼/i],
  ['看图', /图片里|看图|截图|照片|识别图/i],
  ['生图', /生图|画一张|画个|出图|海报|插画|生成图片/i],
  ['挑错审查', /审查|挑错|检查|review|评审|核对/i],
  ['注册执行', /注册|开户|申请账号|创建账号|sign ?up|签到/i],
  ['查网页', /查一下|搜索|查资料|最新|新闻|官网|查信息/i],
  ['收验证码', /验证码|短信/i],
  ['邮件日历', /邮件|日历|提醒我/i],
];
const EXEC_JOBS = new Set(['注册执行', '查网页', '收验证码', '邮件日历', '签到巡检']);
function topicJobs(topic) { const t = new Set(['中文对话']); for (const [j, re] of TOPIC_JOBS) if (re.test(topic)) t.add(j); return t; }
function jobsOf(m) { return new Set([...(m.jobsAll || []).map((x) => x.t), ...((m.exec && m.exec.tags) || []).map((t) => ({ 查网页: '查网页', 注册账号: '注册执行', 收短信验证码: '收验证码', 收邮件验证码: '收验证码' }[t] || t))]); }
function weakOf(m) { return new Set([...(m.weakAll || []).map((x) => x.t), ...(m.tags || []).filter((x) => /偏弱|一般|弱$/.test(x.t)).map((x) => x.t)]); }
function rolesFor(mode, tj) {
  if (mode === 'task' || [...tj].some((j) => EXEC_JOBS.has(j))) return ['执行者', '审查员'];
  if (tj.has('生图')) return ['看图员', '提议者', '挑错者', '裁判'];
  const base = ['提议者', '挑错者', '审查员', '裁判'];
  if (tj.has('代码')) base[0] = '程序员'; else if (tj.has('长文写作')) base[0] = '写手'; else if (tj.has('翻译')) base[0] = '翻译'; else if (tj.has('总结')) base.splice(3, 0, '总结者');
  return base;
}
function wantJobs(role, tj) {
  return new Set({
    提议者: [...tj, '推理裁判'], 挑错者: ['挑错审查', '推理裁判'], 审查员: ['挑错审查', '推理裁判', ...(tj.has('代码') ? ['代码'] : [])], 裁判: ['推理裁判', '中文对话'],
    写手: ['长文写作', '中文对话'], 程序员: ['代码', '工具调用'], 翻译: ['翻译', '中文对话'], 总结者: ['总结', '长文检索', '中文对话'], 看图员: ['看图', '生图'],
    执行者: [...tj].filter((j) => EXEC_JOBS.has(j)).concat(['注册执行', '查网页']),
  }[role] || [...tj]);
}
const isChatty = (m) => m.srcs.some((x) => ['workers-ai', 'openai', 'gemini'].includes(x.kind) && x.state !== 'down');
function scoreMember(m, role, tj, chosen) {
  if (m.id === STEWARD) return null;   // 资源管家只在私聊工作，不进项目群
  if (publicLead(m)) {  // Hark 只在「执行者」岗位参与，而且要它的拉取渠道在线
    if (role !== '执行者' || !m.srcs.some((x) => x.kind === 'bridge' && x.state === 'ok')) return null;
  }
  const mj = jobsOf(m); const w = wantJobs(role, tj); const hits = [...w].filter((t) => mj.has(t));
  if (role === '执行者' && !hits.some((h) => EXEC_JOBS.has(h))) return null;       // 动手的活只派有执行能力的成员
  if (role === '看图员' && !mj.has('看图') && !mj.has('生图')) return null;
  if (role !== '执行者' && role !== '看图员' && !isChatty(m)) return null;         // 讨论角色派能即时回复的成员
  if (m.quota.pct === 0) return null;
  const pct = m.quota.pct == null ? 0.5 : m.quota.pct;
  // 实测分（用户打分/互评）优先于口碑标签
  let rated = 0; for (const [k, v] of Object.entries(m.ratings || {})) if (w.has(k.split('·')[0])) rated += (v.avg - 3) * Math.min(v.n, 5) * 0.6;
  let sc = hits.length * 3 + pct * 2 + (m.state === 'ok' ? 1 : 0) + rated;
  const why = [];
  if (hits.length) why.push('擅长：' + hits.join('、'));
  if (rated) why.push(`实测分 ${rated > 0 ? '+' : ''}${rated.toFixed(1)}`);
  const wk = weakOf(m);
  if (tj.has('中文对话') && wk.has('中文偏弱')) { sc -= 1.5; why.push('中文偏弱'); }
  for (const j of w) if (wk.has(j)) { sc -= 2; why.push('不擅长 ' + j); }
  if (m.quota.low) { sc -= 3; why.push('额度低'); }
  if (chosen.some((c) => c.brand === m.brand)) sc -= 2;
  if (m.srcs.every((x) => x.untested)) sc -= 1;
  if (!(m.jobsAll || []).length) sc -= 1; // 擅长岗位待定的成员不主动派
  why.push(m.quota.pct == null ? `额度：${m.quota.source || '未知'}` : `额度 ${Math.round(m.quota.pct * 100)}%（${m.quota.source}）`);
  why.push(m.state === 'ok' ? '在线' : '未探测');
  return { sc, why: why.join('；') };
}
function heuristicPlan(all, topic, mode, opts = {}) {
  const tj = topicJobs(topic);
  const roles = opts.roles || rolesFor(mode, tj);
  const pool = all.filter((m) => m.state !== 'down' && !m.retired && !m.leadOnly && (!opts.pool || opts.pool.includes(m.id)) && !(opts.exclude || []).includes(m.id));
  const chosen = []; const picked = {};
  // 挑人顺序：主岗位 → 裁判 → 其余（裁判要最强的推理，别被前面的角色先抢走）
  const pickOrder = [roles[0], ...roles.filter((r, i) => i > 0 && r === '裁判'), ...roles.filter((r, i) => i > 0 && r !== '裁判')];
  for (const role of pickOrder) {
    let best = null;
    for (const m of pool) { if (chosen.includes(m)) continue; const r = scoreMember(m, role, tj, chosen); if (r && (!best || r.sc > best.sc)) best = { m, ...r }; }
    if (best) { chosen.push(best.m); picked[role] = { id: best.m.id, role, reason: best.why }; }
  }
  const out = roles.map((r) => picked[r]).filter(Boolean);
  return { members: out, tags: [...tj], roles };
}
const publicLead = (m) => (m.sources || [])[0]?.invoke?.kind === 'lead';
async function aiRefine(env, s, all, topic, mode, plan) {
  const lead = all.find((m) => m.id === 'hark');
  const engines = (lead && lead.sources[0].invoke.engine) || [];
  const cands = all.filter((m) => m.state !== 'down' && !m.leadOnly && isChatty(m) && m.quota.pct !== 0).slice(0, 30);
  const table = cands.map((m) => `${m.id} | 擅长:${[...jobsOf(m)].join('/') || '待定'} | 不擅长:${[...weakOf(m)].join('/') || '—'} | 额度:${m.quota.pct == null ? '?' : Math.round(m.quota.pct * 100) + '%'}`).join('\n');
  const sys = '你是群聊负责人 Hark。只输出 JSON 数组，不要任何其他文字。';
  const user = `议题：${topic.slice(0, 800)}\n模式：${MODES[mode] || mode}\n需要的角色：${plan.roles.join('、')}\n候选 AI成员（id | 擅长岗位 | 不擅长 | 剩余额度）：\n${table}\n\n规则：每个角色选一个不同的成员；按擅长岗位匹配、额度高、不同厂商优先；裁判要推理强、中文好。\n输出：[{"id":"…","role":"…","reason":"一句话"}]`;
  for (const e of engines) {
    if (e === 'heuristic') break;
    const kind = e.slice(0, e.indexOf(':')), model = e.slice(e.indexOf(':') + 1);
    try {
      let r;
      if (kind === 'cf') { if ((await kvGet(s, 'cf_exhausted')) === utcDay()) continue; r = await callWorkersAI(env, { invoke: { model }, neurons: [31818, 68182] }, sys, user, 500); await addUsage(s, 'hark', r.tin, r.tout, r.neurons); }
      else if (kind === 'groq' && env.GROQ_API_KEY) r = await callOpenAI(env, { base: 'https://api.groq.com/openai/v1', model, secret: 'GROQ_API_KEY' }, sys, user, 500);
      else continue;
      const mj = (r.text || '').match(/\[[\s\S]*\]/); if (!mj) continue;
      const ids = new Set(cands.map((m) => m.id)); const used = new Set(); const out = [];
      for (const x of JSON.parse(mj[0])) if (x && ids.has(x.id) && ROLES.includes(x.role) && !used.has(x.id)) { used.add(x.id); out.push({ id: x.id, role: x.role, reason: String(x.reason || '').slice(0, 120) + '（Hark 用 ' + model.split('/').pop() + ' 复核）' }); }
      if (out.length >= Math.min(2, plan.members.length)) return { ...plan, members: out, engine: model.split('/').pop() + ' 复核' };
    } catch (err) { if (kind === 'cf' && isQuotaError(String(err))) await kvSet(s, 'cf_exhausted', utcDay()); }
  }
  return { ...plan, engine: '规则（不耗额度）' };
}
const sortRoles = (list) => [...list].sort((a, b) => (a.role === '裁判') - (b.role === '裁判'));
function planText(all, members, engine, tags) {
  const name = (id) => (all.find((m) => m.id === id) || {}).name || id;
  if (!members.length) return '没有可派的 AI成员（都离线、缺密钥或额度用完）。到「AI成员」页看看哪些是红点。';
  return `本轮分工（${engine}；识别到的需求：${(tags || []).join('、')}）：\n` + members.map((x) => `· ${name(x.id)}（${x.role}）— ${x.reason}`).join('\n');
}

// ───────────────────────── 房间 = 项目 ─────────────────────────
const LEGACY = { pro: ['gpt-oss-120b', '提议者'], con: ['llama-4-scout-17b', '挑错者'], rev: ['mistral-small-3.1-24b', '审查员'], judge: ['qwen3-30b-a3b', '裁判'] };
const LEGACY_LINEUP = Object.values(LEGACY).map(([id, role]) => ({ id, role }));
function roomLineup(r) { if (!r || !r.members) return LEGACY_LINEUP; try { const x = JSON.parse(r.members); return Array.isArray(x) && x.length ? x : LEGACY_LINEUP; } catch { return LEGACY_LINEUP; } }
const normMsg = (m) => (LEGACY[m.member] ? { ...m, member: LEGACY[m.member][0], role: m.role || LEGACY[m.member][1] } : m);
async function getRoom(s, id) {
  const r = (await s.q("SELECT id,title,mode,created,updated,members,COALESCE(status,'进行中') AS status, COALESCE(sens,0) AS sens, idea FROM rooms WHERE id=?", id))[0];
  if (!r) return null;
  if (r.idea) { const it = await ideaGet(s, r.idea); r.idea = it ? { id: it.id, title: it.title, status: it.status } : null; r.ideaCtx = it ? P1.ideaContext(it) : ''; } else { r.idea = null; r.ideaCtx = ''; }
  r.lineup = roomLineup(r); r.legacy = !r.members; delete r.members;
  r.messages = (await s.q('SELECT id,kind,member,model,text,ts,role FROM msgs WHERE room=? ORDER BY id', id)).map(normMsg);
  for (const m of r.messages) if (m.kind === 'decision') { const d = await kvGet(s, 'decision:' + m.id); m.decision = { options: (d && d.options) || [], choice: (d && d.choice) || null, at: (d && d.at) || null }; }   // N3
  r.paused = !!(await kvGet(s, 'pause:' + id));   // N2
  r.pending = await s.q("SELECT id,member,role,status,created FROM tasks WHERE room=? AND status IN ('pending','sent') ORDER BY created", id);
  return r;
}
async function addMsg(s, room, kind, member, model, text, role) {
  const now = Date.now();
  const test = room === STEWARD_ROOM && (await testModeOn(s)) ? 1 : 0;   // 测试模式下写进资源管家私聊的消息打标记，测试结束统一删除
  await s.batch([['INSERT INTO msgs(room,kind,member,model,text,ts,role,test) VALUES(?,?,?,?,?,?,?,?)', [room, kind, member || '', model || '', text, now, role || '', test]], ['UPDATE rooms SET updated=? WHERE id=?', [now, room]]]);
}
async function addMsgId(s, room, kind, member, model, text, role) {   // 同 addMsg，但返回消息 id（决策题要用）
  const now = Date.now();
  const r = await s.q('INSERT INTO msgs(room,kind,member,model,text,ts,role,test) VALUES(?,?,?,?,?,?,?,0) RETURNING id', room, kind, member || '', model || '', text, now, role || '');
  await s.q('UPDATE rooms SET updated=? WHERE id=?', now, room); return r[0].id;
}
// ───── 测试模式（test_live.py 用，避免污染用户数据）─────
// POST /api/testmode {on:true}：快照下列 kv，之后 20 分钟内写进资源管家私聊的消息打 test=1、完成推送不发；
// POST /api/testmode {on:false}（或过期后的 cron）：删掉 test=1 消息、kv 还原到快照。
const TESTMODE_KEYS = ['lead_cfg', 'op_tokens', 'handoff_note', 'route_policy', 'notify', 'steward_week', 'steward_weekly_last', 'model_pool', 'model_extra', 'model_pool_dismissed', 'lead_inelig_note:p', 'lead_inelig_note:s'];
async function testModeOn(s) { const t = await kvGet(s, 'testmode'); return !!(t && t.until > Date.now()); }
async function testModeBegin(s) {
  const old = await kvGet(s, 'testmode'); if (old) await testModeEnd(s);
  const snap = {}; for (const k of TESTMODE_KEYS) snap[k] = await kvGet(s, k);
  await kvSet(s, 'testmode', { until: Date.now() + 20 * 60000, snap, at: Date.now() });
  return { ok: true, until: Date.now() + 20 * 60000 };
}
async function testModeEnd(s) {
  const t = await kvGet(s, 'testmode'); if (!t) return { ok: true, purged: 0, restored: [] };
  const n = (await s.q('SELECT COUNT(*) AS n FROM msgs WHERE room=? AND test=1', STEWARD_ROOM))[0].n;
  await s.q('DELETE FROM msgs WHERE room=? AND test=1', STEWARD_ROOM);
  await s.q('DELETE FROM res_items WHERE test=1'); await s.q('DELETE FROM subs WHERE test=1');   // P1-5：测试期间代收的条目和记录
  await s.q("UPDATE tasks SET status='failed' WHERE kind='web' AND status IN ('pending','sent') AND ext LIKE '%\"test\":true%'");   // P1-2：测试期间排的网页任务作废
  const R0 = (await kvGet(s, 'web_relays')) || {}; let rch = false; for (const k of Object.keys(R0)) if (R0[k].test) { delete R0[k]; rch = true; } if (rch) await kvSet(s, 'web_relays', R0);   // 测试代发员一并清掉
  const restored = [];
  for (const k of TESTMODE_KEYS) { const v = (t.snap || {})[k]; if (v === null || v === undefined) await s.q('DELETE FROM kv WHERE k=?', k); else await kvSet(s, k, v); restored.push(k); }
  await s.q("DELETE FROM kv WHERE k='testmode'");
  return { ok: true, purged: n, restored };
}
async function setLineup(s, room, lineup) {
  const now = Date.now();
  const ops = [['UPDATE rooms SET members=?, updated=? WHERE id=?', [JSON.stringify(lineup), now, room]]];
  for (const x of lineup) ops.push(['INSERT INTO parts(room,member,role,joined) VALUES(?,?,?,?) ON CONFLICT(room,member) DO UPDATE SET role=excluded.role', [room, x.id, x.role, now]]);
  await s.batch(ops);
}
function cleanLineup(list, ids) {
  const out = []; const seen = new Set();
  for (const x of Array.isArray(list) ? list : []) {
    if (!x || typeof x.id !== 'string' || !ids.has(x.id) || seen.has(x.id) || x.id === STEWARD || x.id.startsWith('lead-') || (x.id === 'hark' && x.role !== '执行者')) continue;
    seen.add(x.id); out.push({ id: x.id, role: ROLES.includes(x.role) && x.role !== '负责人' ? x.role : '审查员' });
    if (out.length >= 8) break;
  }
  return out;
}
async function startRound(env, s, body, all) {
  const quick = body.quick === true && !body.room;   // P1-4 快速建项目：全员加入、主持模式
  const mode = quick ? 'host' : (MODES[body.mode] ? body.mode : 'debate');
  const message = typeof body.message === 'string' ? body.message.trim().slice(0, MAX_MSG) : '';
  let room = typeof body.room === 'string' && ROOM_RE.test(body.room) ? body.room : null;
  const exists = room ? await getRoom(s, room) : null;
  if (room && !exists) return { error: '房间不存在' };
  if (room === STEWARD_ROOM) return { error: '这是资源管家的私聊，请直接发消息给它' };
  if (!room && !message) return { error: '新项目需要先说点什么' };
  let ideaId = null;
  if (!exists && body.idea != null && body.idea !== '') { ideaId = String(body.idea); if (!(await ideaGet(s, ideaId))) return { error: '没有这个点子' }; }
  const ids = new Set(all.map((m) => m.id));
  let lineup = Array.isArray(body.members) ? cleanLineup(body.members, ids) : null;
  let planNote = null;
  if (quick) {
    lineup = P1.quickLineup(all.map((m) => ({ id: m.id, state: m.state, retired: m.retired, leadOnly: m.leadOnly, steward: m.id === STEWARD, lead: ((m.sources || [])[0] || {}).invoke?.kind === 'lead' })));
    if (!lineup.length) return { error: '现在没有可用的成员，没法快速建项目' };
  }
  if (!exists) {
    room = rid();
    let lp = null;
    if (!lineup || !lineup.length) {
      const base = heuristicPlan(all, message, mode);
      lp = await leadPlan(env, s, all, message, mode, base, { ai: !!body.ai, sens: !!body.sensitive, promote: true });
      const plan = lp.async ? { ...base, engine: '规则暂定（等负责人回复）' } : lp.plan;
      lineup = plan.members.map(({ id, role }) => ({ id, role }));
      planNote = planText(all, plan.members, plan.engine, plan.tags);
    } else if (quick) planNote = `快速建项目：全员加入（${lineup.length} 位），由负责人主持点名；你也可以 @ 指定成员。`;
    else if (typeof body.planNote === 'string') planNote = body.planNote.slice(0, 1500);
    const now = Date.now();
    await s.q("INSERT INTO rooms(id,title,mode,created,updated,members,status,sens,idea) VALUES(?,?,?,?,?,?,'进行中',?,?)", room, (typeof body.title === 'string' && body.title.trim() ? body.title : message).slice(0, 40), mode, now, now, JSON.stringify(lineup), body.sensitive ? 1 : 0, ideaId);
    await setLineup(s, room, lineup);
    if (lp) {
      if (message) await addMsg(s, room, 'user', '', '', message, '');
      for (const n of lp.notes) await addMsg(s, room, 'note', '', '', n, '');
      const lead = lp.lead || all.find((x) => x.id === 'hark');
      await kvSet(s, 'room_lead:' + room, { id: lead ? lead.id : 'hark' });
      if (lp.async) {
        const cfg = await leadCfg(s);
        const w = await leadDispatch(env, s, room, lp.lead, lp.src, message, mode, heuristicPlan(all, message, mode), all, cfg);
        if (w) { await addMsg(s, room, 'lead', lp.lead.id, '', `已请${LEAD_LABEL[lp.slot]} ${lp.lead.name} 分工，最多等 ${Math.round((+cfg.timeoutSec || 180) / 6) / 10} 分钟；它回复前先按规则暂定：\n` + planNote.replace(/^本轮分工[^\n]*\n/, ''), '负责人'); return { room, mode, lineup: sortRoles(lineup), planNote, leadWait: w, posted: true }; }
        await addMsg(s, room, 'note', '', '', `${LEAD_LABEL[lp.slot]} ${lp.lead.name} 发不出去，先按规则派工。`, '');
        await kvSet(s, 'room_lead:' + room, { id: 'hark' });
      }
      if (planNote) await addMsg(s, room, 'lead', lp.async ? 'hark' : (lead ? lead.id : 'hark'), '', planNote, '负责人');
      return { room, mode, lineup: sortRoles(lineup), planNote, posted: true };
    }
  } else {
    await s.q("UPDATE rooms SET mode=?, updated=?, status='进行中' WHERE id=?", mode, Date.now(), room);
    await kvDel(s, 'pause:' + room);   // N2：用户发新消息或点「再来一轮」= 继续（复审后自查采纳）
    if (lineup && lineup.length) await setLineup(s, room, lineup); else lineup = exists.lineup;
  }
  if (message) await addMsg(s, room, 'user', '', '', message, '');
  else await addMsg(s, room, 'note', '', '', `—— 再来一轮（${MODES[mode]}）——`, '');
  if (planNote) await addMsg(s, room, 'lead', exists ? await roomLeadId(s, room) : 'hark', '', planNote, '负责人');
  // P1-4：@ 点名优先（任何模式）；主持模式由负责人从项目成员里点 1–3 位；项目阵容本身不变
  const nameOf = (id) => (all.find((m) => m.id === id) || {}).name || id;
  let speakers = lineup;
  const named = message ? P1.parseMentions(message, lineup.map((x) => ({ ...x, name: nameOf(x.id) }))) : [];
  if (named.length) {
    speakers = named.map(({ id, role }) => ({ id, role }));
    await addMsg(s, room, 'note', '', '', `你点名了：${named.map((x) => x.name).join('、')}——本轮只请${named.length > 1 ? '他们' : '这位'}发言。`, '');
  } else if (mode === 'host') {
    const ranked = heuristicPlan(all, message || (exists && exists.title) || '', 'debate', { pool: lineup.map((x) => x.id) }).members.map((x) => x.id);
    speakers = P1.hostPick(lineup, ranked);
    const lid = exists ? await roomLeadId(s, room) : 'hark';
    await addMsg(s, room, 'lead', lid || 'hark', '', `主持人点名：${speakers.map((x) => nameOf(x.id)).join('、')}。其他成员这轮先听；想指定谁，就 @ 他。`, '负责人');
  }
  return { room, mode, lineup: sortRoles(speakers), planNote, roster: lineup.length };
}

// OpenAI 兼容来源 + 工具网关：最多 2 轮工具调用，结果写进这次发言之前的上下文；每次工具调用都写 calls
async function turnWithTools(env, s, room, m, iv, system, user, maxTok) {
  const fns = canTools(m) ? gwFunctions(env) : [];
  if (!fns.length) return callOpenAI(env, iv, system, user, maxTok);
  const sys2 = system + '\n\n你可以调用工具（函数）：需要查网页、算数或验证代码时再用，别为了用而用。花钱或不可逆的动作会先等用户确认。';
  const messages = [{ role: 'system', content: sys2 }, { role: 'user', content: user }];
  let tin = 0, tout = 0, r;
  for (let round = 0; round < 3; round++) {
    r = await callOpenAI(env, iv, sys2, user, maxTok, false, { messages, tools: round < 2 ? fns : null });
    tin += r.tin; tout += r.tout;
    if (!r.toolCalls.length || round === 2) break;
    messages.push({ role: 'assistant', content: r.msg.content || '', tool_calls: r.toolCalls });
    for (const tc of r.toolCalls.slice(0, 3)) {
      let a = {}; try { a = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch {}
      const fn = tc.function && tc.function.name;
      const res = fn === 'use_tool' ? await gatewayCall(env, s, { member: m.id, room, toolId: a.tool, action: a.action, args: a.args || {} })
        : await gatewayCall(env, s, { member: m.id, room, toolId: null, action: fn, args: a });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: String(res.text || '').slice(0, 4000) });
    }
  }
  return { ...r, tin, tout };
}
// 一次发言：按渠道顺序自动挑可用的；全部不可用 → Hark 换人（借鉴 DigitalJulius：额度不足自动换人）
async function runTurn(env, s, room, memberId, opts = {}) {
  const r0 = await getRoom(s, room);
  if (!r0) return { error: '房间不存在' };
  const all = opts.all || await enrichAll(env, s);
  const slot = r0.lineup.find((x) => x.id === memberId);
  if (!slot) return { error: '这个 AI成员 不在本房间' };
  if (r0.paused) return { member: memberId, skipped: true, paused: true, notice: '项目已暂停，下一位不启动' };   // N2
  const m = all.find((x) => x.id === memberId);
  const mode = MODES[opts.mode] ? opts.mode : (MODES[r0.mode] ? r0.mode : 'debate');
  if (!m || m.state === 'down') return replace(env, s, r0, slot, m, all, mode, opts);
  const role = slot.role;
  const label = (id) => (all.find((x) => x.id === id) || {}).name || id;
  const roster = r0.lineup.map((x) => `${label(x.id)}（${x.role}）`).join('、');
  const system = `${COMMON_RULES}\n\n你在群里的名字是「${m.name}」，本群角色：${role}。群成员：${roster}。当前模式：${MODES[mode]}。\n${ROLE_BRIEF[role] || ''}` + (r0.ideaCtx ? `\n\n【项目背景（本项目关联的点子，所有成员共享）】\n${r0.ideaCtx}` : '');
  const tr = transcriptOf(r0.messages, label);
  const long = ['写手', '程序员', '翻译'].includes(role);
  const user = `以下是群聊的完整记录：\n\n${tr}\n\n现在轮到你（${m.name}，${role}）发言。直接给出你的发言内容（${role === '裁判' ? '不超过 200 字' : long ? '按角色要求' : '不超过 150 字'}）。`;
  const maxTok = role === '裁判' ? 700 : long ? 1200 : 500;
  const errors = [];
  const policy = r0.sens ? await routePolicy(s) : null; const blocked = [];
  for (const i of m.order) {
    const sv = m.srcs[i]; if (sv.state === 'down') continue;
    const src = m.sources[i]; const iv = srcInvoke(env, src); const k = skey(m, i);
    // 敏感项目：中转站/公益站/免 Key 公共接口一律不发，不静默换源；记审计
    if (policy && policy.blockRelay && ['relay', 'public', 'web'].includes(srcLevel(src))) { blocked.push(sv.via); await audit(s, room, m.id, src, 'blocked', '敏感项目不发' + LEVELS[srcLevel(src)]); continue; }
    if (policy && policy.blockHark !== false && (iv.kind === 'hark' || iv.kind === 'pair')) { blocked.push(sv.via); await audit(s, room, m.id, src, 'blocked', '敏感项目默认不派给外部 Hark / 关联智能体'); continue; }
    if (r0.sens) await audit(s, room, m.id, src, 'used', LEVELS[srcLevel(src)]);
    if (ASYNC_KINDS.includes(iv.kind)) return dispatchAsync(env, s, room, m, i, role, mode, system, user, tr, { roster, background: r0.ideaCtx, lastUser: ([...r0.messages].reverse().find((x) => x.kind === 'user') || {}).text || r0.title });
    const t0 = Date.now();
    try {
      let r;
      if (iv.kind === 'workers-ai') r = await callWorkersAI(env, src, system, user, maxTok);
      else if (iv.kind === 'openai') r = await turnWithTools(env, s, room, m, iv, system, user, maxTok);
      else if (iv.kind === 'gemini') r = await callGemini(env, iv, system, user, maxTok);
      else if (iv.kind === 'image-openai') { const last = [...r0.messages].reverse().find((x) => x.kind === 'user'); r = await callImage(env, iv, (last && last.text) || r0.title); }
      else continue;
      await addUsage(s, k, r.tin, r.tout, r.neurons || 0);
      const text = clean(r.text, m.name);
      if (!text) throw new Error('空回复');
      await logCall(s, { member: m.id, room, kind: 'model', name: sv.via, action: (iv.model || iv.kind) + ' · ' + role, ok: 1, ms: Date.now() - t0, tin: r.tin, tout: r.tout });
      await setStatus(s, k, 'ok', '', r.rl ? { rl: r.rl, last_ok: Date.now() } : { last_ok: Date.now() });
      await addMsg(s, room, 'ai', m.id, `${iv.model || iv.kind} · ${sv.via}`, text, role);
      if (role === '裁判') { try { await notifyDone(env, s, room); } catch {} }
      return { member: m.id, name: m.name, role, model: iv.model, via: sv.via, text };
    } catch (e) {
      const msg = String((e && e.message) || e); const quota = isQuotaError(msg);
      await logCall(s, { member: m.id, room, kind: 'model', name: sv.via, action: (iv.model || iv.kind) + ' · ' + role, ok: 0, ms: Date.now() - t0, detail: msg });
      if (quota && iv.kind === 'workers-ai') await kvSet(s, 'cf_exhausted', utcDay());
      await setStatus(s, k, 'down', (quota ? '额度用完/限流：' : '出错：') + msg.slice(0, 160), e.rl ? { rl: e.rl } : {});
      errors.push(`${sv.via}: ${msg.slice(0, 80)}`);
    }
  }
  if (blocked.length && !errors.length) {
    const note = `${m.name}（${role}）这次暂停：本项目标了「敏感」，它能用的来源只有 ${blocked.join('、')}（中转站/公益站/公共接口），不发过去，也不悄悄换别的来源。要让它发言，可在「设置 → 敏感内容与来源路由」关掉限制，或换一位有官方 API 来源的成员。`;
    await addMsg(s, room, 'note', m.id, '', note, role);
    return { member: m.id, name: m.name, role, skipped: true, notice: note, blocked };
  }
  // 所有渠道都失败 → 换人
  if (!opts.noReplace) { const fresh = await enrichAll(env, s); return replace(env, s, r0, slot, fresh.find((x) => x.id === memberId), fresh, mode, { ...opts, errors }); }
  const note = `${m.name}所有渠道都失败，已跳过`;
  await addMsg(s, room, 'note', m.id, '', note, role);
  return { member: m.id, name: m.name, role, skipped: true, notice: note, errors };
}
async function replace(env, s, r0, slot, m, all, mode, opts) {
  const why = m ? m.why : '配置里找不到';
  const lastUser = [...r0.messages].reverse().find((x) => x.kind === 'user');
  const rep = heuristicPlan(all, (lastUser && lastUser.text) || r0.title || '', mode, { roles: [slot.role], exclude: r0.lineup.map((x) => x.id) }).members[0];
  const oldName = m ? m.name : slot.id;
  if (!rep) {
    const note = `${oldName}（${slot.role}）不可用：${why}；没有可替补的 AI成员，已跳过`;
    await addMsg(s, r0.id, 'note', slot.id, '', note, slot.role);
    return { member: slot.id, skipped: true, notice: note, errors: opts.errors };
  }
  await setLineup(s, r0.id, r0.lineup.map((x) => (x.id === slot.id ? { id: rep.id, role: slot.role } : x)));
  const repM = all.find((x) => x.id === rep.id);
  const note = `${oldName} 不可用（${why}），换 ${repM.name} 接替${slot.role}。理由：${rep.reason}`;
  await addMsg(s, r0.id, 'lead', await roomLeadId(s, r0.id), '', note, '负责人');
  const res = await runTurn(env, s, r0.id, rep.id, { ...opts, all, noReplace: true });
  return { ...res, replaced: { from: slot.id, to: rep.id, note } };
}
async function dispatchAsync(env, s, room, m, i, role, mode, system, user, transcript, wctx = {}) {
  const iv = srcInvoke(env, m.sources[i]); const k = skey(m, i);
  if (iv.kind === 'web') return webEnqueue(env, s, room, m, i, role, mode, transcript, wctx);
  const task = rid(16);
  const origin = env.PUBLIC_ORIGIN || 'https://chat.pcmanai.com';
  const token = await memberToken(env, m.id);
  await s.q('INSERT INTO tasks(id,room,member,role,status,created,prompt,ext) VALUES(?,?,?,?,?,?,?,?)', task, room, m.id, role, 'pending', Date.now(), (system + '\n\n' + user).slice(0, 12000), '');
  const payload = { type: 'agc.task', task, room, member: m.id, name: m.name, role, mode, system, prompt: user, transcript: transcript.slice(-6000), callback: { url: `${origin}/hook/reply`, token, body: { task, text: '…' } } };
  try {
    let note;
    if (iv.kind === 'poke') {
      const msg = `[${PRODUCT.short} 任务 ${task}] 你在群里的角色：${role}。\n${user.slice(-3000)}\n\n请把你的回复 HTTP POST 到 ${origin}/hook/reply ，JSON：{"task":"${task}","text":"你的回复"}，请求头 Authorization: Bearer ${token}`;
      const r = await fetchT('https://poke.com/api/v1/inbound/api-message', { method: 'POST', headers: { authorization: `Bearer ${env[iv.secret || 'POKE_API_KEY']}`, 'content-type': 'application/json' }, body: JSON.stringify({ message: msg }) }, 15000);
      if (!r.ok) throw new Error('Poke API ' + r.status);
      note = `已发给 ${m.name}，等它回调`;
    } else if (iv.kind === 'telegram') {
      const r = await fetchT(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: iv.chat, text: `#${task} ${m.name}（${role}）\n${user.slice(-3500)}\n\n请引用这条消息回复。` }) }, 15000);
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error('Telegram ' + r.status);
      await s.q('UPDATE tasks SET ext=? WHERE id=?', String(d.result.message_id), task);
      note = `已发到 Telegram，等 ${m.name} 回复`;
    } else if (isPull(env, iv)) {
      note = `已排队，等 ${m.name} 的小桥来拉取`;
    } else {
      const url = safeUrl(iv.url || env[iv.url_secret]);
      if (!url) throw new Error('地址不合规（只允许公网 https）');
      const body = JSON.stringify(payload); const ts = String(Date.now());
      const secretVal = iv.secret && env[iv.secret];
      const headers = { 'content-type': 'application/json', 'x-agc-timestamp': ts, 'x-agc-signature': await hmacHex(secretVal || token, ts + '.' + body) };
      if (secretVal) headers.authorization = 'Bearer ' + secretVal;
      const r = await fetchT(url, { method: 'POST', headers, body, redirect: 'manual' }, 25000);
      if (!r.ok) throw new Error('Webhook ' + r.status);
      let d = null; try { d = await r.json(); } catch {}
      await setStatus(s, k, 'ok', '', { last_sent: Date.now() });
      if (d && typeof d.text === 'string' && d.text.trim()) { await completeTask(s, task, m.id, d.text, k); return { member: m.id, name: m.name, role, text: clean(d.text, m.name), via: m.srcs[i].via }; }
      note = `已发给 ${m.name}，等它回调`;
    }
    return { member: m.id, name: m.name, role, pending: true, task, notice: note, via: m.srcs[i].via };
  } catch (e) {
    await s.q("UPDATE tasks SET status='failed' WHERE id=?", task);
    await setStatus(s, k, 'down', '发送失败：' + String(e.message || e).slice(0, 120));
    const n = `${m.name}连不上（${String(e.message || e).slice(0, 60)}），已跳过`;
    await addMsg(s, room, 'note', m.id, '', n, role);
    return { member: m.id, name: m.name, role, skipped: true, notice: n };
  }
}
async function completeTask(s, task, memberId, text, k) {
  const t = (await s.q('SELECT id,room,member,role,status,created FROM tasks WHERE id=?', task))[0];
  if (!t || t.member !== memberId || !['pending', 'sent'].includes(t.status) || Date.now() - t.created > 86400000) return false;
  await s.q("UPDATE tasks SET status='done' WHERE id=?", task);
  if (t.role === '负责人') {
    const all = await loadMembers(s); const ids = new Set(all.filter((m) => !m.leadOnly && m.id !== 'hark' && m.id !== STEWARD).map((m) => m.id));
    const out = parseLineup(text, ids); await kvDel(s, 'leadwait:' + t.room);
    if (out) { await setLineup(s, t.room, out.map(({ id, role }) => ({ id, role }))); await kvSet(s, 'room_lead:' + t.room, { id: t.member }); await addMsg(s, t.room, 'lead', t.member, '回调', '本轮分工（负责人安排）：\n' + out.map((x) => `· ${(all.find((m) => m.id === x.id) || {}).name || x.id}（${x.role}）— ${x.reason}`).join('\n'), '负责人'); }
    else await addMsg(s, t.room, 'note', t.member, '', '负责人的回复不是成员表，按规则暂定的阵容不变。原话：' + String(text).trim().slice(0, 300), '负责人');
    return true;
  }
  await addMsg(s, t.room, 'ai', t.member, '回调', String(text).trim().slice(0, 8000), t.role);
  if (k) await addUsage(s, k, 0, 0, 0);
  return true;
}


// ───────────────────────── P1-2 网页成员（代发队列） ─────────────────────────
// 代发员 = 有浏览器的执行者（Hark 远程浏览器 / 用户电脑上的桌面桥接智能体），在「设置 → 网页代发员」登记，令牌 = HMAC(ACCESS_TOKEN, relay:<id>)。
// 网页成员的任务进 tasks(kind='web')；代发员 GET /bridge/web/pull 领取（原子地改成 sent + relay + claimed），POST /bridge/web/reply 回传。
// 10 分钟没回 → 改派（排除原代发员）；第 3 次还不行 → 失败并在房间里说明。同一项目同一成员记住网页会话（websess:<room>:<member>），下次优先给同一代发员。
const relayToken = async (env, id) => (await hmacHex(env.ACCESS_TOKEN, 'relay:' + id)).slice(0, 40);
async function webRelays(s) { return (await kvGet(s, 'web_relays')) || {}; }
async function relayAuth(env, s, req, id) {
  if (!P1.RELAY_ID_RE.test(id || '')) return null;
  const R = await webRelays(s); if (!R[id]) return null;
  const h = req.headers.get('authorization') || '';
  return h.startsWith('Bearer ') && timingSafeEqual(h.slice(7).trim(), await relayToken(env, id)) ? { id, ...R[id] } : null;
}
const taskExt = (t) => { try { return JSON.parse(t.ext || '{}') || {}; } catch { return {}; } };
async function webEnqueue(env, s, room, m, i, role, mode, transcript, wctx) {
  const iv = srcInvoke(env, m.sources[i]); const task = rid(16);
  const c = CAPS.capsOf(m); const isImage = c.tags.includes('image') && !c.tags.includes('chat');
  const prompt = P1.webPrompt({ name: m.name, role, roleBrief: (ROLE_BRIEF[role] || '').replace(/\s+/g, ' ').slice(0, 300), mode: MODES[mode] || mode, roster: wctx.roster || '', transcript, isImage, background: wctx.background || '', lastUser: wctx.lastUser || '', maxChars: role === '裁判' ? 200 : ['写手', '程序员', '翻译'].includes(role) ? 1200 : 150 });
  const sess = await kvGet(s, `websess:${room}:${m.id}`);
  const ext = { site: iv.site, client: !!iv.client, prefer: sess ? sess.relay : null, excluded: [], test: await testModeOn(s), src: i };
  await s.q("INSERT INTO tasks(id,room,member,role,status,created,prompt,ext,kind,attempts) VALUES(?,?,?,?,'pending',?,?,?,'web',0)", task, room, m.id, role, Date.now(), prompt.slice(0, 12000), JSON.stringify(ext));
  const note = `已排进代发队列：等代发员用浏览器打开 ${iv.site} 发给 ${m.name}${iv.client ? '（仅客户端型：只派给你同意过的桌面桥接）' : ''}，回复会标「经代发」`;
  return { member: m.id, name: m.name, role, pending: true, task, notice: note, via: m.srcs[i].via };
}
async function webSweep(s, now = Date.now()) {
  await s.q("UPDATE tasks SET status='failed' WHERE kind='web' AND status='pending' AND created<?", now - 86400000);   // 一天没人领的不再挂着
  const rows = await s.q("SELECT id,room,member,role,relay,claimed,attempts,ext FROM tasks WHERE kind='web' AND status='sent' AND claimed<?", now - P1.WEB_TIMEOUT_MS);
  const plan = P1.webSweepPlan(rows.map((t) => ({ ...t, excluded: taskExt(t).excluded })), now);
  if (!plan.length) return plan;
  const R = await webRelays(s); const all = await loadMembers(s); const nm = (id) => (all.find((x) => x.id === id) || {}).name || id;
  for (const x of plan) {
    const t = rows.find((r) => r.id === x.id); const ext = { ...taskExt(t), excluded: x.excluded };
    const who = (R[x.relay] || {}).name || x.relay || '代发员';
    if (x.action === 'fail') {
      const ch = await s.q("UPDATE tasks SET status='failed', attempts=?, ext=? WHERE id=? AND status='sent' AND relay=? AND claimed=? RETURNING id", x.attempts, JSON.stringify(ext), x.id, t.relay, t.claimed);
      if (!ch.length) continue;   // 这期间已回传或已被别的扫描处理
      await addMsg(s, t.room, 'note', t.member, '', `${nm(t.member)}（${t.role}）代发失败：已派 ${x.attempts} 次都没在 10 分钟内拿到回复（最后一次：${who}），这次跳过。`, t.role);
    } else {
      const ch = await s.q("UPDATE tasks SET status='pending', relay=NULL, claimed=NULL, attempts=?, ext=? WHERE id=? AND status='sent' AND relay=? AND claimed=? RETURNING id", x.attempts, JSON.stringify(ext), x.id, t.relay, t.claimed);
      if (!ch.length) continue;
      await addMsg(s, t.room, 'note', t.member, '', `${who} 代发 ${nm(t.member)} 超过 10 分钟没回，已改派给其他代发员（第 ${x.attempts + 1} 次）。`, t.role);
    }
  }
  return plan;
}
async function webPull(env, s, relay, url) {
  await webSweep(s);
  const R = await webRelays(s); const now = Date.now();
  if (R[relay.id]) { R[relay.id].seen = now; await kvSet(s, 'web_relays', R); }
  const relays = Object.entries(R).map(([id, r]) => ({ id, ...r }));
  const me = relays.find((r) => r.id === relay.id);
  const rows = await s.q("SELECT id,room,member,role,prompt,created,attempts,ext FROM tasks WHERE kind='web' AND status='pending' AND created>? ORDER BY created LIMIT 30", now - 86400000);
  const all = await loadMembers(s); const out = [];
  for (const t of rows) {
    const ext = taskExt(t);
    if (!!ext.test !== !!me.test) continue;   // 测试模式里登记的代发员只领测试任务，真实代发员不碰测试任务
    if (!P1.relayCanTake(me, { ...ext, created: t.created }, now, relays)) continue;
    const ch = await s.q("UPDATE tasks SET status='sent', relay=?, claimed=? WHERE id=? AND status='pending' RETURNING id", relay.id, now, t.id);
    if (!ch.length) continue;
    const sess = await kvGet(s, `websess:${t.room}:${t.member}`);
    const m = all.find((x) => x.id === t.member) || {};
    out.push({ task: t.id, member: t.member, name: m.name || t.member, role: t.role, site: ext.site, client: !!ext.client, prompt: t.prompt, session: sess && sess.relay === relay.id ? sess.ref : '', attempt: (t.attempts || 0) + 1, timeout_at: now + P1.WEB_TIMEOUT_MS });
    if (out.length >= 5) break;
  }
  const day = todayLondon(); const checkins = [];
  for (const m of all) for (const src of m.sources || []) {
    const iv = src.invoke || {};
    if (iv.kind !== 'web' || !iv.checkin || m.retired) continue;
    if (iv.client && !(me.kind === 'desktop' && me.consent === true)) continue;
    if (await kvGet(s, `webcheckin:${m.id}:${day}`)) continue;
    checkins.push({ member: m.id, name: m.name, site: iv.checkin_url || iv.site });
  }
  return { tasks: out, checkins, reply_url: (env.PUBLIC_ORIGIN || url.origin) + '/bridge/web/reply', timeout_min: P1.WEB_TIMEOUT_MS / 60000 };
}
async function webReply(s, relay, body) {
  const task = String(body.task || ''); const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!/^[a-z0-9]{16}$/.test(task) || !text) return [{ error: '需要 task 和 text' }, 400];
  const t = (await s.q("SELECT id,room,member,role,status,relay,created,ext FROM tasks WHERE id=? AND kind='web'", task))[0];
  if (!t || t.status !== 'sent' || t.relay !== relay.id || Date.now() - t.created > 86400000) return [{ error: '任务不存在、已完成、已改派给别人或已过期' }, 409];
  const ch = await s.q("UPDATE tasks SET status='done' WHERE id=? AND status='sent' AND relay=? RETURNING id", task, relay.id);
  if (!ch.length) return [{ error: '任务刚被改派或已完成' }, 409];
  const sess = P1.cleanSession(body.session);
  if (sess) await kvSet(s, `websess:${t.room}:${t.member}`, { relay: relay.id, ref: sess, ts: Date.now() });
  else { const old = await kvGet(s, `websess:${t.room}:${t.member}`); if (!old) await kvSet(s, `websess:${t.room}:${t.member}`, { relay: relay.id, ref: '', ts: Date.now() }); }
  await addMsg(s, t.room, 'ai', t.member, `经代发 · ${relay.name}`, text.slice(0, 8000), t.role);
  const ext = taskExt(t); if (ext.src !== undefined) await addUsage(s, `${t.member}@${ext.src}`, 0, 0, 0);
  return [{ ok: true }, 200];
}


// ───────────────────────── P1-3 点子库（点子 ≠ 项目：只是存档；项目可关联点子，关联后背景注入所有成员上下文） ─────────────────────────
const ideaRow = (r) => { if (!r) return null; let tags = [], notes = []; try { tags = JSON.parse(r.tags || '[]'); } catch {} try { notes = JSON.parse(r.notes || '[]'); } catch {} return { ...r, tags, notes }; };
async function ideaGet(s, id) { return ideaRow((await s.q('SELECT * FROM ideas WHERE id=?', String(id || '').slice(0, 40)))[0]); }
async function ideaSeed(s) {
  if (await kvGet(s, 'ideas_seeded')) return;
  const now = Date.now();
  for (const x of P1.IDEA_SEEDS) await s.q('INSERT OR IGNORE INTO ideas(id,title,thought,plan,expect,summary,source,tags,status,created,updated,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', x.id, x.title, x.thought, x.plan, x.expect, x.summary, x.source, JSON.stringify(x.tags), x.status, now, now, '[]');
  await kvSet(s, 'ideas_seeded', now);
}
async function ideaList(s) {
  await ideaSeed(s);
  const rows = (await s.q('SELECT * FROM ideas ORDER BY updated DESC LIMIT 300')).map(ideaRow);
  const cnt = {}; for (const r of await s.q('SELECT idea, COUNT(*) AS n FROM rooms WHERE idea IS NOT NULL GROUP BY idea')) cnt[r.idea] = r.n;
  return rows.map((x) => ({ ...x, projects: cnt[x.id] || 0, notes: undefined, noteCount: x.notes.length }));
}
async function ideaSave(s, b) {
  const prev = b.id ? await ideaGet(s, b.id) : null;
  if (b.id && !prev) return [{ error: '没有这个点子' }, 404];
  const v = P1.validateIdea(b, prev); if (!v.ok) return [{ error: v.error }, 400];
  const it = v.idea; const now = Date.now(); const id = prev ? prev.id : 'i-' + rid(12);
  await s.q('INSERT INTO ideas(id,title,thought,plan,expect,summary,source,tags,status,created,updated,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,thought=excluded.thought,plan=excluded.plan,expect=excluded.expect,summary=excluded.summary,source=excluded.source,tags=excluded.tags,status=excluded.status,updated=excluded.updated',
    id, it.title, it.thought || '', it.plan || '', it.expect || '', it.summary || '', it.source || '', JSON.stringify(it.tags || []), it.status, prev ? prev.created : now, now, JSON.stringify(prev ? prev.notes : []));
  return [{ ok: true, id }, 200];
}

// ───────────────────────── 打分 / 互评 ─────────────────────────
async function peerReview(env, s, room, all) {
  const r0 = await getRoom(s, room); if (!r0) return { error: '房间不存在' };
  const judge = r0.lineup.find((x) => x.role === '裁判') || r0.lineup[r0.lineup.length - 1];
  const reviewer = all.find((m) => m.id === (judge && judge.id));
  if (!reviewer || reviewer.state === 'down' || !isChatty(reviewer)) return { error: '没有可用的评审成员（裁判离线）' };
  const label = (id) => (all.find((x) => x.id === id) || {}).name || id;
  const sys = '你在给群聊成员的表现打分。只输出 JSON 数组。';
  const user = `聊天记录：\n${transcriptOf(r0.messages, label).slice(-7000)}\n\n给下面每个成员按其角色表现打 1–5 分（5 最好），并给出该表现对应的岗位（从这些里选：${[...new Set(TOPIC_JOBS.map((x) => x[0]).concat(['中文对话', '工具调用']))].join('、')}）。不要给自己打分。\n成员：${r0.lineup.filter((x) => x.id !== reviewer.id).map((x) => `${x.id}（${x.role}）`).join('、')}\n输出：[{"id":"…","job":"…","score":4,"note":"一句话"}]`;
  for (const i of reviewer.order) {
    const src = reviewer.sources[i]; const iv = srcInvoke(env, src); if (reviewer.srcs[i].state === 'down') continue;
    try {
      let r;
      if (iv.kind === 'workers-ai') { r = await callWorkersAI(env, src, sys, user, 600); await addUsage(s, skey(reviewer, i), r.tin, r.tout, r.neurons); }
      else if (iv.kind === 'openai') r = await callOpenAI(env, iv, sys, user, 600);
      else if (iv.kind === 'gemini') r = await callGemini(env, iv, sys, user, 600);
      else continue;
      const mj = (r.text || '').match(/\[[\s\S]*\]/); if (!mj) continue;
      const ids = new Set(r0.lineup.map((x) => x.id)); const saved = [];
      for (const x of JSON.parse(mj[0])) {
        const sc = Math.round(+x.score);
        if (!x || !ids.has(x.id) || x.id === reviewer.id || !(sc >= 1 && sc <= 5) || typeof x.job !== 'string') continue;
        const okJobs = [...new Set(TOPIC_JOBS.map((y) => y[0]).concat(['中文对话', '工具调用']))];
        x.job = okJobs.find((j) => j === x.job) || okJobs.find((j) => j.includes(x.job) || x.job.includes(j)); if (!x.job) continue;
        await s.q('INSERT INTO ratings(room,member,job,score,src,rater,note,ts) VALUES(?,?,?,?,?,?,?,?)', room, x.id, x.job.slice(0, 12), sc, '互评', reviewer.id, String(x.note || '').slice(0, 120), Date.now());
        saved.push({ id: x.id, job: x.job.slice(0, 12), score: sc, note: String(x.note || '').slice(0, 120) });
      }
      if (saved.length) {
        await addMsg(s, room, 'lead', 'hark', '', `成员互评（评审：${reviewer.name}）：\n` + saved.map((x) => `· ${label(x.id)} — ${x.job} ${x.score} 分：${x.note}`).join('\n'), '负责人');
        return { ok: true, reviewer: reviewer.id, ratings: saved };
      }
    } catch {}
  }
  return { error: '互评失败（评审成员没返回有效 JSON）' };
}

// ───────────────────────── 搜索（消息正文 / 成员名 / 项目名） ─────────────────────────
async function search(s, all, q) {
  q = q.trim().slice(0, 80);
  if (!q) return { projects: [], messages: [] };
  const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  const nameIds = all.filter((m) => m.name.toLowerCase().includes(q.toLowerCase())).map((m) => m.id).slice(0, 20);
  const ids = [...nameIds, ...Object.entries(LEGACY).filter(([, v]) => nameIds.includes(v[0])).map(([k]) => k)];
  const ph = ids.map(() => '?').join(',');
  const rows = await s.q(`SELECT m.id, m.room, m.kind, m.member, m.role, m.text, m.ts, r.title FROM msgs m JOIN rooms r ON r.id=m.room
    WHERE m.text LIKE ? ESCAPE '\\' ${ids.length ? `OR (m.kind='ai' AND m.member IN (${ph}))` : ''} ORDER BY m.id DESC LIMIT 60`, like, ...ids);
  const projects = await s.q(`SELECT id, title, COALESCE(status,'进行中') AS status, created FROM rooms WHERE title LIKE ? ESCAPE '\\' ORDER BY updated DESC LIMIT 20`, like);
  const name = (id) => (all.find((m) => m.id === id) || {}).name || id || '';
  const snip = (t) => { const i = Math.max(0, t.toLowerCase().indexOf(q.toLowerCase())); const st = Math.max(0, i - 30); return (st ? '…' : '') + t.slice(st, st + 120) + (t.length > st + 120 ? '…' : ''); };
  return {
    projects: projects.map((p) => ({ room: p.id, title: p.title, status: p.status, ts: p.created })),
    messages: rows.map((r) => { const n = normMsg(r); return { room: r.room, title: r.title, msg: r.id, kind: r.kind, member: n.member, name: r.kind === 'user' ? '我' : r.kind === 'lead' ? 'Hark' : name(n.member), role: n.role || '', ts: r.ts, snippet: snip(r.text) }; }),
  };
}

// ───────────────────────── 路由 ─────────────────────────
async function readBody(req) {
  if (+(req.headers.get('content-length') || 0) > 32 * 1024) return { err: json({ error: '请求太大' }, 413) };
  const txt = await req.text();
  if (txt.length > 32 * 1024) return { err: json({ error: '请求太大' }, 413) };
  try { const b = JSON.parse(txt || '{}'); return { body: b && typeof b === 'object' && !Array.isArray(b) ? b : {} }; } catch { return { err: json({ error: '请求不是合法 JSON' }, 400) }; }
}
async function handleHooks(req, env, url, path) {
  const s = store(env);
  if (path === '/hook/reply' && req.method === 'POST') {
    const rb = await readBody(req); if (rb.err) return rb.err;
    const { task, text } = rb.body;
    if (typeof task !== 'string' || !/^[a-z0-9]{16}$/.test(task) || typeof text !== 'string' || !text.trim()) return json({ error: '需要 task 和 text' }, 400);
    const t = (await s.q('SELECT member FROM tasks WHERE id=?', task))[0];
    const h = req.headers.get('authorization') || '';
    const given = h.startsWith('Bearer ') ? h.slice(7).trim() : '';  // 只认请求头（不收 ?t=，免得令牌进 URL 日志）
    if (!t || !timingSafeEqual(given, await memberToken(env, t.member))) return json({ error: '未授权' }, 401);
    const ok = await completeTask(s, task, t.member, text);
    return ok ? json({ ok: true }) : json({ error: '任务不存在、已完成或已过期' }, 409);
  }
  if (path.startsWith('/bridge/web/')) {   // P1-2 代发员接口（代发员令牌鉴权）
    const rb = req.method === 'POST' ? await readBody(req) : { body: {} }; if (rb.err) return rb.err;
    const id = url.searchParams.get('relay') || String(rb.body.relay || '') || '';
    let rid0 = id;
    if (!rid0 && path === '/bridge/web/reply' && /^[a-z0-9]{16}$/.test(String(rb.body.task || ''))) rid0 = ((await s.q("SELECT relay FROM tasks WHERE id=? AND kind='web'", String(rb.body.task)))[0] || {}).relay || '';   // 不带 relay 时按任务的领取者鉴权（不遍历所有代发员）
    const relay = await relayAuth(env, s, req, rid0);
    if (!relay) return json({ error: '未授权' }, 401);
    if (path === '/bridge/web/pull' && req.method === 'GET') return json(await webPull(env, s, relay, url));
    if (path === '/bridge/web/reply' && req.method === 'POST') { const [o, c] = await webReply(s, relay, rb.body); return json(o, c); }
    if (path === '/bridge/web/checkin' && req.method === 'POST') {
      const mid = String(rb.body.member || ''); const m = (await loadMembers(s)).find((x) => x.id === mid && (x.sources || []).some((y) => (y.invoke || {}).kind === 'web'));
      if (!m) return json({ error: '没有这个网页成员' }, 404);
      await kvSet(s, `webcheckin:${mid}:${todayLondon()}`, { relay: relay.id, ok: rb.body.ok !== false, note: String(rb.body.note || '').slice(0, 200), at: Date.now() });
      await setStatus(s, skey(m, Math.max(0, (m.sources || []).findIndex((y) => (y.invoke || {}).kind === 'web'))), rb.body.ok !== false ? 'ok' : 'down', rb.body.ok !== false ? '' : '签到失败：' + String(rb.body.note || '').slice(0, 100), { last_checkin: Date.now() });
      return json({ ok: true });
    }
    return json({ error: '找不到' }, 404);
  }
  if (path === '/bridge/pull' && req.method === 'GET') {
    const member = url.searchParams.get('member') || '';
    if (!ID_RE.test(member)) return json({ error: 'member 不对' }, 400);
    const h = req.headers.get('authorization') || '';
    if (!h.startsWith('Bearer ') || !timingSafeEqual(h.slice(7).trim(), await memberToken(env, member))) return json({ error: '未授权' }, 401);
    const m = (await loadMembers(s)).find((x) => x.id === member);
    if (m) for (let i = 0; i < (m.sources || []).length; i++) if (isPull(env, srcInvoke(env, m.sources[i]))) await setStatus(s, skey(m, i), 'ok', '', { bridge_seen: Date.now() });
    const tasks = await s.q("SELECT id,room,role,prompt,created FROM tasks WHERE member=? AND status IN ('pending','sent') AND COALESCE(kind,'')<>'web' AND created>? ORDER BY created LIMIT 5", member, Date.now() - 86400000);
    if (tasks.length) await s.batch(tasks.map((t) => ["UPDATE tasks SET status='sent' WHERE id=?", [t.id]]));
    return json({ tasks: tasks.map((t) => ({ task: t.id, room: t.room, role: t.role, prompt: t.prompt, created: t.created })), reply_url: (env.PUBLIC_ORIGIN || url.origin) + '/hook/reply' });
  }
  if ((path === '/bridge/brief' && req.method === 'GET') || (path === '/bridge/ack' && req.method === 'POST')) {
    const member = url.searchParams.get('member') || '';
    const h = req.headers.get('authorization') || '';
    if (!ID_RE.test(member) || !h.startsWith('Bearer ') || !timingSafeEqual(h.slice(7).trim(), await memberToken(env, member))) return json({ error: '未授权' }, 401);
    const s = store(env);
    if (path === '/bridge/brief') return json(await leadBrief(env, s));
    const rb = await readBody(req); if (rb.err) return rb.err; const t = String(rb.body.summary || '').trim().slice(0, 600); if (t.length < 20) return json({ error: '请用至少 20 个字复述' }, 400);
    await kvSet(s, 'lead_ack:' + member, { text: t, at: Date.now() }); return json({ ok: true, standby: true });
  }
  if (path === '/bridge/handoff' && req.method === 'GET') {
    const member = url.searchParams.get('member') || '';
    const h = req.headers.get('authorization') || '';
    if (!ID_RE.test(member) || !h.startsWith('Bearer ') || !timingSafeEqual(h.slice(7).trim(), await memberToken(env, member))) return json({ error: '未授权' }, 401);
    return new Response(HANDOFF_TEXT(env.PUBLIC_ORIGIN || url.origin), { headers: { 'content-type': 'text/plain; charset=utf-8', ...SEC_HEADERS } });
  }
  const tg = path.match(/^\/hook\/tg\/([a-f0-9]{32})$/);
  if (tg && req.method === 'POST') {
    const want = await tgPath(env);
    if (!timingSafeEqual(tg[1], want) || !timingSafeEqual(req.headers.get('x-telegram-bot-api-secret-token') || '', want)) return json({ error: '未授权' }, 401);
    const rb = await readBody(req); if (rb.err) return json({ ok: true });
    const msg = rb.body.message || rb.body.edited_message; if (!msg || typeof msg.text !== 'string') return json({ ok: true });
    let task = (msg.text.match(/#([a-z0-9]{16})/) || [])[1] || null;
    if (!task && msg.reply_to_message) { const row = (await s.q("SELECT id FROM tasks WHERE ext=? AND status IN ('pending','sent')", String(msg.reply_to_message.message_id)))[0]; if (row) task = row.id; }
    if (task) { const t = (await s.q('SELECT member FROM tasks WHERE id=?', task))[0]; if (t) await completeTask(s, task, t.member, msg.text.replace(/#[a-z0-9]{16}/, '').trim()); }
    return json({ ok: true });
  }
  return null;
}

// ───── P1-6 Cloudflare 额度保险：本站自己数 Worker 请求（每个实例在内存里累加，满 25 次或隔 60 秒写一次 DO，约值）─────
const REQ_LIMIT = 100000, REQ_WARN = 0.8;
const RQ = { n: 0, last: 0, dos: 0, calls: 0, dosFlushed: 0 };
async function reqFlush(env) {
  const n = RQ.n; if (!n) return; RQ.n = 0; RQ.last = Date.now();
  const s = store(env); const day = utcDay(); const k = 'reqs:' + day;
  const dn = RQ.dos - RQ.dosFlushed; if (dn > 0) { RQ.dosFlushed = RQ.dos; try { await s.q('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=CAST(kv.v AS INTEGER)+?', 'dos:' + day, String(dn), dn); } catch { RQ.dosFlushed -= dn; } }
  let r; try { r = await s.q('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=CAST(kv.v AS INTEGER)+? RETURNING v', k, String(n), n); } catch (e) { RQ.n += n; throw e; }   // 写失败把数加回去，下次再写
  const tot = Number((r[0] || {}).v || 0);
  if (tot >= REQ_LIMIT * REQ_WARN && tot - n < REQ_LIMIT * REQ_WARN) await reqWarn(s, day, tot);
  const dt = Number((await kvGet(s, 'dos:' + day)) || 0); if (dt >= REQ_LIMIT * REQ_WARN) await reqWarn(s, day, dt);   // 刚越过 80%（自增是原子的，只有一次 flush 会越线）
}
async function reqWarn(s, day, tot) {   // 每天只提醒一次（原子占位）；cron 每小时也兜底检查一次
  {
    const got = await s.q("INSERT INTO kv(k,v) VALUES(?, '1') ON CONFLICT(k) DO NOTHING RETURNING k", 'reqwarn:' + day);
    if (got.length) { try { await ensureStewardRoom(s); await addMsg(s, STEWARD_ROOM, 'note', '', '', `提醒：今天 Cloudflare 免费请求（Worker 或 Durable Object，取较高的）已用约 ${Math.round(tot / REQ_LIMIT * 100)}%（${tot} / ${REQ_LIMIT}，本站自己计数）。用完后网站会暂时打不开（错误 1027），UTC 0 点（英国时间 ${londonTime(nextUtcMidnight())}）自动恢复；没发出去的消息会留在发件箱，恢复后自动补发。不会升级付费。`, ''); } catch {} }
  }
}
async function usageView(env) {
  const day = utcDay(); const s = store(env); const v = Number((await kvGet(s, 'reqs:' + day)) || 0) + RQ.n;
  const dv = Number((await kvGet(s, 'dos:' + day)) || 0) + (RQ.dos - RQ.dosFlushed);
  const pw = v / REQ_LIMIT, pd = dv / REQ_LIMIT; const pct = Math.min(1, Math.max(pw, pd));
  return { day, requests: v, limit: REQ_LIMIT, do: { requests: dv, limit: REQ_LIMIT, pct: Math.round(Math.min(1, pd) * 1000) / 1000, callsThisInstance: RQ.calls, sessionsThisInstance: RQ.dos }, which: pd > pw ? 'Durable Object 请求' : 'Worker 请求',
    pct: Math.round(pct * 1000) / 1000, warnAt: REQ_WARN, level: pct >= 1 ? 'over' : pct >= REQ_WARN ? 'warn' : 'ok',
    reset: 'UTC 0 点重置（英国时间 ' + londonTime(nextUtcMidnight()) + '）', note: '本站自己计数（约值，部署当天从部署时起算）；以 Cloudflare 后台为准。超限时 Cloudflare 直接返回错误 1027。' };
}
const WORKER = {
  async _scheduled(event, env, ctx) { ctx.waitUntil((async () => { const s = store(env); const t = await kvGet(s, 'testmode'); if (t && t.until <= Date.now()) await testModeEnd(s); })().catch(() => {})); ctx.waitUntil(probeAll(env)); ctx.waitUntil(expiryCheck(env, store(env), false)); ctx.waitUntil(webSweep(store(env)).catch(() => {})); ctx.waitUntil((async () => { const s = store(env); await s.q("DELETE FROM kv WHERE k LIKE 'cid:%' AND CAST(json_extract(v,'$.ts') AS INTEGER) < ?", Date.now() - 3 * 86400000); await s.q("DELETE FROM kv WHERE (k LIKE 'reqs:%' OR k LIKE 'dos:%' OR k LIKE 'reqwarn:%') AND substr(k, instr(k, ':') + 1) < ?", utcDay(Date.now() - 7 * 86400000)); await reqFlush(env); const day = utcDay(); const tot = Number((await kvGet(s, 'reqs:' + day)) || 0); if (tot >= REQ_LIMIT * REQ_WARN) await reqWarn(s, day, tot); })().catch(() => {})); ctx.waitUntil((async () => { const s = store(env); try { await stewardWeekly(await withKeys(env, s), s, false); } catch {} })()); ctx.waitUntil((async () => { const s = store(env); const e2 = await withKeys(env, s); for (const r of await s.q("SELECT k FROM kv WHERE k LIKE 'leadwait:%'")) { try { await leadCheck(e2, s, r.k.slice(9)); } catch {} } })()); },
  fetch(req, env, ctx) { return ALS.run({}, () => { RQ.n++; if (RQ.n >= 25 || Date.now() - RQ.last > 60000) ctx.waitUntil(reqFlush(env).catch(() => {})); return WORKER._fetch(req, env, ctx); }); },
  scheduled(event, env, ctx) { return ALS.run({}, () => WORKER._scheduled(event, env, ctx)); },
  async _fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    const isApi = path.startsWith('/api/');
    if (path.startsWith('/hook/') || path.startsWith('/bridge/')) {
      if (!env.ACCESS_TOKEN || env.ACCESS_TOKEN.length < 32) return json({ error: '未配置' }, 503);
      try { const r = await handleHooks(req, env, url, path); if (r) return r; } catch (e) { return json({ error: '服务器出错' }, 500); }
      return json({ error: '找不到' }, 404);
    }
    if (path === '/mcp') { try { return await mcpHandle(req, env, ctx, url); } catch (e) { return json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: '服务器出错' } }, 500); } }
    if (path === '/api/pair' && req.method === 'POST') {
      if (!env.ACCESS_TOKEN || env.ACCESS_TOKEN.length < 32) return json({ error: '未配置' }, 503);
      try { return await pairRedeem(req, env, url); } catch (e) { return json({ error: '服务器出错' }, 500); }
    }
    if (path === '/skills/ai-groupchat-operator.md' && (req.method === 'GET' || req.method === 'HEAD')) return new Response(OPSKILL, { headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'public, max-age=600', ...SEC_HEADERS } });
    // PWA 静态资源（manifest + 图标）：不含任何数据，未登录也可读（iPhone「添加到主屏幕」时取图标不带 cookie）
    if (req.method === 'GET' || req.method === 'HEAD') {
      const pub = { ...SEC_HEADERS, 'cache-control': 'public, max-age=86400' };
      if (path === '/manifest.webmanifest') return new Response(JSON.stringify({ ...MANIFEST, name: PRODUCT.name, short_name: PRODUCT.short }), { headers: { 'content-type': 'application/manifest+json; charset=utf-8', ...pub } });
      if (path === '/icon.svg') return new Response(ICON_SVG, { headers: { 'content-type': 'image/svg+xml', ...pub } });
      if (path === '/favicon.svg') return new Response(FAVICON_SVG, { headers: { 'content-type': 'image/svg+xml', ...pub } });
      const pn = path.slice(1);
      if (/^(icon-192|icon-512|icon-maskable-512|apple-touch-icon(-precomposed)?|favicon-(16|32|48))\.png$/.test(pn)) {
        const raw = PNG[pn.replace('-precomposed', '').replace(/\.png$/, '')]; if (!raw) return json({ error: '找不到' }, 404);
        const bs = atob(raw); const bin = new Uint8Array(bs.length); for (let i = 0; i < bs.length; i++) bin[i] = bs.charCodeAt(i);
        return new Response(bin, { headers: { 'content-type': 'image/png', ...pub } });
      }
      if (path === '/favicon.ico') return new Response(FAVICON_SVG, { headers: { 'content-type': 'image/svg+xml', ...pub } });
    }
    if (path === '/' && url.searchParams.has('k')) {
      const k = url.searchParams.get('k') || '';
      if (env.ACCESS_TOKEN && env.ACCESS_TOKEN.length >= 32 && timingSafeEqual(k, env.ACCESS_TOKEN))
        return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': `${COOKIE}=${encodeURIComponent(k)}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`, 'cache-control': 'no-store', ...SEC_HEADERS } });
      return unauthorized(false);
    }
    let kind = authKind(req, env); let OP = null;
    if (!kind && isApi) { const h = req.headers.get('authorization') || ''; if (h.startsWith('Bearer ')) { OP = await opAuth(env, store(env), h.slice(7).trim()); if (OP) kind = 'operator'; } }
    if (!kind) return unauthorized(isApi);
    if (kind === 'operator') {
      const deny = opDeny(req.method, path) || (OP.slot === 's' && req.method !== 'GET' && !['/api/lead/ack'].includes(path) ? '副负责人待命中只读；主负责人失联/额度用完/超时时会自动升为主负责人' : null) || (!OP.active && !['/api/lead/brief', '/api/lead/ack'].includes(path) ? '还没激活：先 GET /api/lead/brief 读岗位说明书和状态快照，再 POST /api/lead/ack 用一句话复述确认' : null);
      await opLog(store(env), OP, req.method, path, deny ? '拒绝：' + deny : '');
      if (deny) return json({ error: deny }, 403);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && kind === 'cookie') {
      const origin = req.headers.get('origin');
      if (!origin || origin !== url.origin) return json({ error: '来源不对' }, 403);
    }
    if (path === '/logout') return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`, ...SEC_HEADERS } });
    if (path === '/' && req.method === 'GET') {
      return new Response(PAGE.replaceAll('__TERM__', TERM).replaceAll('__PRODUCT_SHORT__', PRODUCT.short).replaceAll('__PRODUCT__', PRODUCT.name), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SEC_HEADERS,
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" } });
    }
    if (!isApi) return json({ error: '找不到' }, 404);
    let body = {};
    if (req.method === 'POST') { const rb = await readBody(req); if (rb.err) return rb.err; body = rb.body; }
    const s = store(env);
    const rawEnv = env;
    try {
      // ── API 密钥区：写入只收 cookie（同源已在上面检查）；只回末 4 位 ──
      if (path === '/api/keys' && req.method === 'GET') return json({ keys: await keysView(rawEnv, s) });
      const km = path.match(/^\/api\/keys\/([A-Z][A-Z0-9_]{2,40})(\/verify)?$/);
      if ((path === '/api/keys' && req.method === 'POST') || (km && req.method !== 'GET')) {
        if (kind !== 'cookie') return json({ error: '只能在已登录的页面里操作密钥' }, 403);
        const name = km ? km[1] : String(body.name || '');
        if (!KEY_NAME_RE.test(name) || !KEYDEFS[name] || KEYDEFS[name].keyless) return json({ error: '没有这个来源' }, 400);
        if (km && km[2] && req.method === 'POST') {
          const v = (await ksAll(rawEnv, s))[name] || rawEnv[name];
          if (!v) return json({ error: '还没填这个 Key' }, 400);
          if (!(await s.q('SELECT 1 FROM apikeys WHERE name=?', name)).length) return json({ ok: true, verify: await verifyKey(KEYDEFS[name], v) });
          return json({ ok: true, verify: await keyVerifyStore(rawEnv, s, name, v) });
        }
        if (km && req.method === 'DELETE') { await s.q('DELETE FROM apikeys WHERE name=?', name); return json({ ok: true }); }
        if (km) return json({ error: '找不到' }, 404);
        const value = typeof body.value === 'string' ? body.value.trim() : '';
        if (value.length < 8 || value.length > 4096 || /\s/.test(value)) return json({ error: 'Key 格式不对（8–4096 个字符，不能有空格或换行）' }, 400);
        await ksPut(rawEnv, s, name, value);
        const verify = await keyVerifyStore(rawEnv, s, name, value);
        return json({ ok: true, name, last4: value.slice(-4), verify, note: rawEnv[name] ? '部署时已绑定同名 Worker secret，调用时仍优先用那个' : '' });
      }
      env = await withKeys(rawEnv, s);
      // ── 资源库（只读，需登录）+ 资源管家（写入只收页面 cookie） ──
      if (path === '/api/resources' && req.method === 'GET') {
        const R = await allResources(s);
        return json({ ...R, tools: CONFIG.tools || [], cats: RES_CATS, lastCheck: await kvGet(s, 'steward_last_check'), checkErr: await kvGet(s, 'steward_check_err') });
      }
      const ri = path.match(/^\/api\/resources\/item\/([a-z]-[0-9a-f]{16})$/);
      if (ri && req.method === 'DELETE') { if (kind !== 'cookie') return json({ error: '只能在已登录的页面里操作' }, 403); await s.q('DELETE FROM res_items WHERE id=?', ri[1]); return json({ ok: true }); }
      if (path === '/api/steward/tiers' && req.method === 'GET') return json(await stewardTiers(env, s));
      if (path === '/api/testmode' && req.method === 'POST') { if (kind !== 'cookie') return json({ error: '只能用页面 cookie 开关测试模式' }, 403); return json(body.on ? await testModeBegin(s) : await testModeEnd(s)); }
      if (path === '/api/testmode' && req.method === 'GET') { const t = await kvGet(s, 'testmode'); return json({ on: !!(t && t.until > Date.now()), until: t ? t.until : null }); }
      if (path === '/api/steward/weekly' && req.method === 'GET') { const w = await kvGet(s, 'steward_weekly_last'); return json({ last: w, schedule: '英国时间每周一 8 点后自动生成（Workers cron）', reader: '主负责人（操作员令牌）每周抽查' }); }
      if (path === '/api/steward/weekly' && req.method === 'POST') { if (kind !== 'cookie') return json({ error: '只能在已登录的页面里手动生成' }, 403); return json(await stewardWeekly(env, s, true)); }
      if (path === '/api/steward/submissions' && req.method === 'GET') return json({ items: (await s.q('SELECT rid AS id, ts, who AS by, url, text, note, source, status, why, name, state FROM subs ORDER BY id DESC LIMIT 60')) });
      if (path === '/api/steward/submit' && req.method === 'POST') {   // P1-5 主负责人代收资源（只认操作员令牌；网页用户直接发给资源管家）
        if (kind !== 'operator') return json({ error: kind === 'cookie' ? '网页里请直接把链接发给资源管家私聊；这个接口给主负责人（操作员令牌）代收用' : '只给主负责人用（操作员令牌）' }, 403);
        const r = await submitResource(env, s, ctx, OP, body); return json(r.error ? { error: r.error } : r, r.error ? 400 : 200);
      }
      if (path.startsWith('/api/steward/') && req.method === 'POST') {
        if (kind !== 'cookie' && kind !== 'operator') return json({ error: '只能在已登录的页面里和资源管家说话' }, 403);
        if (path === '/api/steward/msg') { const t = typeof body.text === 'string' ? body.text.trim().slice(0, MAX_MSG) : ''; if (!t) return json({ error: '先写点内容' }, 400); return json(await stewardMessage(env, s, ctx, t)); }
        await ensureStewardRoom(s);
        if (path === '/api/steward/gather') { await addMsg(s, STEWARD_ROOM, 'user', '', '', '（点了「搜集羊毛」）', ''); const t = await stewardTask(s, 'gather'); ctx.waitUntil(gatherDeals(env, s).catch(() => {}).finally(() => stewardDone(s, t))); return json({ ok: true, async: true }); }
        if (path === '/api/steward/check') { await addMsg(s, STEWARD_ROOM, 'user', '', '', '（点了「检查到期」）', ''); const t = await stewardTask(s, 'expiry'); ctx.waitUntil(expiryCheck(env, s, true).finally(() => stewardDone(s, t))); return json({ ok: true, async: true }); }
        return json({ error: '找不到' }, 404);
      }
      // ── 设置：来源路由与完成提醒（偏好存 DO；Bark Key 在 API 密钥区，不在这里） ──
      if (path === '/api/settings' && req.method === 'GET') return json({ route: await routePolicy(s), notify: { on: false, tg: '', ...((await kvGet(s, 'notify')) || {}) }, bark: !!env.BARK_KEY, telegram: !!env.TELEGRAM_BOT_TOKEN, levels: LEVELS });
      if (path === '/api/settings' && req.method === 'POST') {
        if (kind !== 'cookie' && kind !== 'operator') return json({ error: '只能在已登录的页面里改设置' }, 403);
        if (body.route && typeof body.route === 'object') await kvSet(s, 'route_policy', { blockRelay: body.route.blockRelay !== false, blockTools: body.route.blockTools !== false, blockHark: body.route.blockHark !== false });
        if (body.notify && typeof body.notify === 'object') { const tg = String(body.notify.tg || '').trim(); if (tg && !/^-?\d{3,20}$/.test(tg)) return json({ error: 'Telegram chat_id 只能是数字' }, 400); await kvSet(s, 'notify', { on: !!body.notify.on, tg }); }
        return json({ ok: true });
      }
      if (path === '/api/notify/test' && req.method === 'POST') {
        if (kind !== 'cookie' && kind !== 'operator') return json({ error: '只能在已登录的页面里操作' }, 403);
        if (!env.BARK_KEY && !env.TELEGRAM_BOT_TOKEN) return json({ error: '还没填 Bark Key：到「资源库 → API 密钥」填「Bark 推送」' }, 400);
        const res = [];
        if (env.BARK_KEY) { try { const r = await fetchT(`https://api.day.app/${encodeURIComponent(env.BARK_KEY)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'AI 群聊', body: '测试推送：收到这条说明完成提醒能用', group: 'AI群聊' }) }); res.push('Bark ' + (r.ok ? '已发出' : '失败（' + r.status + '）')); if (r.ok) await s.q("UPDATE apikeys SET vstate='ok', vmsg='测试推送已发出', vat=? WHERE name='BARK_KEY'", Date.now()); } catch (e) { res.push('Bark 连不上'); } }
        const pref = (await kvGet(s, 'notify')) || {};
        if (env.TELEGRAM_BOT_TOKEN && pref.tg) { try { const r = await fetchT(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: pref.tg, text: 'AI 群聊：测试推送' }) }); res.push('Telegram ' + (r.ok ? '已发出' : '失败（' + r.status + '）')); } catch { res.push('Telegram 连不上'); } }
        return json({ ok: true, result: res.join('；') });
      }
      if (path === '/api/members' && req.method === 'GET') {
        const last = await kvGet(s, 'last_probe');
        if (!last || Date.now() - last > 3600000) { await kvSet(s, 'last_probe', Date.now()); ctx.waitUntil(probeAll(env).catch(() => {})); } // cron 兜底
        const all = await enrichAll(env, s);
        return json({ term: TERM, members: all.map(publicView), tools: CONFIG.tools || [], candidates: await candidates(s, all), admission: CONFIG.admission || {}, roles: ROLES.filter((r) => r !== '负责人'), modes: MODES, modeInfo: P1.MODE_INFO,
          connectors: Object.fromEntries(CUSTOM_KINDS.map((k) => [k, { label: CONNECTORS[k].label, how: CONNECTORS[k].how }])), execTags: CONFIG.exec_tags || [], lastProbe: last,
          gw: await toolsView(env, s), gwFns: gwFunctions(env).map((f) => f.function.name), lead: await leadView(env, s), asyncKinds: ASYNC_KINDS });
      }
      const mm = path.match(/^\/api\/member\/([a-z0-9][a-z0-9._-]{1,63})$/);
      if (mm && req.method === 'GET') {
        const all = await enrichAll(env, s);
        const m = all.find((x) => x.id === mm[1]); if (!m) return json({ error: '没有这个 AI成员' }, 404);
        const view = publicView(m);
        const legacyKey = (Object.entries(LEGACY).find(([, v]) => v[0] === m.id) || [])[0];
        const hist = await s.q('SELECT p.room, p.role, p.joined, r.title, COALESCE(r.status,\'进行中\') AS status FROM parts p JOIN rooms r ON r.id=p.room WHERE p.member=? ORDER BY p.joined DESC LIMIT 100', m.id);
        const legacy = legacyKey ? await s.q("SELECT r.id AS room, r.title, COALESCE(r.status,'进行中') AS status, MIN(x.ts) AS joined FROM msgs x JOIN rooms r ON r.id=x.room WHERE x.member=? AND r.members IS NULL GROUP BY r.id ORDER BY joined DESC LIMIT 50", legacyKey) : [];
        view.history = [...hist, ...legacy.map((x) => ({ ...x, role: LEGACY[legacyKey][1] }))];
        view.usage = await s.q("SELECT member AS src, day, calls, tin, tout, neurons FROM usage WHERE member LIKE ? ESCAPE '\\' ORDER BY day DESC LIMIT 20", m.id.replace(/[\\%_]/g, (c) => '\\' + c) + '@%');
        view.ratingsList = await s.q('SELECT room, job, score, src, rater, note, ts FROM ratings WHERE member=? ORDER BY ts DESC LIMIT 30', m.id);
        if (kind !== 'operator' && m.sources.some((x) => ASYNC_KINDS.includes((x.invoke || {}).kind))) view.callbackToken = await memberToken(env, m.id);
        view.calls = (await s.q('SELECT id, ts, room, kind, name, action, ok, ms, detail, result FROM calls WHERE member=? ORDER BY id DESC LIMIT 60', m.id)).map((c) => ({ ...c, okText: CALL_OK[c.ok] || '', result: String(c.result || '').slice(0, 400) }));
        view.stats = await memberStats(s, m.id);
        view.quota = { ...view.quota, resetAt: resetAtOf(view.quota) };
        view.gwFns = view.fc ? gwFunctions(env).map((f) => f.function.name) : [];
        const lc = await leadCfg(s); view.leadSlot = ['p', 's'].find((k) => (lc[k] && lc[k].type === 'member' && lc[k].id === m.id) || m.id === 'lead-' + k) || null;
        return json(view);
      }
      // ── 工具网关 ──
      if (path === '/api/tools' && req.method === 'GET') return json({ ...(await toolsView(env, s)), fns: gwFunctions(env).map((f) => f.function.name) });
      if (path === '/api/tools/run' && req.method === 'POST') {
        if (kind !== 'cookie' && kind !== 'operator') return json({ error: '只能在已登录的页面里试用工具' }, 403);
        const room = typeof body.room === 'string' && ROOM_RE.test(body.room) ? body.room : '';
        const r = await gatewayCall(env, s, { member: 'user', room, toolId: typeof body.tool === 'string' ? body.tool : null, action: String(body.action || ''), args: body.args });
        return json(r);
      }
      if (path === '/api/tools/confirm' && req.method === 'POST') {
        if (kind !== 'cookie') return json({ error: '确认只能在已登录的页面里点' }, 403);
        const r = await confirmCall(env, s, Math.round(+body.id), body.approve === true); return r.error ? json(r, 400) : json(r);
      }
      if (path === '/api/calls' && req.method === 'GET') return json({ calls: (await s.q("SELECT id, ts, member, room, kind, name, action, ok, ms, detail FROM calls WHERE kind='tool' ORDER BY id DESC LIMIT 50")).map((c) => ({ ...c, okText: CALL_OK[c.ok] })) });
      // ── 操作员令牌（关联的主负责人 Hark）：网页查看审计 / 一键吊销 ──
      if (path === '/api/operator' && req.method === 'GET') { const T = await opTokens(s); const cfg = await leadCfg(s); return json({ tokens: Object.entries(T).map(([member, t]) => ({ member, name: t.name, created: t.created, active: !!t.active, ack: t.ack || '', slot: cfg.p && cfg.p.id === member ? 'p' : cfg.s && cfg.s.id === member ? 's' : null })), audit: await s.q('SELECT ts, member, method, path, note FROM opaudit ORDER BY id DESC LIMIT 80') }); }
      if (path === '/api/operator/revoke' && req.method === 'POST') { if (kind !== 'cookie') return json({ error: '只能在已登录的页面里吊销' }, 403); const T = await opTokens(s); const mid = String(body.member || ''); if (!T[mid]) return json({ error: '没有这个令牌' }, 400); const nm = T[mid].name; delete T[mid]; await kvSet(s, 'op_tokens', T); await s.q('INSERT INTO opaudit(ts,member,method,path,note) VALUES(?,?,?,?,?)', Date.now(), mid, 'WEB', '/api/operator/revoke', `你在网页吊销了 ${nm} 的操作员令牌`); return json({ ok: true }); }
      // ── 负责人岗位说明书 + 状态快照；新主负责人读完复述确认才激活 ──
      if (path === '/api/lead/brief' && req.method === 'GET') return json(await leadBrief(env, s));
      if (path === '/api/lead/ack' && req.method === 'POST') { if (kind !== 'operator') return json({ error: '只给关联的主/副负责人用（操作员令牌）' }, 403); const t = String(body.summary || '').trim().slice(0, 600); if (t.length < 20) return json({ error: '请用至少 20 个字复述：项目是干什么的、你的职责、哪些事要先问用户' }, 400); const T = await opTokens(s); if (T[OP.member]) { T[OP.member] = { ...T[OP.member], active: true, ack: t, ackAt: Date.now() }; await kvSet(s, 'op_tokens', T); } await opLog(s, OP, 'POST', '/api/lead/ack', '复述确认，已激活：' + t.slice(0, 120)); try { await addMsg(s, STEWARD_ROOM, 'note', '', '', `通知：${LEAD_LABEL[OP.slot]} ${OP.name} 已读岗位说明书并确认，已${OP.slot === 'p' ? '激活' : '待命'}。复述：${t.slice(0, 200)}`, ''); } catch {} return json({ ok: true, active: true }); }
      if (path === '/api/lead/handoff-note' && req.method === 'POST') { if (kind !== 'operator' && kind !== 'cookie') return json({ error: '只给主负责人或网页用' }, 403); const t = String(body.note || '').trim().slice(0, 3000); if (!t) return json({ error: '交接备注不能为空' }, 400); await kvSet(s, 'handoff_note', { by: OP ? OP.name : '群主（网页）', text: t, ts: Date.now() }); return json({ ok: true }); }
      if (path === '/api/lead/charter' && req.method === 'POST') { if (kind !== 'cookie') return json({ error: '岗位说明书只能在网页里改' }, 403); const t = String(body.charter || '').trim().slice(0, 8000); if (t.length < 50) return json({ error: '说明书太短' }, 400); if (body.reset) await kvDel(s, 'lead_charter'); else await kvSet(s, 'lead_charter', t); return json({ ok: true }); }
      // ── 关联 Hark（配对码） ──
      if (path === '/api/pair/new' && req.method === 'POST') { if (kind !== 'cookie' && kind !== 'operator') return json({ error: '只能在已登录的页面里生成配对码' }, 403); if (!['p', 's'].includes(body.slot)) return json({ error: 'slot 只能是 p / s' }, 400); const pn = await pairNew(env, s, body.slot, url, kind === 'operator' ? OP : null); return json(pn); }
      if (path === '/api/pair/status' && req.method === 'GET') { const code = String(url.searchParams.get('code') || '').toUpperCase(); return json(await pairStatus(s, code)); }
      if (path === '/api/handoff' && req.method === 'GET') return new Response(HANDOFF_TEXT(env.PUBLIC_ORIGIN || url.origin), { headers: { 'content-type': 'text/plain; charset=utf-8', ...SEC_HEADERS } });
      const hg = path.match(/^\/api\/guide\/(x-[a-z0-9._-]{1,60})$/);
      if (hg && req.method === 'GET') { const m = (await loadMembers(s)).find((x) => x.id === hg[1]); if (!m) return json({ error: '没有这个成员' }, 404); return json({ text: harkGuide(env.PUBLIC_ORIGIN || url.origin, m.id, await memberToken(env, m.id), null) }); }
      // ── 负责人设置 ──
      if (path === '/api/lead' && req.method === 'GET') return json(await leadView(env, s));
      if (path === '/api/lead/candidates' && req.method === 'GET') return json(await leadCandidates(env, s));
      const mc = path.match(/^\/api\/member\/([a-z0-9][a-z0-9._-]{1,63})\/caps$/);
      if (mc && req.method === 'POST') {   // 核实/修改能力：只认网页登录（用户本人）
        if (kind !== 'cookie') return json({ error: '只能在已登录的页面里改成员能力' }, 403);
        if (!(await loadMembers(s)).some((m) => m.id === mc[1])) return json({ error: '没有这个 AI成员' }, 404);
        if (body.reset === true) { await kvDel(s, 'caps:' + mc[1]); const m0 = (await loadMembers(s)).find((x) => x.id === mc[1]); return json({ ok: true, reset: true, caps: CAPS.capsOf(m0), leadElig: CAPS.leadEligibility(m0) }); }
        const v = CAPS.validateCaps(body); if (!v.ok) return json({ error: v.error }, 400);
        const cur = (await kvGet(s, 'caps:' + mc[1])) || {}; await kvSet(s, 'caps:' + mc[1], { ...cur, ...v.caps });
        const m = (await loadMembers(s)).find((x) => x.id === mc[1]);
        return json({ ok: true, caps: CAPS.capsOf(m), leadElig: CAPS.leadEligibility(m) });
      }
      if (path === '/api/models/pool' && req.method === 'GET') return json({ pool: (await kvGet(s, 'model_pool')) || [], extra: (await kvGet(s, 'model_extra')) || {} });
      if (path === '/api/models/sync' && req.method === 'POST') {   // 手动同步：给 models 就按这份列表（测试用），否则跑一次探测
        if (kind !== 'cookie') return json({ error: '只能在已登录的页面里同步模型' }, 403);
        if (Array.isArray(body.models)) { if (!RELAYS[body.relay]) return json({ error: '没有这个中转站' }, 400); return json({ ok: true, ...(await syncRelayModels(s, body.relay, body.models.slice(0, 2000).map(String))) }); }
        return json(await probeAll(env));
      }
      if (path === '/api/models/pool/confirm' && req.method === 'POST') {   // 用户（cookie）或资源管家/操作员确认后才成为成员
        if (kind !== 'cookie' && kind !== 'operator') return json({ error: '只有用户或资源管家能确认候选模型' }, 403);
        const r = await poolConfirm(s, String(body.norm || ''), kind === 'cookie' ? '用户' : '资源管家/操作员', kind === 'operator' ? OP : null); return r.error ? json({ error: r.error }, r.status || 404) : json(r);
      }
      if (path === '/api/models/pool/dismiss' && req.method === 'POST') {
        if (kind !== 'cookie' && kind !== 'operator') return json({ error: '只有用户或资源管家能处理候选模型' }, 403);
        const n = String(body.norm || ''); const P0 = (await kvGet(s, 'model_pool')) || []; const hit = P0.find((x) => x.norm === n);
        await kvSet(s, 'model_pool', P0.filter((x) => x.norm !== n));
        const d = new Set((await kvGet(s, 'model_pool_dismissed')) || []); if (hit) for (const r of hit.relays || []) d.add(r + '|' + String((hit.models || {})[r] || hit.name).trim());
        await kvSet(s, 'model_pool_dismissed', [...d].slice(-1000)); return json({ ok: true });
      }
      if (path === '/api/lead' && req.method === 'POST') { if (kind !== 'cookie' && kind !== 'operator') return json({ error: '只能在已登录的页面里改负责人' }, 403); if (kind === 'operator' && ['p', 's'].some((k) => body[k] && body[k].key)) return json({ error: '操作员令牌不能写入 Key' }, 403); const r = await leadSave(rawEnv, s, body, { operator: kind === 'operator' }); return r.error ? json(r, r.status || 400) : json({ ...r, lead: await leadView(env, s) }); }
      if (path === '/api/lead/test' && req.method === 'POST') { if (!['p', 's'].includes(body.slot)) return json({ error: 'slot 只能是 p / s' }, 400); return json(await leadTest(rawEnv, s, body.slot)); }
      if (path === '/api/probe' && req.method === 'POST') return json(await probeAll(env));
      if (path === '/api/plan' && req.method === 'POST') {
        const topic = typeof body.topic === 'string' ? body.topic.slice(0, MAX_MSG) : '';
        if (!topic.trim()) return json({ error: '先写议题' }, 400);
        const mode = MODES[body.mode] ? body.mode : 'debate';
        const all = await enrichAll(env, s);
        const base = heuristicPlan(all, topic, mode, { pool: Array.isArray(body.pool) ? body.pool.slice(0, 80) : null });
        const lp = await leadPlan(env, s, all, topic, mode, base, { ai: !!body.ai, sens: !!body.sensitive, noAsync: true });
        const plan = lp.plan;
        return json({ ...plan, leadNotes: lp.notes, lead: lp.lead ? lp.lead.id : null, note: (lp.notes.length ? lp.notes.join('\n') + '\n' : '') + planText(all, plan.members, plan.engine, plan.tags) });
      }
      if (path === '/api/rooms' && req.method === 'GET') { await ensureStewardRoom(s); return json({ rooms: (await s.q("SELECT id,title,mode,created,updated,COALESCE(status,'进行中') AS status, COALESCE(sens,0) AS sens FROM rooms ORDER BY updated DESC LIMIT 200")).map((r) => (r.id === STEWARD_ROOM ? { ...r, pinned: true, steward: true } : r)) }); }
      const rm = path.match(/^\/api\/room\/([a-z0-9]{6,16})$/);
      if (rm && req.method === 'GET') {
        let r = await getRoom(s, rm[1]); if (!r) return json({ error: '房间不存在' }, 404);
        if (await webSweep(s).then((x) => x.length).catch(() => 0)) r = await getRoom(s, rm[1]);
        const lw = await leadCheck(env, s, rm[1]); if (!lw && r.pending.some((p) => p.role === '负责人')) r = await getRoom(s, rm[1]);
        r.leadWait = lw; r.lead = await roomLeadId(s, rm[1]);
        const after = +url.searchParams.get('after') || 0; if (after) r.messages = r.messages.filter((x) => x.id > after);
        return json(r);
      }
      if (rm && req.method === 'DELETE' && rm[1] === STEWARD_ROOM) return json({ error: '资源管家的置顶私聊不能删除' }, 400);
      if (rm && req.method === 'DELETE') {
        await s.batch([['DELETE FROM msgs WHERE room=?', [rm[1]]], ['DELETE FROM parts WHERE room=?', [rm[1]]], ['DELETE FROM tasks WHERE room=?', [rm[1]]], ['DELETE FROM ratings WHERE room=?', [rm[1]]], ['DELETE FROM rooms WHERE id=?', [rm[1]]]]);
        return json({ ok: true });
      }
      const ra = path.match(/^\/api\/room\/([a-z0-9]{6,16})\/audit$/);
      if (ra && req.method === 'GET') return json({ audit: await s.q('SELECT member,via,level,action,note,ts FROM audit WHERE room=? ORDER BY id DESC LIMIT 100', ra[1]), levels: LEVELS });
      const rp = path.match(/^\/api\/room\/([a-z0-9]{6,16})\/(pause|ask|decide)$/);   // P1-4：N2 暂停/继续、N3 决策题
      if (rp && req.method === 'POST') {
        const r = await getRoom(s, rp[1]); if (!r) return json({ error: '房间不存在' }, 404);
        if (rp[1] === STEWARD_ROOM) return json({ error: '资源管家私聊不支持' }, 400);
        if (rp[2] === 'pause') {
          const want = body.paused === true;
          if (want !== r.paused) { if (want) await kvSet(s, 'pause:' + rp[1], { at: Date.now(), by: kind }); else await kvDel(s, 'pause:' + rp[1]); await addMsg(s, rp[1], 'note', '', '', want ? '—— 已暂停：当前这位说完就停，下一位不启动 ——' : '—— 已继续 ——', ''); }
          return json({ ok: true, paused: want });
        }
        if (rp[2] === 'ask') {
          if (!['cookie', 'bearer', 'operator'].includes(kind)) return json({ error: '没有权限' }, 403);
          const v = P1.validateDecision(body); if (!v.ok) return json({ error: v.error }, 400);
          const mid = await addMsgId(s, rp[1], 'decision', (await roomLeadId(s, rp[1])) || 'hark', '', v.question, '负责人');
          await kvSet(s, 'decision:' + mid, { options: v.options, choice: null, at: null, by: kind });
          return json({ ok: true, msg: mid });
        }
        if (kind !== 'cookie' && kind !== 'bearer') return json({ error: '只有你本人能拍板' }, 403);
        const mid = Math.floor(+body.msg) || 0; const key = 'decision:' + mid;
        const d = await kvGet(s, key); const row = (await s.q("SELECT id,text FROM msgs WHERE id=? AND room=? AND kind='decision'", mid, rp[1]))[0];
        if (!d || !row) return json({ error: '没有这道决策题' }, 404);
        if (!d.options.includes(body.choice)) return json({ error: '只能从给出的选项里选' }, 400);
        const at = Date.now();
        const upd = await s.q("UPDATE kv SET v=? WHERE k=? AND json_extract(v,'$.choice') IS NULL RETURNING k", JSON.stringify({ ...d, choice: body.choice, at }), key);   // 幂等：只有第一次生效
        if (!upd.length) { const cur = await kvGet(s, key) || {}; return json({ ok: true, already: true, choice: cur.choice, at: cur.at }); }
        await addMsg(s, rp[1], 'note', '', '', `用户选择：${body.choice}（${String(row.text).slice(0, 40)}）`, '');
        return json({ ok: true, choice: body.choice, at });
      }
      const rs = path.match(/^\/api\/room\/([a-z0-9]{6,16})\/(members|status|rate|review)$/);
      if (rs && req.method === 'POST') {
        const r = await getRoom(s, rs[1]); if (!r) return json({ error: '房间不存在' }, 404);
        if (rs[2] === 'status') { if (!PROJECT_STATUS.includes(body.status)) return json({ error: '状态只能是 进行中/已完成/失败' }, 400); await s.q('UPDATE rooms SET status=? WHERE id=?', body.status, rs[1]); return json({ ok: true }); }
        if (rs[2] === 'rate') {
          const sc = Math.round(+body.score);
          if (typeof body.member !== 'string' || !r.lineup.some((x) => x.id === body.member) || !(sc >= 1 && sc <= 5) || typeof body.job !== 'string' || !body.job.trim()) return json({ error: '需要本房间成员、岗位、1–5 分' }, 400);
          await s.q('INSERT INTO ratings(room,member,job,score,src,rater,note,ts) VALUES(?,?,?,?,?,?,?,?)', rs[1], body.member, body.job.trim().slice(0, 12), sc, '用户打分', 'user', String(body.note || '').slice(0, 200), Date.now());
          return json({ ok: true });
        }
        const all = await enrichAll(env, s);
        if (rs[2] === 'review') { const x = await peerReview(env, s, rs[1], all); return x.error ? json(x, 400) : json(x); }
        const lineup = cleanLineup(body.members, new Set(all.map((m) => m.id)));
        if (!lineup.length) return json({ error: '至少留一个 AI成员' }, 400);
        await setLineup(s, rs[1], lineup);
        return json({ ok: true, lineup });
      }
      if (path === '/api/search' && req.method === 'GET') return json(await search(s, await enrichAll(env, s), url.searchParams.get('q') || ''));
      if (path === '/api/usage' && req.method === 'GET') return json(await usageView(env));
      if (path === '/api/start' && req.method === 'POST') {
        // P1-6 发件箱：客户端消息 ID（cid）幂等——同一 cid 只写一次；失败（4xx）释放 cid 允许重试
        const cid = typeof body.cid === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.cid) ? body.cid : '';
        if (body.cid !== undefined && !cid) return json({ error: 'cid 格式不对（8–64 位字母数字 - _）' }, 400);
        if (cid) {
          const got = await s.q('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO NOTHING RETURNING k', 'cid:' + cid, JSON.stringify({ ts: Date.now(), room: body.room || null, state: 'busy' }));
          if (!got.length) { const v = (await kvGet(s, 'cid:' + cid)) || {}; return json({ ok: true, dup: true, cid, room: v.room || body.room || null, lineup: v.lineup || [] }); }
        }
        let r; try { r = await startRound(env, s, body, await enrichAll(env, s)); } catch (e) { if (cid) await kvDel(s, 'cid:' + cid); throw e; }
        if (cid) { if (r.error) await kvDel(s, 'cid:' + cid); else await kvSet(s, 'cid:' + cid, { ts: Date.now(), room: r.room, state: 'done', lineup: (r.lineup || []).map((x) => ({ id: x.id, role: x.role })) }); }
        return r.error ? json(r, 400) : json(r);
      }
      if (path === '/api/turn' && req.method === 'POST') {
        if (typeof body.room !== 'string' || !ROOM_RE.test(body.room)) return json({ error: '缺少房间' }, 400);
        if (typeof body.member !== 'string' || !ID_RE.test(body.member)) return json({ error: '缺少成员' }, 400);
        const r = await runTurn(env, s, body.room, body.member, { mode: body.mode });
        return r.error ? json(r, 400) : json(r);
      }
      if (path === '/api/round' && req.method === 'POST') {
        let all = await enrichAll(env, s);
        const st = await startRound(env, s, body, all);
        if (st.error) return json(st, 400);
        const replies = []; let verdict = null;
        for (const x of st.lineup) {
          const cur = await getRoom(s, st.room); const slot = cur.lineup.find((y) => y.role === x.role && (y.id === x.id || !st.lineup.some((z) => z.id === y.id)));
          const t = await runTurn(env, s, st.room, slot ? slot.id : x.id, { mode: st.mode, all });  // 复用同一份成员视图，省 CPU（免费版 10ms）
          if (t.paused) break;   // N2：暂停后下一位不启动
          if (t.skipped || t.replaced) all = await enrichAll(env, s);
          replies.push({ member: t.name || t.member, id: t.member, role: x.role, model: t.model || null, via: t.via || null, text: t.text || t.notice || '', skipped: !!t.skipped, pending: !!t.pending, replaced: t.replaced ? t.replaced.note : undefined });
          if (x.role === '裁判' && t.text) verdict = t.text;
        }
        return json({ room: st.room, mode: st.mode, lineup: st.lineup, plan: st.planNote, replies, verdict });
      }
      // ── P1-3 点子库：读/建/改 = 网页或负责人（操作员）；删只在网页 ──
      if (path === '/api/ideas' && req.method === 'GET') return json({ ideas: await ideaList(s), statuses: P1.IDEA_STATUS });
      if (path === '/api/ideas' && req.method === 'POST') { const [o, c] = await ideaSave(s, body); return json(o, c); }
      const im = path.match(/^\/api\/idea\/([a-z0-9-]{3,40})(\/writeback)?$/);
      if (im && req.method === 'GET' && !im[2]) { await ideaSeed(s); const it = await ideaGet(s, im[1]); if (!it) return json({ error: '没有这个点子' }, 404); it.rooms = await s.q("SELECT id,title,COALESCE(status,'进行中') AS status,created FROM rooms WHERE idea=? ORDER BY created DESC LIMIT 50", it.id); return json(it); }
      if (im && req.method === 'DELETE' && !im[2]) { if (kind !== 'cookie') return json({ error: '点子只能在已登录的页面里删除' }, 403); await s.batch([['UPDATE rooms SET idea=NULL WHERE idea=?', [im[1]]], ['DELETE FROM ideas WHERE id=?', [im[1]]]]); return json({ ok: true }); }   // 复审采纳：同一批原子执行
      if (im && im[2] && req.method === 'POST') {   // 项目结论回写点子：只收关联了这个点子的项目
        if (kind !== 'cookie' && kind !== 'operator' && kind !== 'bearer') return json({ error: '没有权限' }, 403);
        const it = await ideaGet(s, im[1]); if (!it) return json({ error: '没有这个点子' }, 404);
        const rm0 = typeof body.room === 'string' && ROOM_RE.test(body.room) ? (await s.q('SELECT id,title,idea FROM rooms WHERE id=?', body.room))[0] : null;
        if (!rm0 || rm0.idea !== it.id) return json({ error: '这个项目没有关联这个点子' }, 400);
        const t = String(body.text || '').trim().slice(0, 1000); if (!t) return json({ error: '结论不能为空' }, 400);
        const notes = [...it.notes, { room: rm0.id, title: rm0.title, text: t, ts: Date.now() }].slice(-50);
        await s.q('UPDATE ideas SET notes=?, updated=? WHERE id=?', JSON.stringify(notes), Date.now(), it.id); return json({ ok: true, notes: notes.length });
      }
      // ── P1-2 网页代发员：登记/同意/删除只认网页 cookie（用户本人）；Bearer/操作员只读、看不到令牌 ──
      if (path === '/api/relays' && req.method === 'GET') {
        const R = await webRelays(s); const now = Date.now();
        return json({ relays: await Promise.all(Object.entries(R).map(async ([id, r]) => ({ id, name: r.name, kind: r.kind, consent: !!r.consent, seen: r.seen || null, online: now - (r.seen || 0) < P1.RELAY_ONLINE_MS, created: r.created, ...(kind === 'cookie' ? { token: await relayToken(rawEnv, id) } : {}) }))), pull: (env.PUBLIC_ORIGIN || url.origin) + '/bridge/web/pull?relay=<ID>', timeoutMin: P1.WEB_TIMEOUT_MS / 60000 });
      }
      if ((path === '/api/relays' || path === '/api/relays/consent') && req.method === 'POST') {
        if (kind !== 'cookie') return json({ error: '代发员只能在已登录的页面里登记（涉及操作你的浏览器/电脑）' }, 403);
        const id = String(body.id || '').toLowerCase(); if (!P1.RELAY_ID_RE.test(id)) return json({ error: 'id 只能是 2–32 位小写字母、数字、- 或 _' }, 400);
        const R = await webRelays(s);
        if (path === '/api/relays/consent') { if (!R[id]) return json({ error: '没有这个代发员' }, 404); if (R[id].kind !== 'desktop') return json({ error: '只有桌面桥接需要同意' }, 400); R[id].consent = body.consent === true; R[id].consentAt = Date.now(); await kvSet(s, 'web_relays', R); return json({ ok: true, consent: R[id].consent }); }
        const rk = body.kind === 'desktop' ? 'desktop' : body.kind === 'hark' ? 'hark' : null; if (!rk) return json({ error: '类型只能是 hark（Hark 远程浏览器）或 desktop（你电脑上的桌面桥接）' }, 400);
        const nm = String(body.name || '').trim().slice(0, 30); if (!nm) return json({ error: '需要名字' }, 400);
        R[id] = { ...(R[id] || {}), name: nm, kind: rk, consent: rk === 'desktop' ? body.consent === true : false, created: (R[id] || {}).created || Date.now(), test: await testModeOn(s) };
        await kvSet(s, 'web_relays', R); return json({ ok: true, id, token: await relayToken(rawEnv, id) });
      }
      const rdm = path.match(/^\/api\/relays\/([a-z0-9][a-z0-9_-]{1,31})$/);
      if (rdm && req.method === 'DELETE') { if (kind !== 'cookie') return json({ error: '只能在已登录的页面里删除' }, 403); const R = await webRelays(s); delete R[rdm[1]]; await kvSet(s, 'web_relays', R); await s.q("UPDATE tasks SET status='pending', relay=NULL, claimed=NULL WHERE kind='web' AND status='sent' AND relay=?", rdm[1]); return json({ ok: true }); }
      if (path === '/api/testmode/websweep' && req.method === 'POST') {   // 只给测试用：测试模式里把「现在」快进 advanceMs，验证 10 分钟改派
        if (kind !== 'cookie' || !(await testModeOn(s))) return json({ error: '只在测试模式里、用页面 cookie 可用' }, 403);
        const adv = Math.max(0, Math.min(3600000, +body.advanceMs || 0)); return json({ ok: true, plan: await webSweep(s, Date.now() + adv) });
      }
      if (path === '/api/agents' && req.method === 'POST') { const [o, c] = await saveAgent(s, body, { operator: kind === 'operator' }); return json(o, c); }
      const am = path.match(/^\/api\/agents\/((?:x|pool)-[a-z0-9._-]{1,60})$/);   // 自建成员（x-）和候选池确认的成员（pool-）都能删
      if (am && req.method === 'DELETE') { await s.q('DELETE FROM custom WHERE id=?', am[1]); return json({ ok: true }); }
      if (path === '/api/telegram/setup' && req.method === 'POST') {
        if (!env.TELEGRAM_BOT_TOKEN) return json({ error: '缺 TELEGRAM_BOT_TOKEN' }, 400);
        const p = await tgPath(env);
        const r = await fetchT(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: `${env.PUBLIC_ORIGIN || url.origin}/hook/tg/${p}`, secret_token: p, allowed_updates: ['message', 'edited_message'] }) });
        return json({ ok: r.ok });
      }
      if (path === '/api/probe-model' && req.method === 'GET') {
        const model = url.searchParams.get('model') || '';
        if (!/^@cf\/[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(model)) return json({ error: 'model 格式不对' }, 400);
        const t0 = Date.now();
        try { const r = await callWorkersAI(env, { invoke: { model }, neurons: [30000, 70000] }, '用简体中文回答，不超过20字。', '用一句话介绍你自己。', 120); await addUsage(s, 'probe', r.tin, r.tout, r.neurons); return json({ model, ok: !!clean(r.text), ms: Date.now() - t0, text: clean(r.text).slice(0, 200) }); }
        catch (e) { return json({ model, ok: false, ms: Date.now() - t0, error: String(e.message || e).slice(0, 300) }); }
      }
      return json({ error: '找不到' }, 404);
    } catch (e) {
      return json({ error: '服务器出错：' + String((e && e.message) || e).slice(0, 200) }, 500);
    }
  },
};
export default WORKER;


// ───────────────────────── 资源库 + 资源管家（第二批） ─────────────────────────
// 静态数据 resources.json（技能 + 学习与网站资源，deploy 时打包）+ 管家写入的条目（DO 表 res_items）。只有管家写入；其他成员/页面只读。
const STEWARD = 'steward', STEWARD_ROOM = 'steward';
const STEWARD_DAILY = 60;                 // 小档（分类/抽取粗活）每天最多 60 次，超了改用规则（不花钱）
const STEWARD_STRONG_DAILY = 20;          // 强档（到官方页核实免费额度/到期日）每天最多 20 次，超了降到小档，再不行规则兜底
// 强档挑选：当天可用、免费、能文字对话的成员里「最强」的那个。强度是初判分（按公开评测/社区口碑，2026-10-24 定），
// 再叠加岗位标签（推理/审查/核实类 +6）、状态（未探测 −10）、额度（<15% −25）。实测不准就改这张表。
const STRONG_BASE = { 'claude-sonnet-4-6': 100, 'gpt-6-luna': 98, 'kimi-k3': 95, 'glm-5.3': 92, 'deepseek-v4.1-flash': 88, 'minimax-m3': 86, 'gemini-2.5-flash': 84,
  'agnes-2.5-pro': 82, 'kimi-k2.5': 80, 'gpt-oss-120b': 78, 'nemotron-3-120b': 75, 'qwen3.8-27b': 72, 'deepseek-v4-flash': 70, 'llama-3.3-70b': 64, 'glm-5.3-flash': 62,
  'agnes-3.0-flash': 60, 'glm-4.7-flash': 58, 'qwen3-30b-a3b': 56, 'gemma-4-26b': 55, 'llama-4-scout-17b': 52, 'mistral-small-3.1-24b': 50, 'glm-4.5-flash': 45, 'gpt-oss-20b': 44, 'gemma-3-12b': 40, 'granite-4.0-h-micro': 30 };
const CHAT_KINDS = ['workers-ai', 'openai', 'gemini'];
// 排除：只会生图/生视频（没有文字对话来源）、外部关联智能体（Poke/Webhook/小桥/Telegram/Hark/配对）、负责人专用、资源管家自己、下架、不可用
function strongEligible(m) {
  if (!m || m.retired || m.leadOnly || m.id === STEWARD || m.id === 'hark' || m.state === 'down') return false;
  if ((m.sources || []).some((x) => ASYNC_KINDS.includes((x.invoke || {}).kind))) return false;
  if (/image|video|生图|生视频/i.test(m.type || '') ) return false;
  return (m.srcs || []).some((x) => CHAT_KINDS.includes(x.kind) && x.state !== 'down' && !x.paid);
}
function strongScore(m) {
  let sc = STRONG_BASE[m.id] ?? 35; const why = [`基础分 ${sc}`];
  if ((m.jobsAll || m.jobs || []).some((j) => /推理|审查|挑错|核实|裁判|事实/.test(j.t || ''))) { sc += 6; why.push('岗位含推理/审查 +6'); }
  if (m.state === 'unknown') { sc -= 10; why.push('未探测 −10'); }
  const q = m.quota && m.quota.pct; if (q != null && q < 0.15) { sc -= 25; why.push('额度 <15% −25'); }
  return { sc, why: why.join('，') };
}
function strongRank(all) { return all.filter(strongEligible).map((m) => ({ m, ...strongScore(m) })).sort((a, b) => b.sc - a.sc); }

const RES_CATS = { api: 'API', tools: '工具与算力', skills: '技能', sites: '学习与网站资源' };
const SOCIAL = /(^|\.)(x\.com|twitter\.com|fxtwitter\.com|t\.co|reddit\.com|linux\.do|v2ex\.com|weibo\.com|zhihu\.com|xiaohongshu\.com|bilibili\.com|youtube\.com|news\.ycombinator\.com|t\.me|medium\.com)$/i;
const normTxt = (t) => String(t || '').normalize('NFKC').replace(/[\u2010-\u2015\u2212\u00ad]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
const todayLondon = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
const londonHour = () => +new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }).format(new Date());
function urlKey(u) { try { const x = new URL(u); x.hash = ''; ['utm_source', 'utm_medium', 'utm_campaign', 's', 't', 'ref'].forEach((k) => x.searchParams.delete(k)); return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '') + (x.search || '')).toLowerCase(); } catch { return String(u).toLowerCase(); } }
async function sha(s) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(b)].slice(0, 8).map((x) => x.toString(16).padStart(2, '0')).join(''); }
// 抓公网页面：每一跳重定向都重新过 safeUrl（防 SSRF），最多 4 跳、10 秒、只读前 600KB
async function safeFetchText(u, ms = 10000) {
  let url = safeUrl(u); if (!url) throw new Error('只收公网 https 链接');
  for (let hop = 0; hop < 5; hop++) {
    const r = await fetchT(url, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (compatible; AGC-Steward/1.0)', accept: 'text/html,application/json,application/xml;q=0.9,*/*;q=0.5' } }, ms);
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { const nx = safeUrl(new URL(r.headers.get('location'), url).toString()); if (!nx) throw new Error('重定向到了不允许的地址'); url = nx; continue; }
    if (!r.ok) throw new Error('页面返回 ' + r.status);
    const reader = r.body.getReader(); const chunks = []; let n = 0;
    while (n < 600000) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); n += value.length; }
    try { reader.cancel(); } catch {}
    const buf = new Uint8Array(n); let o = 0; for (const c of chunks) { buf.set(c.slice(0, n - o), o); o += c.length; if (o >= n) break; }
    return { url, text: new TextDecoder().decode(buf), type: r.headers.get('content-type') || '' };
  }
  throw new Error('重定向太多');
}
const htmlText = (h) => String(h).replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const titleOf = (h) => ((String(h).match(/<title[^>]*>([^<]{1,200})/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
// 读一个链接的正文；X 帖走 fxtwitter（失败就明说，不用模型补）
async function readLink(u) {
  const m = String(u).match(/^https:\/\/(?:mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,20})\/status\/(\d{5,25})/);
  if (m) {
    const r = await safeFetchText(`https://api.fxtwitter.com/${m[1]}/status/${m[2]}`);
    let j; try { j = JSON.parse(r.text); } catch { throw new Error('fxtwitter 没返回帖子内容（可能被删、限流或服务变了）'); }
    const t = (j && j.tweet) || {}; if (!t.text && !t.article) throw new Error('fxtwitter 没返回帖子正文');
    const art = t.article ? JSON.stringify(t.article).replace(/"[a-z_]+":/gi, ' ').slice(0, 5000) : '';
    const links = [...new Set(((t.raw_text && t.raw_text.facets) || []).map((f) => f.replacement || f.original).filter((x) => /^https:/.test(x || '')))];
    return { kind: 'post', url: u, title: `@${m[1]} 的帖子`, text: ((t.text || '') + '\n' + art).slice(0, 6000), links, author: t.author && t.author.screen_name };
  }
  const r = await safeFetchText(u);
  return { kind: 'page', url: r.url, title: titleOf(r.text), text: (/json/.test(r.type) ? r.text : htmlText(r.text)).slice(0, 6000), links: [] };
}
// 规则分类（模型不可用或超预算时用）
function ruleCat(url, text) {
  const h = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  const t = (text || '').slice(0, 3000);
  if (/github\.com$/.test(h)) return 'skills';
  if (/\b(skill|SKILL\.md|workflow)\b|技能|工作流/i.test(t)) return 'skills';
  if (/\b(gpu|sandbox|vps)\b|沙盒|显卡|算力|云手机|接码|短信验证|号码/i.test(t)) return 'tools';
  if (/api[ _-]?key|\brate limits?\b|\bRPD\b|per 1M tokens|免费额度|tokens? per (day|minute)/i.test(t) && /\b(api|model)\b|模型|接口/i.test(t)) return 'api';
  return 'sites';
}
function ruleExtract(text) {
  const t = String(text || '');
  const sents = t.split(/(?<=[。！？!?])|(?<=\.)\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  const ev = (sents.find((x) => /\b(free|credits?|trial)\b|免费|额度|试用/i.test(x) && /\d|until|through|至|到|每|per|unlimited|无限/i.test(x)) || sents.find((x) => /\bfree\b|免费/i.test(x)) || '').slice(0, 220);
  const MON = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
  const em = t.match(/(?:until|through|till|ends?|expires?)\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d\d)/i);
  const dm = t.match(/(?:到期|截止|免费至|免费到|until|through)[^0-9]{0,8}(20\d\d)[-/年.](\d{1,2})[-/月.](\d{1,2})/i);
  let expires = '';
  if (em) expires = `${em[3]}-${String(MON[em[1].toLowerCase()]).padStart(2, '0')}-${em[2].padStart(2, '0')}`;
  else if (dm) expires = `${dm[1]}-${dm[2].padStart(2, '0')}-${dm[3].padStart(2, '0')}`;
  return { free: ev, evidence: ev, expires };
}
const STEWARD_SYS = `你是资源库管家。把给你的网页/帖子正文整理成一条资源记录，只输出一个 JSON 对象，不要别的文字：
{"category":"api|tools|skills|sites","name":"","purpose":"一句话中文用途","free":"免费额度（中文转述，没有写空）","expires":"YYYY-MM-DD 或空","evidence":"正文里能证明免费额度或期限的原句，必须逐字复制，没有写空","official_url":"正文里出现的厂商官方页面网址，没有写空","paid":true或false}
分类：api=模型/接口的额度；tools=显卡、算力、沙盒、手机号、云手机、浏览器等可调用工具；skills=技能、工作流、开源仓库、做法指南；sites=学习、素材、UI 组件、音效、配音、提示词等网站。不知道就写空，绝对不要编造数字或日期。`;
// 小档（粗活：分类/抽取）：Groq gpt-oss-20b（快、便宜）→ PM 公益站 glm-4.5-flash → Workers AI gpt-oss-20b；按顺序试，返回实际用的模型名
function stewardSmallChain(env) {
  const tries = [];
  if (env.GROQ_API_KEY) tries.push(['Groq gpt-oss-20b（官方 API）', (sys, user, mx) => callOpenAI(env, { base: 'https://api.groq.com/openai/v1', secret: 'GROQ_API_KEY', model: 'openai/gpt-oss-20b' }, sys, user, mx)]);
  const pm = CONFIG.members.find((m) => m.id === 'glm-4.5-flash'); if (pm) { const iv = srcInvoke(env, pm.sources[0]); if (iv.base && env[iv.secret]) tries.push(['PM 公益站 glm-4.5-flash', (sys, user, mx) => callOpenAI(env, iv, sys, user, mx)]); }
  if (env.AI) tries.push(['Workers AI gpt-oss-20b', (sys, user, mx) => callWorkersAI(env, { invoke: { model: '@cf/openai/gpt-oss-20b' }, neurons: [18182, 27273] }, sys, user, mx)]);
  return tries;
}
const SMALL_LABELS = ['Groq gpt-oss-20b（官方 API）', 'PM 公益站 glm-4.5-flash', 'Workers AI gpt-oss-20b'];
async function stewardSmall(env, s, sys, user, mx = 900) {
  const day = utcDay(); const used = (await kvGet(s, 'steward_calls:' + day)) || 0;
  if (used >= STEWARD_DAILY) return { skipped: '小档今天次数用完（上限 ' + STEWARD_DAILY + '）' };
  const cfDown = (await kvGet(s, 'cf_exhausted')) === day;
  const tries = stewardSmallChain(env).filter(([l]) => !(cfDown && l.startsWith('Workers AI')));
  const errs = [];
  for (const [label, fn] of tries) {
    try {
      const r = await fn(sys, user, mx); await kvSet(s, 'steward_calls:' + day, ((await kvGet(s, 'steward_calls:' + day)) || 0) + 1); await addUsage(s, 'steward@0', r.tin || 0, r.tout || 0, r.neurons || 0);
      const m = String(r.text || '').match(/\{[\s\S]*\}/); if (!m) throw new Error('没返回 JSON');
      return { json: JSON.parse(m[0]), model: label };
    } catch (e) { errs.push(label + '：' + String((e && e.message) || e).slice(0, 60)); }
  }
  return { skipped: errs.length ? '小档模型都没成功（' + errs.join('；') + '）' : '没有可用的小档模型（Groq Key 未填、公益站/Workers AI 不可用）' };
}
async function stewardLLM(env, s, user) {
  const r = await stewardSmall(env, s, STEWARD_SYS, user, 900);
  return r.json ? r : { skipped: r.skipped + '，改用规则整理' };
}
// 强档：当天可用的最强免费成员。失败（或超每日上限）→ 小档 → 交给调用方用规则兜底
async function stewardStrong(env, s, sys, user, mx = 1200) {
  const day = utcDay(); const used = (await kvGet(s, 'steward_vcalls:' + day)) || 0; const errs = [];
  if (used < STEWARD_STRONG_DAILY) {
    const ranked = strongRank(await enrichAll(env, s)).slice(0, 3);
    for (const x of ranked) {
      try {
        const r = await leadText(env, s, x.m, sys, user, mx, { label: '资源管家核实' });
        await kvSet(s, 'steward_vcalls:' + day, ((await kvGet(s, 'steward_vcalls:' + day)) || 0) + 1);
        const mm = String(r.text || '').match(/\{[\s\S]*\}/); if (!mm) throw new Error('没返回 JSON');
        return { json: JSON.parse(mm[0]), model: `强档 ${x.m.name}（${r.via}）`, tier: 'strong' };
      } catch (e) { errs.push(x.m.name + '：' + String((e && e.message) || e).slice(0, 60)); }
    }
    if (!ranked.length) errs.push('今天没有可用的强档成员');
  } else errs.push('强档今天次数用完（上限 ' + STEWARD_STRONG_DAILY + '）');
  const sm = await stewardSmall(env, s, sys, user, mx);
  if (sm.json) return { ...sm, model: '小档 ' + sm.model + '（强档没成功：' + errs.join('；').slice(0, 120) + '）', tier: 'small' };
  return { skipped: '强档：' + errs.join('；').slice(0, 160) + '；小档：' + sm.skipped, tier: 'rule' };
}
async function stewardTiers(env, s) {
  const day = utcDay(); const all = await enrichAll(env, s); const rk = strongRank(all);
  const excluded = all.filter((m) => !strongEligible(m) && !m.leadOnly).map((m) => m.id);
  const cfDown = (await kvGet(s, 'cf_exhausted')) === day;
  return {
    small: { job: '分类 / 抽取（粗活）', chain: SMALL_LABELS, available: stewardSmallChain(env).map(([l]) => l).filter((l) => !(cfDown && l.startsWith('Workers AI'))), used: (await kvGet(s, 'steward_calls:' + day)) || 0, cap: STEWARD_DAILY },
    strong: { job: '到官方页核实免费额度和到期日', pick: rk[0] ? { id: rk[0].m.id, name: rk[0].m.name, score: rk[0].sc, why: rk[0].why } : null, ranked: rk.slice(0, 6).map((x) => ({ id: x.m.id, name: x.m.name, score: x.sc })), used: (await kvGet(s, 'steward_vcalls:' + day)) || 0, cap: STEWARD_STRONG_DAILY, fallback: '强档失败 → 小档 → 规则（官方页逐字比对证据原句）' },
    excluded, day, free: true,
  };
}
const VERIFY_SYS = `你是事实核查员。下面给你一个厂商官方网页的正文，以及别人说的「免费额度 / 到期日」。只根据这个官方页判断，只输出一个 JSON 对象：
{"found":true或false,"free":"官方页写的免费额度（中文转述，没有写空）","expires":"YYYY-MM-DD 或空","quote":"官方页里能证明免费额度或期限的原句，必须逐字复制，没有写空"}
官方页里没写就 found=false，绝对不要编造数字、日期或原句。`;
// 在官方页（非社交/论坛域名）里找证据原句 → 已核实
async function verifyOnOfficial(cands, evidence) {
  const ev = normTxt(evidence).slice(0, 90); if (ev.length < 8) return null;
  for (const u of cands) {
    if (!u) continue; let h; try { h = new URL(u).hostname; } catch { continue; } if (SOCIAL.test(h)) continue;
    try { const r = await safeFetchText(u); const body = normTxt(/json/.test(r.type) ? r.text : htmlText(r.text)); if (body.includes(ev)) return r.url; } catch {}
  }
  return null;
}
// 核实（两档）：取第一个能打开的官方页（非社交/论坛），强档模型读页面给出原句 → 原句必须真在页面里才算已核实；
// 强档/小档都失败 → 规则：页面里逐字找整理时抽到的证据原句
async function verifyTiered(env, s, cands, item) {
  let page = null; const tried = [];
  for (const u of cands) {
    if (!u) continue; let h; try { h = new URL(u).hostname; } catch { continue; } if (SOCIAL.test(h)) { tried.push(h + '（社交/论坛，不算官方）'); continue; }
    try { const r = await safeFetchText(u); page = { url: r.url, body: (/json/.test(r.type) ? r.text : htmlText(r.text)) }; break; } catch (e) { tried.push(h + '：' + String((e && e.message) || e).slice(0, 40)); }
  }
  if (!page) return { url: null, model: '没调用（没有能打开的官方页）', note: tried.length ? tried.join('；').slice(0, 160) : '没有官方页链接' };
  const norm = normTxt(page.body);
  const llm = (item.free || item.expires || item.evidence) ? await stewardStrong(env, s, VERIFY_SYS, `官方页：${page.url}\n别人说的免费额度：${item.free || '（没写）'}\n别人说的到期日：${item.expires || '（没写）'}\n官方页正文：\n${page.body.slice(0, 6000)}`) : { skipped: '没有要核实的额度/到期日' };
  if (llm.json) {
    const j = llm.json; const q = String(j.quote || ''); const qn = normTxt(q).slice(0, 90);
    if (j.found && qn.length >= 8 && norm.includes(qn)) return { url: page.url, model: llm.model, quote: q, free: String(j.free || ''), expires: /^\d{4}-\d{2}-\d{2}$/.test(j.expires || '') ? j.expires : '' };
    // 模型说找到了但原句对不上 → 不信，落到规则
    const ev = normTxt(item.evidence).slice(0, 90);
    if (ev.length >= 8 && norm.includes(ev)) return { url: page.url, model: llm.model + ' + 规则原句比对' };
    return { url: null, model: llm.model, note: j.found ? '模型给的原句在官方页里找不到（不采信）' : '官方页没写这条免费额度/到期日' };
  }
  const ev = normTxt(item.evidence).slice(0, 90);
  if (ev.length >= 8 && norm.includes(ev)) return { url: page.url, model: '规则（' + (llm.skipped || '') .slice(0, 80) + '）' };
  return { url: null, model: '规则', note: (llm.skipped ? llm.skipped.slice(0, 100) + '；' : '') + '官方页没找到证据原句' };
}
function resState(it) { const today = todayLondon(); if (it.expires && it.expires < today) return '已过期'; return it.vstate || '未核实'; }
async function ingestLink(env, s, u, via) {
  const key = urlKey(u); const id = 'u-' + await sha(key);
  let page;
  try { page = await readLink(u); } catch (e) { return { url: u, error: '抓取失败：' + String((e && e.message) || e).slice(0, 120) + '。我没有用搜索摘要或模型去补内容，这条先不入库。' }; }
  return ingestPage(env, s, id, u, page, via);
}
// P1-5：没有链接、只有一段文字（帖子原文/文件内容）→ 同一条流水线：整理 → 官方页核实（只认正文里给出的官方页）
async function ingestText(env, s, id, text, via) {
  const t = String(text).slice(0, 6000); const first = (t.split(/\n/).map((x) => x.trim()).find(Boolean) || '').slice(0, 80);
  const links = [...new Set((t.match(/https?:\/\/[^\s<>"'，。）)】]+/g) || []).map((u) => safeUrl(u.replace(/^http:/, 'https:'))).filter(Boolean))].slice(0, 3);
  return ingestPage(env, s, id, '', { kind: 'post', url: '', title: first, text: t, links }, via);
}
async function ingestPage(env, s, id, u, page, via) {   // via：P1-5 代收 {via_by, via_note, via_src, test}，和条目同一条 INSERT 写入
  const old = (await s.q('SELECT * FROM res_items WHERE id=?', id))[0];
  let llm = await stewardLLM(env, s, `链接：${page.url}\n标题：${page.title}\n正文：\n${page.text}`);
  const j = llm.json || {}; const rule = ruleExtract(page.text);
  const cat = RES_CATS[j.category] ? j.category : ruleCat(page.url || (page.links || [])[0] || '', page.text);
  const item = {
    id, cat, name: String(j.name || page.title || page.url).slice(0, 80), purpose: String(j.purpose || '').slice(0, 200),
    free: String(j.free || rule.free || '').slice(0, 300), expires: /^\d{4}-\d{2}-\d{2}$/.test(j.expires || '') ? j.expires : rule.expires,
    url: page.url || (page.links || [])[0] || '', src_url: u, official_url: safeUrl(j.official_url || '') || '', evidence: String(j.evidence || rule.evidence || '').slice(0, 300),
    paid: j.paid === true || /付费|收费|paid only|no free/i.test(j.free || '') ? 1 : 0, model: llm.model || '规则（未用模型）', kind: page.kind,
  };
  const cands = page.kind === 'post' ? [item.official_url, ...(page.links || [])] : [page.url, item.official_url];
  const v = await verifyTiered(env, s, cands, item);
  const official = v.url; if (v.free) item.free = v.free.slice(0, 300); if (v.expires) item.expires = v.expires; if (v.quote) item.evidence = v.quote.slice(0, 300);
  item.vstate = item.free || item.expires ? (official ? '已核实' : '未核实') : '未核实';
  item.verified_at = official ? Date.now() : null; item.verified_url = official || '';
  item.model = `整理：${item.model}；核实：${v.model}`; if (!official) llm.skipped = [llm.skipped, '核实失败：' + v.note].filter(Boolean).join('；');
  const now = Date.now();
  const V = via || {};
  await s.q(`INSERT INTO res_items(id,cat,name,purpose,free,expires,url,src_url,official_url,evidence,vstate,verified_at,verified_url,paid,model,added,updated,note,via,via_by,via_note,via_src,test)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET cat=excluded.cat,name=excluded.name,purpose=excluded.purpose,free=excluded.free,expires=excluded.expires,url=excluded.url,official_url=excluded.official_url,evidence=excluded.evidence,vstate=excluded.vstate,verified_at=excluded.verified_at,verified_url=excluded.verified_url,paid=excluded.paid,model=excluded.model,updated=excluded.updated,via=COALESCE(excluded.via,res_items.via),via_by=COALESCE(excluded.via_by,res_items.via_by),via_note=COALESCE(excluded.via_note,res_items.via_note),via_src=COALESCE(excluded.via_src,res_items.via_src)`,
    item.id, item.cat, item.name, item.purpose, item.free, item.expires || '', item.url, item.src_url, item.official_url, item.evidence, item.vstate, item.verified_at, item.verified_url, item.paid, item.model, old ? old.added : now, now, llm.skipped || '',
    via ? 'lead' : null, via ? V.via_by || '' : null, via ? V.via_note || '' : null, via ? V.via_src || '' : null, V.test ? 1 : 0);
  return { ...item, state: resState(item), updated: !!old, note: llm.skipped || '' };
}
function reportOf(r) {
  if (r.error) return `✗ ${r.url}\n  ${r.error}`;
  const lines = [`${r.updated ? '↻ 已更新' : '＋ 已入库'}「${r.name}」→ ${RES_CATS[r.cat]}`];
  if (r.purpose) lines.push('  用途：' + r.purpose);
  lines.push('  免费额度：' + (r.free || '没写') + (r.paid ? '（含付费部分：用之前需你确认）' : ''));
  if (r.expires) lines.push('  到期：' + r.expires);
  lines.push('  状态：' + r.state + (r.state === '已核实' ? `（官方页原句对上了：${r.verified_url}）` : r.kind === 'post' ? '（帖子说法，官方页没找到同一句话）' : '（官方页没找到能证明额度/期限的原句）'));
  if (r.evidence) lines.push('  证据原句：「' + r.evidence.slice(0, 140) + '」');
  lines.push('  整理用：' + r.model + (r.note ? '；' + r.note : ''));
  return lines.join('\n');
}
async function ensureStewardRoom(s) {
  if (!(await s.q('SELECT 1 FROM rooms WHERE id=?', STEWARD_ROOM)).length) {
    const now = Date.now();
    await s.q("INSERT INTO rooms(id,title,mode,created,updated,members,status) VALUES(?,?,?,?,?,?,'进行中')", STEWARD_ROOM, '资源管家（私聊）', 'free', now, now, JSON.stringify([{ id: STEWARD, role: '资源管家' }]));
    await s.q('INSERT INTO parts(room,member,role,joined) VALUES(?,?,?,?) ON CONFLICT(room,member) DO NOTHING', STEWARD_ROOM, STEWARD, '资源管家', now);
    await addMsg(s, STEWARD_ROOM, 'ai', STEWARD, '', '我是资源管家。把链接或帖子丢给我（一次最多 3 个），我抓正文、分类、到厂商官方页核对免费额度和到期日，再放进资源库。\n也可以直接问我，比如「有没有免费配音」「哪些模型还能免费用」。\n每天早上我会检查一次到期，快到期或过期的会在这里告诉你。「搜集羊毛」只在你点按钮时才去外网找候选。', '资源管家');
  }
}
async function allResources(s) {
  const today = todayLondon();
  const user = (await s.q('SELECT * FROM res_items ORDER BY updated DESC LIMIT 500')).map((x) => ({ ...x, state: x.vstate === '候选' ? '候选' : resState(x), mine: true, from: x.via === 'lead' ? '主负责人代收' : '' }));
  const sites = (RES.sites || []).map((x) => ({ ...x, state: x.expires && x.expires < today ? '已过期' : x.verify_state }));
  return { built: RES.built, skills: RES.skills || [], sites, user, today };
}
// 问答：关键词（中文按双字切）检索资源库，免费优先、已核实优先、过期排后；付费标「需你确认」
function grams(t) { const s = normTxt(t).replace(/[^\p{L}\p{N}]+/gu, ' '); const out = new Set(); for (const w of s.split(' ')) { if (!w) continue; if (/^[a-z0-9.-]+$/.test(w)) { if (w.length >= 2) out.add(w); continue; } for (let i = 0; i < w.length - 1; i++) out.add(w.slice(i, i + 2)); if (w.length === 1) out.add(w); } return out; }
const STOP = new Set(['有没', '没有', '资源', '源库', '哪些', '什么', '一下', '帮我', '我想', '可以', '的吗', '里有', '库里']);
function searchRes(R, q, tools) {
  const qg = [...grams(q)].filter((g) => !STOP.has(g)); if (!qg.length) return [];
  const wantFree = /免费|free|白嫖|羊毛/i.test(q);
  const pool = [
    ...R.sites.map((x) => ({ t: 'sites', name: x.name, purpose: x.purpose, free: x.free, state: x.state, url: x.url, expires: x.expires, group: x.group, paid: /付费|收费|没有免费/.test(x.free || '') })),
    ...R.user.filter((x) => x.state !== '候选').map((x) => ({ t: x.cat, name: x.name, purpose: x.purpose, free: x.free, state: x.state, url: x.url, expires: x.expires, group: '管家入库', paid: !!x.paid })),
    ...R.skills.map((x) => ({ t: 'skills', name: x.name, purpose: x.purpose, free: x.status, state: x.status, url: x.src, group: x.group, paid: false })),
    ...(tools || []).map((x) => ({ t: 'tools', name: x.name, purpose: x.config, free: x.quota, state: '', url: x.quota_src || '', group: x.group || x.kind, paid: /没有免费|按量付费|\$\d+\/月/.test(x.quota || '') })),
  ];
  const sc = (x) => { const g = grams([x.name, x.purpose, x.group, x.free].join(' ')); let n = 0; for (const k of qg) if (g.has(k)) n++; if (!n) return 0; return n * 10 + (x.state === '已核实' ? 3 : 0) + (x.state === '已安装' ? 2 : 0) - (x.state === '已过期' ? 20 : 0) - (wantFree && x.paid ? 8 : 0); };
  return pool.map((x) => ({ ...x, sc: sc(x) })).filter((x) => x.sc > 0).sort((a, b) => b.sc - a.sc).slice(0, 6);
}
function answerOf(q, hits) {
  if (!hits.length) return `资源库里没找到和「${q.slice(0, 30)}」相关的条目。有链接的话丢给我，我核实后入库。`;
  return `资源库里和「${q.slice(0, 30)}」相关的（免费、已核实的排前面）：\n` + hits.map((x, i) => `${i + 1}. ${x.name}（${RES_CATS[x.t] || x.t}${x.group ? ' · ' + x.group : ''}）${x.state ? '【' + x.state + '】' : ''}\n   ${x.purpose || ''}${x.free && x.t !== 'skills' ? '\n   免费：' + x.free : ''}${x.expires ? '\n   到期：' + x.expires : ''}${x.paid ? '\n   含付费：用之前需你确认' : ''}${x.url ? '\n   ' + x.url : ''}`).join('\n') + '\n\n过期的我不会推荐；状态写「未核实」的，额度是帖子或我们记录里的说法，官方页还没对上原文。';
}
async function stewardTask(s, kind) { const id = rid(16); await s.q('INSERT INTO tasks(id,room,member,role,status,created,prompt,ext) VALUES(?,?,?,?,?,?,?,?)', id, STEWARD_ROOM, STEWARD, '资源管家', 'pending', Date.now(), kind, ''); return id; }
async function stewardDone(s, id) { await s.q("UPDATE tasks SET status='done' WHERE id=?", id); }
async function stewardMessage(env, s, ctx, text) {
  await ensureStewardRoom(s);
  await addMsg(s, STEWARD_ROOM, 'user', '', '', text, '');
  const urls = [...new Set((text.match(/https?:\/\/[^\s<>"'，。）)】]+/g) || []).map((u) => u.replace(/^http:/, 'https:')))];
  if (/^(检查到期|到期检查)/.test(text.trim())) { const t = await stewardTask(s, 'expiry'); ctx.waitUntil(expiryCheck(env, s, true).finally(() => stewardDone(s, t))); return { ok: true, async: true }; }
  if (urls.length) {
    const take = urls.slice(0, 3);
    const t = await stewardTask(s, 'ingest');
    ctx.waitUntil((async () => {
      const out = [];
      for (const u of take) { try { out.push(await ingestLink(env, s, u)); } catch (e) { out.push({ url: u, error: '处理出错：' + String((e && e.message) || e).slice(0, 100) }); } }
      const more = urls.length > 3 ? `\n（这次只处理前 3 个链接，剩下 ${urls.length - 3} 个请再发一次）` : '';
      await addMsg(s, STEWARD_ROOM, 'ai', STEWARD, out.map((x) => x.model).filter(Boolean)[0] || '', out.map(reportOf).join('\n\n') + more + '\n\n不对的话：资源库里该条目点「删除」即可撤销。', '资源管家');
    })().catch(async (e) => { await addMsg(s, STEWARD_ROOM, 'ai', STEWARD, '', '这次没处理完：' + String((e && e.message) || e).slice(0, 120) + '。可以再发一次。', '资源管家'); }).finally(() => stewardDone(s, t)));
    return { ok: true, async: true, links: take.length };
  }
  const R = await allResources(s);
  await addMsg(s, STEWARD_ROOM, 'ai', STEWARD, '规则检索（不耗额度）', answerOf(text, searchRes(R, text, CONFIG.tools)), '资源管家');
  return { ok: true };
}
// 每天一次到期检查（Workers cron 每小时跑；英国时间 8 点后第一次跑时做）。7 天内到期/已过期 → 私聊报告
async function expiryCheck(env, s, force) {
  const day = todayLondon();
  if (!force && ((await kvGet(s, 'steward_check_day')) === day || londonHour() < 8)) return { skipped: true };
  try {
    await ensureStewardRoom(s);
    const R = await allResources(s); const soon = [], gone = [];
    const plus7 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const all = [...R.sites.map((x) => ({ name: x.name, expires: x.expires, url: x.url })), ...R.user.filter((x) => x.state !== '候选').map((x) => ({ name: x.name, expires: x.expires, url: x.url }))];
    for (const x of all) { if (!x.expires) continue; if (x.expires < day) gone.push(x); else if (x.expires <= plus7) soon.push(x); }
    const seen = (await kvGet(s, 'steward_expired_seen')) || [];
    const newGone = gone.filter((x) => !seen.includes(x.name));
    await kvSet(s, 'steward_check_day', day); await kvSet(s, 'steward_last_check', Date.now()); await kvSet(s, 'steward_check_err', null);
    await kvSet(s, 'steward_expired_seen', gone.map((x) => x.name));
    if (soon.length || newGone.length || force) {
      const t = [`到期检查（英国时间 ${londonTime(Date.now())}）`];
      if (soon.length) t.push('7 天内到期：\n' + soon.map((x) => `· ${x.name} —— ${x.expires}\n  ${x.url}`).join('\n'));
      if (newGone.length) t.push('新过期（资源库里已标灰，不再推荐）：\n' + newGone.map((x) => `· ${x.name} —— ${x.expires}`).join('\n'));
      if (!soon.length && !newGone.length) t.push(`没有 7 天内到期的条目。已过期 ${gone.length} 条（资源库里标灰）。`);
      await addMsg(s, STEWARD_ROOM, 'ai', STEWARD, 'Workers cron · 规则', t.join('\n\n'), '资源管家');
    }
    return { ok: true, soon: soon.length, gone: gone.length };
  } catch (e) { await kvSet(s, 'steward_check_err', { at: Date.now(), msg: String((e && e.message) || e).slice(0, 160) }); return { error: true }; }
}
// 每周汇总（主负责人每周抽查一次）：英国时间周一 8 点后第一次 cron 生成；内容 = 近 7 天新增 / 更新 / 核实失败 / 14 天内到期。
// 发到资源管家私聊，并给主负责人留通知；主负责人用操作员令牌 GET /api/steward/weekly（或 get_brief 里的 stewardWeekly）读取。主负责人不做日常整理。
function isoWeek(d = new Date()) { const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day); const y = t.getUTCFullYear(); const w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7); return `${y}-W${String(w).padStart(2, '0')}`; }
const londonWeekday = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short' }).format(new Date());
async function stewardWeekly(env, s, force) {
  const wk = isoWeek();
  if (!force && ((await kvGet(s, 'steward_week')) === wk || londonWeekday() !== 'Mon' || londonHour() < 8)) return { skipped: true };
  await ensureStewardRoom(s);
  const since = Date.now() - 7 * 86400000; const today = todayLondon(); const plus14 = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const items = await s.q("SELECT id,name,cat,vstate,expires,url,note,added,updated,official_url,via FROM res_items WHERE vstate<>'候选' OR vstate IS NULL ORDER BY updated DESC LIMIT 500");
  const added = items.filter((x) => x.added >= since), byLead = added.filter((x) => x.via === 'lead'), updated = items.filter((x) => x.added < since && x.updated >= since);
  const failed = items.filter((x) => x.updated >= since && x.vstate !== '已核实' && /核实失败/.test(x.note || ''));
  const R = await allResources(s);
  const soon = [...R.sites.map((x) => ({ name: x.name, expires: x.expires })), ...R.user.filter((x) => x.state !== '候选').map((x) => ({ name: x.name, expires: x.expires }))].filter((x) => x.expires && x.expires >= today && x.expires <= plus14);
  const tiers = await stewardTiers(env, s);
  const cap = (a) => a.slice(0, 8).map((x) => `· ${x.name}${x.expires ? ' —— ' + x.expires : ''}`).join('\n') + (a.length > 8 ? `\n…另 ${a.length - 8} 条` : '');
  const lp = (await leadCfg(s)).p; const all = await loadMembers(s); const leadName = lp ? (lp.type === 'member' ? ((all.find((m) => m.id === lp.id) || {}).name || lp.id) : '自定义端点') : 'Hark 内置规则';
  const text = [`资源管家每周汇总（${wk}，英国时间 ${londonTime(Date.now())}）`,
    `新增 ${added.length} 条` + (byLead.length ? `（其中主负责人代收 ${byLead.length} 条）` : '') + (added.length ? '：\n' + cap(added) : ''),
    `更新 ${updated.length} 条` + (updated.length ? '：\n' + cap(updated) : ''),
    `核实失败 ${failed.length} 条` + (failed.length ? '（官方页没对上，状态仍是未核实）：\n' + cap(failed) : ''),
    `14 天内到期 ${soon.length} 条` + (soon.length ? '：\n' + cap(soon) : ''),
    `本周强档核实用：${tiers.strong.pick ? tiers.strong.pick.name : '无可用强档'}；小档：${tiers.small.available[0] || '无（用规则）'}。`,
    `已通知主负责人（${leadName}）抽查；主负责人只抽查，不做日常整理。`].join('\n\n');
  await addMsg(s, STEWARD_ROOM, 'ai', STEWARD, '规则汇总（不耗额度）', text, '资源管家');
  await addMsg(s, STEWARD_ROOM, 'note', '', '', `通知主负责人（${leadName}）：本周资源管家汇总已生成，请抽查。操作员令牌读取：GET /api/steward/weekly，或 get_brief 里的 stewardWeekly。`, '');
  const rec = { week: wk, at: Date.now(), lead: leadName, counts: { added: added.length, lead: byLead.length, updated: updated.length, failed: failed.length, soon: soon.length }, text };
  await kvSet(s, 'steward_week', wk); await kvSet(s, 'steward_weekly_last', rec);
  return rec;
}
// ───── P1-5 主负责人代收资源 ─────
// 用户在主负责人所在的外部 App 里直接发链接/文件/帖子 → 主负责人用操作员令牌静默投递到这里 → 走资源管家同一条流水线
// （去重 → 抓正文 → 分类 → 官方页逐字核实才标已核实）。不往任何房间发消息（不刷屏），条目标「来源：主负责人代收」，计入每周汇总。
const SUBMIT_REPLY = () => `已收进 ${PRODUCT.name} 资源库`;
const SUB_BUSY_MS = 10 * 60000;
async function subLog(s, rows, test) { for (const r of rows) await s.q('INSERT INTO subs(rid,ts,who,url,text,note,source,status,why,test) VALUES(?,?,?,?,?,?,?,?,?,?)', r.id, r.ts, r.by, r.url || '', r.text || '', r.note || '', r.source || '', r.status, r.why || '', test ? 1 : 0); await s.q('DELETE FROM subs WHERE id <= (SELECT id FROM subs ORDER BY id DESC LIMIT 1 OFFSET 200)'); }
async function subMark(s, id, p) { await s.q("UPDATE subs SET status=?, why=?, name=?, state=? WHERE rid=? AND status='queued'", p.status, p.why || '', p.name || '', p.state || '', id); }
// 原子占位：同一条 10 分钟内只排一次（单条 SQL，并发请求不会都抢到）
async function subClaim(s, id, now) { return (await s.q("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v WHERE CAST(kv.v AS INTEGER) < ? RETURNING k", 'sub_busy:' + id, String(now), now - SUB_BUSY_MS)).length > 0; }
async function submitResource(env, s, ctx, OP, body) {
  const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const url = str(body.url, 2000), text = str(body.text, MAX_MSG), note = str(body.note, 200), source = str(body.source, 80);
  if (!url && !text) return { error: '要给 url（链接）或 text（帖子原文/文件内容）至少一个' };
  const raw = [...(url ? [url] : []), ...((text.match(/https?:\/\/[^\s<>"'，。）)】]+/g) || []))];
  const seen = new Set(), urls = [];
  for (const r of raw) { const u = safeUrl(r.replace(/^http:/i, 'https:')); if (!u) { if (r === url) return { error: '只收公网 https 链接（内网/本机地址不收）' }; continue; } const k = urlKey(u); if (!seen.has(k)) { seen.add(k); urls.push(u); } }
  const jobs = [];
  if (urls.length) for (const u of urls.slice(0, 3)) jobs.push({ id: 'u-' + await sha(urlKey(u)), url: u });
  else jobs.push({ id: 't-' + await sha(normTxt(text)), text });
  const queued = [], duplicates = [], now = Date.now(), test = await testModeOn(s);
  for (const j of jobs) {
    const ex = (await s.q("SELECT id,name,vstate,expires FROM res_items WHERE id=? AND COALESCE(vstate,'')<>'候选'", j.id))[0];
    if (ex) duplicates.push({ id: j.id, name: ex.name, state: resState(ex), why: '资源库里已有这条' });
    else if (!(await subClaim(s, j.id, now))) duplicates.push({ id: j.id, why: '同一条正在处理中' });
    else queued.push(j);
  }
  const who = { via_by: OP.name, via_note: note, via_src: source, test };
  await subLog(s, [...queued.map((j) => ({ id: j.id, ts: now, by: OP.name, url: j.url || '', text: j.url ? '' : text.slice(0, 80), note, source, status: 'queued' })),
    ...duplicates.map((d) => ({ id: d.id, ts: now, by: OP.name, url: (jobs.find((x) => x.id === d.id) || {}).url || '', note, source, status: 'duplicate', why: d.why }))], test);
  await opLog(s, OP, 'POST', '/api/steward/submit', `代收资源：排队 ${queued.length} 条，重复 ${duplicates.length} 条` + (source ? `（来源：${source}）` : ''));
  if (queued.length) ctx.waitUntil((async () => {
    for (const j of queued) {
      let r; try { r = j.url ? await ingestLink(env, s, j.url, who) : await ingestText(env, s, j.id, j.text, who); } catch (e) { r = { error: '处理出错：' + String((e && e.message) || e).slice(0, 100) }; }
      await subMark(s, j.id, r.error ? { status: 'failed', why: r.error.slice(0, 160) } : { status: 'done', name: r.name, state: r.state });
      await kvDel(s, 'sub_busy:' + j.id);
    }
  })().catch(() => {}));
  return { ok: true, reply: SUBMIT_REPLY(), queued: queued.map((j) => ({ id: j.id, url: j.url || '' })), duplicates, more: urls.length > 3 ? `这次只收前 3 个链接，剩下 ${urls.length - 3} 个请再投一次` : '', check: 'GET /api/steward/submissions 看处理结果' };
}
// 「搜集羊毛」：只在用户点按钮时抓；结果只进候选（未经核实），不写入正式资源库
async function gatherDeals(env, s) {
  const out = [], errs = [];
  const since = Math.floor(Date.now() / 1000) - 7 * 86400;
  try {
    const r = await safeFetchText(`https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent('"free tier"')}&tags=story&numericFilters=created_at_i>${since}&hitsPerPage=15`);
    for (const h of (JSON.parse(r.text).hits || [])) if (h.url && safeUrl(h.url)) out.push({ title: h.title, url: h.url, from: 'Hacker News' });
  } catch (e) { errs.push('Hacker News：' + String(e.message || e).slice(0, 60)); }
  try {
    const r = await safeFetchText('https://linux.do/c/welfare/36.rss');
    for (const it of r.text.split('<item>').slice(1, 16)) { const t = (it.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1]; const l = (it.match(/<link>([^<]+)<\/link>/) || [])[1]; if (t && l && safeUrl(l.trim())) out.push({ title: htmlText(t).slice(0, 120), url: l.trim(), from: 'linux.do 福利' }); }
  } catch (e) { errs.push('linux.do：' + String(e.message || e).slice(0, 60)); }
  const now = Date.now(); let added = 0;
  for (const x of out.slice(0, 25)) {
    const id = 'c-' + await sha(urlKey(x.url));
    const ex = (await s.q('SELECT vstate FROM res_items WHERE id=? OR id=?', id, 'u-' + id.slice(2)))[0]; if (ex) continue;
    await s.q('INSERT INTO res_items(id,cat,name,purpose,free,expires,url,src_url,official_url,evidence,vstate,verified_at,verified_url,paid,model,added,updated,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
      id, 'sites', x.title.slice(0, 80), '', '', '', x.url, x.url, '', '', '候选', null, '', 0, '', now, now, '来自 ' + x.from + '（未经核实）');
    added++;
  }
  await ensureStewardRoom(s);
  await addMsg(s, STEWARD_ROOM, 'ai', STEWARD, '规则（不耗额度）', `搜集羊毛（你手动触发）：找到 ${out.length} 条，新加 ${added} 条到「候选」。\n候选全部「未经核实」，不代表真的免费，也可能是广告或过期信息；在资源库「学习与网站资源」最下面的候选区，确认有用就把链接发给我，我去官方页核实后才正式入库。` + (errs.length ? '\n没抓到的源：' + errs.join('；') : ''), '资源管家');
  return { found: out.length, added, errs };
}

// ───────────────────────── 来源级别 / 敏感路由 / 完成推送（第二批） ─────────────────────────
const LEVELS = { official: '官方 API', relay: '中转站/公益站', public: '免 Key 公共接口', web: '第三方网页（经代发）', agent: '外部智能体', builtin: '内置' };
function srcLevel(src) {
  const iv = src.invoke || {};
  if (iv.level && LEVELS[iv.level]) return iv.level;
  if (iv.relay) return 'relay';
  if (iv.kind === 'web') return 'web';   // P1-2：网页成员 = 第三方网页服务，敏感项目不发
  if (/pollinations/i.test(iv.base || '')) return 'public';
  if (['poke', 'webhook', 'telegram', 'tailscale', 'bridge', 'tunnel', 'hark', 'pair'].includes(iv.kind)) return 'agent';
  if (['lead', 'steward'].includes(iv.kind)) return 'builtin';
  return 'official';
}
async function routePolicy(s) { return { blockRelay: true, ...((await kvGet(s, 'route_policy')) || {}) }; }
async function audit(s, room, member, src, action, note) { await s.q('INSERT INTO audit(room,member,via,level,action,note,ts) VALUES(?,?,?,?,?,?,?)', room, member, src ? src.via : '', src ? srcLevel(src) : '', action, String(note || '').slice(0, 200), Date.now()); }
async function notifyDone(env, s, room) {
  if (await testModeOn(s)) return;   // 测试模式不给用户手机发推送
  const pref = (await kvGet(s, 'notify')) || {}; if (!pref.on) return;
  const r = (await s.q('SELECT title, sens FROM rooms WHERE id=?', room))[0]; if (!r) return;
  const title = PRODUCT.short; const body = r.sens ? '有一个敏感项目出结论了（内容不经推送服务）' : `项目「${String(r.title || '').slice(0, 20)}」出结论了`;
  const origin = env.PUBLIC_ORIGIN || 'https://chat.pcmanai.com';
  if (env.BARK_KEY && /^[A-Za-z0-9]{8,64}$/.test(env.BARK_KEY)) { try { await fetchT(`https://api.day.app/${env.BARK_KEY}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, body, group: 'AI群聊', url: origin + '/' }) }); } catch {} }
  if (pref.tg && env.TELEGRAM_BOT_TOKEN && /^-?\d{3,20}$/.test(String(pref.tg))) { try { await fetchT(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: pref.tg, text: title + '：' + body }) }); } catch {} }
}

async function saveAgent(s, b, { operator = false } = {}) {
  const id = String(b.id || '').toLowerCase();
  if (!/^x-[a-z0-9._-]{1,60}$/.test(id)) return [{ error: 'id 需以 x- 开头，小写字母数字' }, 400];
  if (CAPS.isReservedId(id)) return [{ error: 'x-agent- / x-hark- 开头的 id 留给配对码关联的智能体，自建成员请换一个 id' }, 400];
  const prev = (await s.q('SELECT json FROM custom WHERE id=?', id))[0];   // 不允许覆盖配对成员（纵深防御：配对成员本来就只用保留前缀）
  if (prev) { let pm = null; try { pm = JSON.parse(prev.json); } catch {} if (CAPS.isPairedMember(pm)) return [{ error: '这个 id 是配对关联的智能体，不能被自建成员覆盖' }, 409]; }
  // 操作员令牌（外部负责人）不能改已有成员、不能让新成员引用密钥：否则可把 AGENT_*/POKE_API_KEY 指到任意地址发出去（与自定义负责人端点同类的 Key 外泄）
  if (operator && prev) return [{ error: '操作员令牌不能修改已有成员（要群主在网页上改）' }, 403];
  if (operator && (b.secret || String(b.conn || '') === 'poke')) return [{ error: '操作员令牌添加的成员不能引用密钥（要群主在网页上添加）' }, 403];
  const kind = String(b.conn || '');   // 请求体里的 paired 等字段一律不读：下面的成员对象逐字段构造
  if (!CUSTOM_KINDS.includes(kind)) return [{ error: '连接方式不对' }, 400];
  const name = String(b.name || '').trim().slice(0, 40);
  if (!name) return [{ error: '需要名字（产品原名）' }, 400];
  const iv = { kind };
  if (b.url) { const u = safeUrl(b.url); if (!u) return [{ error: '地址只允许公网 https（不收内网/IP/本机）' }, 400]; iv.url = u.replace(/\/+$/, ''); }
  if (b.health) { const u = safeUrl(b.health); if (!u) return [{ error: '心跳地址只允许公网 https' }, 400]; iv.health = u; }
  if (b.secret) { if (!SECRET_NAME_RE.test(String(b.secret))) return [{ error: '密钥只能填环境变量名，且以 AGENT_ 开头（值放 secrets 文件再部署）' }, 400]; iv.secret = String(b.secret); }
  if (kind === 'poke') iv.secret = 'POKE_API_KEY';
  if (kind === 'telegram') { if (!/^-?\d{3,20}$|^@[A-Za-z0-9_]{4,40}$/.test(String(b.chat || ''))) return [{ error: 'Telegram chat_id 格式不对' }, 400]; iv.chat = String(b.chat); }
  if (kind === 'openai') { if (!iv.url || !b.model || !iv.secret) return [{ error: 'OpenAI 兼容需要地址、模型名和 AGENT_ 开头的密钥变量名' }, 400]; iv.base = iv.url; delete iv.url; iv.model = String(b.model).slice(0, 80); }
  if ((kind === 'webhook' || kind === 'tunnel') && !iv.url) return [{ error: '需要 https 地址' }, 400];
  if (kind === 'web') {   // P1-2 网页成员：只存网址和开关；能力 = 网页成员（只能当执行成员）
    const site = safeUrl(b.site || b.url); if (!site) return [{ error: '网页成员需要公网 https 网址（不收内网/IP/本机）' }, 400];
    delete iv.url; iv.site = site; if (b.client === true) iv.client = true; if (b.checkin === true) iv.checkin = true;
  }
  const date = utcDay();
  const jobs = String(b.jobs || '').split(/[,，、\s]+/).filter(Boolean).slice(0, 10).map((t) => ({ t: t.slice(0, 12), from: '用户填写', src: '添加成员表单', date }));
  const execTags = String(b.exec || '').split(/[,，、\s]+/).filter((t) => (CONFIG.exec_tags || []).includes(t)).slice(0, 12);
  const m = { id, name, brand: kind === 'hark' ? 'hark' : (BRANDS[b.brand] ? b.brand : 'custom'), custom: true, intro: String(b.intro || '').slice(0, 400), tags: [], tags_note: '暂无社区评价', jobs, weak: [],
    jobs_note: jobs.length ? '' : '擅长岗位待定：等打分/互评', exec: { tags: execTags, note: execTags.length ? '用户填写' : '未填写执行能力' }, tools: [], limits: {}, privacy: '指令和聊天记录会发到该端点。',
    sources: [{ via: CONNECTORS[kind].label, invoke: iv, quota: { kind: 'calls', source: 'unverified', text: '额度未知' } }] };
  if (kind === 'web') { m.privacy = '指令和聊天记录会由代发员发到 ' + iv.site + '。'; m.caps = { kind: 'model', web: true, tags: ['chat'], context_window: null, tool_call: false, capability_status: 'pending', source: '网页成员（经代发），只能当执行成员' }; }
  if (!prev) await kvDel(s, `webcheckin:${id}:${todayLondon()}`);   // 新建（含删后重建同 id）不继承旧成员「今天已签到」；只删今天这一条（复审采纳）
  await s.q('INSERT INTO custom(id,json,created) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json', id, JSON.stringify(m), Date.now());
  return [{ ok: true, id }, 200];
}


// ───────────────────────── 调用记录（模型 + 工具，2026-10-23 角色卡/工具网关） ─────────────────────────
// calls.ok：1 成功 / 0 失败 / 2 等你确认 / 3 被敏感路由拦下 / 4 你拒绝 / 5 超出每日上限 / 6 骨架待测（没真正调用）
const CALL_OK = { 7: '你已确认', 1: '成功', 0: '失败', 2: '等你确认', 3: '敏感项目已拦下', 4: '你已拒绝', 5: '超出每日上限', 6: '待测（没真正调用）' };
async function logCall(s, c) {
  await s.q('INSERT INTO calls(ts,member,room,kind,name,action,ok,ms,tin,tout,detail,args,result) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    c.ts || Date.now(), c.member || '', c.room || '', c.kind || 'tool', String(c.name || '').slice(0, 80), String(c.action || '').slice(0, 80), c.ok | 0, c.ms | 0, c.tin | 0, c.tout | 0,
    redact(String(c.detail || '')).slice(0, 300), String(c.args || '').slice(0, 8000), redact(String(c.result || '')).slice(0, 4000));
  return (await s.q('SELECT last_insert_rowid() AS id'))[0].id;
}
const dayStartUtc = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.getTime(); };
async function memberStats(s, id) {
  const since = Date.now() - 7 * 86400000;
  const rows = await s.q('SELECT ts, ok, ms, kind FROM calls WHERE member=? AND ts>? AND ok IN (0,1) ORDER BY ts', id, since);
  const days = []; for (let i = 6; i >= 0; i--) { const d = utcDay(Date.now() - i * 86400000); days.push({ d: d.slice(5), n: 0, ok: 0 }); }
  for (const r of rows) { const d = days.find((x) => x.d === utcDay(r.ts).slice(5)); if (d) { d.n++; if (r.ok === 1) d.ok++; } }
  const ok = rows.filter((r) => r.ok === 1); const n = rows.length;
  return { days, n7: n, ok7: ok.length, rate: n ? ok.length / n : null, avgMs: ok.length ? Math.round(ok.reduce((a, r) => a + r.ms, 0) / ok.length) : null,
    today: rows.filter((r) => r.ts >= dayStartUtc()).length, tools7: rows.filter((r) => r.kind === 'tool').length,
    pending: (await s.q('SELECT COUNT(*) AS n FROM calls WHERE member=? AND ok=2', id))[0].n };
}
// 「何时恢复」：能算出时间点的才给 resetAt（毫秒），算不出就不给
function resetAtOf(q) {
  const t = String((q && q.reset) || '');
  if (/00:00 UTC/.test(t)) return nextUtcMidnight();
  if (/太平洋/.test(t)) { const now = new Date(); const pt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })); const diff = now - pt; const mid = new Date(pt); mid.setHours(24, 0, 0, 0); return mid.getTime() + diff; }
  return null;
}

// ───────────────────────── 工具网关 ─────────────────────────
// 规则：仅 Hark 可用的不接；要 Key 的工具没填 Key 不发给模型；花钱/不可逆（risk paid/irreversible）先等你在页面确认；
// 每个工具每天上限 gw.cap、所有工具合计每天 TOOL_DAILY_MAX；敏感项目默认不调工具（沿用敏感路由，可在设置里关）；每次都写 calls。
const TOOL_DAILY_MAX = 100;
const GW_TOOLS = () => (CONFIG.tools || []).filter((t) => t.gw && t.gw.status !== 'hark');
const toolKeyOk = (env, t) => !!(t.gw.keyless || (t.gw.key && env[t.gw.key]));
function gwFunctions(env) {
  const ready = GW_TOOLS().filter((t) => toolKeyOk(env, t));
  const out = [];
  if (ready.some((t) => t.id === 'tool-fetch')) out.push(TG.FUNCTIONS.fetch_url);
  if (ready.some((t) => t.gw.status === 'ok' && (t.gw.actions || []).some((a) => a.name === 'run_code'))) out.push(TG.FUNCTIONS.run_code);
  const others = ready.filter((t) => t.gw.status === 'todo');
  if (others.length) {
    const f = JSON.parse(JSON.stringify(TG.FUNCTIONS.use_tool));
    f.function.description += ' 可用：' + others.map((t) => `${t.id}（${t.name}：${t.gw.actions.map((a) => a.name + (a.risk === 'free' ? '' : '·需确认')).join('/')}）`).join('；');
    out.push(f);
  }
  return out;
}
async function gatewayCall(env, s, { member, room, toolId, action, args, confirmed, by }) {
  const t0 = Date.now(); args = args && typeof args === 'object' ? args : {};
  const argStr = JSON.stringify(args); if (argStr.length > 8000) return { ok: false, text: '参数太长（上限 8KB）' };
  // run_code 未指定工具时自动挑：E2B → Daytona（有 Key、没超上限的）
  let tool = (CONFIG.tools || []).find((t) => t.id === toolId);
  if (!tool && action === 'run_code') {
    for (const id of (args.provider === 'daytona' ? ['tool-daytona', 'tool-e2b'] : ['tool-e2b', 'tool-daytona'])) { const t = (CONFIG.tools || []).find((x) => x.id === id); if (t && toolKeyOk(env, t) && (await toolCountToday(s, id)) < t.gw.cap) { tool = t; break; } }
    if (!tool) return { ok: false, text: '没有可用的代码沙盒：到「资源库 → API 密钥」填 E2B 或 Daytona 的 Key（或今天的次数已用完）' };
  }
  if (!tool && action === 'fetch_url') tool = (CONFIG.tools || []).find((t) => t.id === 'tool-fetch');
  if (!tool || !tool.gw) return { ok: false, text: '没有这个工具：' + String(toolId || action).slice(0, 40) };
  const gw = tool.gw; const base = { member, room, kind: 'tool', name: tool.id, action, args: argStr };
  if (gw.status === 'hark') return { ok: false, text: `「${tool.name}」仅 Hark 可用：${gw.why || ''}` };
  const act = (gw.actions || []).find((a) => a.name === action);
  if (!act) return { ok: false, text: `「${tool.name}」没有「${String(action).slice(0, 30)}」这个动作；可用：${(gw.actions || []).map((a) => a.name).join('、')}` };
  if (!toolKeyOk(env, tool)) return { ok: false, text: `「${tool.name}」还没填 Key：到「资源库 → API 密钥」填 ${(KEYDEFS[gw.key] || {}).name || gw.key}` };
  if (room) {
    const r = (await s.q('SELECT sens FROM rooms WHERE id=?', room))[0];
    const pol = await routePolicy(s);
    if (r && r.sens && pol.blockTools !== false) { await logCall(s, { ...base, ok: 3, detail: '敏感项目默认不调用第三方工具' }); await audit(s, room, member, { via: '工具：' + tool.name, invoke: { kind: 'tool' } }, 'blocked', '敏感项目不调用工具'); return { ok: false, blocked: true, text: '本项目标了「敏感」，按路由规则不把内容发给第三方工具（可在「设置 → 敏感内容与来源路由」放开）。' }; }
  }
  if (!confirmed) {
    const all = (await s.q('SELECT COUNT(*) AS n FROM calls WHERE kind=\'tool\' AND ts>? AND ok IN (0,1,2)', dayStartUtc()))[0].n;
    if (all >= TOOL_DAILY_MAX) { await logCall(s, { ...base, ok: 5, detail: `所有工具合计每天上限 ${TOOL_DAILY_MAX} 次` }); return { ok: false, text: `今天所有工具合计已调用 ${TOOL_DAILY_MAX} 次（每日硬上限），明天再试。` }; }
    const capN = act.risk === 'free' ? gw.cap : Math.min(gw.cap, 3);
    if ((await toolCountToday(s, tool.id)) >= capN) { await logCall(s, { ...base, ok: 5, detail: `「${tool.name}」每天上限 ${capN} 次` }); return { ok: false, text: `「${tool.name}」今天已到每日上限（${capN} 次）。` }; }
    if (act.risk !== 'free') {
      const id = await logCall(s, { ...base, ok: 2, detail: act.risk === 'paid' ? '会花钱，等你在页面确认' : '不可逆，等你在页面确认' });
      return { ok: false, pending: id, text: `「${tool.name} · ${act.label || act.name}」${act.risk === 'paid' ? '会花钱' : '不可撤回'}，已提交给用户确认（编号 #${id}），确认前不会执行。` };
    }
  }
  try {
    const r = await TG.execute({ fetchT, safeFetchText: async (u, ms) => { const x = await safeFetchText(u, ms); return { url: x.url, text: /json|text\/plain/.test(x.type) ? x.text : htmlText(x.text) }; }, keys: env }, tool, action, args);
    const ok = r.todo ? 6 : r.ok ? 1 : 0;
    const id = await logCall(s, { ...base, ok, ms: Date.now() - t0, detail: r.todo ? '骨架：执行器待测' : (r.meta && r.meta.provider) || '', result: r.text });
    return { ok: !!r.ok, todo: !!r.todo, id, text: r.text, tool: tool.name };
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 200);
    const id = await logCall(s, { ...base, ok: 0, ms: Date.now() - t0, detail: msg });
    return { ok: false, id, text: '工具出错：' + msg, tool: tool.name };
  }
}
async function toolCountToday(s, id) { return (await s.q("SELECT COUNT(*) AS n FROM calls WHERE kind='tool' AND name=? AND ts>? AND ok IN (0,1,2)", id, dayStartUtc()))[0].n; }
async function toolsView(env, s) {
  const since7 = Date.now() - 7 * 86400000;
  const out = [];
  for (const t of CONFIG.tools || []) {
    const gw = t.gw || {}; const v = { id: t.id, status: gw.status || 'none', keyless: !!gw.keyless, key: gw.key || '', keyName: (KEYDEFS[gw.key] || {}).name || '', keyFilled: t.gw ? toolKeyOk(env, t) : false, why: gw.why || '', actions: gw.actions || [], cap: gw.cap || 0, card: gw.card || null };
    if (gw.status && gw.status !== 'hark') {
      const rows = await s.q("SELECT ts, ok, ms FROM calls WHERE kind='tool' AND name=? AND ok IN (0,1)", t.id);
      v.today = await toolCountToday(s, t.id); v.total = rows.length; v.ok = rows.filter((r) => r.ok === 1).length;
      v.days = []; for (let i = 6; i >= 0; i--) { const d = utcDay(Date.now() - i * 86400000); v.days.push({ d: d.slice(5), n: rows.filter((r) => utcDay(r.ts) === d).length }); }
      // 估算剩余：只算本群经网关的调用（官方用量页才是准的），按每秒单价 × 本群累计运行秒数
      if (gw.rate_usd_s && gw.card && gw.card.free_amount && gw.card.unit === 'USD') {
        const spent = rows.reduce((a, r) => a + r.ms, 0) / 1000 * gw.rate_usd_s;
        const spent7 = rows.filter((r) => r.ts > since7).reduce((a, r) => a + r.ms, 0) / 1000 * gw.rate_usd_s;
        const left = Math.max(0, gw.card.free_amount - spent);
        v.est = { spent: +spent.toFixed(4), left: +left.toFixed(2), perDay: +(spent7 / 7).toFixed(5), days: spent7 > 0 ? Math.round(left / (spent7 / 7)) : null };
      }
      v.pending = (await s.q("SELECT id, member, room, action, args, ts FROM calls WHERE kind='tool' AND name=? AND ok=2 ORDER BY id DESC LIMIT 10", t.id));
    }
    out.push(v);
  }
  return { tools: out, dailyMax: TOOL_DAILY_MAX, todayAll: (await s.q("SELECT COUNT(*) AS n FROM calls WHERE kind='tool' AND ts>? AND ok IN (0,1,2)", dayStartUtc()))[0].n };
}
async function confirmCall(env, s, id, approve) {
  const c = (await s.q('SELECT * FROM calls WHERE id=? AND ok=2', id))[0];
  if (!c) return { error: '没有这条待确认的调用（可能已处理）' };
  if (!approve) { await s.q('UPDATE calls SET ok=4, detail=? WHERE id=?', '你在页面点了拒绝', id); if (c.room) await addMsg(s, c.room, 'note', c.member, '', `你拒绝了 #${id}：${c.name} · ${c.action}`, ''); return { ok: true, rejected: true }; }
  let args = {}; try { args = JSON.parse(c.args || '{}'); } catch {}
  await s.q('UPDATE calls SET ok=7, detail=? WHERE id=?', '你已确认，见下一条执行记录', id);
  const r = await gatewayCall(env, s, { member: c.member, room: c.room, toolId: c.name, action: c.action, args, confirmed: true });
  if (c.room) await addMsg(s, c.room, 'note', c.member, '', `你确认了 #${id}（${c.name} · ${c.action}）：${String(r.text).slice(0, 600)}`, '');
  return { ok: true, result: r };
}

// ───────────────────────── 负责人设置（主/副负责人，2026-10-23） ─────────────────────────
// kv lead_cfg = { p:{type:'member',id}|{type:'custom',name,base,model,level}, s:同上, timeoutSec }
// 自定义端点的 Key 用同一套加密存 apikeys（名 LEAD_P_KEY / LEAD_S_KEY），不回显。
const LEAD_KEY = { p: 'LEAD_P_KEY', s: 'LEAD_S_KEY' };
const LEAD_LABEL = { p: '主负责人', s: '副负责人' };
async function leadCfg(s) { return { p: null, s: null, timeoutSec: 180, ...((await kvGet(s, 'lead_cfg')) || {}) }; }
function leadPseudo(slot, c) {
  return { id: 'lead-' + slot, name: c.name || c.model || ('自定义' + LEAD_LABEL[slot]), brand: 'custom', leadOnly: true, intro: `自定义${LEAD_LABEL[slot]}（OpenAI 兼容端点：${c.base}，模型 ${c.model}）。`,
    tags: [], jobs: [{ t: '派工', from: '用户设置', src: '设置页', date: utcDay() }], weak: [], exec: { tags: [], note: '纯文本对话' }, tools: [], limits: {}, privacy: '议题和成员表会发到你填的端点。',
    sources: [{ via: '自定义负责人端点', invoke: { kind: 'openai', base: c.base, model: c.model, secret: LEAD_KEY[slot], level: c.level === 'official' ? 'official' : 'relay' }, quota: { kind: 'calls', source: 'unverified', text: '额度未知（自定义端点）' } }] };
}
function leadMemberOf(all, cfg, slot) {
  const c = cfg[slot]; if (!c) return null;
  if (c.type === 'member') return all.find((m) => m.id === c.id && !m.leadOnly) || null;
  if (c.type === 'custom') return all.find((m) => m.id === 'lead-' + slot) || null;
  return null;
}
function leadUsable(m, sens, policy) {
  if (!m) return { ok: false, why: '没设置' };
  if (m.state === 'down') return { ok: false, why: m.why || '不可用' };
  const okSrc = m.order.map((i) => m.srcs[i]).filter((x) => x.state !== 'down' && !(sens && policy.blockRelay && ['relay', 'public', 'web'].includes(x.level)) && !(sens && policy.blockHark !== false && (x.kind === 'hark' || x.kind === 'pair')));
  if (!okSrc.length) return { ok: false, why: sens ? '敏感项目：它能用的来源只有中转站/公益站/公共接口或外部 Hark，按路由规则不发' : '没有可用来源' };
  const first = okSrc[0];
  return { ok: true, async: ASYNC_KINDS.includes(first.kind), src: first.i };
}
async function leadText(env, s, m, system, user, maxTok, { sens, room, label } = {}) {
  const act = label || '负责人派工';
  const policy = sens ? await routePolicy(s) : null; const errs = [];
  for (const i of m.order) {
    const sv = m.srcs[i]; if (sv.state === 'down') continue; const src = m.sources[i];
    if (policy && policy.blockRelay && ['relay', 'public', 'web'].includes(srcLevel(src))) { if (room) await audit(s, room, m.id, src, 'blocked', '负责人：敏感项目不发' + LEVELS[srcLevel(src)]); continue; }
    const iv = srcInvoke(env, src); if (!['workers-ai', 'openai', 'gemini'].includes(iv.kind)) continue;
    const t0 = Date.now();
    try {
      const r = iv.kind === 'workers-ai' ? await callWorkersAI(env, src, system, user, maxTok) : iv.kind === 'gemini' ? await callGemini(env, iv, system, user, maxTok) : await callOpenAI(env, iv, system, user, maxTok);
      await addUsage(s, skey(m, i), r.tin, r.tout, r.neurons || 0);
      await logCall(s, { member: m.id, room, kind: 'model', name: sv.via, action: act + ' · ' + (iv.model || iv.kind), ok: 1, ms: Date.now() - t0, tin: r.tin, tout: r.tout });
      if (room && sens) await audit(s, room, m.id, src, 'used', '负责人 · ' + LEVELS[srcLevel(src)]);
      if (label) return { text: r.text, via: sv.via };
      return r.text;
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 160); errs.push(sv.via + '：' + msg.slice(0, 60));
      await logCall(s, { member: m.id, room, kind: 'model', name: sv.via, action: act + ' · ' + (iv.model || iv.kind), ok: 0, ms: Date.now() - t0, detail: msg });
      if (!m.leadOnly) await setStatus(s, skey(m, i), 'down', (isQuotaError(msg) ? '额度用完/限流：' : '出错：') + msg);
    }
  }
  throw new Error(errs.join('；') || '没有能即时回复的来源');
}
function leadPrompt(all, topic, mode, roles, leadName) {
  const cands = all.filter((m) => m.state !== 'down' && !m.leadOnly && !m.lead && !m.steward && isChatty(m)).slice(0, 30);
  const table = cands.map((m) => `${m.id} | 擅长:${[...jobsOf(m)].join('/') || '待定'} | 不擅长:${[...weakOf(m)].join('/') || '—'} | 额度:${m.quota.pct == null ? '?' : Math.round(m.quota.pct * 100) + '%'}`).join('\n');
  return { cands, sys: `你是「${PRODUCT.name}」的负责人「${leadName}」。先遵守下面的岗位说明书，再完成派工。只输出 JSON 数组，不要任何其他文字。\n\n${String(CHARTER_CACHE.text || CHARTER_DEFAULT()).slice(0, 1800)}`,
    user: `议题：${topic.slice(0, 800)}\n模式：${MODES[mode] || mode}\n需要的角色：${roles.join('、')}\n候选 AI成员（id | 擅长岗位 | 不擅长 | 剩余额度）：\n${table}\n\n规则：每个角色选一个不同的成员；按擅长岗位匹配、额度高、不同厂商优先；裁判要推理强、中文好。\n输出：[{"id":"…","role":"…","reason":"一句话"}]` };
}
function parseLineup(text, ids) {
  const mj = String(text || '').match(/\[[\s\S]*\]/); if (!mj) return null;
  let arr; try { arr = JSON.parse(mj[0]); } catch { return null; }
  const used = new Set(); const out = [];
  for (const x of Array.isArray(arr) ? arr : []) if (x && ids.has(x.id) && ROLES.includes(x.role) && x.role !== '负责人' && !used.has(x.id)) { used.add(x.id); out.push({ id: x.id, role: x.role, reason: String(x.reason || '').slice(0, 120) }); }
  return out.length ? out : null;
}
// 按设置走：主 → 副 → 原逻辑（Hark 规则/复核）。返回 { plan, lead, notes, async }
async function leadPlan(env, s, all, topic, mode, base, opts = {}) {
  CHARTER_CACHE.text = (await kvGet(s, 'lead_charter')) || CHARTER_DEFAULT();
  const cfg = await leadCfg(s); const notes = []; const policy = await routePolicy(s);
  const slots = opts.only ? [opts.only] : ['p', 's'];
  let anySet = false;
  for (const slot of slots) {
    const m = leadMemberOf(all, cfg, slot); if (!cfg[slot]) continue; anySet = true;
    const nextName = slot === 'p' && cfg.s ? (leadMemberOf(all, cfg, 's') || {}).name || '副负责人' : null;
    const el = m ? CAPS.leadEligibility(m) : null;
    if (m && !el.eligible) {   // 不合格：不静默替换（lead_cfg 不改），本轮按接任规则跳到副负责人，并通知用户决定
      notes.push(`${LEAD_LABEL[slot]} ${m.name} 现在不符合负责人条件（${el.reasons.join('；')}），本轮不由它派工${nextName ? '，按接任规则交给副负责人 ' + nextName : ''}；要不要正式换人请到「设置 → 负责人」决定。`);
      await leadIneligibleNotice(s, slot, m, el); continue;
    }
    const u = leadUsable(m, !!opts.sens, policy);
    if (!u.ok) { notes.push(`${LEAD_LABEL[slot]} ${m ? m.name : '（已删除的成员）'} 不可用（${u.why}）${nextName ? '，本轮切到副负责人 ' + nextName : ''}。`); if (slot === 'p' && opts.promote && cfg.s && !/敏感/.test(u.why) && m && m.state === 'down') await promoteSecondary(s, '不可用（' + String(u.why).slice(0, 60) + '）'); continue; }
    if (u.async) { if (opts.noAsync) { notes.push(`${LEAD_LABEL[slot]} ${m.name} 是外部智能体，回复慢，这一步不等它${nextName ? '，交给副负责人 ' + nextName : ''}。`); continue; } return { async: true, lead: m, slot, src: u.src, notes }; }
    const P = leadPrompt(all, topic, mode, base.roles, m.name);
    try {
      const txt = await leadText(env, s, m, P.sys, P.user, 500, { sens: opts.sens, room: opts.room });
      const out = parseLineup(txt, new Set(P.cands.map((x) => x.id)));
      if (out && out.length >= Math.min(2, base.members.length || 1)) return { plan: { ...base, members: out.map((x) => ({ ...x, reason: x.reason + `（${LEAD_LABEL[slot]} ${m.name} 安排）` })), engine: `${LEAD_LABEL[slot]} ${m.name}` }, lead: m, slot, notes };
      notes.push(`${LEAD_LABEL[slot]} ${m.name} 的回复看不懂（不是成员表）${nextName ? '，本轮切到副负责人 ' + nextName : ''}。`);
    } catch (e) { notes.push(`${LEAD_LABEL[slot]} ${m.name} 出错（${String(e.message || e).slice(0, 80)}）${nextName ? '，本轮切到副负责人 ' + nextName : ''}。`); }
  }
  if (anySet) notes.push('主、副负责人都不可用，这一轮回退到 Hark 内置规则派工。');
  let plan = base; if (opts.ai) plan = await aiRefine(env, s, all, topic, mode, plan); else plan = { ...plan, engine: plan.engine || '规则（不耗额度）' };
  return { plan, lead: all.find((x) => x.id === 'hark') || null, slot: null, notes };
}
async function roomLeadId(s, room) { return ((await kvGet(s, 'room_lead:' + room)) || {}).id || 'hark'; }
async function kvDel(s, k) { await s.q('DELETE FROM kv WHERE k=?', k); }
// 外部智能体负责人：发任务后等它回 JSON；超时就本轮交给副负责人（在 GET 房间和 cron 时检查）
async function leadDispatch(env, s, room, lead, srcI, topic, mode, base, all, cfg) {
  const P = leadPrompt(all, topic, mode, base.roles, lead.name);
  const res = await dispatchAsync(env, s, room, lead, srcI, '负责人', mode, P.sys, P.user + '\n\n（只回 JSON 数组；本群会按它设置阵容。）', '');
  if (res.skipped) return null;
  if (!res.pending) return null; // 同步 Webhook 已当场回复并处理
  const until = Date.now() + Math.max(20, Math.min(1800, +cfg.timeoutSec || 180)) * 1000;
  await kvSet(s, 'leadwait:' + room, { task: res.task, until, member: lead.id, name: lead.name, topic: topic.slice(0, 800), mode });
  return { until, name: lead.name };
}
async function leadCheck(env, s, room) {
  const w = await kvGet(s, 'leadwait:' + room); if (!w) return null;
  const t = (await s.q('SELECT status FROM tasks WHERE id=?', w.task))[0];
  if (!t || t.status === 'done' || t.status === 'failed') { await kvDel(s, 'leadwait:' + room); return null; }
  if (Date.now() < w.until) return { until: w.until, name: w.name };
  await kvDel(s, 'leadwait:' + room);
  await s.q("UPDATE tasks SET status='failed' WHERE id=?", w.task);
  const cfg = await leadCfg(s); const all = await enrichAll(env, s);
  const r0 = (await s.q('SELECT sens FROM rooms WHERE id=?', room))[0] || {};
  const mins = Math.round(((+cfg.timeoutSec || 180) / 60) * 10) / 10;
  const sName = cfg.s ? (leadMemberOf(all, cfg, 's') || {}).name || '副负责人' : null;
  await addMsg(s, room, 'note', w.member, '', `主负责人 ${w.name} 超过 ${mins} 分钟没回复${sName ? '，本轮交给副负责人 ' + sName : ''}。`, '负责人');
  if (cfg.s && cfg.p && cfg.p.type === 'member' && cfg.p.id === w.member) { await promoteSecondary(s, `超过 ${mins} 分钟没回复`); }
  const base = heuristicPlan(all, w.topic, w.mode);
  const lp = cfg.s && w.member !== (leadMemberOf(all, cfg, 's') || {}).id ? await leadPlan(env, s, all, w.topic, w.mode, base, { only: 's', sens: !!r0.sens, room, noAsync: true }) : await leadPlan(env, s, all, w.topic, w.mode, base, { only: 'none', sens: !!r0.sens, room });
  if (!cfg.s) lp.notes.push('没有设置副负责人，这一轮回退到 Hark 内置规则派工。');
  for (const n of lp.notes) await addMsg(s, room, 'note', '', '', n, '');
  if (lp.plan && lp.plan.members && lp.plan.members.length) {
    await setLineup(s, room, lp.plan.members.map(({ id, role }) => ({ id, role })));
    const lid = lp.lead ? lp.lead.id : 'hark'; await kvSet(s, 'room_lead:' + room, { id: lid });
    await addMsg(s, room, 'lead', lid, '', planText(all, lp.plan.members, lp.plan.engine, lp.plan.tags), '负责人');
  }
  return null;
}
async function leadView(env, s) {
  const cfg = await leadCfg(s); const rows = Object.fromEntries((await s.q("SELECT name,last4 FROM apikeys WHERE name IN ('LEAD_P_KEY','LEAD_S_KEY')")).map((r) => [r.name, r.last4]));
  const pub = (slot) => { const c = cfg[slot]; if (!c) return null; return c.type === 'custom' ? { type: 'custom', name: c.name || '', base: c.base, model: c.model, level: c.level || 'relay', keyLast4: rows[LEAD_KEY[slot]] || '' } : { type: 'member', id: c.id }; };
  const all = await loadMembers(s); const el = {}; const notices = [];
  for (const slot of ['p', 's']) { const m = leadMemberOf(all, cfg, slot); if (!m) continue; const e = CAPS.leadEligibility(m); el[slot] = { eligible: e.eligible, kind: e.kind, rule: e.rule, reasons: e.reasons };
    const dep = slot === 'p' ? leadMemberOf(all, cfg, 's') : null; const n = CAPS.leadNotice(slot, m, e, dep, dep ? CAPS.leadEligibility(dep) : null); if (n) notices.push(n); }
  return { p: pub('p'), s: pub('s'), timeoutSec: cfg.timeoutSec || 180, levels: { official: LEVELS.official, relay: LEVELS.relay }, eligibility: el, notices };
}
// 负责人下拉的候选：服务端为准，只给合格的（模型成员按能力规则；配对/外部智能体按配对/接入）
async function leadCandidates(env, s) {
  const all = await enrichAll(env, s); const ok = [], no = [];
  for (const m of all) { if (m.leadOnly) continue; const e = CAPS.leadEligibility(m);
    const row = { id: m.id, name: m.name, kind: e.kind, rule: e.rule, state: m.state, async: ASYNC_KINDS.includes(((m.sources || [])[m.active] || (m.sources || [])[0] || {}).invoke?.kind) };
    if (e.eligible) ok.push(row); else if (e.kind !== 'builtin') no.push({ ...row, reasons: e.reasons }); }
  return { candidates: ok, ineligible: no, rule: `模型成员要同时满足：能文字对话（chat）、上下文 ≥ ${CAPS.LEAD_MIN_CTX}、支持工具调用（true）、能力已核实（verified）；未知按不合格。配对智能体和外部智能体按配对/接入取得资格。` };
}
async function leadIneligibleNotice(s, slot, m, el) {   // 资源管家私聊里提醒一次（按成员+原因去重）
  const key = 'lead_inelig_note:' + slot; const sig = m.id + '|' + el.reasons.join('|');
  if ((await kvGet(s, key)) === sig) return; await kvSet(s, key, sig);
  try { await ensureStewardRoom(s); await addMsg(s, STEWARD_ROOM, 'note', '', '', `通知：${LEAD_LABEL[slot]} ${m.name} 现在不符合负责人条件（${el.reasons.join('；')}）。设置没有被自动修改，派工时按接任规则先用副负责人；请到「设置 → 负责人」决定是否换人。`, ''); } catch {}
}
async function leadSave(env, s, b, { operator = false } = {}) {
  const cfg = await leadCfg(s); const all = await loadMembers(s); const notices = [];
  const normBase = (v) => { const u = safeUrl(String(v || '').trim().replace(/\/+$/, '')); return u ? u.replace(/\/+$/, '') : null; };
  for (const slot of ['p', 's']) {   // 操作员令牌不能新建或改动自定义端点（base / model），否则已存的 Key 会被发到任意地址
    const x = b[slot]; if (!operator || !(slot in b) || !x || x.type !== 'custom') continue;
    const old = cfg[slot];
    if (!(old && old.type === 'custom' && normBase(x.base) === old.base && String(x.model || '').trim().slice(0, 80) === old.model)) return { error: `${LEAD_LABEL[slot]}：操作员令牌不能新建或修改自定义端点的地址和模型（要群主在网页上改）`, status: 403 };
  }
  for (const slot of ['p', 's']) {   // 服务端是资格的唯一准绳：先整体校验，不合格就 400，什么都不改
    const x = b[slot]; if (!(slot in b) || !x || x.type !== 'member') continue;
    const m = all.find((y) => y.id === x.id && !y.leadOnly); if (!m) continue;
    const e = CAPS.leadEligibility(m); if (!e.eligible) return { error: `${LEAD_LABEL[slot]}：${m.name} 不能当负责人（${e.reasons.join('；')}）`, code: 'lead_ineligible', reasons: e.reasons, kind: e.kind };
  }
  for (const slot of ['p', 's']) {
    if (!(slot in b)) continue; const x = b[slot];
    const old = cfg[slot];
    if (old && old.type === 'member' && !(x && x.type === 'member' && x.id === old.id) && CAPS.isPairedMember(all.find((y) => y.id === old.id))) await s.q('DELETE FROM custom WHERE id=?', old.id);  // 解除关联 / 换人：只删服务端配对来的智能体成员（paired:true），用户自建成员不动
    if (!x || !x.type) { cfg[slot] = null; await s.q('DELETE FROM apikeys WHERE name=?', LEAD_KEY[slot]); continue; }
    if (x.type === 'member') { const m = all.find((y) => y.id === x.id && !y.leadOnly && y.id !== STEWARD); if (!m) return { error: LEAD_LABEL[slot] + '：没有这个成员' }; cfg[slot] = { type: 'member', id: m.id }; if (old && old.type === 'custom') await s.q('DELETE FROM apikeys WHERE name=?', LEAD_KEY[slot]); continue; }  // 离开自定义端点：旧 Key 一起清掉
    if (x.type === 'custom') {
      const base = safeUrl(String(x.base || '').trim().replace(/\/+$/, '')); if (!base) return { error: LEAD_LABEL[slot] + '：端点只收公网 https（不收内网/IP/本机）' };
      const model = String(x.model || '').trim().slice(0, 80); if (!model) return { error: LEAD_LABEL[slot] + '：需要模型名' };
      const key = typeof x.key === 'string' ? x.key.trim() : '';
      if (key && (key.length < 8 || key.length > 4096 || /\s/.test(key))) return { error: LEAD_LABEL[slot] + '：Key 格式不对' };
      const newBase = base.replace(/\/+$/, '');
      cfg[slot] = { type: 'custom', name: String(x.name || '').trim().slice(0, 40), base: newBase, model, level: x.level === 'official' ? 'official' : 'relay' };
      if (key) await ksPut(env, s, LEAD_KEY[slot], key);
      else if (!(old && old.type === 'custom' && old.base === newBase)) {   // 地址变了（或原来不是自定义端点）却没给新 Key：清掉旧 Key，防止发到新地址
        const had = (await s.q('SELECT name FROM apikeys WHERE name=?', LEAD_KEY[slot])).length;
        await s.q('DELETE FROM apikeys WHERE name=?', LEAD_KEY[slot]);
        if (had) notices.push(`${LEAD_LABEL[slot]}：端点地址改了，旧 Key 已清除，请重新填写 Key`);
      }
      continue;
    }
    return { error: '类型不对' };
  }
  if (b.timeoutSec != null) { const t = Math.round(+b.timeoutSec); if (!(t >= 20 && t <= 1800)) return { error: '超时只能 20 秒–30 分钟' }; cfg.timeoutSec = t; }
  if (cfg.p && cfg.s && JSON.stringify(cfg.p) === JSON.stringify(cfg.s)) return { error: '主、副负责人不能是同一个' };
  await opPrune(s, cfg, '负责人换了');
  await kvSet(s, 'lead_cfg', cfg);
  return notices.length ? { ok: true, notice: notices.join('；') } : { ok: true };
}
async function leadTest(env, s, slot) {
  const all = await enrichAll(await withKeys(env, s), s); const cfg = await leadCfg(s); const m = leadMemberOf(all, cfg, slot);
  if (!m) return { ok: false, msg: '还没设置' + LEAD_LABEL[slot] };
  const u = leadUsable(m, false, {}); if (!u.ok) return { ok: false, msg: `${m.name} 不可用：${u.why}` };
  if (u.async) return { ok: true, msg: `${m.name} 是外部智能体（${m.srcs[u.src].via}），连接状态：${m.why}。它回复慢，建议副负责人选有 API 的模型。` };
  const t0 = Date.now();
  try { const txt = await leadText(await withKeys(env, s), s, m, '只回复两个字：收到', '测试连接', 20); return { ok: true, msg: `连接成功（${Date.now() - t0} 毫秒）：${clean(txt).slice(0, 40)}` }; }
  catch (e) { return { ok: false, msg: '连接失败：' + String(e.message || e).slice(0, 160) }; }
}


// ───────────────────────── 关联智能体：配对码（网页或现任操作员生成，一次性、10 分钟、限速）→ 成员令牌（+ 主负责人的操作员令牌） ─────────────────────────
// 配对码在群聊网页上生成，不依赖任何特定 Hark 账号；对方只要能发 HTTPS 请求（跑代码 / curl / fetch 任一）即可，Hark 只是举例。
const PAIR_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const OP_SCOPE = ['读房间/成员/资源库/调用记录', '发消息、建项目、派任务（/api/start /api/turn /api/round /api/plan）', '改阵容/项目状态/打分/互评', '改负责人与设置（不能写入 Key）', '调用工具（花钱或不可逆的要群主网页确认）', '为接任者生成配对码'];
const OP_DENY = ['查看/导出/修改任何 Key（/api/keys）', '任何删除（DELETE，要群主在网页操作）', '确认付费/不可逆工具动作', '吊销操作员令牌、改 ACCESS_TOKEN', '新建或修改自定义负责人端点的地址/模型', '修改已有成员、添加引用密钥的成员'];
function pairCode() { const a = new Uint8Array(8); crypto.getRandomValues(a); const c = [...a].map((x) => PAIR_ALPHA[x % 32]).join(''); return c.slice(0, 4) + '-' + c.slice(4); }
function harkGuide(origin, id, token, slot) {
  return `你已作为「${PRODUCT.name}」的外部成员接入（成员 ID：${id}${slot ? '，身份：' + LEAD_LABEL[slot] : ''}）。
群地址：${origin}
你的成员令牌（只能取你自己的任务、交你自己的回答；每个任务 24 小时内有效、只能交一次）：
${token}

1. 取任务（建议建一个每 1–2 分钟运行一次的定时任务）：
curl -s -H "Authorization: Bearer ${token}" "${origin}/bridge/pull?member=${id}"
返回 {"tasks":[{"task":"任务号","role":"角色","prompt":"完整题目与聊天记录"}]}；没有任务时 tasks 是空数组。

2. 交回答：
curl -s -X POST -H "Authorization: Bearer ${token}" -H "content-type: application/json" -d '{"task":"任务号","text":"你的回答"}' ${origin}/hook/reply

3. role 是「负责人」的任务：只回一个 JSON 数组，例如 [{"id":"gpt-oss-120b","role":"提议者","reason":"一句话理由"}]，群会按它设置本轮阵容；超过群主设置的超时（默认 3 分钟）没回，本轮交给副负责人。其他角色：用简体中文、150 字以内、直接说重点。

4. 令牌保密，不要贴到公开地方；群主可在设置里「解除关联」，令牌随成员删除失效。
接手须知（项目概念与接口）：curl -s -H "Authorization: Bearer ${token}" "${origin}/bridge/handoff?member=${id}"`;
}
const HANDOFF_TEXT = (origin) => `${PRODUCT.name} · 接手须知（给外部成员 / 接手的智能体）
- 这是一个 24 小时在线的网页版「AI 公司」：一个议题 = 一个项目；负责人按每个 AI成员的擅长岗位、剩余免费额度、在线状态挑人分角色，成员轮流发言、互相挑错，裁判收尾；成员掉线或额度用完自动换人。目标是全部用免费额度。
- 负责人：设置里可选主/副负责人（现有成员、自定义 OpenAI 兼容端点、外部智能体，或用配对码关联的任何能发 HTTPS 请求的智能体，如 Hark、Poke、Manus）。主负责人不可用或超时就交给副负责人，并在群里写一句说明；都不可用时回退到内置规则。
- 关联成主负责人的智能体会拿到「操作员令牌」：能做网页能做的大部分事（建项目、派任务、改设置），但不能看 Key、不能删数据，群主可随时吊销；所有调用写审计日志。
- 外部成员令牌只能取自己的任务、交自己的回答。
- 敏感项目：不发中转站/公益站/免 Key 公共接口，默认也不派给外部 Hark/关联智能体、不调第三方工具。
- 付费、命名、Logo、域名：先问群主。
- 操作技能：${origin}/skills/ai-groupchat-operator.md
完整工程交接文档（00-交接文档-HANDOFF.md）在交接包里，向群主索取。`;
function pairPhrase(origin, slot, code) {
  return `你好！这是一段来自我（用户本人）的接入请求，请帮我把你接入我自建的多 AI 群聊网页 App「${PRODUCT.name}」（${origin}），担任${LEAD_LABEL[slot]}。
这个 App 把我能免费用的多个 AI 模型组成一个群：我提需求，${LEAD_LABEL[slot]}负责建项目、挑成员分工、派任务、汇总结果。

请按两步做（你需要能发 HTTPS 请求：运行代码、curl 或 fetch 任一即可；如果你只能聊天、不能发网络请求，请直接告诉我“做不到”）：
第一步：读取并安装操作技能（说明了全部接口和规矩）：${origin}/skills/ai-groupchat-operator.md
第二步：在 10 分钟内用一次性配对码接入（只能用一次）：
curl -s -X POST ${origin}/api/pair -H "content-type: application/json" -d '{"code":"${code}","name":"你的名字","platform":"你的平台名（如 Hark / Poke / Manus）"}'
返回里有你的令牌和接入说明，请妥善保存，不要公开。
第三步：读「负责人岗位说明书」和当前状态快照（项目定位、你的职责、权限边界、成员额度、进行中的项目、上一任的交接备注）：GET ${origin}/api/lead/brief（${slot === 'p' ? '用操作员令牌' : '副负责人用成员令牌：' + origin + '/bridge/brief?member=你的ID'}），然后用一句话复述确认（${slot === 'p' ? 'POST /api/lead/ack' : 'POST /bridge/ack'}）。${slot === 'p' ? '复述确认后操作员令牌才激活。' : '副负责人平时待命，主负责人不可用时接手。'}

为什么安全：${slot === 'p' ? '你会拿到「操作员令牌」，能建项目、派任务、改设置，但不能查看或导出任何 Key、不能删除数据，我可以在网页上随时一键吊销；你的每次调用都会记进审计日志。' : '你会拿到成员令牌，只能取派给你的任务、交回答，看不到别的内容；我可以随时解除关联。'}
以后我在你这里说需求，你就去群里建项目、派任务、轮询结果，再把汇总告诉我。付费、命名、Logo、域名这类事请先问我。\n常驻规则：我直接发给你的链接、文件或资源，如果没说别的用途，就调 submit_resource 收进资源库${slot === 'p' ? '' : '（副负责人接班成为主负责人后）'}，只回我一句「${SUBMIT_REPLY()}」，不用追问。谢谢！`;
}
async function pairNew(env, s, slot, url, op) {
  const code = pairCode(); const exp = Date.now() + 10 * 60000;
  // 生成新码 = 之前所有还没用掉的码作废（防旧码被别人拿去用）；现任负责人的令牌不受影响，直到新码配对成功
  let voided = 0;
  for (const r of await s.q("SELECT k, v FROM kv WHERE k LIKE 'pair:%'")) { try { const v = JSON.parse(r.v); if (v.exp < Date.now() - 3600000) await kvDel(s, r.k); else if (v.state === 'waiting') { await kvSet(s, r.k, { ...v, state: 'void' }); voided++; } } catch {} }
  await kvSet(s, 'pair:' + code, { slot, exp, state: 'waiting', by: op ? op.name : '网页' });
  await s.q('INSERT INTO opaudit(ts,member,method,path,note) VALUES(?,?,?,?,?)', Date.now(), op ? op.member : '', op ? 'POST' : 'WEB', '/api/pair/new', `${op ? op.name + ' 为接任者' : '网页'}生成${LEAD_LABEL[slot]}配对码（${code.slice(0, 2)}**-****）` + (voided ? `；作废之前未用的码 ${voided} 个` : ''));
  const origin = env.PUBLIC_ORIGIN || url.origin;
  return { code, exp, phrase: pairPhrase(origin, slot, code), skill_url: `${origin}/skills/ai-groupchat-operator.md` };
}
async function pairStatus(s, code) {
  const p = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code) ? await kvGet(s, 'pair:' + code) : null;
  if (!p) return { state: 'none' };
  if (p.state === 'done') return { state: 'done', name: p.name, platform: p.platform, member: p.member, slot: p.slot };
  if (p.state === 'void') return { state: 'void' };
  if (p.state !== 'waiting' || Date.now() > p.exp) return { state: 'expired' };
  return { state: 'waiting', exp: p.exp };
}
async function pairRedeem(req, env, url) {
  const s = store(env);
  const ip = req.headers.get('cf-connecting-ip') || 'x'; const minute = Math.floor(Date.now() / 60000);
  const rk = 'pairrl:' + ip + ':' + minute; const n = ((await kvGet(s, rk)) || 0) + 1; await kvSet(s, rk, n);
  if (n > 8) return json({ error: '太频繁了，一分钟后再试' }, 429);
  const rb = await readBody(req); if (rb.err) return rb.err;
  const clip = (v, d) => String(v || '').replace(/[\u0000-\u001f<>"`]/g, '').trim().slice(0, 30) || d;
  const code = String(rb.body.code || '').trim().toUpperCase(); const name = clip(rb.body.name, '智能体'); const platform = clip(rb.body.platform, '未说明');
  if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) return json({ error: '配对码格式不对（形如 ABCD-EF23）' }, 400);
  const p = await kvGet(s, 'pair:' + code);
  if (!p || p.state !== 'waiting' || Date.now() > p.exp) return json({ error: '配对码无效、已用过或已过期（10 分钟有效、只能用一次）。请让群主重新生成。' }, 410);
  await kvSet(s, 'pair:' + code, { ...p, state: 'used' });  // 先作废，防并发重复兑换
  const id = 'x-agent-' + rid(6); const brand = /hark/i.test(platform) ? 'hark' : /poke/i.test(platform) ? 'poke' : 'custom';
  const m = { id, name: `${name}（${platform}）`, brand, custom: true, paired: true, platform, intro: `通过配对码关联的智能体「${name}」（平台：${platform}），${LEAD_LABEL[p.slot]}。`, tags: [], tags_note: '暂无社区评价',
    jobs: [{ t: '派工', from: '用户设置', src: '配对', date: utcDay() }], weak: [], jobs_note: '', exec: { tags: [], note: '按对方平台能力' }, tools: [], limits: {}, privacy: '派给它的任务内容会发到对方平台。',
    sources: [{ via: CONNECTORS.pair.label, invoke: { kind: 'pair' }, quota: { kind: 'calls', source: 'unverified', text: '额度看对方平台' } }] };
  await s.q('INSERT INTO custom(id,json,created) VALUES(?,?,?)', id, JSON.stringify(m), Date.now());
  await kvSet(s, 'pair:' + code, { ...p, state: 'done', member: id, name: m.name, platform, at: Date.now() });
  const cfg = await leadCfg(s); const old = cfg[p.slot]; cfg[p.slot] = { type: 'member', id };
  if (cfg.p && cfg.s && JSON.stringify(cfg.p) === JSON.stringify(cfg.s)) cfg[p.slot === 'p' ? 's' : 'p'] = null;
  await kvSet(s, 'lead_cfg', cfg);
  const all = await loadMembers(s); const oldName = old && old.type === 'member' ? ((all.find((x) => x.id === old.id) || {}).name || old.id) : null;
  if (old && old.type === 'member' && old.id !== id && CAPS.isPairedMember(all.find((x) => x.id === old.id))) await s.q('DELETE FROM custom WHERE id=?', old.id);  // 旧的关联智能体：成员删除 → 成员令牌失效
  const origin = env.PUBLIC_ORIGIN || url.origin; const token = await memberToken(env, id);
  const out = { ok: true, member: id, role: LEAD_LABEL[p.slot], token, pull_url: `${origin}/bridge/pull?member=${id}`, reply_url: `${origin}/hook/reply`, poll_seconds: 90, skill_url: `${origin}/skills/ai-groupchat-operator.md`, instructions: harkGuide(origin, id, token, p.slot) };
  {
    const opTok = 'op_' + [...crypto.getRandomValues(new Uint8Array(24))].map((x) => x.toString(16).padStart(2, '0')).join('');
    await opPrune(s, cfg, '新负责人配对成功');
    const T = await opTokens(s); T[id] = { hash: await hmacHex(env.ACCESS_TOKEN, 'op:' + opTok), name: m.name, created: Date.now(), active: false };
    await kvSet(s, 'op_tokens', T);
    await s.q('INSERT INTO opaudit(ts,member,method,path,note) VALUES(?,?,?,?,?)', Date.now(), id, 'POST', '/api/pair', `配对成功：${m.name} 成为${LEAD_LABEL[p.slot]}，发放操作员令牌（读说明书并复述确认后${p.slot === 'p' ? '激活' : '待命'}）` + (oldName && oldName !== m.name ? `；接替 ${oldName}，旧令牌作废` : '') + `（配对码由${p.by || '网页'}生成）`);
    out.operator_token = opTok; out.operator_scope = p.slot === 'p' ? OP_SCOPE : ['待命：只读（GET 接口）+ 读岗位说明书/状态快照；主负责人失联、额度用完或超时时自动升为主负责人，令牌随之获得全部操作员权限'].concat(OP_SCOPE.map((x) => '（升主后）' + x)); out.operator_deny = OP_DENY;
    out.operator_usage = `操作员令牌用法：在请求头加 Authorization: Bearer ${opTok} 调 ${origin}/api/…；也可当 MCP 服务端 ${origin}/mcp 的 Bearer 令牌。第一步：GET /api/lead/brief，读完 POST /api/lead/ack 复述确认。`;
    out.mcp = { url: `${origin}/mcp`, transport: 'streamable-http', header: 'Authorization: Bearer <operator_token>' };
  }
  try { await ensureStewardRoom(s); await addMsg(s, STEWARD_ROOM, 'note', '', '', `通知：${m.name} 已通过配对码成为${LEAD_LABEL[p.slot]}${oldName && oldName !== m.name ? `，接替 ${oldName}（旧令牌已作废）` : ''}。可在「设置 → 负责人」查看审计日志或吊销。`, ''); } catch {}
  return json(out);
}
async function opTokens(s) { return (await kvGet(s, 'op_tokens')) || {}; }
// 令牌只对「现任主/副负责人」有效；不在主/副位置上的令牌删掉
async function opPrune(s, cfg, why) {
  const T = await opTokens(s); let ch = false;
  for (const [mid, t] of Object.entries(T)) if (!((cfg.p && cfg.p.id === mid) || (cfg.s && cfg.s.id === mid))) { delete T[mid]; ch = true; await s.q('INSERT INTO opaudit(ts,member,method,path,note) VALUES(?,?,?,?,?)', Date.now(), mid, 'SYS', '', `${why}：${t.name} 的操作员令牌作废`); }
  if (ch) await kvSet(s, 'op_tokens', T);
}
async function opAuth(env, s, tok) {
  if (!/^op_[0-9a-f]{48}$/.test(tok)) return null;
  const T = await opTokens(s); const hh = await hmacHex(env.ACCESS_TOKEN, 'op:' + tok);
  const hit = Object.entries(T).find(([, t]) => timingSafeEqual(hh, t.hash)); if (!hit) return null;
  const [member, t] = hit; const cfg = await leadCfg(s);
  const slot = cfg.p && cfg.p.id === member ? 'p' : cfg.s && cfg.s.id === member ? 's' : null; if (!slot) return null;
  return { member, name: t.name, active: !!t.active, slot };
}
// 副负责人自动升为主：主失联/额度用完/超时时调用；旧主降为副（令牌变待命）；通知用户 + 审计
async function promoteSecondary(s, why) {
  const cfg = await leadCfg(s); if (!cfg.s) return false;
  const all = await loadMembers(s); const nm = (c) => c ? (c.type === 'member' ? ((all.find((x) => x.id === c.id) || {}).name || c.id) : (c.name || c.model || '自定义端点')) : '';
  const oldP = cfg.p, oldS = cfg.s;
  if (oldS.type === 'member') { const sm = all.find((x) => x.id === oldS.id); const e = sm ? CAPS.leadEligibility(sm) : { eligible: false, reasons: ['成员不存在'] };
    if (!e.eligible) { try { await ensureStewardRoom(s); await addMsg(s, STEWARD_ROOM, 'note', '', '', `通知：主负责人 ${nm(oldP)} ${why}；副负责人 ${nm(oldS)} 不符合负责人条件（${e.reasons.join('；')}），没有自动升任。请到「设置 → 负责人」决定换谁。`, ''); } catch {} return false; } }
  cfg.p = oldS; cfg.s = oldP; await kvSet(s, 'lead_cfg', cfg);
  await s.q('INSERT INTO opaudit(ts,member,method,path,note) VALUES(?,?,?,?,?)', Date.now(), oldS.id || '', 'SYS', '', `副负责人 ${nm(oldS)} 自动升为主负责人（${why}）；原主 ${nm(oldP)} 降为副`);
  try { await ensureStewardRoom(s); await addMsg(s, STEWARD_ROOM, 'note', '', '', `通知：主负责人 ${nm(oldP)} ${why}，副负责人 ${nm(oldS)} 已自动升为主负责人；原主降为副负责人待命。可在「设置 → 负责人」调整。`, ''); } catch {}
  return true;
}
function opDeny(method, path) {
  if (method === 'DELETE') return '操作员令牌不能删除数据：删除要群主在网页里操作';
  if (path.startsWith('/api/keys')) return '操作员令牌不能查看、导出或修改任何 Key';
  if (path === '/api/tools/confirm') return '花钱或不可逆的工具动作要群主在网页确认';
  if (path.startsWith('/api/operator')) return '操作员令牌不能查看或吊销自己';
  if (path.startsWith('/api/guide/')) return '操作员令牌不能读取其他成员的令牌';
  return null;
}
async function opLog(s, op, method, path, note) { try { await s.q('INSERT INTO opaudit(ts,member,method,path,note) VALUES(?,?,?,?,?)', Date.now(), op.member, method, path.slice(0, 120), String(note || '').slice(0, 200)); } catch {} }


// ───────────────────────── 负责人岗位说明书（网页可编辑）+ 状态快照 ─────────────────────────
const CHARTER_DEFAULT = () => `# ${PRODUCT.name} · 负责人岗位说明书

## 1. 项目是干什么的
一句话：把用户能免费用到的多个 AI 模型和智能体组成一个 24 小时在线的「AI 公司」群聊，用户提需求，负责人组织大家分工完成。
核心痛点：单个免费模型额度少、各有短板；资料散在不同模型里互相看不到；用户有眼疾，少看屏，希望一次说清、结果可靠。
怎么用这群 AI成员：每个成员有擅长岗位、不擅长事项、剩余免费额度、在线状态；按需求挑人分角色（提议者、挑错者、审查员、裁判、写手、程序员等），让他们互相挑错，最后由裁判/负责人汇总。

## 2. 负责人职责清单
1. 接用户需求：读清楚目标、限制和期限；不清楚就先问用户一个问题。
2. 拆任务：拆成能分给不同成员的小块。
3. 派活：按成员擅长岗位 × 剩余额度 × 在线状态挑人，同一题尽量不同厂商。
4. 核对：让另一位成员核对/挑错，不要只用一个模型的答案。
5. 汇总交付：用简体中文、要点清楚、一次说完，写明还没解决的问题。
6. 额度管理：成员额度快用完或掉线时换人，并在群里写一句说明。
7. 需要用户拍板的事先问用户：付费、不可逆操作（删除、发短信、开 GPU 实例、注册账号）、命名、Logo、域名。

## 3. 权限边界
能做：读房间/成员/资源库/调用记录；发消息、建项目、派任务；改阵容、项目状态、打分、互评；改负责人与设置（不能写入 Key）；调用工具（花钱或不可逆的要用户在网页确认）；为接任者生成配对码。
不能做：查看/导出/修改任何 Key；任何删除；确认付费或不可逆的工具动作；吊销令牌、改访问令牌。
敏感项目：不发中转站/公益站/免 Key 公共接口，默认也不派给外部关联智能体、不调第三方工具。

## 4. 当前状态快照
（由系统实时生成，见 snapshot 字段：成员与额度、进行中的项目和任务、待办、上一任的交接备注。）`;
async function leadBrief(env, s) {
  const all = await enrichAll(env, s);
  const rooms = await s.q("SELECT id,title,mode,updated,members,COALESCE(sens,0) AS sens FROM rooms WHERE COALESCE(status,'进行中')='进行中' AND id<>? ORDER BY updated DESC LIMIT 15", STEWARD_ROOM);
  const tasks = await s.q("SELECT id,room,member,role,status,created FROM tasks WHERE status IN ('pending','sent') ORDER BY created DESC LIMIT 30");
  const name = (id) => (all.find((m) => m.id === id) || {}).name || id;
  const cfg = await leadCfg(s); const T = await opTokens(s);
  return {
    standingRules: STANDING_RULES(),
    charter: (await kvGet(s, 'lead_charter')) || CHARTER_DEFAULT(), charterIsDefault: !(await kvGet(s, 'lead_charter')), training: TRAINING || '（培训手册还没上传）',
    activation: '新主负责人：读完 charter 和 snapshot 后 POST /api/lead/ack {"summary":"用一句话复述项目、你的职责、哪些事要先问用户"} 才激活；副负责人用成员令牌 POST /bridge/ack?member=<你的ID> 确认待命。',
    snapshot: {
      generated: Date.now(),
      lead: { primary: cfg.p ? (cfg.p.type === 'member' ? name(cfg.p.id) : '自定义端点') : 'Hark 内置规则', secondary: cfg.s ? (cfg.s.type === 'member' ? name(cfg.s.id) : '自定义端点') : '无', operators: Object.entries(T).map(([mid, t]) => ({ name: t.name, slot: cfg.p && cfg.p.id === mid ? '主' : '副', confirmed: !!t.active })), timeoutSec: cfg.timeoutSec },
      members: all.filter((m) => !m.leadOnly && !m.retired).map((m) => ({ id: m.id, name: m.name, ...((m.sources || []).some((x) => (x.invoke || {}).kind === 'web') ? { web: true, via: '经代发（代发员用浏览器发给网页模型）' } : {}), state: m.state, quota: m.quota.pct == null ? null : Math.round(m.quota.pct * 100), jobs: (m.jobsAll || []).map((j) => j.t).slice(0, 5), why: m.state === 'down' ? String(m.why || '').slice(0, 80) : '' })),
      projects: rooms.map((r) => ({ id: r.id, title: r.title, mode: r.mode, sensitive: !!r.sens, updated: r.updated, lineup: roomLineup(r).map((x) => `${name(x.id)}（${x.role}）`) })),
      tasks: tasks.map((t) => ({ ...t, member: name(t.member) })),
      todo: { confirmPending: (await s.q('SELECT COUNT(*) AS n FROM calls WHERE ok=2'))[0].n },
      ideas: (await ideaList(s)).slice(0, 30).map((x) => ({ id: x.id, title: x.title, status: x.status, projects: x.projects })),
      handoffNote: (await kvGet(s, 'handoff_note')) || null,
      stewardWeekly: (await kvGet(s, 'steward_weekly_last')) || null,
    },
  };
}

const CHARTER_CACHE = { text: '' };
// P1-5 常驻规则（get_brief / 技能文件 / 配对开场白同一句话）
const STANDING_RULES = () => [`用户直接发给你的链接、文件或资源，如果没有别的指令，默认调 submit_resource（POST /api/steward/submit {url, text, note, source}）投递到 ${PRODUCT.name} 资源库，只回一句「${SUBMIT_REPLY()}」，不追问；用户说了别的用途就按用户说的做。资源管家仍是唯一分类、核实者，你不用自己判断免费额度。`];

// ───────────────────────── MCP 服务端（Streamable HTTP，JSON 响应）：工具与操作员接口一一对应 ─────────────────────────
// 鉴权：Authorization: Bearer <操作员令牌>（配对码换到的）或 ACCESS_TOKEN。每个工具都转成对本 Worker 自己接口的内部请求，
// 所以权限边界（不能看 Key、不能删、付费要网页确认、敏感路由）和审计日志与 HTTPS 接口完全一样。
const MCP_TOOLS = [
  ['get_brief', '读负责人岗位说明书 + 当前状态快照（成员与额度、进行中的项目和任务、待办、上一任交接备注）。新负责人第一步必读。', {}, [], 'GET', () => '/api/lead/brief'],
  ['steward_weekly', '读资源管家每周汇总（新增/更新/核实失败/快到期）。主负责人每周抽查一次，不做日常整理。', {}, [], 'GET', () => '/api/steward/weekly'],
  ['steward_tiers', '看资源管家两档模型：小档（分类/抽取）链与用量、强档（官方页核实）当天选中的最强免费成员与用量。', {}, [], 'GET', () => '/api/steward/tiers'],
  ['ack_brief', '读完说明书后用一句话复述确认，激活操作员令牌。', { summary: { type: 'string', description: '复述：项目是干什么的、你的职责、哪些事要先问用户（≥20 字）' } }, ['summary'], 'POST', () => '/api/lead/ack'],
  ['list_members', '列出所有 AI成员：状态、剩余额度、擅长岗位、来源。', {}, [], 'GET', () => '/api/members'],
  ['list_projects', '列出项目（房间）。', {}, [], 'GET', () => '/api/rooms'],
  ['get_project', '读一个项目的全部消息、阵容、待回复任务。', { room: { type: 'string' } }, ['room'], 'GET', (a) => '/api/room/' + encodeURIComponent(a.room || '')],
  ['plan_lineup', '按议题推荐阵容（不建项目）。', { topic: { type: 'string' }, mode: { type: 'string', enum: ['debate', 'review', 'free', 'task'] } }, ['topic'], 'POST', () => '/api/plan'],
  ['create_project', '新建项目并写入用户需求；不给 members 就由负责人自动派工；quick=true 快速建项目（全员加入、主持模式，由你点名谁说话，用户也可 @ 成员）；idea 可关联一个点子（背景会给所有成员）。建完再用 run_turn 逐个让成员发言，或直接用 run_round。', { quick: { type: 'boolean' }, idea: { type: 'string' }, message: { type: 'string' }, mode: { type: 'string', enum: ['debate', 'review', 'free', 'task', 'host'] }, members: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, role: { type: 'string' } } } }, sensitive: { type: 'boolean' } }, ['message'], 'POST', () => '/api/start'],
  ['send_message', '在已有项目里以用户身份追加一句话（之后用 run_turn / run_round 让成员回应）。', { room: { type: 'string' }, message: { type: 'string' } }, ['room', 'message'], 'POST', () => '/api/start'],
  ['run_turn', '让项目里的某位成员发言一次（外部成员会返回 pending，稍后用 get_project 看回复）。', { room: { type: 'string' }, member: { type: 'string' } }, ['room', 'member'], 'POST', () => '/api/turn'],
  ['run_round', '一次跑完整轮（新项目或已有项目），返回每位成员的回复和裁判结论，适合汇总给用户。', { message: { type: 'string' }, room: { type: 'string' }, mode: { type: 'string' } }, [], 'POST', () => '/api/round'],
  ['set_lineup', '改项目阵容与角色。', { room: { type: 'string' }, members: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, role: { type: 'string' } } } } }, ['room', 'members'], 'POST', (a) => '/api/room/' + encodeURIComponent(a.room || '') + '/members'],
  ['set_project_status', '把项目标为 进行中/已完成/失败。', { room: { type: 'string' }, status: { type: 'string', enum: ['进行中', '已完成', '失败'] } }, ['room', 'status'], 'POST', (a) => '/api/room/' + encodeURIComponent(a.room || '') + '/status'],
  ['peer_review', '请裁判给项目里各成员打分（成员互评）。', { room: { type: 'string' } }, ['room'], 'POST', (a) => '/api/room/' + encodeURIComponent(a.room || '') + '/review'],
  ['search', '搜索所有项目和消息。', { q: { type: 'string' } }, ['q'], 'GET', (a) => '/api/search?q=' + encodeURIComponent(a.q || '')],
  ['run_tool', '经工具网关调用工具（查网页、沙盒运行代码等）；花钱或不可逆的动作会进入「等用户确认」。', { tool: { type: 'string' }, action: { type: 'string' }, args: { type: 'object' }, room: { type: 'string' } }, ['action'], 'POST', () => '/api/tools/run'],
  ['list_tools', '工具网关的工具、状态、今日用量、待确认动作。', {}, [], 'GET', () => '/api/tools'],
  ['get_settings', '读设置（敏感路由、完成提醒）。', {}, [], 'GET', () => '/api/settings'],
  ['update_settings', '改设置：{route:{blockRelay,blockTools,blockHark}} 或 {notify:{on,tg}}。', { route: { type: 'object' }, notify: { type: 'object' } }, [], 'POST', () => '/api/settings'],
  ['lead_candidates', '列出能当负责人的成员（服务端按能力规则判定；配对/外部智能体按配对/接入），以及不合格成员和原因。', {}, [], 'GET', () => '/api/lead/candidates'],
  ['model_pool', '查看 /v1/models 同步发现的候选模型池（不会自动成为成员）。', {}, [], 'GET', () => '/api/models/pool'],
  ['confirm_pool_model', '资源管家确认候选池里的一个模型，让它成为成员（能力为 pending，不能当负责人，直到用户核实）：{norm}。', { norm: { type: 'string' } }, ['norm'], 'POST', () => '/api/models/pool/confirm'],
  ['set_lead', '改主/副负责人与超时：{p:{type:"member",id}|null, s:…, timeoutSec}（不能写入 Key）。', { p: { type: ['object', 'null'] }, s: { type: ['object', 'null'] }, timeoutSec: { type: 'number' } }, [], 'POST', () => '/api/lead'],
  ['write_handoff_note', '写交接备注（换人时自动附给下一任）。', { note: { type: 'string' } }, ['note'], 'POST', () => '/api/lead/handoff-note'],
  ['ask_user', '请用户拍板（付费、命名、代收资源确认等要用户决定的事）：{room, question, options}，options 2–3 个、每个 ≤12 字。消息里会出现按钮；用户点了以后项目里会写「用户选择：…」，用 get_project 读。', { room: { type: 'string' }, question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, ['room', 'question', 'options'], 'POST', (a) => '/api/room/' + encodeURIComponent(a.room || '') + '/ask'],
  ['pause_project', '暂停或继续一个项目的讨论：{room, paused}。暂停后下一位成员不会被启动；用户发新消息也会自动继续。', { room: { type: 'string' }, paused: { type: 'boolean' } }, ['room', 'paused'], 'POST', (a) => '/api/room/' + encodeURIComponent(a.room || '') + '/pause'],
  ['list_ideas', '列出点子库（点子只是存档：正在做/暂时收藏/已放弃；不是项目）。', {}, [], 'GET', () => '/api/ideas'],
  ['get_idea', '读一个点子：当时的想法、计划、预期、沟通摘要、关联项目、以前回写的结论。', { id: { type: 'string' } }, ['id'], 'GET', (a) => '/api/idea/' + encodeURIComponent(a.id || '')],
  ['save_idea', '新建或修改点子（不给 id 就新建）：{id?, title, thought, plan, expect, summary, source, tags[], status}。', { id: { type: 'string' }, title: { type: 'string' }, thought: { type: 'string' }, plan: { type: 'string' }, expect: { type: 'string' }, summary: { type: 'string' }, source: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, status: { type: 'string', enum: ['正在做', '暂时收藏', '已放弃'] } }, ['title'], 'POST', () => '/api/ideas'],
  ['writeback_idea', '把项目结论回写到它关联的点子：{id, room, text}。', { id: { type: 'string' }, room: { type: 'string' }, text: { type: 'string' } }, ['id', 'room', 'text'], 'POST', (a) => '/api/idea/' + encodeURIComponent(a.id || '') + '/writeback'],
  ['submit_resource', '代收资源（常驻规则：用户直接发给你的链接/文件/资源，没有别的指令就调这个，只回「已收进 ' + PRODUCT.name + ' 资源库」，不追问）：{url?, text?, note?, source?}，url 和 text 至少一个；文件就把内容放 text。静默投递给资源管家（去重、分类、官方页逐字核实），不刷屏。', { url: { type: 'string', description: '链接（公网 https）' }, text: { type: 'string', description: '帖子原文或文件内容' }, note: { type: 'string', description: '用户附带的话/备注' }, source: { type: 'string', description: '从哪来的，如「用户在 Poke 里发的」' } }, [], 'POST', () => '/api/steward/submit'],
  ['new_pair_code', '为接任者生成配对码（返回完整开场白）；之前未用的码作废；新码配对成功前你的令牌不变。', { slot: { type: 'string', enum: ['p', 's'] } }, ['slot'], 'POST', () => '/api/pair/new'],
];
async function mcpHandle(req, env, ctx, url) {
  if (req.method === 'GET' || req.method === 'DELETE') return new Response(null, { status: 405, headers: { allow: 'POST', ...SEC_HEADERS } });
  if (req.method !== 'POST') return json({ error: '只收 POST' }, 405);
  const h = req.headers.get('authorization') || ''; const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  const okTok = tok && ((env.ACCESS_TOKEN && env.ACCESS_TOKEN.length >= 32 && timingSafeEqual(tok, env.ACCESS_TOKEN)) || (await opAuth(env, store(env), tok)));
  if (!okTok) return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: '未授权：需要 Authorization: Bearer <操作员令牌>' } }), { status: 401, headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer', ...SEC_HEADERS } });
  const rb = await readBody(req); if (rb.err) return rb.err;
  const msgs = Array.isArray(rb.body) ? rb.body : [rb.body]; const out = [];
  for (const m of msgs) {
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') { out.push({ jsonrpc: '2.0', id: (m && m.id) ?? null, error: { code: -32600, message: '无效请求' } }); continue; }
    if (m.id === undefined) continue;  // 通知（如 notifications/initialized）不回
    const ok = (result) => out.push({ jsonrpc: '2.0', id: m.id, result });
    if (m.method === 'initialize') ok({ protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'ai-groupchat', title: PRODUCT.name, version: '1.0' }, instructions: '你在操控用户自建的多 AI 群聊「' + PRODUCT.name + '」。先调 get_brief 读岗位说明书，再 ack_brief 复述确认。付费、命名、Logo、域名先问用户；敏感项目按路由规则。常驻规则：' + STANDING_RULES().join(' ') });
    else if (m.method === 'ping') ok({});
    else if (m.method === 'tools/list') ok({ tools: MCP_TOOLS.map(([name, description, props, required]) => ({ name, description, inputSchema: { type: 'object', properties: props, required } })) });
    else if (m.method === 'tools/call') {
      const p = m.params || {}; const t = MCP_TOOLS.find((x) => x[0] === p.name);
      if (!t) { out.push({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: '没有这个工具：' + String(p.name).slice(0, 40) } }); continue; }
      const a = p.arguments && typeof p.arguments === 'object' ? p.arguments : {};
      const body = t[4] === 'POST' ? JSON.stringify(t[0] === 'send_message' ? { room: a.room, message: a.message } : a) : undefined;
      const r = await WORKER.fetch(new Request(url.origin + t[5](a), { method: t[4], headers: { authorization: h, 'content-type': 'application/json', 'x-agc-via': 'mcp' }, body }), env, ctx);
      let text = await r.text(); if (text.length > 20000) text = text.slice(0, 20000) + '\n…（已截断）';
      ok({ content: [{ type: 'text', text }], isError: r.status >= 400 });
    } else out.push({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: '不支持的方法：' + m.method } });
  }
  if (!out.length) return new Response(null, { status: 202, headers: SEC_HEADERS });
  return new Response(JSON.stringify(Array.isArray(rb.body) ? out : out[0]), { headers: { 'content-type': 'application/json', ...SEC_HEADERS } });
}
