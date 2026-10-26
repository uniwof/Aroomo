# P1-5 复审裁决（Groq gpt-oss-120b + Agnes 3.0 flash 对抗式；全新上下文复核 Groq + Agnes）
输入：review/p15_prompt.txt（diff）、review/p15_fresh.txt（最终代码，全新上下文）。原文：p15_groq.md、p15_agnes.md、p15fresh_groq.md、p15fresh_agnes.md。

## 采纳（3）
1. Agnes：sub_log 用 kv 读-改-写，并发请求会互相覆盖丢记录 → 改成 subs 表逐行 INSERT / 条件 UPDATE（测试模式按 test=1 删除）。
2. （由 Agnes 第 4 条引出，自查）去重占位先读后写有竞态 → 改为单条 SQL 原子占位 subClaim（INSERT … ON CONFLICT DO UPDATE … WHERE 过期 RETURNING），并发同一条只会有一个排队。
3. Agnes：测试模式结束删除所有 sub_busy 键会误删真实用户正在处理的占位 → 删掉这段（占位本来就有 10 分钟时效、处理完自删）。

## 驳回
- Groq：cols('res_items') 在 ALTER 后未重读 → 每列只检查一次、各不相同，结果正确。
- Groq/Agnes：副负责人能调用 submit → 中间件对 slot='s' 的非 GET 一律 403，test_live 用例「副负责人待命时不能代收 → 403」已覆盖；升主后可用也有用例。
- Groq：ingestLink 签名变了其他调用会崩 → via 是可选参数，旧调用 via=undefined 行为不变（stewardMessage 路径 test_live 全绿）。
- Groq：page.url 未过 safeUrl → readLink/safeFetchText 每跳都过 safeUrl；ingestText 的 links 也过 safeUrl。
- Groq：note/source 没写进 via_* → 已写（同一条 INSERT），用例验证 via_note / via_src。
- Groq/Groq 全新：GET /api/steward/submissions 无鉴权 → 全局鉴权在路由之前，未登录 401；群主与操作员本就可读。
- Groq：test 列只给代收用会误删 → 目前只有代收写 test=1，正是要删的。
- Groq：每周汇总要排除 test 条目 → 测试结束时这些条目已删除；测试期间计入是预期（用例要用）。
- Agnes：纯文字没链接无法核实 → 规格就是「对不上官方页原文就是未核实」，纯文字条目一律未核实（用例覆盖「自称已核实也不算」）。http→https 与现有资源管家一致。
- Groq 全新：subLog 截断与插入非事务 → 只保留最新 200 条，排队记录是最新的，不会被截掉；影响可忽略。
- Groq 全新：PRODUCT 未定义 → 第 20 行全局常量。
- Agnes 全新：res_items.id 是整数主键、去重失效 → 表定义 id TEXT PRIMARY KEY，去重用例（文字重复、处理中链接重复、MCP 重复）全绿。
- Agnes 全新：进程中断后占位残留 10 分钟 → 设计如此（10 分钟时效），可接受。
