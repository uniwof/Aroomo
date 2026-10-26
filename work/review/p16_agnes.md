<!-- model=agnes-3.0-flash secs=35 usage={'completion_tokens': 4000, 'prompt_tokens': 5207, 'total_tokens': 9207} -->
# P1-6 审查结果（苛刻视角：安全 / 正确性 / 规格符合度）

## 1. `worker.js` — `reqFlush`：计数逻辑有严重竞态与丢失，且“每天只提醒一次”判定是错的

- **文件/函数**：`worker.js` / `reqFlush` + `fetch` 中 `RQ.n++`
- **问题**：
  1. `RQ.n` 是**每 Worker 实例内存变量**。Cloudflare Workers 的实例是**短生命周期、多副本、频繁冷启动**的。注释说“满 25 次或隔 60 秒写一次”，但：
     - 实例在任何一次请求后随时被回收（Worker isolate 生命周期由 CF 决定，通常数秒~数十秒），`ctx.waitUntil(reqFlush...)` 只在**触发条件命中的那次请求**里挂上；其余 24 次累加里的 flush 从未被调度，回收即丢。
     - 多个 isolate 并发各自从 `RQ.n=0` 起算，每个都只 flush 自己那一份；总计数 ≈ Σ(各 isolate 成功 flush 的 n)，**系统性偏低**，但偏低本身不影响“超额提醒”的正确性（80% 只是提醒，不是硬上限），真正的问题是**漏 flush 导致低估**，且 1027 前提醒可能严重滞后或根本不触发。
  2. **并发写同一 `kv` 行**：`INSERT ... ON CONFLICT DO UPDATE SET v=CAST(kv.v AS INTEGER)+?` 在 SQLite 里是原子的（DO 内串行化），这部分 OK。但 `reqFlush` 先取 `const n = RQ.n; RQ.n = 0;` 再发 RPC，若两次 flush 在 `waitUntil` 里并行（虽然当前写法 60s/25 次的门槛使得同实例并发概率低，但**不同 isolate** 同时写同一 key 是常态）——SQLite 串行化没问题，但**提醒判定 `tot - n < WARN && tot >= WARN` 用的是本次自己的 n**，在多 isolate 场景下这个“刚越过”的判定基本不可靠（A 实例 flush 10 条时已越过 80%，B 实例随后 flush 20 条时 `tot-n` 仍可能 > WARN，漏提醒；或反过来重复提醒被 `ON CONFLICT DO NOTHING` 兜住——这点倒是 OK，因为 `reqwarn:` key 每天只插一次）。
  3. **`reqwarn` 的 `ON CONFLICT DO NOTHING RETURNING k`**：SQLite 对 `ON CONFLICT ... DO NOTHING` 的 `RETURNING` 行为是——冲突时**不返回行**（`got.length === 0`）。这里逻辑是“没插进去就跳过”，意图是每天只发一次。但要注意：**这条 INSERT 本身不计入 `reqs:` 计数**（它写的是 `reqwarn:` 前缀 key，不影响 `reqs:` 汇总），OK。
- **为什么是问题**：规格要求“80% 提醒”。当前实现**只能近似做到**，且低估偏差随实例规模增大而增大；在流量高峰（如 1027 即将触发前）恰恰是最需要准确提醒的时候，反而漏计最严重。另外 `RQ.last` 初始为 0，`Date.now() - 0 > 60000` 恒真，**第一个 isolate 的第一次请求就会 flush（此时 n=1）**，之后每 60 秒或每 25 次再 flush——但如前所述，60 秒的计时器在 isolate 回收后**归零**，不是真正的定时器。
- **怎么改**：
  - **最低成本**：接受“近似值”，但把注释和 UI 文案里的“约值”说得更明确（当前 note 已提“约值”，可接受）。
  - **更稳健**：每次请求都 flush（放弃 25/60s 的攒批），代价是每请求多一次 DO RPC，对免费版 10 万次/日意味着 10 万次 `kv` 写——**不可接受**（SQLite DO 写 QPS 限制、成本）。折中：**每次请求写 `kv` 行 `reqs:<day>` 的增量由客户端请求头带不上来（无状态），只能服务端攒批**。当前攒批策略在“实例存活时间 >> 60s”时近似有效；在冷启动密集时严重漏计。
  - **务实建议**：把 80% 提醒改为**由调度器（`scheduled`）每小时读一次 `reqs:<day>` 汇总并判断是否越线**，而不是依赖 `reqFlush` 里的即时判定。这样即使漏计，最多滞后 1 小时提醒，且 `scheduled` 里已经有 `reqFlush` 调用（见下文问题 2），可把提醒逻辑移到 `scheduled` 或专门的 cron 任务。
