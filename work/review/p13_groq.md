<!-- model=openai/gpt-oss-120b secs=5 usage={'queue_time': 0.118745176, 'prompt_tokens': 4805, 'prompt_time': 0.187762289, 'completion_tokens': 2156, 'completion_time': 4.490082271, 'total_tokens': 6961, 'total_time': 4.6778445600000005, 'completion_tokens_details': {'reasoning_tokens': 1089}} -->
**代码审查结果（仅列出真实问题）**

| 文件 / 函数 | 问题 | 为什么是问题 | 怎么改 | 把握度 |
|------------|------|--------------|--------|--------|
| `p1.js → webPrompt` | **未对 `background` 参数做转义** | 直接拼接 `String(background)` 进入 LLM 提示，攻击者可构造包含特殊指令的字符串实现 Prompt 注入（如 `{{#system}}…`），进而影响模型输出。 | 在拼接前使用统一的转义函数（如 `esc()`）或严格白名单过滤，只保留安全字符；或在前端统一 `esc()` 后再传入。 | 高 |
| `worker.js → startRound` | **关联点子时缺少权限校验** | 任意持有 `cookie` 或 `bearer`（普通用户）均可在创建项目时提交任意 `ideaId`，只要该点子存在即被关联，违反“点子只能被拥有者或有授权的成员关联” 的业务规则。 | 在读取 `idea` 前先检查当前成员对该点子的可见性（如 `idea.owner === memberId` 或 `member.role >= allowed`），不满足则返回 `403`。 | 高 |
| `p1.js → ideaContext` | **未对 `notes` 中的 `title`、`text` 做转义** | `notes` 可能来源于用户自行编辑的项目结论，直接拼接进提示会导致 Prompt 注入或泄露内部信息。 | 对 `n.title`、`n.text` 统一调用转义函数（`esc()`）或过滤危险字符后再拼接。 | 中 |
| `worker.js → getRoom`（返回的 `r.ideaCtx`） | **返回的项目背景未经过前端 `esc()` 处理，可能导致 XSS** | `r.ideaCtx` 直接作为 JSON 字段返回给前端，若其中包含 `<script>` 等 HTML，前端若忘记 `esc()` 会产生跨站脚本。 | 在 API 响应层统一对所有字符串字段做 HTML 转义，或在前端强制使用 `esc()` 再渲染。 | 中 |
| `worker.js → CREATE TABLE ideas` | **`tags`、`notes` 字段定义为 TEXT，却在业务代码中当作数组使用** | 代码在 `validateIdea`、`ideaContext` 中把 `tags`、`notes` 当作数组处理，但未在写入 DB 时序列化为 JSON，导致存取不一致、潜在数据损坏。 | 在写入时使用 `JSON.stringify(tags)`、`JSON.stringify(notes)`；读取时 `JSON.parse`，或改表结构为 `JSON` 类型（若底层支持）。 | 低 |
| `worker.js → startRound`（创建房间） | **创建房间后未清理已关联的点子引用的孤儿记录** | 当房间被删除（未在本 diff 中实现）时，`rooms.idea` 仍指向旧点子，导致数据库中出现无效关联，影响后续查询与数据一致性检查。 | 在房间删除逻辑中加入 `UPDATE rooms SET idea=NULL WHERE id=?` 或在 `ON DELETE SET NULL` 约束上实现。 | 低 |
| `p1.js → webPrompt`（新增 `background` 参数） | **未在函数签名文档或调用方同步更新** | 只有 `dispatchAsync` 调用了新参数，其他可能直接调用 `webPrompt`（如单元测试或其他模块）会得到 `undefined`，导致提示缺失或意外行为。 | 在项目文档、类型定义（如 JSDoc/TS）中补全 `background` 参数说明；在所有调用点统一传入 `r0.ideaCtx`（或空字符串）。 | 低 |

---

### 最反对的 3 点（影响最大、最容易被利用）

1. **关联点子时缺少权限校验**（`worker.js → startRound`）  
   任意用户可把任何点子挂到新建项目上，导致信息泄露、业务规则被绕过，属于高危权限漏洞。

2. **`webPrompt` 中的 `background` 未转义**（`p1.js → webPrompt`）  
   直接把用户可控的字符串拼进 LLM 提示，攻击者可执行 Prompt 注入，影响模型输出，危害范围广。

3. **`ideaContext` 对 `notes` 内容未转义**（`p1.js → ideaContext`）  
   项目结论可能包含恶意指令或敏感信息，直接注入提示会导致模型误导或泄露内部数据，属于中高危。