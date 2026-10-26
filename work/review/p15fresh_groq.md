<!-- model=openai/gpt-oss-120b secs=7 usage={'queue_time': 0.212738927, 'prompt_tokens': 2341, 'prompt_time': 0.131432374, 'completion_tokens': 3000, 'completion_time': 6.290890852, 'total_tokens': 5341, 'total_time': 6.422323226, 'completion_tokens_details': {'reasoning_tokens': 2350}} -->
**代码审查发现的真实问题（仅列出真正的缺陷）**

| 文件/函数 | 问题 | 为什么是问题 | 怎么改 | 把握度 |
|---|---|---|---|---|
| `GET /api/steward/submissions`（路由处理） | 未做鉴权直接返回所有提交记录 | 任意未授权用户可获取 `url、text、note、source、status、why、name、state` 等内部信息，导致数据泄露、业务机密泄漏 | 在该 GET 接口前加入同 POST 一样的操作员令牌校验，或仅对拥有特定角色的用户开放；返回前过滤掉敏感字段（如 `note、source、test`） | 高 |
| `subLog`（插入 + 删除） | 插入和删除操作未放在同一事务中 | 并发调用时可能出现 “插入‑删除” 的交叉执行，导致已插入的记录被误删或超过 200 条的旧记录未被清理，出现记录丢失或数据不一致 | 使用 SQLite `BEGIN IMMEDIATE TRANSACTION … COMMIT`（或 `s.q('BEGIN; …; COMMIT;')`）将所有 `INSERT` 与 `DELETE` 包裹在同一个事务里；必要时加锁或使用 `INSERT OR REPLACE` 防止冲突 | 高 |
| `subLog`（旧记录清理） | `DELETE FROM subs WHERE id <= (SELECT id FROM subs ORDER BY id DESC LIMIT 1 OFFSET 200)` 在高并发下可能误删仍在处理的记录 | 当多个请求几乎同时执行该语句时，子查询返回的 “第 201 条记录的 id” 可能已经被其他请求插入的更早记录覆盖，导致已排队但尚未处理的记录被删除 | 改为基于时间戳或状态的清理策略，例如 `DELETE FROM subs WHERE ts < ? AND status!='queued'`，并在事务中执行；或改为单独的后台任务定期清理 | 中 |
| `ctx.waitUntil` 中的错误捕获 | `catch(() => {})` 完全吞掉异常 | 处理失败后没有任何日志或重试机制，运维难以发现问题，导致资源长期卡在 “queued” 状态 | 捕获后记录到日志系统或监控平台（如 `console.error(e)`、`await logError(e)`），并根据需要重试或标记为 `failed` | 中 |
| `SUBMIT_REPLY` | 使用未定义的全局变量 `PRODUCT.name` | 在实际运行时会抛出 `ReferenceError`，导致整个请求返回 500，破坏用户体验 | 将 `PRODUCT` 通过参数传入或改为硬编码/配置项；若不需要动态名称，直接返回固定字符串 | 高 |
| `MAX_MSG`、`urlKey`、`sha`