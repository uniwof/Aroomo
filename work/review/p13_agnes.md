<!-- model=agnes-3.0-flash secs=22 usage={'completion_tokens': 2200, 'prompt_tokens': 6431, 'total_tokens': 8631} -->
审查意见如下

### 1. 文件: worker.js / `getRoom` (line ~756)
**问题**: 在获取项目详情时，调用了 `ideaGet` 并使用了 `r0.idea`。
**为什么是问题**: 这里的逻辑是**同步且直接调用**了一个 async 函数，但没有 `await` 它。虽然在代码 `if (r.idea) { const it = await ideaGet(s, r.idea); ...` 中有 await，但这是 `getRoom` 内部逻辑。然而，`ideaGet` 本身依赖于 `kvGet` 和 SQL 查询。更严重的问题是：`getRoom` 是高频热点路径（每次发消息、拉取房间都调用），每次调用都会去查 `ideas` 表。如果点子表变大，或者 `ideaCtx` 构建耗时，会造成严重的性能下降。另外，如果 `r.idea` 指向的点子被删除了（虽然 DELETE 接口里做了 `UPDATE rooms SET idea=NULL`，但如果事务没提交完或者并发操作），`ideaGet` 返回 `null`，`r.idea` 会变成 `null`，但 `r.ideaCtx` 是 `''`。这在逻辑上是通的，但性能浪费。
**怎么改**: 考虑缓存 `ideaCtx`，或者至少确保 `ideaGet` 只查轻量字段。目前的写法在高频路径上执行两次 DB 查询（一次 `rooms`，一次 `ideas`），可以优化为 JOIN 或仅在需要生成 prompt 时计算 `ideaCtx`。
**把握度**: 中（性能隐患，非直接 bug）

### 2. 文件: worker.js / `runTurn` (line ~892)
**问题**: 背景注入逻辑 `r0.ideaCtx` 直接拼接进 `system` prompt。
**为什么是问题**: 规格要求“关联后点子内容作为项目背景注入**所有**成员上下文”。代码中 `system` 变量确实对每个成员都加了 `r0.ideaCtx`。但是，注意 `dispatchAsync` (Web 模型) 传入了 `background: r0.ideaCtx`。而在 `runTurn` 中，对于**非 Web 模型**（直接调用 LLM API），`system` prompt 里加了背景，但 `user` prompt（转述）里**没有**加背景。通常 Web 模型是通过 `webPrompt` 生成的，其中 `background` 被单独处理。然而，对于普通的 LLM 调用（`callLLM` 等），背景在 `system` 中。这符合规格。
**但是**，有一个严重的逻辑错误：**敏感项目（`sens`）与背景注入的冲突**。规格提到 `operator` 权限较低。如果项目是 `sensitive` 的，通常会对 `operator` 限制访问。但点子背景中可能包含敏感信息。代码中 `runTurn` 并没有检查 `kind`（来源）是否允许看背景。所有来源（包括 `operator`, `bearer`）只要在这个 room 里被调度，都会拿到 `ideaCtx`。如果点子被标记为敏感（虽然点子表没有 sens 字段，但源数据可能敏感），且项目是敏感的，那么 `operator` 可能会通过背景注入看到不该看的内容。
**怎么改**: 在 `runTurn` 中，根据 `kind` 和 `room.sens` 判断是否注入 `ideaCtx`。如果 `sens=1` 且 `kind='operator'`，应屏蔽或脱敏背景。
**把握度**: 高（安全/权限问题）

### 3. 文件: worker.js / `ideaSave` (line ~1125)
**问题**: `ideaSave` 允许任何人（只要通过 `/api/ideas` POST 鉴权）修改点子，包括修改 `notes` 字段（通过覆盖）。
**为什么是问题**: 代码中 `const it = v.idea;`，然后 `INSERT ... ON CONFLICT ... DO UPDATE SET ...`。注意 SQL 语句中 **没有更新 `notes` 列**，而是使用了 `prev.notes`。但是，`validateIdea` 返回的 `o` 对象可能包含从 `prev` 合并来的数据。如果前端发送的 `b` 中没有 `notes`，`o.notes` 会是 `prev.notes`。然而，SQL 的 `ON CONFLICT DO UPDATE` 部分**完全忽略了 `notes` 的更新**，而是写死了 `JSON.stringify(prev ? prev.notes : [])`。这意味着 `notes` 只能通过 `writeback` 接口修改。这是正确的。
**但是**，`ideaSave` 的鉴权逻辑在哪里？代码片段只显示了路由匹配 `if (path === '/api/ideas' && req.method === 'POST')`，**没有看到任何权限检查**（如 `checkAuth` 或 `kind` 校验）。在之前的代码中，通常会有 `if (kind !== 'cookie' && kind !== 'operator') return ...`。这里缺失了鉴权，导致**未授权或低权限用户（bearer）可能修改点子库**。
**怎么改**: 在 `POST /api/ideas` 路由处理前添加权限检查，限制为 `cookie` 或 `operator`（如果操作员允许创建/编辑）。
**把握度**: 高（权限漏洞）