- **把握度**：高（竞态与低估是确定的；“是否可接受”取决于产品容忍度）。

---

## 2. `worker.js` — `scheduled` 中 `reqFlush` 放在 `cid` 清理之后，且 `cid` 清理 SQL 有类型转换隐患

- **文件/函数**：`worker.js` / `scheduled`
- **问题**：
  1. `DELETE FROM kv WHERE k LIKE 'cid:%' AND CAST(json_extract(v,'$.ts') AS INTEGER) < ?`：`json_extract(v,'$.ts')` 返回 TEXT（因为 `ts` 是 JS 数字被 `JSON.stringify` 序列化为数字，`json_extract` 对 JSON 数字返回 INTEGER 或 REAL，`CAST(... AS INTEGER)` 是安全的）。**但** `v` 列存的是 `JSON.stringify({ts, room, state})`，若 `state` 或 `room` 含特殊字符不影响。真正的问题是：**`cid:` 行的 `v` 可能是初始的 `{ts, room, state:'busy'}` 或最终的 `{ts, room, state:'done', lineup:[...]}`，两种都含 `ts`，OK。** 但若某条 `cid:` 行因异常路径（见问题 5）`v` 不是合法 JSON 或缺 `ts`，`json_extract` 返回 NULL，`CAST(NULL AS INTEGER)` 为 NULL，`NULL < ?` 为 NULL（非 TRUE），**该行不会被删**，泄漏。
  2. `reqFlush(env)` 在 `scheduled` 里被调用，但 `RQ.n` 此时是**调度器所在 isolate 的内存变量**，通常为 0（调度器不在 fetch 路径上，`RQ.n` 从未递增），所以 `reqFlush` 直接 return，**实际没 flush 任何东西**。把 `reqFlush` 放在 `scheduled` 里是**无效代码**。
- **为什么是问题**：`cid:` 行 3 天过期清理依赖 `json_extract`，NULL 泄漏；`scheduled` 里的 `reqFlush` 是死代码，误导维护者。
- **怎么改**：
  - `cid:` 清理改为 `WHERE k LIKE 'cid:%' AND (CAST(json_extract(v,'$.ts') AS INTEGER) IS NULL OR CAST(json_extract(v,'$.ts') AS INTEGER) < ?)`，或更简单：在 `INSERT` 时同时写一个 `cidts:<cid>` 整数时间戳 key，清理时用 `substr` 或单独表。
  - 删除 `scheduled` 里的 `await reqFlush(env);`，或改为**直接读 `reqs:<day>` 做 80% 提醒判定**（见问题 1 建议）。
- **把握度**：高（`RQ.n` 在调度 isolate 为 0 是确定的；NULL 泄漏是确定的）。

---

## 3. `worker.js` — `/api/start` 的 cid 幂等：`dup` 路径不返回 `lineup`，与首次成功响应形状不一致

