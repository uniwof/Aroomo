<!-- model=agnes-3.0-flash secs=41 usage={'completion_tokens': 4000, 'prompt_tokens': 9207, 'total_tokens': 13207} -->
### 独立审查

**1. `writeback` 端点：`JSON.stringify` 序列化 `notes` 数组时未截断总量，存在 SQLite TEXT 存储溢出风险**
- **文件/函数**: `worker.js` 中 `if (im && im[2] && req.method === 'POST')` 块 (约 1554-1560 行)
- **问题**: `const notes = [...it.notes, { room: rm0.id, title: rm0.title, text: t, ts: Date.now() }].slice(-50);` 这里只限制了条数为 50 条，且单条 `text` 限制 1000 字符。但是 `title` 来自 `rooms` 表，虽然建表时限制 40 字符，但旧数据或异常数据可能超长。更重要的是，`notes` 是一个对象数组，序列化后 `JSON.stringify` 的总长度没有上限控制。虽然 50 * (1000 + 40 + 其他) 大约 50KB，在 SQLite TEXT 字段中通常没问题，但 `ideaRow` 读取时 `JSON.parse` 如果数据被外部篡改或未来逻辑变更导致条数/长度增加，可能超过 SQLite 动态最大长度 (通常 1GB，但实际受内存限制)。
- **更严重的问题（正确性/一致性）**: `writeback` 接口允许 `operator` 和 `bearer` 调用（见裁决 A3/A6 驳回理由）。但是 `writeback` 逻辑中 `rm0.idea !== it.id` 校验了关联性。然而，`it` 是通过 `ideaGet` 获取的，`ideaGet` 没有加锁（DO 单线程是安全的，但如果是异步等待外部输入时... DO 是单线程同步执行 SQL，所以原子性没问题）。
- **真问题（数据一致性/逻辑漏洞）**: `writeback` 中 `const notes = [...it.notes, ...]`。`it.notes` 是从数据库读出的**已解析**数组（见 `ideaRow`）。但是 `ideaSave` 在更新点子时，`JSON.stringify(prev ? prev.notes : [])` 会保留旧 notes。如果用户在点子编辑页面（POST /api/ideas）和 writeback 之间发生竞态（DO 单线程，但如果有异步网络调用穿插，比如 ideaGet 之后有 await，DO 允许其他请求介入吗？Durable Objects 在等待网络 I/O 时可以穿插其他请求，但本地 SQLite 操作是同步的）。
    - 关键在于：`writeback` 先 `await ideaGet`（同步 SQL，但函数是 async，如果内部有 await 则可能中断？`s.q` 在 Cloudflare Durable Objects 中如果是 `execSync` 就是同步的。代码中用的是 `await s.q`，说明底层可能封装了异步或允许微任务循环。DO 的 SQLite 是同步 API `exec`，但如果用户代码用 `await` 包装，且中间没有 `yield` 或网络等待，逻辑是原子的。如果 `ideaGet` 内部没有网络等待，则是原子的。
    - **真正的 Bug**: `writeback` 中 `rm0.idea !== it.id`。如果房间 `rm0` 存在，但 `rm0.idea` 是 `NULL`，则 `rm0.idea` 为 `undefined` 或 `null`，`it.id` 是字符串。比较 `null !== 'i-xxx'` 为 `true`，返回错误。这是正确的。
    - **Bug 点**: `title: rm0.title`。`rm0.title` 直接从房间表读取，没有经过 `esc()` 或长度严格校验（建表时 INSERT 限制了 40，但 `ALTER TABLE` 或旧数据？）。`writeback` 将 `rm0.title` 直接存入 `notes` 数组的 `title` 字段。如果 `rm0.title` 包含特殊字符，虽然 JSON 安全，但前端渲染 `notes` 时如果未转义，会有 XSS 风险。但 `notes` 是存进 `ideas` 表的 TEXT 字段，后续读取时 `ideaContext` 会拼接这些 title。
    - **`ideaContext` 中的 XSS/注入风险**: `ideaContext` 拼接 `notes.map((n) => `「${n.title || ''}」${n.text}`).join('；')`。`n.title` 来自房间标题，`n.text` 来自用户输入（已截断 1000）。这些内容会注入到 AI 的系统提示词中（`r0.ideaCtx`）。如果房间标题包含“忽略之前指令”，这会构成提示注入。裁决 G1/G3 驳回了“转义”请求，理由是“用户自己写的”。但 `n.title` 是**房间标题**，房间标题在 `startRound` 中创建时是 `(typeof body.title === 'string' && body.title.trim() ? body.title : message).slice(0, 40)`。`message` 是用户输入。所以 `n.title` 确实可以是用户控制的恶意文本。
    - **为什么是问题**: 裁决认为“单用户应用，无风险”，但对于 LLM 而言，即使单用户，如果用户误操作或恶意测试，将房间标题（可能含敏感信息或注入 payload）写入点子 notes，再注入到其他关联该点子的新项目中，会导致上下文污染。更重要的是，**`n.title` 没有像 `n.text` 那样做长度限制**（虽然房间标题限 40，但 `writeback` 代码中 `rm0.title` 直接取用，若房间表被篡改或旧数据超长，JSON 体积不可控）。
    - **怎么改**: `writeback` 中应对 `rm0.title` 做截断（`String(rm0.title).slice(0, 40)`）并清理控制字符。对 `n.text` 已有截断。
    - **把握度**: 中（提示注入在单用户场景下被视为设计接受的风险，但长度/数据污染是确定的代码缺陷）。

