<!-- model=agnes-3.0-flash secs=39 usage={'completion_tokens': 3382, 'prompt_tokens': 2356, 'total_tokens': 5738} -->
# 代码审查：主负责人代收资源功能

## 发现的真问题

### 1. `subClaim` 的“原子占位”存在竞态漏洞（把握度：高）

**文件/函数：** `subClaim(s, id, now)`

**问题：**
使用 `INSERT ... ON CONFLICT DO UPDATE SET v=excluded.v WHERE CAST(kv.v AS INTEGER) < ? RETURNING k` 作为并发互斥锁。这个逻辑是：只有当 `kv.v`（上次时间戳）小于 `now - SUB_BUSY_MS` 时才更新并返回行。但 `RETURNING k` 在 SQLite 中，如果 `ON CONFLICT DO UPDATE` 的 `WHERE` 条件不满足（即没有真正更新），是否还返回行？

- SQLite 文档：`ON CONFLICT DO UPDATE` 若 `WHERE` 不满足，则**不执行更新**，此时 `RETURNING` **不返回任何行**。
- 所以表面看逻辑正确：若 `kv` 表中已有 `sub_busy:<id>` 且其值 >= `now - SUB_BUSY_MS`，则 `UPDATE ... WHERE` 失败，`RETURNING` 为空，`length === 0`，返回 `false`。

**但真正的漏洞在于：`kv` 表初始没有该行时，`ON CONFLICT` 根本不会触发，走的是 `INSERT` 分支，`RETURNING` 返回新插入的行，`length === 1`，返回 `true`。这没问题。**

**真正的并发问题：** 两个几乎同时到达的请求 A、B，`kv` 表中无 `sub_busy:<id>`。SQLite 在 Durable Object 中是串行的（DO 内 `s.q()` 是 RPC 到 DO，DO 内执行是串行的）。所以**在 DO 内部**，两个 RPC 不会真正并发执行 DML。但 `submitResource` 中先 `SELECT` 再 `subClaim` 再 `INSERT INTO subs`，这些是**多次独立 RPC**。两个并发的 `submitResource` 调用可能对同一个 `j.id` 都通过 `subClaim`（因为第一个 `subClaim` 刚插入 `kv` 行，第二个 RPC 到达时 `kv` 行已存在且时间戳很近，`WHERE CAST(kv.v AS INTEGER) < ?` 不满足，返回 `false`）。

等等——重新梳理：RPC 是串行的，所以 A 的 `subClaim` 完成前，B 的 `subClaim` 不会开始。A 插入 `kv` 成功，B 的 `subClaim` 看到 `kv` 已有行，`WHERE` 条件 `CAST(kv.v AS INTEGER) < now - 10min` 不满足（因为刚插入），返回 `false`。**所以 DO 串行性保证了互斥。**

**那问题出在哪？** 出在 **`subClaim` 成功但后续 `subLog` / `ingest` 失败或超时**的情况。`ctx.waitUntil` 中 `subMark` 和 `kvDel` 是 fire-and-forget。如果 DO 在 `waitUntil` 完成前被冻结（Worker 超时 30s 等），`kvDel` 没执行，`sub_busy:<id>` 残留 10 分钟。期间该资源即使入库了，用户再投会被误报“正在处理中”。这是**可用性问题**，不是安全漏洞，但值得标注。

**更严重的问题：** `subClaim` 用 `String(now)` 存入 `kv.v`，但 `kv` 表 `v` 列类型未知。若 `kv` 表 `v` 是 `TEXT`，`CAST(kv.v AS INTEGER)` 对 `"1719999999"` 能正确转 int。但如果 `kv` 表被其他用途写入非数字值，`CAST` 返回 0，`0 < now - 10min` 为真，会意外覆盖。**需确认 `kv` 表 schema 中 `v` 列是否允许非数字写入。** 把握度：中。

**怎么改：**
- 在 `kv` 表层面加约束或专用 key 前缀隔离，避免 `CAST` 误判。
- 或在 `kvDel` 失败时增加 TTL 重试/定期清理。
- 确认 `kv` 表 `v` 列是否可能为 null 或非数字。

---

### 2. `subLog` 中 `r.id` 来自 `sha(urlKey(u))` 或 `sha(normTxt(text))`，但 `res_items` 表的主键是整数 `id`，而 `subs.rid` 存的是 SHA 字符串（把握度：高）

**文件/函数：** `submitResource` → `jobs` 构建 → `subLog` → `SELECT ... WHERE id=?`

