# P1-6 复审裁决（第 1、2 条；第 3 条只出方案 docs/P1-6-备用入口方案.md）
原文：p16_agnes.md、p16g_groq.md（p16_groq.md 推理用尽 token 无正文，缩小提示重跑为 p16g）、全新上下文 p16fresh_groq.md、p16fresh_agnes.md。

## 采纳（4）
1. Agnes：80% 提醒只在 flush 时判定，cron 里的 reqFlush 多数是空操作 → 抽出 reqWarn（原子占位每天一次），cron 每小时读当天总数兜底检查一次。
2. Groq：reqFlush 先清零再写库，写失败计数丢失 → 失败时把数加回 RQ.n。
3. Groq 全新/Agnes 全新：补发遇到 4xx 删除条目会丢原文 → 删除前把原文放回输入框（输入框空时），提示里也带原文前 40 字。（5xx/网络/1027 一律保留重试，原代码已如此。）
4. （自查）用量胶囊字号 18→19px，与正文规则一致。

## 驳回
- Groq：upsert 里 kv.v 语法错误 → SQLite 允许在 DO UPDATE 里引用原表列；本机/线上计数增长用例通过。
- Groq：应每次请求原子写 DO → 会让 DO 请求量翻倍、反而更快耗尽免费额度；计数写明「约值、以 Cloudflare 后台为准」。
- Groq/Groq 全新：/api/usage、dup 返回无鉴权 → 全局鉴权在路由前，用例「用量接口未登录 → 401」。
- Groq：cron 删旧键会删到当天 → 只删 7 天前。
- Groq 全新：kvGet 返回字符串 → kvGet 内部 JSON.parse；room 未声明 → 页面全局变量；RETURNING 不支持 → DO SQLite 支持，用例通过；e 可能无 net → api() 只抛 Error。
- Agnes：dup 返回形状和首次不同 → 前端 dup 时重拉房间，不读 lineup；接口说明已写。
- Agnes：startRound 成功后进程中断 cid 卡在 busy → 消息已写入、重试返回 dup，不丢不重，符合要求。
- Agnes：RQ.last=0 首次请求就 flush → 每个实例启动多 1 次 DO 写，可接受。
- Agnes：1027 只看正文 → 只看状态码会把本站自己的 429 当成 1027；Cloudflare 错误页正文固定含 "1027"。
