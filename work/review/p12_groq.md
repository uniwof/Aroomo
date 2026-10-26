<!-- model=openai/gpt-oss-120b secs=6 usage={'queue_time': 0.169094559, 'prompt_tokens': 4653, 'prompt_time': 0.230019137, 'completion_tokens': 2579, 'completion_time': 5.329723735, 'total_tokens': 7232, 'total_time': 5.559742872, 'completion_tokens_details': {'reasoning_tokens': 1461}} -->
**文件/函数** | **问题** | **为什么是问题** | **怎么改** | **把握度**
---|---|---|---|---
`caps.js → capsOf` | 通过任意 source.kind 为 `web` 即自动把成员标记为 `web` 成员 | 攻击者只要在成员的 `sources` 中加入一个伪造的 `{"kind":"web"}` 条目，就能让该成员获得网页代发权限，导致未授权的代发员被派单，出现鉴权绕过与任务泄露 | 只在明确受信任的成员配置中才允许 `web`，例如在成员配置文件里显式声明 `web:true` 或在后台管理界面受控添加；不要在 `capsOf` 中依据 `sources` 推断 `web` 标记 | 高
`worker.js → srcState` | 使用 `ctx.relays` 前未确保其已定义，若 `srcState` 在 `enrichAll` 之前被调用会抛 `TypeError: Cannot read property 'filter' of undefined` | 运行时错误会导致任务调度中断，进而出现任务丢失或重复派发，破坏系统可靠性 | 在访问 `ctx.relays` 前加 `const relays = (ctx.relays || []);` 并使用 `relays.filter(...)`，或确保 `srcState` 只在 `enrichAll` 之后调用 | 中
`worker.js → srcMissing` | 对 `web` 类型仅检查 `iv.site` 是否存在，未校验 URL 协议或域名合法性 | 代发员会被迫打开任意 URL，包括 `http://`、内部 IP、或恶意钓鱼站点，可能导致 SSRF、信息泄露或用户被诱导访问恶意页面 | 在校验 `iv.site` 时加入正则或 URL 解析，强制要求 `https://` 且域名在白名单或符合公司安全策略 | 高
`worker.js → webEnqueue` | `note` 中直接拼接 `iv.site` 并返回给前端，未做转义 | 若 `iv.site` 包含 HTML/JS 代码，前端渲染时会产生 XSS，攻击者可窃取令牌或注入恶意脚本 | 对 `iv.site` 进行 HTML 实体转义（如 `escapeHTML`）后再拼接到提示文字，或在前端统一使用安全渲染函数 | 中
`worker.js → webEnqueue` | `prompt` 直接使用 `transcript`（用户聊天记录）拼接进提示词，未对其中可能出现的产品名称、回调地址等敏感信息做过滤 | 代发员收到的完整提示可能泄露内部产品名、内部 API 地址或其他机密信息，违背“提示词泄露产品名或回调地址”安全要求 | 在生成 `prompt` 前对 `transcript` 进行敏感信息脱敏（正则过滤或关键字屏蔽），或在 `P1.webPrompt` 中统一实现脱敏逻辑 | 高
`worker.js → dispatchAsync` | 为 `web` 类型直接 `return webEnqueue(...)`，但未对返回值的结构与其它 async 类型保持一致（缺少 `status`、`taskId` 等字段） | 调用方可能依赖统一的返回结构进行后续处理，结构不统一会导致后续代码出现未捕获的 `undefined` 错误，影响任务流转 | 让 `webEnqueue` 返回与其他 async 处理器相同的字段集合（如 `status:'pending'`, `taskId`），或在 `dispatchAsync` 包装统一返回对象 | 中
`worker.js → ASYNC_KINDS / CUSTOM_KINDS` | 将 `web` 加入这两个列表后，未在其他涉及 `ASYNC_KINDS` 的权限检查、配额统计、审计等模块同步处理 `web` | 可能导致 `web` 任务被错误计入配额、审计日志缺失或被误判为不安全的外部调用 | 在所有遍历 `ASYNC_KINDS` 的地方（如配额计算、审计、速率限制）加入对 `web` 的专门处理或显式排除 | 中

---

### 最反对的 3 点
1. **`capsOf` 中的 `web` 标记推断** – 直接依据 `sources` 赋予网页成员权限，构成明显的鉴权绕过路径，风险最高。  
2. **`srcMissing` 对 `web` URL 的缺乏校验** – 允许任意 URL（包括非 HTTPS、内部网络）被代发员打开，导致 SSRF 与信息泄露。  
3. **`srcState` 对 `ctx.relays` 的空指针使用** – 运行时错误会中断任务调度，导致任务丢失或重复派发，破坏系统可靠性。