**问题：**
```js
const ex = (await s.q("SELECT id,name,vstate,expires FROM res_items WHERE id=? AND COALESCE(vstate,'')<>'候选'", j.id))[0];
```
`j.id` 是 `'u-' + await sha(...)` 或 `'t-' + await sha(...)`，是一个字符串（如 `"u-3f2a..."`）。但 `res_items.id` 是 `INTEGER PRIMARY KEY`（从 `subLog` 的 `INSERT INTO subs` 看，`rid TEXT` 存这个字符串）。**`WHERE id=?` 用字符串去匹配整数主键，SQLite 会做隐式类型转换，但 `"u-3f2a"` 无法转为整数，结果为 0 行。** 也就是说，**去重检查永远找不到已存在的条目，去重形同虚设。**

除非 `res_items` 表有一个 `rid TEXT` 列而非整数 `id`。但代码中 `SELECT id,name,vstate,expires FROM res_items WHERE id=?` 明确用 `id`。**如果 `res_items` 的主键确实是整数，那 `j.id`（SHA 字符串）根本匹配不上。**

**为什么是问题：** 去重是核心需求。若 `res_items` 没有用 SHA 字符串作为查找键，则重复提交同一资源会反复进入队列、反复抓取、反复入库，造成重复数据和资源浪费。

**怎么改：**
- 确认 `res_items` 表是否有 `rid TEXT` 或类似的哈希列用于去重。
- 若 `res_items.id` 是整数主键，应改为 `WHERE rid=?` 或 `WHERE hash=?`，并确保 `res_items` 表有对应的哈希列。
- 若 `res_items` 确实用整数 `id`，那 `jobs` 的 `id` 生成逻辑就错了，需要改为用 `res_items.id` 或一个统一的外键。

**把握度：高**（这是逻辑正确性问题，取决于 `res_items` 的实际 schema，但从代码片段看极可能不匹配）。

---

### 3. `subLog` 的批量 INSERT + 截断 DELETE 不是原子的（把握度：中）

**文件/函数：** `subLog`

**问题：**
```js
for (const r of rows) await s.q('INSERT INTO subs(...) VALUES(...)');
await s.q('DELETE FROM subs WHERE id <= (SELECT id FROM subs ORDER BY id DESC LIMIT 1 OFFSET 200)');
```
逐行 INSERT 之间，另一个并发 RPC（如 `subMark` 或另一个 `submitResource`）可能插入或修改 `subs` 表。最后的 `DELETE` 按“最新 200 条”截断，如果并发导致顺序错乱，可能删掉刚插入的合法记录，或保留不该保留的。

虽然 DO 内 RPC 串行，但 `submitResource` 的 `subLog` 和 `ingestPage` 中的操作是**多次独立 RPC**，期间其他请求可以插入 `subs`。`DELETE ... WHERE id <= (SELECT ... OFFSET 200)` 假设“最新 200 条”是安全的，但如果并发插入多行，`OFFSET 200` 的基准会漂移。

**怎么改：** 将 `subLog` 改为单条 SQL 批量插入（`INSERT INTO subs VALUES (...),(...),...`）+ 独立的事务或 `BEGIN IMMEDIATE ... COMMIT` 包裹 INSERT + DELETE，保证原子性。

---

### 4. `ingestText` 中的 `safeUrl` 对 `http:` 替换不完整（把握度：低）

**文件/函数：** `ingestText`

**问题：**
```js
t.match(/https?:\/\/[^\s<>"'，。）)】]+/g)
```
匹配到 `http://` 开头后：
```js
map((u) => safeUrl(u.replace(/^http:/, 'https:')))
```
`u.replace(/^http:/, 'https:')` 只替换第一个匹配（`^` 锚定开头），且只替换字符串开头的 `http:`。如果 URL 中间还有 `http://` 子串（虽然 regex 已经保证匹配从 `http` 或 `https` 开头，所以只替换开头一次是够的）。但 `String.prototype.replace` 默认只替换第一个匹配，而 regex 没有 `g` 标志（此处 `u` 是单个 URL 字符串，开头只有一个 `http:`，所以没问题）。

**真正的轻微问题：** `safeUrl(u.replace(/^http:/, 'https:'))` 中，如果 `u` 是 `https://` 开头，`replace` 不匹配（`^http:` 不匹配 `https:`），`safeUrl` 直接接收原始 URL，正常。如果 `u` 是 `http://`，替换为 `https://`，正常。看起来没问题。但 `submitResource` 中写的是 `r.replace(/^http:/i, 'https:')`（有 `i` 标志，匹配 `HTTP:` / `Http:` 等），而 `ingestText` 中没有 `i` 标志。**不一致，但实际影响极小，因为 regex 匹配阶段已经大小写敏感地匹配了 `http://` 和 `https://`。**

