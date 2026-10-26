# P1-6 fix1 复审裁决（DO 一请求一会话 + DO 用量 + DO 额度用完识别）
原文：p16f1_groq.md、p16f1_agnes.md；全新上下文 p16f1fresh_groq.md、p16f1fresh_agnes.md（见文末补充）。
实测（本机 fresh p16f1）：一轮 test_live 4335 次 s.q → 382 个 DO 会话（约 11 倍降幅）。

## 采纳（2）
1. Agnes：同一请求里开会话失败后每次 s.q 都重开，DO 故障/额度用完时形成重试风暴 → 失败结果在本请求内缓存，不再重试。
2. Agnes：没有 ALS 上下文时静默退回每次一个 RPC → 保留退路但同样计入 DO 用量（所有入口 fetch/scheduled 都已包在 ALS.run 里，正常不会走到）。

## 驳回
- Groq：ALS 没生效 → 实测 382 会话 / 4335 调用，生效。
- Groq：.catch 用在非 Promise 上、每次调用都 +1 → stub RPC 返回 Promise；+1 只在首次开会话时执行（p || …）。
- Groq：waitUntil 丢 ALS 上下文 → ALS 随 run 内创建的异步延续传播；计数证明后台任务没有额外开会话。
- Agnes：尝试时就计数会高估 → 尝试本身就是计费请求，按尝试计更接近账单。

## 全新上下文复核（p16f1fresh_groq.md / p16f1fresh_agnes.md）裁决：全部驳回
- 「waitUntil 里 ALS 上下文丢失，会话复用失效」→ ALS.run 内创建的 waitUntil 任务继承上下文；本机 workerd 实测会话数 ≈ Worker 请求数（382），后台任务没有额外开会话。部署后线上用 /api/usage 的 sessionsThisInstance / callsThisInstance 再核一次（验收清单已写）。
- 「失败 Promise 缓存导致瞬时故障永久化」→ 只在当前这一个 Worker 请求内缓存；下一个请求重新开会话。这正是防重试风暴的取舍。
- 「RQ 计数并发竞争」→ JS 单线程，同一实例内 ++ 不会竞争；跨实例本来就是各自计数后原子累加进 DO。
- 「reqFlush 异常被吞」「惊群」→ 计数是约值、失败把数加回（上一轮已采纳）；每实例 25 次/60 秒才写一次。
