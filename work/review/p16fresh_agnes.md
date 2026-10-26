<!-- model=agnes-3.0-flash secs=22 usage={'completion_tokens': 2804, 'prompt_tokens': 2282, 'total_tokens': 5086} -->
**文件/函数**: `/api/start` (Worker)
**问题**: `cid` 幂等锁释放逻辑存在竞态窗口，导致“失败释放”与“成功写入”之间可能丢失消息或重复执行。
**为什么是问题**:
1. 当 `startRound` 抛出异常时，代码执行 `await kvDel(s, 'cid:' + cid)`。
2. 当 `startRound` 返回 `r.error` 时，代码也执行 `await kvDel(s, 'cid:' + cid)`。
3. 关键在于：如果 `startRound` 内部已经部分完成了业务逻辑（例如已经向房间发送了消息，但后续步骤失败导致返回 `r.error` 或抛出异常），此时删除 `cid` 锁意味着客户端可以重新发送。如果底层操作不具备幂等性（通常 `startRound` 涉及创建房间或插入数据，未必完全幂等），重试会导致数据重复。
4. 更严重的是，如果 `startRound` 成功创建了房间并发送了消息，但 `kvSet` 更新状态时 `s.q` 抛出异常（数据库故障），代码会进入 `catch` 块并 `kvDel`，导致锁被释放，但消息实际已发出。客户端重试会再次调用 `startRound`，造成重复发信/重复创建。
5. 另外，`if (r.error) await kvDel...` 这里的 `r.error` 表示业务逻辑失败（4xx），如果 `startRound` 内部没有实现真正的幂等键检查，仅仅靠 `cid` 锁来防止并发是不够的，一旦锁被删，重试就是全量重放。

**怎么改**:
1. `startRound` 内部必须基于 `cid` 做幂等判断：在开始核心逻辑前，先查询该 `cid` 是否已存在“done”状态的结果。如果存在，直接返回缓存结果，不再执行副作用操作。
2. 只有在 `startRound` 内部确认**未产生任何副作用**（即纯校验失败，如参数错误）时才允许删除 `cid` 锁。
3. 如果 `startRound` 已产生副作用（即使后续失败），**不要**删除 `cid` 锁，而是将其状态标记为 `failed` 或 `partial`，并保留记录。让前端根据状态决定是丢弃还是查询最终状态，而不是盲目重试。
4. 建议：将 `cid` 的生命周期管理与 `startRound` 的事务绑定。如果是部分失败，保留锁并记录状态；如果是纯前置校验失败，删除锁。

**把握度**: 高

---

**文件/函数**: `flushOutbox` (Frontend)
**问题**: 发送失败后的状态处理逻辑错误，导致消息丢失或无限重试循环。
**为什么是问题**:
1. 在 `catch(e)` 块中，如果 `e.net` 为真（网络错误），执行 `break` 并 `OB.del(x.cid)`。
   - **错误1**: 网络错误时删除了本地 Outbox 记录！这直接违反了“消息不丢”的要求。用户断网时，消息应该保留在 Outbox 中等待恢复后重试，而不是删除。
   - **错误2**: 注释说“恢复后自动补发”，但代码在断网时删除了消息，恢复后无货可补。
2. 如果 `e` 不是网络错误（如 4xx 业务错误），也执行 `await OB.del(x.cid)`。
   - 如果服务端返回 400（格式错误）或 401（未授权），前端删除消息是合理的（因为重试也不会成功，除非用户修改内容）。但如果是临时性 5xx 错误，前端也删除消息，同样导致消息丢失。
   - 前端代码未区分“永久性错误”和“临时性错误”。对于 5xx 或网络错误，应保留消息并稍后重试；对于 4xx（非 401/403），可删除或标记为 failed。

**怎么改**:
1. 捕获异常后，判断错误类型：
   - 如果是网络错误 (`e.net` 或 `e.type === 'network'`)：**不删除** `x.cid`，保留在 Outbox 中，`break` 停止本轮刷新，等待下次定时器。
   - 如果是 4xx 且非 429/401/403（如参数错误）：删除消息，提示用户。
   - 如果是 5xx 或 429：保留消息，`break` 或 `continue`（建议 `break` 避免过载），等待重试。
2. 修改 `catch` 块逻辑，严禁在断网时 `OB.del`。

**把握度**: 高

---

**文件/函数**: `reqFlush` / `WORKER` (Worker)
**问题**: `RQ.last` 初始化为 0，导致首次请求时 `Date.now() - 0 > 60000` 恒为真，频繁触发 flush。
**为什么是问题**:
1. `const RQ = { n: 0, last: 0 };`
2. 第一次请求进来，`RQ.n` 变为 1。
3. 检查 `RQ.n >= 25` (假) OR `Date.now() - RQ.last > 60000`。
4. `Date.now()` 大约是 1.7e12，`1.7e12 - 0` 远大于 60000。条件为真。
5. 因此，**每一台新启动的 Worker 实例的第一次请求都会立即触发一次 `reqFlush`**，即使只累积了 1 个请求。
6. 这导致大量不必要的 DO 调用，浪费资源，且可能在冷启动瞬间产生突发的 DO 负载。
7. 此外，`RQ.last` 在 flush 成功后被更新为 `Date.now()`。但如果 flush 失败（`catch(() => {})` 吞掉了错误），`RQ.n` 已经被清零（在 `reqFlush` 内部 `RQ.n = 0`），而 `RQ.last` 已更新。这意味着即使 flush 失败，计数器也重置了，下一次请求不会立即触发 flush（因为 `n` 从 0 开始累加，且 `last` 刚更新）。这会导致统计偏差：失败的 flush 丢失了数据，且不会立即重试，要等到再次累积 25 个或 60 秒后才重试。虽然这是“约值”设计，但丢失数据的机制不够健壮。