- **文件/函数**：`worker.js` / `handleHooks` 中 `/api/start` 的 cid 分支
- **问题**：
  - 首次成功：`return json(r)`，`r` 是 `startRound` 的返回值 `{room, lineup, ...}`。
  - 重复（`got.length === 0`）：`return json({ ok:true, dup:true, cid, room, lineup: v.lineup || [] })`。
  - 首次 `startRound` 成功但 `r.error` 为 falsy 时存 `v.lineup = (r.lineup||[]).map(...)`，只存了 `id` 和 `role`。dup 路径返回的 `lineup` 是**裁剪过的**（只有 `id, role`），而首次返回的 `r.lineup` 是完整的 `startRound` 结构。前端 `send()` 里 `if(st.dup){roomData=await api('/api/room/'+room);renderRoom()}` 实际上会**重新拉 room**，所以 `lineup` 不被直接使用，**碰巧没炸**。但规格说“服务端按 cid 幂等，不丢不重”，dup 响应的形状应与首次一致（或文档说明差异）。当前不一致是**潜在 bug**，依赖前端恰好绕开了。
- **为什么是问题**：幂等接口的响应形状不一致违反最小惊讶原则；未来任何消费者直接读 `st.lineup` 会拿到裁剪版 vs 完整版的不一致。
- **怎么改**：dup 时要么返回与首次完全相同的 `{room, lineup, ...}`（从存储里存全量 `r` 而非裁剪版），要么在 JSDoc/README 里明确 dup 响应只有 `{ok,dup,cid,room,lineup(id+role)}`，前端必须重拉 room。
- **把握度**：中（当前前端绕开了，但接口契约不一致是事实）。

---

## 4. `worker.js` — `cid:` 初始 `INSERT` 存 `state:'busy'`，但 `startRound` 抛异常时 `kvDel`，被 `catch` 住后**没有标记**，下次同 cid 重试可以——但**没有超时清理 `busy` 状态**

- **文件/函数**：`worker.js` / `/api/start` cid 分支
- **问题**：
  - 初始 `INSERT ... state:'busy'`。若 `startRound` 正常完成，`kvSet` 为 `state:'done'`。若 `startRound` 抛异常，`kvDel` 删除 cid 行，客户端可重试。
  - **但若 `startRound` 成功后、`kvSet` 前 Worker 被 kill**（OOM、超时），cid 行停留在 `state:'busy'`，**永久占用该 cid**，客户端重试同 cid 会被判为 dup，拿到 `state:'busy'` 的 `v`（`v.lineup` 为 undefined → `lineup: []`），客户端误以为成功但实际 room 可能没写完。
  - `scheduled` 里 3 天清理 `cid:` 行，意味着 `busy` 态最多活 3 天。
- **为什么是问题**：竞态窗口（`startRound` 成功 → `kvSet` 之间）内实例被回收，导致 cid 永久锁死。对“不丢不重”的规格，这是**静默失败**：用户消息实际已写入 room，但 cid 状态不一致。
- **怎么改**：
  - 在 `kvSet` 之前先 `kvSet(s, 'cid:'+cid, {ts, room, state:'done', lineup})` 再执行其他逻辑；或把 `startRound` 和 `kvSet` 合并到**同一个 SQLite 事务**（DO 内），保证原子性。
  - 客户端对 dup 且 `state==='busy'` 的情况，视为“不确定”，应重拉 room 验证而非直接返回。
- **把握度**：中（窗口存在但窄；是否“可接受”取决于 DO 回收频率）。

---

## 5. `worker.js` — `usageView` 直接读 `kvGet` + `RQ.n`，`kvGet` 可能返回 `null`/`undefined`/非数字

