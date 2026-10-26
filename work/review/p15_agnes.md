<!-- model=agnes-3.0-flash secs=20 usage={'completion_tokens': 2458, 'prompt_tokens': 4786, 'total_tokens': 7244} -->
**代码审查报告：P1-5 主负责人代收资源**

### 问题 1：`testmode` 结束时的数据清理逻辑存在严重边界缺陷
*   **文件/函数**：`worker.js` -> `testModeEnd`
*   **问题**：代码新增 `await s.q('DELETE FROM res_items WHERE test=1');`。然而，在 `ingestPage` 中，`test` 字段仅在 `via` 对象存在且 `V.test` 为真时才设为 1（`V.test ? 1 : 0`）。这意味着只有通过“主负责人代收”接口（`submitResource`）且明确标记了 `test` 的条目才会被删除。
*   **为什么是问题**：
    1.  **数据残留**：如果测试模式期间，主负责人通过代收接口提交了资源，但没有在 `via` 对象里显式传 `test: true`（看 `submitResource` 的实现，`via` 是从 `body` 构造的，需确认 `submitResource` 是否根据 `testModeOn` 自动注入 `test` 标志。如果没注入，这些条目 `test=0`，`DELETE ... WHERE test=1` 无法清理它们，导致测试数据永久污染生产库）。
    2.  **`sub_busy` 清理逻辑风险**：`for (const r of await s.q("SELECT k FROM kv WHERE k LIKE 'sub_busy:%'")) await kvDel(s, r.k);`。`kv` 是 DO 内 SQLite 表。如果 `kv` 表没有针对 `k LIKE 'sub_busy:%'` 的索引，随着条目增加，全表扫描可能变慢；更严重的是，如果 `kv` 表里还有其他以 `sub_busy:` 开头的非测试相关键，会被误删。
*   **怎么改**：
    1.  在 `submitResource` 中，如果 `testModeOn(s)` 为 true，必须在构造 `via` 对象时强制添加 `test: true` 标记，或者在 `ingestPage` 调用前检查测试模式并设置标志。确保测试期间所有入库条目都打标。
    2.  考虑更严格的清理机制，例如给 `res_items` 增加 `created_at` 过滤，或在 `testmode` 开始/结束时记录快照 ID，而不是依赖可能缺失的 `test` 标记。
*   **把握度**：高

### 问题 2：`ingestText` 中的正则表达式匹配链接存在安全风险和逻辑漏洞
*   **文件/函数**：`worker.js` -> `ingestText`
*   **问题**：`const links = [...new Set((t.match(/https?:\/\/[^\s<>"'，。）)】]+/g) || []).map((u) => safeUrl(u.replace(/^http:/, 'https:'))).filter(Boolean))].slice(0, 3);`
*   **为什么是问题**：
    1.  **`safeUrl` 与 `http://` 替换的冲突**：`safeUrl` 文档称“只放行公网 https”。如果 `safeUrl` 内部拒绝 `http://`，那么先 `.replace(/^http:/, 'https:')` 再传给 `safeUrl` 是多余的，但如果替换失败或 `safeUrl` 行为不一致，可能导致非预期行为。更重要的是，如果原始 URL 是 `http://`，`safeUrl` 可能直接返回 `null` 或抛出异常，而这里先强行改成 `https://`，改变了用户提供的原始链接语义。虽然规格说“只放行公网 https”，但直接修改用户输入而不保留原始记录（`src_url`）可能会导致后续核实阶段使用的 URL 与用户提交的不一致。
    2.  **正则表达式注入/绕过风险**：`[^\s<>"'，。）)】]+` 这个字符集排除了中文标点，但没有排除其他可能的终止符，如 `&` 或 `?`（虽然 `?` 在 URL 中合法，但某些场景下可能是查询参数的一部分）。如果文本中包含 `https://example.com/?a=1&b=2`，正则可能会正确匹配，但如果包含 `https://example.com/path" onclick="..."`，虽然排除了 `"`，但其他场景可能截断错误。更严重的是，`safeUrl` 是否处理了所有危险字符？如果 `safeUrl` 只是检查协议和域名，这里的预处理可能引入未净化的字符。
    3.  **逻辑漏洞**：`ingestText` 调用 `ingestPage` 时传入 `url: ''` 和 `page.url` 为 `''`。在 `ingestPage` 中，`item.url` 被设为 `page.url || (page.links || [])[0] || ''`。如果 `links` 为空（即文本中没有提取到有效链接），`item.url` 将是空字符串。这会导致 `res_items` 表中的 `url` 为空，而规格要求“走资源管家同一流水线：去重、抓正文、分类、到官方页逐字核实”。如果 `url` 为空，后续的 `verifyTiered` 或官方页核实逻辑可能无法正常工作，或者会因为 URL 为空而直接失败，但 `vstate` 可能仍被标记为某种状态，造成数据不一致。