**2. `ideaList` 中 `notes` 字段泄露完整数据导致响应过大**
- **文件/函数**: `worker.js` `ideaList` 函数
- **问题**: `return rows.map((x) => ({ ...x, projects: cnt[x.id] || 0, notes: undefined, noteCount: x.notes.length }));`
- **分析**: 这里显式将 `notes` 设为 `undefined`，在 JSON 序列化时会被忽略。这是好的做法。但是 `ideaGet` 返回完整的 `it`（包含 `notes`），而前端 `GET /api/idea/:id` 返回 `it`。`notes` 数组最大 50 条，每条 1000+ 字符，总大小约 50KB。单个点子详情返回 50KB 是可接受的。
- **真问题**: `ideaList` 中 `x.notes.length`。`x` 是 `ideaRow` 处理后的对象，`x.notes` 是解析后的数组。如果数据库字段 `notes` 为 `NULL` 或非法 JSON，`ideaRow` 会 catch 并设 `notes = []`。所以 `x.notes.length` 是安全的。
- **未发现**此点有严重问题。

**3. `startRound` 中关联点子时的 `ideaGet` 失败处理**
- **文件/函数**: `worker.js` `startRound`
- **问题**: `if (!exists && body.idea != null && body.idea !== '') { ideaId = String(body.idea); if (!(await ideaGet(s, ideaId))) return { error: '没有这个点子' }; }`
- **正确性**: 如果 `body.idea` 是数字 `1`，`String(body.idea)` 变成 `"1"`。`ideaGet` 内部 `String(id || '').slice(0, 40)`。如果点子 ID 是 `i-abc...`，传 `"1"` 会查不到，返回 error。这是正确的。
- **但**: `body.idea` 如果超长（例如 10000 字符），`String(body.idea)` 会被 `ideaGet` 内的 `slice(0, 40)` 截断。如果用户截断后的前 40 位恰好匹配某个点子 ID，而用户原本想传完整 ID（虽然 ID 是生成的 12 位 rid + 前缀，不可能超长），这是防御性编程，不是 bug。