- **文件/函数**：`worker.js` / `usageView`
- **问题**：`const v = Number((await kvGet(store(env), 'reqs:'+day)) || 0) + RQ.n;`
  - 若 `kvGet` 返回的 value 是 `String(n)`（`reqFlush` 里写的是 `String(n)` 作为初始值），`Number("5")` OK。
  - 但若 `kv` 行被 `ON CONFLICT DO UPDATE` 后 `v` 是 `CAST(kv.v AS INTEGER)+?` 的结果，是 INTEGER，`Number(5)` OK。
  - **风险**：若 `kvGet` 返回的是 `{k,v}` 对象（取决于 `kvGet` 的实现——diff 里没展示），`Number({k,v})` → `NaN`。从 `reqFlush` 里 `const tot = Number((r[0]||{}).v || 0)` 看，`s.q` 返回的是行数组，`kvGet` 可能返回单行对象或 `null`。**如果 `kvGet` 返回 `{v: "5"}` 或 `{v: 5}`，`Number({v:5})` 是 `NaN`**。
  - 这是**致命 bug**：若 `kvGet` 返回对象而非标量，`v` 为 `NaN`，`pct` 为 `NaN`，前端显示 `NaN%`。
- **为什么是问题**：`kvGet` 的返回类型不确定（diff 未包含其定义），`Number((await kvGet(...)) || 0)` 在返回对象时静默产生 `NaN`。
- **怎么改**：确认 `kvGet` 返回的是 `v` 的值本身还是行对象。若返回行对象，改为 `Number((await kvGet(...) || {}).v || 0)`；若返回标量，当前写法 OK。加防御：`if (Number.isNaN(v)) v = 0;`
- **把握度**：高（若 `kvGet` 返回对象则 100% 是 bug；需看 `kvGet` 源码确认，但写法本身不安全）。

---

## 6. `page.html` — 1027 检测：`/\b1027\b/.test(raw)` 在 `raw` 非 JSON 时才匹配，但 Cloudflare 1027 错误页通常是 HTML

- **文件/函数**：`page.html` / `api` 的 fetch 包装
- **问题**：
  ```js
  if(!r.ok && /\b1027\b/.test(raw) && !/^\s*\{/.test(raw)){
  ```
  条件 `!/^\s*\{/.test(raw)` 意在排除“正常 JSON 响应里恰好含 1027 字样”。但 Cloudflare 1027 错误页是**HTML**（`<html>...Error 1027...`），`raw` 以 `<` 开头，`/^\s*\{/` 不匹配，条件成立。OK。
  **但**：若某次请求恰好返回 `{"error":"rate limit 1027 exceeded"}` 的 JSON（其他来源），`/^\s*\{/` 匹配，**不会触发 1027 横幅**——这是对的（不想误报）。
  **真正的问题**：`String(e&&e.message||e).slice(0,40)` 在 network error 时 `e` 可能是 `TypeError: Failed to fetch`，OK。但 **`er.net=true` 在 1027 时也被设为 true**，导致 `flushOutbox` 里 `if(e.net) break;`——**1027 时 outbox 不会补发**，这是**正确的**（1027 意味着 Worker 都不响应了，补发没意义）。但 outbox 里的 `state` 不会被改为 `'pending'`（因为 `send` 的 catch 里 `if(ob&&e.net){ob.state='pending';...}` 会执行），所以用户看到“待发送”，恢复后 1027 解除时自动补发。**逻辑上自洽，但**：1027 时 `send` 先 `OB.put(ob)` 再 `api` 抛 1027，catch 里改 `state='pending'`，OK。
- **为什么是问题**：当前逻辑自洽，但**没有处理 `!r.ok && r.status===1027` 的情况**——Cloudflare 的 1027 是否一定在 body 里含“1027”字样且是 HTML？若 CF 未来改变错误页格式，检测失效。建议加 `r.status === 1027` 或 `r.headers.get('cf-error-code') === '1027'` 作为主判据。
- **把握度**：中（当前能工作，但脆弱）。

---

## 7. `page.html` — `flushOutbox` 里 `room` 变量未定义

- **文件/函数**：`page.html` / `flushOutbox`
- **问题**：
  ```js
  if(n){if(room&&rooms.has(room)&&!busy){...}}
  ```
  `room` 是全局变量（指当前房间 ID），但 `flushOutbox` 在**非房间上下文**