*   **怎么改**：
    1.  在 `ingestText` 中，如果提取不到任何有效链接，应该返回错误，因为规格要求“官方页逐字核实”，没有 URL 无法核实。或者明确说明“纯文本条目”的核实策略是什么。
    2.  不要强行将 `http:` 替换为 `https:`，而是让 `safeUrl` 处理，并在 `ingestPage` 中使用 `src_url` 记录原始输入，`url` 记录验证后的安全 URL。
    3.  检查 `safeUrl` 的实现，确保它能处理从正则中提取的所有字符。
*   **把握度**：中（取决于 `safeUrl` 的具体实现和 `verifyTiered` 对空 URL 的处理）

### 问题 3：`submitResource` 接口缺乏对“副负责人待命时只读，接班后可用”的显式校验
*   **文件/函数**：`worker.js` -> `WORKER` -> `POST /api/steward/submit`
*   **问题**：代码中 `if (kind !== 'operator') return ...` 仅校验了请求者是操作员。规格要求“只有「主负责人」用操作员令牌可调（副负责人待命时只读，接班后可用）”。这意味着，即使是操作员令牌，如果是副负责人在“待命”状态下调用，也应该被拒绝（或只允许读取？规格说“待命时只读”，但这是 POST 写入接口，所以应该拒绝）。
*   **为什么是问题**：当前代码没有检查操作员对应的主/副负责人身份及其当前状态（是否处于“待命”）。任何持有效操作员令牌的人（包括副负责人）都可以调用此接口进行写入，违反了“副负责人待命时只读”的规格。如果副负责人在待命时提交了资源，这些资源会被标记为 `via='lead'`，但提交者实际上是副负责人，这会导致来源记录错误，也可能干扰主负责人的决策。
*   **怎么改**：
    1.  在 `submitResource` 中，根据 `OP`（操作员信息）查询 `lead_cfg` 或相关表，确定当前操作员是主负责人还是副负责人。
    2.  如果是副负责人，检查其状态是否为“待命”。如果是，返回 403 错误，提示“副负责人待命时无法提交资源，请等待接班或联系主负责人”。
    3.  只有主负责人或已接班的副负责人才能调用此接口。
*   **把握度**：高

### 问题 4：`sub_log` 的并发写入和数据一致性问题
*   **文件/函数**：`worker.js` -> `subLog` / `subMark`
*   **问题**：`subLog` 和 `subMark` 都执行 `const L = (await kvGet(s, 'sub_log')) || []; ... await kvSet(s, 'sub_log', ...)`。这是典型的“读-改-写”操作，在异步环境中没有原子性保护。
*   **为什么是问题**：如果两个请求同时调用 `subLog` 或 `subMark`，它们可能同时读取到相同的 `L`，然后各自修改后写回，导致其中一个请求的更新被覆盖（丢失更新）。虽然 `sub_log` 只是审计日志，但如果丢失了某些操作记录，会影响审计完整性。
*   **怎么改**：
    1.  将 `sub_log` 存储从 KV 键值对改为 SQLite 表（如 `submissions_log`），使用 `INSERT` 语句，SQLite 本身提供事务隔离，避免并发写入冲突。
    2.  如果必须使用 KV，可以使用 `kvGet` 获取当前值，然后使用 `kvSet` 的 CAS（Compare-And-SwAp）语义（如果 Cloudflare Durable Objects 支持）或加分布式锁，但 DO 内部操作同一实例是串行的，问题在于多个 DO 实例或同一实例内的并发微任务。由于是同一个 Durable Object 实例（ChatStore），操作是串行的，但 `await` 点会导致交错。例如，`subLog` 在 `await kvGet` 后挂起，另一个请求开始并也 `await kvGet`，然后第一个请求恢复并 `kvSet`，第二个请求也 `kvSet`，覆盖第一个的更新。因此，必须使用 SQLite 表或确保单线程执行中的原子操作。
*   **把握度**：中（取决于 DO 的事件循环和并发模型，但读-改-写模式在异步环境中确实存在风险）

### 最反对的 3 点

1.  **测试数据清理机制不可靠**：`testmode` 结束时的 `DELETE FROM res_items WHERE test=1` 依赖于所有测试条目都正确标记了 `test=1`。如果 `submitResource` 没有在所有调用路径中正确注入 `test` 标志，测试数据将永久污染生产库。这是一个严重的运维风险。
2.  **权限校验不完整**：`POST /api/steward/submit` 仅校验了操作员身份，但未区分主/副负责人及其状态（待命/接班）。这直接违反了“副负责人待命时只读”的规格，允许副负责人在待命时写入数据，导致数据来源混乱和权限滥用。
3.  **`ingestText` 对无链接文本的处理逻辑存在缺陷**：当提取不到有效链接时，`item.url` 为空，但代码仍尝试执行“官方页逐字核实”流程。这可能导致核实失败或状态不一致。此外，正则表达式提取链接并强行将 `http` 改为 `https` 的做法，可能扭曲原始用户输入，且未充分考虑 `safeUrl` 的具体实现和安全性。