**把握度：低**，不算真 bug。

---

### 5. `subMark` 的 `state` 字段与 `res_items` 的 `vstate` 语义不一致（把握度：中）

**文件/函数：** `subMark`

**问题：**
```js
await s.q("UPDATE subs SET status=?, why=?, name=?, state=? WHERE rid=? AND status='queued'", p.status, p.why || '', p.name || '', p.state || '', id);
```
`subs.state` 被设为 `r.state`，而 `r` 来自 `ingestLink` / `ingestText` → `ingestPage`。`ingestPage` 返回的 `r.state` 是什么？代码未展示，但 `res_items` 用 `vstate`（已核实/候选/...），而 `subs` 用 `state`。如果 `r.state` 是 `res_items` 的 `vstate` 值（如 `'已核实'`、`'候选'`），那语义一致。但如果 `ingestPage` 返回的 `state` 是另一种枚举（如 `'ok'`、`'failed'`），则 `subs.state` 存的是不透明的值，前端 `GET /api/steward/submissions` 展示时可能无法正确判断“是否已核实”。

**要求明确说“未核实不显示已核实”。** 如果 `subs.state` 直接来自 `ingestPage` 的返回值，而 `ingestPage` 在某些路径下可能返回 `vstate='候选'` 的条目但 `state` 字段为 `''`，前端可能误判。需确认 `ingestPage` 返回的 `state` 字段语义是否与 `vstate` 完全一致。

**怎么改：** 明确 `subMark` 中的 `p.state` 应直接映射 `res_items.vstate`，并在 `GET /api/steward/submissions` 中对 `state` 做白名单校验（只接受 `'已核实'` / `'候选'` 等合法值），防止 `ingestPage` 异常路径写入脏数据。

---

### 6. `GET /api/steward/submissions` 无鉴权过滤（把握度：中）

**文件/函数：** `if (path === '/api/steward/submissions' && req.method === 'GET')`

**问题：**
```js
return json({ items: (await s.q('SELECT ... FROM subs ORDER BY id DESC LIMIT 60')) });
```
此接口返回所有 `subs` 记录（含 `who`、`url`、`text`、`note`、`source`）。如果该路径**没有**操作员令牌鉴权（代码片段未展示鉴权逻辑），则**任何已认证用户（甚至匿名）都能查看所有主负责人的代收记录**，包括文本内容、URL、备注。这是**数据泄露**。

代码注释说“副负责人非 GET 一律 403”，但 GET 是否放行？如果 GET 对副负责人也放行，则副负责人能看到主负责人的全部代收记录（含敏感文本）。

**怎么改：** 在 `GET /api/steward/submissions` 处增加令牌校验，至少要求操作员令牌（`OP` 存在且为主负责人），或按 `who` 字段过滤只返回自己的记录。

---

### 7. `opLog` 中 `source` 直接拼接进日志字符串（把握度：低）

**文件/函数：** `submitResource` → `opLog`

**问题：**
```js
`代收资源：排队 ${queued.length} 条，重复 ${duplicates.length} 条` + (source ? `（来源：${source}）` : '')
```
`source` 是用户输入（`str(body.source, 80)`），直接拼入日志字符串。如果后续日志被展示到管理界面或导出，可能存在**日志注入**（如 source 含 HTML 标签或特殊字符）。风险取决于日志的消费端，把握度低。

**怎么改：** 对 `source` 做转义或使用参数化日志。

---

## 最反对的 3 点

1. **`res_items WHERE id=?` 用 SHA 字符串匹配整数主键，去重逻辑很可能完全失效**（问题 2）。这是核心功能的正确性问题，直接违反“去重”需求。若 `res_items` 没有对应的哈希列，整个去重机制形同虚设。

2. **`GET /api/steward/submissions` 疑似无鉴权或鉴权不足，导致主负责人代收数据（含用户提交的文本、URL、备注）对副负责人甚至匿名用户泄露**（问题 6）。违反“令牌鉴权”和“数据不泄露”要求。

3. **`subLog` 逐行 INSERT + 非原子截断 DELETE，并发下可能误删合法记录或产生不一致状态**（问题 3）。加上 `subClaim` 的 `kv` 表 `CAST` 隐式转换风险（问题 1），整个“原子占位 + 记录”链路在并发和异常路径下不可靠。