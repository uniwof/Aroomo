<!-- model=openai/gpt-oss-120b secs=6 usage={'queue_time': 0.176038764, 'prompt_tokens': 2528, 'prompt_time': 0.117949791, 'completion_tokens': 2604, 'completion_time': 5.411261993, 'total_tokens': 5132, 'total_time': 5.529211784, 'completion_tokens_details': {'reasoning_tokens': 1117}} -->
**文件/函数** | **问题** | **为什么是问题** | **怎么改** | **把握度**
---|---|---|---|---
`worker.js → store(env)` | **ALS 上下文未被初始化** | 代码直接调用 `ALS.getStore()`，但在 `fetch`、`scheduled` 等入口处没有使用 `ALS.run()` 包裹请求上下文，导致 `c` 永远为 `undefined`，所有调用都会退回旧的 `stubOf(env)`，失去会话合并的效果。 | 在每个入口（`fetch`、`scheduled`、`event.waitUntil` 包装的异步任务）里使用 `ALS.run(new Map(), () => …)`，并在内部把 `store(env)` 作为唯一的入口函数；确保所有异步分支（包括 `ctx.waitUntil`）都在同一个 ALS 实例中执行。 | 高
`worker.js → store(env) → open()` | **对 `RpcTarget.session()` 的返回值使用 `.catch`** | `st.session()` 返回的是一个普通对象（`RpcTarget` 实例），不是 `Promise`。在其后直接调用 `.catch` 会抛出 `TypeError: … .catch is not a function`，导致会话创建失败并破坏计数逻辑。 | 将 `st.session()` 包装为 `Promise.resolve(st.session())`，或改写为 `const sess = st.session(); p = p || Promise.resolve(sess);`，并把错误捕获放在 `await` 之后的 `try…catch` 中。 | 高
`worker.js → store(env) → open()` | **每次调用 `open()` 都会递增 `RQ.dos`** | `open()` 在每次被调用时执行 `RQ.dos++`，即使已经有缓存的会话 (`p` 已有值) 也会再次计数，导致 “会话次数” 与实际创建的 RPC 会话不匹配，误报额度使用。 | 只在真正创建新会话时递增计数：`if (!p) { RQ.dos++; p = Promise.resolve(st.session()); }`。 | 中
`worker.js → reqFlush(env)` | **`dos` 计数未在成功写入后归零** | `dn = RQ.dos - RQ.dosFlushed` 计算增量后写入 KV，但写成功后只更新 `RQ.dosFlushed`，未把 `RQ.dos` 本身归零或同步到持久化，导致后续 `dn` 计算出现负数或重复计数。 | 写入成功后执行 `RQ.dos = RQ.dosFlushed;`（或 `RQ.dos = 0; RQ.dosFlushed = 0;`），确保增量只计一次。 | 中
`worker.js → usageView(env)` | **返回对象中 `pct` 键出现两次**（在代码片段中实际只有一次，但在后续维护中容易误写） | 若不慎出现重复键，会导致后面的值覆盖前面的值，产生不可预期的统计结果。 | 在返回对象中明确只保留一个 `pct` 字段，或使用不同的命名（如 `overallPct`）。 | 低
`worker.js → scheduled`（以及所有 `ctx.waitUntil` 调用） | **`waitUntil` 中的异步任务失去 ALS 上下文** | `ctx.waitUntil` 在请求结束后执行，若未手动传递 ALS 上下文，这些任务会在没有 `c` 的环境中调用 `store(env)`，导致每个后台任务都重新打开独立 RPC 会话，抵消合并会话的目的并可能超额计费。 | 在 `waitUntil` 包装函数里使用 `ALS.run(ALS.getStore() || new Map(), async () => { … })`，或在 `store(env)` 中检测 `c` 为 `undefined` 时抛出错误并在 `waitUntil` 外部显式创建会话。 | 高
`worker.js → store(env) → c.s` | **并发安全隐患** | 多个并发的异步分支（如 `fetch` 处理函数内部的并行 `Promise.all`）共享同一个 `c.s` 对象，但 `c.s.q` 与 `c.s.batch` 在内部使用同一个 `open()`，若两个分支同时触发 `open()`，可能导致 `p` 被多次赋值，产生竞争条件。 | 将 `open()` 的创建过程加锁（例如使用 `let opening = null; if (!p) opening = opening || (opening = (async () => { … })()); await opening;`），确保同一时刻只有一个会话创建。 | 中
`worker.js → StoreSession` | **未实现 `RpcTarget` 必要的元信息** | `RpcTarget` 在 Cloudflare Workers 中需要 `target`、`method` 等内部属性以便序列化；直接继承而不调用 `super()` 可能导致序列化错误或不可预期的 RPC 行为。 | 在构造函数中调用 `super();`（已做），但还需实现 `toJSON` 或使用 `RpcTarget.from` 官方示例；若不确定，改为直接返回原 `DurableObject` stub 而非自定义包装。 | 低
`worker.js → reqFlush` | **错误后重试逻辑不完整** | 当 `INSERT INTO kv` 失败时，仅把 `RQ.n += n` 加回，但未把 `dos`、`calls` 等计数恢复，导致后续统计不准确。 | 在捕获块中同时恢复 `RQ.dos`、`RQ.calls`（或整体回滚），并记录错误以便监控。 | 中

---

### 最反对的 3 点
1. **ALS 上下文未被正确初始化**——整个“同一请求共用 DO RPC 会话”的核心思路在代码里根本没有生效，导致额度仍然被快速耗尽，且是最根本的逻辑错误。  
2. **`open()` 对非 Promise 对象使用 `.catch` 并且每次调用都递增 `RQ.dos`**——这两点直接导致运行时异常和计数严重失真，既破坏功能也误导监控。  
3. **`ctx.waitUntil` 中失去 ALS 上下文**——后台任务会重新打开独立会话，抵消合并会话的收益，且在高并发的定时任务场景下会产生不可控的额外 DO 调用，极易再次触发免费额度上限。