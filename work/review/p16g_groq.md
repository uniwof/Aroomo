<!-- model=openai/gpt-oss-120b secs=6 usage={'queue_time': 0.221626631, 'prompt_tokens': 2139, 'prompt_time': 0.095505842, 'completion_tokens': 2672, 'completion_time': 5.580799235, 'total_tokens': 4811, 'total_time': 5.676305077, 'completion_tokens_details': {'reasoning_tokens': 1708}} -->
**文件/函数** | **问题** | **为什么是问题** | **怎么改** | **把握度**  
---|---|---|---|---  
worker.js / `reqFlush` | SQL 语句中使用了 `kv.v` 而不是列名 `v` | SQLite 的 `INSERT … ON CONFLICT … DO UPDATE SET` 只能引用表的列名，`kv.v` 会导致语法错误，计数写入失败 | 将 `SET v=CAST(kv.v AS INTEGER)+?` 改为 `SET v=CAST(v AS INTEGER)+?`（或使用别名 `SET v=CAST(EXCLUDED.v AS INTEGER)+?`） | 高  
worker.js / `reqFlush` | 在写入数据库前就把 `RQ.n`、`RQ.last` 归零 | 若 `INSERT` 失败（网络、磁盘、超时等），计数已被清零导致请求数永久丢失 | 仅在 `INSERT/UPDATE` 成功后再执行 `RQ.n = 0; RQ.last = Date.now();`，或者在 `catch` 中恢复计数 | 中  
worker.js / `fetch`（全局请求计数） | `RQ.n` 的自增与 `reqFlush` 的触发不是原子操作，且每个 Worker 实例只维护本地计数 | 多实例并发时会出现计数不一致、低估实际请求量，违背“全局计数”规格 | 使用 Durable Object（或 KV）在每次请求时直接原子递增计数，或在 `fetch` 中 `await ctx.waitUntil(reqFlush(...))` 前先写入 KV 并在 `reqFlush` 只负责批量写入而不清零本地计数 | 高  
worker.js / `usageView`（GET /api/usage） | 该接口未做任何身份验证，任何人都能查询当天的请求使用情况 | 公开内部资源使用数据可能被恶意用户用于攻击或监控，属于信息泄露 | 为该接口添加鉴权（如仅管理员 token、IP 白名单或 Cloudflare Access）或在配置中关闭公开 | 中  
worker.js / `POST /api/start`（cid 幂等） | 对 `cid` 重复写入时返回的 `room`、`lineup` 信息未做脱敏，可能泄露其他用户的房间状态 | 攻击者可通过猜测或枚举 `cid` 获取已存在的房间信息，违反最小权限原则 | 在返回 `dup:true` 时仅返回 `cid` 本身或一个通用 “已存在” 标识，避免返回 `room`、`lineup` 等内部数据 | 低  
worker.js / `reqWarn` | `ensureStewardRoom`、`addMsg` 的异常被空捕获并吞掉 | 警告消息发送失败时不会被记录或上报，导致管理员错失重要提醒 | 将捕获的异常记录日志或重新抛出，至少保留错误信息供运维排查 | 低  
worker.js / `scheduled`（定时任务） | 在同一次调度中先删除旧的 `reqs:`/`reqwarn:` 键后才调用 `reqFlush`，若 `reqFlush` 正好写入同一天的键会被误删或计数丢失 | 删除操作与写入操作的顺序不确定，可能导致当天计数被清除或重复计数 | 将 `reqFlush` 放在删除旧键之前，或在删除时排除当前日期的键（如 `WHERE k LIKE 'reqs:%' AND k != 'reqs:'||?`） | 中  

---

### 最反对的 3 点
1. **全局请求计数不准确**（`fetch` 中的本地计数 + `reqFlush` 非原子）——直接导致规格“用量显示”失效，且在高并发环境下会严重低估使用量。  
2. **SQL 语法错误**（`kv.v`）——计数写入根本失败，整个额度保险功能失效。  
3. **未鉴权的 `/api/usage` 接口**——信息泄露风险明显，任何人都能实时监控 Cloudflare 配额，违背最小暴露原则。