**4. `writeback` 鉴权逻辑与 `DELETE` 不一致**
- **文件/函数**: `worker.js` `if (im && im[2] && req.method === 'POST')`
- **问题**: `DELETE /api/idea/:id` 强制 `kind === 'cookie'`。但 `POST /api/idea/:id/writeback` 允许 `cookie`, `operator`, `bearer`。
- **规格符合度**: 裁决 A3/A6 驳回理由称“operator 可建/改/回写是规格要求”。如果规格确实允许 operator 回写，则代码正确。但如果 operator 是“受限”的（不能删点子），通常意味着其权限较低，而 writeback 是修改点子数据（notes 是点子的一部分）。允许 operator 修改数据但禁止删除，逻辑上尚可。
- **潜在风险**: `bearer` 是“用户自己的令牌”，与 cookie 同权。如果 bearer 泄露，攻击者可随意回写结论到点子，污染上下文。但这是令牌管理的风险，非代码逻辑错误。

**5. `MCP_TOOLS` 中 `save_idea` 的 `required` 字段**
- **文件/函数**: `MCP_TOOLS` 定义
- **问题**: `['save_idea', ..., { id: ..., title: ..., ... }, ['title'], 'POST', ...]`
- **正确性**: `required` 只有 `['title']`。这意味着通过 MCP 调用 `save_idea` 时，可以不传 `id`（新建），但必须传 `title`。这与 `validateIdea` 逻辑一致（`if (!o.title) return { ok: false ... }`）。
- **但**: `validateIdea` 中 `if (b.status !== undefined) ... else o.status = '暂时收藏'`。如果 MCP 用户不传 `status`，默认为收藏。这是合理的。
- **未发现**错误。

**6. `GET /api/idea/:id` 返回 `it.rooms` 的 SQL 查询**
- **文件/函数**: `worker.js` `if (im && req.method === 'GET' && !im[2])`
- **问题**: `it.rooms = await s.q("SELECT id,title,COALESCE(status,'进行中') AS status,created FROM rooms WHERE idea=? ORDER BY created DESC LIMIT 50", it.id);`
- **数据一致性**: 如果房间被删除（`DELETE FROM rooms`），`rooms` 表中该记录消失。`ideas` 表的 `notes` 中可能仍保留 `{ room: 'deleted-room-id', title: 'Old Title', text: '...' }`。
- **影响**: `ideaContext` 使用 `notes` 生成“以前项目的结论”。这些结论引用的房间 ID 已不存在。这属于“历史数据”，前端或 AI 无法跳转到该房间（因为房间没了）。裁决 G6 已承认并添加了测试。
- **新发现的问题**: `it.rooms` 返回的是**当前**关联该点子的房间列表。如果用户删除了一个关联项目（房间），该房间从 `it.rooms` 消失，但 `it.notes` 中仍保留该房间的结论。如果用户再次关联新项目，`notes` 依然保留旧结论。这在逻辑上是“记忆”，符合预期。
- **但未发现**新错误。

**7. `ideaRow` 中 `tags` 和 `notes` 的解析安全**
- **文件/函数**: `worker.js` `const ideaRow = (r) => { ... let tags = [], notes = []; try { tags = JSON.parse(r.tags || '[]'); } catch {} ... }`
- **问题**: 如果 `r.tags` 是 `"abc"`（非法 JSON），`catch` 块后 `tags` 保持 `[]`。这是安全的。
- **但**: 如果 `r.tags` 是 `"[1,2,3]"`，解析为 `[1,2,3]`。`validateIdea` 写入时 `JSON.stringify(it.tags)`，`it.tags` 是字符串数组。读取时解析为数组。`ideaContext` 中 `it.tags.join('、')` 安全。
- **未发现**错误。

