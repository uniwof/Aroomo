<!-- model=openai/gpt-oss-120b secs=5 usage={'queue_time': 0.175396189, 'prompt_tokens': 2244, 'prompt_time': 0.094929128, 'completion_tokens': 2131, 'completion_time': 4.440143325, 'total_tokens': 4375, 'total_time': 4.535072453, 'completion_tokens_details': {'reasoning_tokens': 877}} -->
**代码审查结果（仅列出真实问题）**

| 文件/函数 | 问题 | 为什么是问题 | 怎么改 | 把握度 |
|----------|------|--------------|--------|--------|
| `usageView`（Worker） | `kvGet` 返回的是字符串，但代码直接当作对象使用 `v.room`、`v.lineup` | 未对返回值进行 `JSON.parse`，导致 `v.room`、`v.lineup` 永远为 `undefined`，进而在幂等返回中产生错误信息 | `const raw = await kvGet(store(env), 'cid:' + cid); const v = raw ? JSON.parse(raw) : {};` 同时在写入时保持 `JSON.stringify` | 高 |
| `WORKER[1331]`（Worker） | `room` 变量在 `flushOutbox` 中未声明却被引用 (`if(room && rooms.has(room) && !busy)`) | 运行时会抛 `ReferenceError`，导致补发成功后页面脚本中断，用户看不到补发提示 | 将 `room` 改为从函数参数或全局状态中获取，例如 `const curRoom = getCurrentRoom(); if (curRoom && rooms.has(curRoom) && !busy) …` | 高 |
| `flushOutbox`（前端） | 在网络错误 (`!e.net`) 时仍执行 `await OB.del(x.cid)`，导致**消息永久丢失** | 业务要求“消息不丢不重”，但代码在非网络错误（如服务器返回 5xx）时直接删除 outbox 条目，违背需求 | 只在确定已成功发送后才删除；在其他错误情况下保留条目并在下次重试：`if (e.net) { break; } // keep entry`，删除操作放在 `try` 成功分支 | 高 |
| `flushOutbox`（前端） | `if (e.net) break;` 只判断 `e.net`，但 `e` 可能不是对象或没有 `net` 属性，导致 `TypeError` 并中止整个循环 | 代码在捕获非网络错误时会抛异常，导致后续待发送条目永远不再被处理 | 使用安全检测 `if (e && e.net) break;` 或改为 `if (e?.net) break;` | 中 |
| `reqWarn`（Worker） | `catch {}` 空捕获，吞掉所有异常，导致提醒失败时没有任何日志或回退机制 | 隐蔽潜在错误，运维难以定位问题，且可能导致提醒永远不发送 | 至少记录错误日志：`catch (err) { console.error('reqWarn error:', err); }` | 中 |
| `reqFlush`（Worker） | `await s.q('INSERT INTO kv… RETURNING v', …)` 假设 SQLite `RETURNING` 在冲突时仍返回旧值，但在某些 SQLite 版本中 `ON CONFLICT … DO UPDATE` 不会返回 `v`，可能得到 `undefined` 导致 `tot` 为 `NaN` | 计数不准确，可能导致误报或漏报 | 使用 `SELECT v FROM kv WHERE k = ?` 读取最新值，或确保 SQLite 版本支持 `RETURNING` 并加容错：`const r = await s.q(...); const tot = Number(r?.[0]?.v ?? 0);` | 中 |
| `newCid`（前端） | 生成的 CID 以 `c` 开头且长度固定 33（UUID）或 33（随机），但后端正则只允许 8–64 位字母数字 `_-`，未排除首字符必须是字母 | 虽然符合正则，但若未来改为更严格的规则（如不允许首字符为数字），前端仍会产生非法 CID，导致 400 错误 | 在前端统一使用后端同样的正则或在后端放宽限制；最好在前端也做同样校验 | 低 |
| `flushOutbox`（前端） | `if (!OBC.length && OBT) { clearInterval(OBT); OBT = null }` 只在本次 `flushOutbox` 完成后检查，若页面在 `OBC` 仍有条目但 `OBT` 已被 `clearInterval`（例如手动调用 `clearInterval`），会导致 **定时器泄漏** | 资源未及时释放，长时间运行的页面会产生不必要的计时器 | 在页面 `unload` 事件中统一清理：`window.addEventListener('beforeunload', () => { if (OBT) clearInterval(OBT); });` | 低 |

---

### 最反对的 3 点（影响最大、最违背需求的）

1. **消息可能永久丢失** – `flushOutbox` 在非网络错误时仍删除 outbox 条目，直接违背“消息不丢不重”的核心需求。  
2. **未声明的 `room` 变量导致运行时错误** – 在补发成功后页面脚本抛 `ReferenceError`，用户界面卡死，影响可用性。  
3. **幂等检查返回错误信息** – `usageView`/`/api/start` 中对 `cid` 的重复检测使用了未解析的 KV 字符串，导致 `dup:true` 时返回的 `room`、`lineup` 永远为空，幂等性实现不完整。  

以上问题均为 **高把握度**，请务必优先修复。