**怎么改**:
1. 将 `RQ.last` 初始化为 `Date.now()`。
2. 在 `reqFlush` 中，仅在成功写入 DO 后才更新 `RQ.last` 和清零 `RQ.n`。如果失败，保留 `RQ.n` 以便下次重试，或者将 `RQ.n` 保留但标记为“脏数据”，下次成功时一并写入。最简单的修正：
   ```javascript
   async function reqFlush(env) {
     const n = RQ.n; 
     if (!n) return;
     // 先尝试写入，成功后再重置状态
     try {
       const s = store(env); 
       const day = utcDay(); 
       const k = 'reqs:' + day;
       const r = await s.q('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=CAST(kv.v AS INTEGER)+? RETURNING v', k, String(n), n);
       // ... 后续逻辑 ...
       RQ.n = 0; // 成功后重置
       RQ.last = Date.now();
     } catch (e) {
       // 失败时不清零 RQ.n，保留待下次重试
       // 可选：记录日志
     }
   }
   ```
   注意：原代码在调用 `reqFlush` 前就修改了 `RQ.n` 吗？不，原代码是 `const n = RQ.n; if (!n) return; RQ.n = 0;` 这是在 `reqFlush` 内部立刻清零。如果 `s.q` 失败，数据就丢了。必须改为“写成功后再清零”。

**把握度**: 高

---

**文件/函数**: `usageView` (Worker)
**问题**: `kvGet` 实现细节不明，若 `kvGet` 是异步且未正确等待，或 `store(env)` 在非 `/api/usage` 路径下不可用，可能导致错误。但更主要的问题是：`usageView` 中直接调用 `kvGet(store(env), ...)`，而 `store(env)` 可能在某些上下文中未初始化或返回错误。
**为什么是问题**:
1. 代码片段中 `store(env)` 未定义。假设它是获取 DO 连接的辅助函数。
2. 在 `usageView` 中，如果 `kvGet` 失败，没有 catch 处理，会导致 `/api/usage` 返回 500。
3. 另外，`reqs:` 键的值在 `reqFlush` 中是用 `String(n)` 写入的，但在 `INSERT ... VALUES(?, ?)` 中，第二个参数是 `String(n)`，第三个参数是 `n` (number)。
   - SQL: `INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=CAST(kv.v AS INTEGER)+?`
   - 参数绑定: `k`, `String(n)`, `n`.
   - 这里 `kv.v` 被定义为 TEXT? 还是 INTEGER? 如果 `kv.v` 是 TEXT，`CAST(kv.v AS INTEGER)` 是有效的。但 `INSERT` 时写入 `String(n)`，下次 `ON CONFLICT` 时读取 `kv.v` 是 Text，再 CAST。这没问题。
   - 但是，`usageView` 中 `kvGet` 返回的值是 String，`Number(...)` 转换是安全的。
   - 真正的问题是：`usageView` 没有处理 `kvGet` 可能的异常。

**怎么改**:
1. 在 `usageView` 中添加 try-catch，如果获取失败，返回默认的 `requests: 0` 或抛出明确错误。
2. 确认 `kvGet` 的实现是否原子。

**把握度**: 中

---

**文件/函数**: `ob` (Frontend - IndexedDB)
**问题**: `OB.put` 和 `OB.del` 在 IndexedDB 模式下依赖 `this.db()`，但如果 `this.db()` 返回 `null`（降级模式），则走 `localStorage`。然而，`OB.del` 在 IndexedDB 模式下执行 `st.delete(cid)`，但在 `catch` 块中如果 IndexedDB 事务失败，数据可能不一致。
**为什么是问题**:
1. 更严重的是：`newCid` 使用 `crypto.randomUUID` 或 `getRandomValues`。`crypto` 在 `http://` 非安全上下文中可能不可用（`getRandomValues` 可用，`randomUUID` 可能不可用）。代码有 fallback，这是好的。
2. 但在 `flushOutbox` 中，`OB.del(x.cid)` 在发送成功后立即删除。如果 `api` 返回成功，但本地 `OB.del` 失败（IndexedDB 错误），消息会在下次刷新时再次发送，导致重复。虽然服务端有 `cid` 幂等，可以防止重复执行，但前端会看到 `dup: true` 并提示“已补发”，用户体验尚可，但逻辑上是不干净的。
3. 最关键的还是之前提到的 `e.net` 时 `OB.del` 的问题。

**怎么改**:
1. 见前文“消息丢失”问题。
2. 确保 `OB.del` 失败时不静默忽略，或增加重试机制。

**把握度**: 高

---

**最反对的 3 点**:

1.  **前端 `flushOutbox` 在断网时删除 Outbox 消息 (`OB.del(x.cid)`)，直接导致“消息丢失”，严重违反核心需求。**
2.  **Worker `reqFlush` 在请求计数器 `RQ.n` 清零后才执行异步写入，若写入失败数据永久丢失，且冷启动时因 `RQ.last=0` 导致频繁不必要的 DO 调用。**
3.  **`/api/start` 中 `cid` 幂等锁在 `startRound` 失败（包括部分成功）时无条件删除，若底层操作非幂等，重试会导致数据重复或状态不一致。**