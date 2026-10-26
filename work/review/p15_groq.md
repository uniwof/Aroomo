<!-- model=openai/gpt-oss-120b secs=6 usage={'queue_time': 0.169287898, 'prompt_tokens': 4674, 'prompt_time': 0.219254887, 'completion_tokens': 2726, 'completion_time': 5.638732296, 'total_tokens': 7400, 'total_time': 5.857987183, 'completion_tokens_details': {'reasoning_tokens': 1485}} -->
**文件/函数** | **问题** | **为什么是问题** | **怎么改** | **把握度**
---|---|---|---|---
`ChatStore.constructor` | **列检查逻辑不完整** | `xc = cols('res_items')` 在第一次 `ALTER TABLE` 之后未重新读取，导致后续 `if (!xc.includes(...))` 永远为 `false`，新列可能不会被创建。 | 在每次 `ALTER TABLE` 之后重新调用 `cols('res_items')`，或改为一次性检查并一次性执行所有 `ALTER`。 | 中
`testModeEnd` | **删除所有 `test=1` 条目** | 只应清除本次测试期间由主负责人代收的条目，若其他功能也使用 `test` 标记会误删。 | 在 `DELETE FROM res_items WHERE test=1` 前加上 `AND via='lead'`（或其他区分标记），确保只删代收的测试数据。 | 中
`/api/steward/submissions` GET 处理 | **未校验访问权限** | 任何持有普通 Cookie 或 Bearer Token 都能读取 `sub_log`，泄露代收日志，违背“只认操作员令牌”要求。 | 在路由入口加入 `if (kind !== 'operator') return json({error:'仅限操作员令牌'},403);` 同时记录审计。 | 高
`/api/steward/submit` POST 处理 | **未校验主负责人身份** | 规格要求“只认主负责人（操作员令牌）”，但代码仅检查 `kind === 'operator'`，副负责人同样能调用。 | 在 `OP`（操作员对象）中加入 `if (!OP.isLead) return json({error:'仅主负责人可用'},403);` 或在 `opDeny` 中区分角色。 | 高
`ingestLink` 调用处 | **函数签名改动导致运行时错误** | `ingestLink` 现在需要四个参数 `(env,s,u,via)`，但项目其余位置仍以旧签名调用，导致 `via` 为 `undefined` 或抛异常。 | 全局搜索 `ingestLink(`，统一补足 `null` 或适当的 `via` 参数；或为向后兼容提供包装函数 `function ingestLinkLegacy(...args){return ingestLink(...args,null);}`。 | 高
`ingestPage` 中对 `page.url` 的处理 | **未对存储的 URL 进行安全过滤** | 规范要求只放行公网 HTTPS，直接写入 `page.url`（可能是 HTTP、内部地址或恶意 URL）会破坏数据安全性。 | 在构造 `item` 前使用 `safeUrl(page.url)`，若返回 `null` 则记录错误并中止入库。 | 中
`submitResource`（未完整展示） | **未将 `note`、`source` 写入 `via_*` 字段** | 规格要求“代收人、用户给的备注/来源”保存到 `via_by`、`via_note`、`via_src`，但当前代码仅解析却未传递。 | 在调用 `ingestLink` / `ingestText` 时构造 `via = {via_by: OP.id, via_note: note, via_src: source, test: testModeOn(s)}` 并传入。 | 中
`submitResource`（未完整展示） | **缺少对 `url`/`text` 必填校验的统一返回** | 只检查 `!url && !text` 返回错误，但未对 `url` 的合法性（如 `safeUrl`）进行校验，可能导致非法 URL 进入流水线。 | 在解析后 `if (url && !safeUrl(url)) return {error:'仅支持公网 HTTPS 链接'};` 同时对 `text` 长度做上限检查。 | 中
`allResources` 返回结构 | **`from` 字段始终返回空字符串** | 当 `via` 不是 `'lead'`，返回空字符串导致前端需要额外判断，且未区分副负责人等其他来源。 | 改为 `from: x.via ? (x.via === 'lead' ? '主负责人代收' : x.via) : ''`，或直接返回原始 `via` 值供前端自行映射。 | 低
`stewardWeekly` 统计逻辑 | **`byLead` 统计未排除已删除的测试条目** | `test=1` 条目在测试结束后已删除，但仍可能残留在 `added` 中导致统计不准确。 | 在 `added` 过滤时加入 `&& x.test !== 1`，或在 `SELECT` 时加 `WHERE test<>1`。 | 低

---

### 最反对的 3 点
1. **未对 `/api/steward/submissions` 读取接口做权限校验**——导致任何用户都能窥视代收日志，严重泄露内部运营信息。  
2. **`/api/steward/submit` 未区分主副负责人**——副负责人可直接使用同一操作员令牌提交资源，违背“仅主负责人代收”规格，可能被滥用。  
3. **`ingestLink` 签名改动未同步全局调用**——必然在运行时抛异常，导致资源管家在正常使用时崩溃，影响系统可用性。