### 4. 文件: worker.js / `DELETE /api/idea/:id` (line ~1546)
**问题**: 删除点子的逻辑：`UPDATE rooms SET idea=NULL WHERE idea=?` 然后 `DELETE FROM ideas WHERE id=?`。
**为什么是问题**: 这两个操作没有包裹在事务中。如果 `UPDATE` 成功但 `DELETE` 失败（或反之），会导致数据不一致：要么房间还指向一个不存在的点子（后续 `getRoom` 时 `ideaGet` 返回 null，虽然代码有处理，但状态脏了），要么点子被删了但房间还指向它（导致孤儿引用）。虽然代码中 `ideaGet` 有 null 检查，但数据完整性受损。
**怎么改**: 使用 `s.transaction()` 包裹这两个 SQL 操作。
**把握度**: 高（数据一致性）

### 5. 文件: p1.js / `ideaContext` (line ~26)
**问题**: `ideaContext` 拼接了 `notes`。`notes` 来自数据库的 `JSON.parse(r.notes)`。
**为什么是问题**: `notes` 的内容（`n.title`, `n.text`）是用户通过 `writeback` 接口写入的。如果 `writeback` 接口没有对输入进行严格的清洗或长度限制，攻击者可以注入恶意内容到 `notes` 中，然后通过 `ideaContext` 注入到所有成员的 Prompt 中（Prompt Injection）。
**怎么改**: 在 `writeback` 接口中对 `text` 和 `title` 进行严格验证和长度限制，并在 `ideaContext` 中再次确认长度限制（目前 `slice(0, 2000)` 是整体限制，单个 note 可能没有限制，导致前面的 note 被截断而恶意的长 note 可能被完整注入？不，是整体 slice，所以如果恶意 note 很长，它会占据大部分空间。但主要风险是 prompt injection）。
**把握度**: 中（注入风险）

### 6. 文件: worker.js / `POST /api/idea/:id/writeback`
**问题**: 代码片段截断在 `if (kind !== 'cookie' && kind !== 'operator' && kind !== 'bearer') return ...`。
**为什么是问题**: 规格提到 `operator` 权限较低，**不能删除**。但这里允许 `operator` 进行 `writeback`。规格说“项目结论可回写点子”，通常这是由项目成员（包括 operator）做的。但需要确认 `operator` 是否有权限修改点子的内容。如果 `operator` 是外部负责人，修改内部存档的“结论”是否合适？通常结论应该由项目核心成员（cookie/bearer）写。允许 `operator` 写回可能违反最小权限原则。
**怎么改**: 检查业务规格，是否应该禁止 `operator` 写回，仅允许 `cookie` 和 `bearer`。
**把握度**: 低（需确认业务规则，但倾向于反对 operator 写回）

### 7. 文件: worker.js / `startRound`
**问题**: 新建项目时关联点子：`if (body.idea != null && body.idea !== '') { ideaId = String(body.idea); if (!(await ideaGet(s, ideaId))) return { error: '没有这个点子' }; }`。
**为什么是问题**: 这里没有检查权限。任何能创建项目的人（可能是 `operator` 或 `bearer`）都可以关联任意点子。如果点子包含敏感信息，低权限用户创建项目并关联高敏感点子，可能会在后续的 `getRoom` 中触发背景注入。结合第 2 点，这构成了一个**越权信息泄露**的链路。
**怎么改**: 在关联点子时，校验请求者的权限是否允许访问该点子（如果点子有敏感度标记）。或者，在 `runTurn` 注入背景时严格过滤权限。
**把握度**: 高（权限/注入错误）

---

### 最反对的 3 点

1.  **`DELETE` 接口缺乏事务保护**：`UPDATE` 和 `DELETE` 分开执行，极易产生孤儿引用或数据不一致，必须包裹在事务中。
2.  **`POST /api/ideas` 路由缺失显式权限检查**：代码片段中未见鉴逻辑，若默认允许所有经过 API Gateway 的请求修改点子库，则是严重的越权漏洞（bearer/operator 可能篡改存档）。
3.  **敏感项目与背景注入的权限隔离缺失**：`runTurn` 中无差别地向所有成员（包括低权限的 `operator`）注入 `ideaCtx`。若项目标记为敏感，低权限用户不应看到完整背景，当前逻辑会导致敏感信息通过 Prompt 泄露给外部令牌用户。