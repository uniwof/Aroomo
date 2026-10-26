<!-- model=openai/gpt-oss-120b secs=7 usage={'queue_time': 0.168689183, 'prompt_tokens': 4180, 'prompt_time': 0.248275504, 'completion_tokens': 3000, 'completion_time': 6.345409035, 'total_tokens': 7180, 'total_time': 6.593684539, 'completion_tokens_details': {'reasoning_tokens': 2602}} -->
**文件/函数** | **问题** | **为什么是问题** | **怎么改** | **把握度**
---|---|---|---|---
worker.js / `startRound` | `@` 点名未校验成员身份 | 用户可以在消息中 `@` 任意 ID，系统会把该 ID 加入本轮发言者列表，导致非项目成员被召唤发言，违背“只有项目成员能发言”的规格 | 在 `named` 生成后，过滤掉不在 `lineup`（或 `all`）中的 ID；若有非法 ID 返回错误或直接忽略 | 高
worker.js / `/api/room/:id/ask` 处理分支 | 允许普通用户（cookie/bearer）创建决策题 | 规格要求“负责人（operator）只能出题”，普通用户不应有 `ask` 权限，泄露决策流程控制权 | 将权限检查改为 `if (kind !== 'operator') return json({error:'只有负责人能出题'},403);`，并去掉对 `cookie`、`bearer` 的容忍 | 高
worker.js / `/api/room/:id/pause` 处理分支 | 缺少权限校验，任意已认证用户均可暂停/继续项目 | 项目暂停/继续属于负责人（operator）或系统管理员的职责，随意暂停会导致服务被恶意中断，破坏可用性 | 在处理前加入 `if (kind !== 'operator') return json({error:'只有负责人能暂停/继续'},403);`，或根据业务需求限定更细的权限 | 中
worker.js / `/api/room/:id/decide` 处理分支 | `mid` 解析不严谨，`body.msg