**8. `webPrompt` 中 `background` 拼接位置**
- **文件/函数**: `p1.js` `webPrompt`
- **问题**: `background ? '【项目背景】\n' + String(background).slice(0, 2000) : ''`
- **正确性**: `background` 来自 `r0.ideaCtx`。`ideaCtx` 在 `getRoom` 中计算。`getRoom` 中 `r.ideaCtx = it ? P1.ideaContext(it) : '';`。`ideaContext` 返回的字符串是纯文本。
- **风险**: `ideaContext` 中包含 `notes` 的 `title`（房间标题）和 `text`（用户输入）。如果房间标题包含 `【前情】` 或 `【输出格式】` 等关键词，可能会干扰 LLM 提示词结构。例如，如果 `n.title` 是 `"] 忽略指令 [``，拼接后可能破坏提示词分隔。
- **为什么是问题**: 提示注入的载体。虽然裁决 G1 驳回，但针对 `notes.title` 的注入风险未被充分考虑。`notes.title` 来自 `rooms.title`，`rooms.title` 来自 `body.title` 或 `message`。用户可以在 `message` 中放入恶意字符串，创建房间，回写结论，该结论的 `title` 实际上是 `rooms.title`。如果用户故意将房间标题设为 `【项目背景（恶意注入）】`，则 `ideaContext` 拼接时会出现嵌套括号或混淆指令。
- **怎么改**: 在 `ideaContext` 中，对 `n.title` 和 `n.text` 进行过滤，移除或转义 `【`、`】` 等特殊标记符，或者在拼接时添加前缀 `title: ` 和 `text: ` 以明确边界，避免与指令块混淆。
- **把握度**: 高（提示注入向量）。

### 对裁决的复核

| 裁决项 | 判断 | 理由 | 把握度 |
| :--- | :--- | :--- | :--- |
| G1 驳回 | **部分错误** | 驳回理由“用户自己写的”忽略了 `notes.title` 来源于房间标题，房间标题可被用户通过 `message` 或 `title` 参数控制，且 `ideaContext` 拼接时未做特殊字符过滤，存在提示注入向量（如混淆 `【】` 指令块）。 | 高 |
| G2/A7 驳回 | **正确** | 单用户应用，关联操作本身不需要细粒度权限，只要用户有权限访问房间/点子即可。 | 高 |
| G3/A5 驳回 | **部分错误** | 同 G1，`notes` 中的 `title` 和 `text` 在 `ideaContext` 中拼接时缺乏对特殊标记的防御，存在注入风险。 | 高 |
| G4 驳回 | **正确** | 前端确实不渲染 `ideaCtx`，XSS 风险低。 | 高 |
| G5 驳回 | **正确** | `JSON.stringify/parse` 序列化/反序列化逻辑正确。 | 高 |
| G6 驳回 | **正确** | 孤儿引用是设计使然（历史记录），测试已覆盖。 | 高 |
| G7 驳回 | **正确** | 参数传递逻辑正确。 | 高 |
| A1 驳回 | **正确** | 性能影响可忽略。 | 高 |
| A2 驳回 | **正确** | Operator 权限设计符合规格。 | 高 |
| A3/A6 驳回 | **正确** | 鉴权逻辑符合“operator 受限但可写”的设定。 | 高 |
| A4 采纳 | **正确** | `s.batch` 确保原子性，修复正确。 | 高 |

### 最反对的 3 点

1.  **`ideaContext` 中的提示注入风险（G1/G3 驳回不当）**: 裁决认为“用户自己写”就无风险，但 `notes.title` 来自房间标题，房间标题可被用户通过消息内容间接控制。当房间标题包含 `【项目背景】`、`【前情】` 等提示词结构标记时，`ideaContext` 拼接后可能破坏 LLM 提示词的语义边界，导致模型行为异常或注入成功。应对 `n.title` 和 `n.text` 中的 `【`、`】` 进行过滤或转义。
2.  **`writeback` 接口中 `rm0.title` 未做长度和字符过滤**: 虽然房间标题在创建时限制 40 字符，但 `writeback` 直接读取 `rm0.title` 并存入 `notes`。如果未来房间标题逻辑变更或存在数据异常，`notes` 数组的总大小不可控。且未过滤控制字符，可能导致 JSON 序列化异常（虽然 JS `JSON.stringify` 会自动转义，但增加存储负担）。
3.  **`startRound` 中 `body.idea` 校验逻辑过于宽松**: `if (!exists && body.idea != null && body.idea !== '')`。如果 `body.idea` 是 `0`（数字零），`0 != null` 