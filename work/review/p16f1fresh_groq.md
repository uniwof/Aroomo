<!-- model=openai/gpt-oss-120b secs=5 usage={'queue_time': 0.118714691, 'prompt_tokens': 948, 'prompt_time': 0.045022465, 'completion_tokens': 2319, 'completion_time': 4.80455915, 'total_tokens': 3267, 'total_time': 4.849581615, 'completion_tokens_details': {'reasoning_tokens': 934}} -->
**代码审查（仅列出真实问题）**

| 文件/函数 | 问题 | 为什么是问题 | 怎么改 | 把握度 |
|----------|------|--------------|--------|--------|
| `store(env)`（ALS 取值分支） | `ctx.waitUntil` 中使用 `store()` 时，ALS 上下文已经失效 | `ctx.waitUntil` 的回调在响应返回后执行，Cloudflare 并不保证 AsyncLocalStorage 的上下文会被保留，导致 `ALS.getStore()` 为 `undefined`，进而走回退路径，每次都会重新打开 RPC 会话，计费会意外增加 | 在 `waitUntil` 回调里显式传递已创建的 `RpcTarget`（如把 `c.s` 作为闭包变量），或在 `waitUntil` 前把会话对象保存到全局/请求对象中再使用；若必须在 `waitUntil` 中使用 `store()`，先 `ALS.enterWith({})` 恢复上下文 | 高 |
| `store(env)`（计数器 `RQ`） | `RQ.dos`、`RQ.calls`、`RQ.n` 等全局计数器在并发请求下会产生竞争条件 | 多个 Worker 实例（或同一实例的并发请求）会同时读写这些变量，导致计数不准确，甚至出现负数/溢出，进而影响阈值判断和监控 | 将计数器封装为 `Atomic`（如 `Atomics` + `SharedArrayBuffer`）或使用 `Map` 按请求 ID 存储；最简方案是改为 `let RQ = { dos: 0, calls: 0, n: 0, last: Date.now() }` 并在每次请求结束后重置，避免跨请求共享 | 中 |
| `store(env)`（错误处理） | `ctx.waitUntil(reqFlush(env).catch(() => {}))` 完全吞掉了 `reqFlush` 的异常 | 隐藏了可能的持久化失败，运维无法感知错误，导致数据不一致或 DO 配额被耗尽却不知情 | 至少记录错误日志：`ctx.waitUntil(reqFlush(env).catch(e => console.error('reqFlush error', e)))`；必要时将错误上报到监控系统 | 中 |
| `open()`（会话创建） | 失败的 `p`（Rejected Promise）会被缓存，后续所有查询都会复用同一个失败的 Promise，导致业务“卡死”而不触发重试 | 代码注释中有意为之（防止重试风暴），但在实际业务中，临时网络抖动导致一次会话创建失败后，整个请求的后续所有 DB 操作都失效，用户体验极差 | 在 `open()` 中区分“已成功打开” 与 “打开失败” 两种状态：成功后缓存 `p`，失败后不缓存并允许后续再次尝试打开；示例：`if (!p || p.rejected) p = (RQ.dos++, st.session()).catch(err => { p = null; throw err; });` | 中 |
| `fetch(req, env, ctx)`（递归调用） | `WORKER._fetch` 可能内部再次调用 `store()`，但 `ALS.run` 的作用域仅覆盖当前同步调用栈，若 `_fetch` 中出现 **微任务**（`Promise.resolve().then(...)`）或 **事件循环切片**，ALS 上下文可能在这些异步回调里丢失 | AsyncLocalStorage 在 Node.js 中会跨 `await`、`then` 传播，但在 Cloudflare Workers（即使开启 `nodejs_als`）对 **并发的子请求**（如 `fetch` 再次触发 `fetch`）的传播并未完全保证，导致子请求走回退路径，产生额外 RPC 会话 | 将 `ALS.run` 包裹的作用域扩大到整个异步链：`return ALS.run({}, async () => { … await WORKER._fetch(...); })`；或者在 `WORKER._fetch` 开头手动 `ALS.enterWith({})` 以确保上下文持续 | 中 |
| `store(env)`（并发安全） | `c.s` 对象在同一次请求的并发查询中被共享，但其内部的 `open()` 只返回一次 `p`（Promise），若多个查询几乎同时进入 `open()`，可能出现 **竞争创建多次会话** 的情况 | `p || (p = …)` 在并发环境下仍是安全的（因为 JavaScript 单线程），但在 **跨 Worker 实例**（如同一请求被分片到不同实例）时会失效，导致同一次请求产生多个会话计费 | 对跨实例的请求使用 **请求 ID** 作为键，放入全局 `Map`，在同一次请求的所有实例间共享同一个会话对象；或在业务层面限制同一请求不跨实例（如使用 `sticky`） | 低 |

---

### 最反对的 3 点（影响最大、最容易导致计费或数据错误）

1. **`ctx.waitUntil` 中失去 ALS 上下文**  
   - 直接导致每次 `waitUntil` 里再次打开 DO RPC，会把本应 1 次计费的操作变成多次，违背项目核心目标。

2. **全局计数器 `RQ.*` 的并发竞争**  
   - 计数不准会触发错误的阈值判断（提前或延迟 `reqFlush`），并且在高并发下可能出现计数溢出，影响监控和限流逻辑。

3. **错误被完全吞掉 (`catch(() => {})`)**  
   - 隐蔽的持久化失败会导致数据丢失或 DO 配额耗尽而不被发现，运维和调试成本极高。

> 以上问题均为 **真实**、**可复现** 的缺陷，未发现其他与“请求结束后 ctx.waitUntil 里能否继续用会话、递归 fetch、并发、错误处理”相关的隐藏错误。