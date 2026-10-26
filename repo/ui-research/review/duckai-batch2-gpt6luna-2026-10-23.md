## DUCK.AI ANSWER — VERBATIM

Site: https://duck.ai/?chatID=a514f3ab-6416-4a25-a0fb-02698fda8779
Model used: **GPT-6 Luna** (the strongest free GPT in the model picker — picker listed GPT-6 Luna, GPT-5.4 mini, Claude Haiku 4.5, Mistral Small 4, gpt-oss 120B, Gemma 4 31B as free; GPT-5.6 Terra / Claude Sonnet 4.6 (Plus), GPT-5.6 Sol / Claude Opus 4.8 (Pro) were disabled/Plus-Pro. GPT-6 Luna is the newest/strongest free GPT.)
Chat title the model gave itself: 资源库与管家风险点清单
Response state: Response complete (the chat showed "Response complete" and the 2nd-opinion/feedback row).

CAPTURE NOTE: The assistant's Copy-to-clipboard button produces Markdown and was truncated by the page's own writeText at the mid-point of item 8. The page's rendered DOM contains the full text of items 9–15 and the closing section verbatim; items 1–8 below are taken from that same Markdown copy. Every word below is the model's wording — nothing summarized. Items 6, 7, 8 carried inline `<citation src="…">` tags in the clipboard text; they are kept verbatim here.

=== ITEMS 1–8 (from assistant's markdown copy, verbatim) ===

## 反对与高风险点

1. **“实测 4 条全对”不足以支持自动入库。** → 四条样本无法覆盖帖子删改、登录墙、反爬页面、短链跳转、非英语文本和过期信息；“分类全对”也不等于额度、期限、证据都准确。→ 把自动入库降为“待确认”：模型只生成候选字段，用户确认后才写入；至少用一批有标注的边界样本评估分类、字段准确率和漏检率。

2. **“抓官方页比对原句”不能证明免费额度是真的。** → 网页里可能有多个额度数字、旧文档、脚注、地区限制，甚至页面内容与模型引用不对应；原句匹配只证明字符串出现过，不证明适用于当前服务或用户。→ 保存官方 URL、抓取时间、原文上下文、适用条件和页面版本；额度及到期日必须由规则解析或人工确认，证据不完整就标“未核实”。

3. **链接抓取存在 SSRF 和内部网络探测风险。** → 用户可提交指向 `localhost`、私网地址、云服务元数据地址的 URL，或用重定向绕过首轮检查；Worker 代用户发请求，会把内部网络探测变成服务端能力。→ 限制协议为 HTTP/HTTPS、解析并拦截私网/保留地址、每次重定向重新校验、限制跳转数和响应大小；默认拒绝非必要端口，并设置抓取超时与域名策略。

4. **“X 走 fxtwitter”把可用性和证据链压在第三方改写服务上。** → 服务可能限流、变更、失效或返回不完整内容；转发后的正文也未必保留原帖时间、作者和上下文。→ 抓取失败时明确报告失败，不用搜索摘要或模型补正文；记录原始链接、来源、抓取时间和正文哈希，用户能看到抓取依据。

5. **多模型回退会造成隐性的路由与数据处理变化。** → Groq、GLM、Workers AI 的输出格式、能力、可用性和数据处理条件并不相同；“自动退到下一个”可能让用户不知道任务文本发给了谁，也可能输出不同判断。→ 每次任务先显示/记录实际模型与结果来源；对每个供应商设置超时、熔断和输出校验；失败就返回可重试状态，不把不同模型的结果当成等价证据。

6. **免费优先不等于免费可持续，也不等于不会产生账单。** → 外部模型、抓取、推送和存储都可能有配额或收费变化；“完全免费优先”如果没有硬限额，流量异常或服务策略变化可能导致费用和功能中断。Cloudflare 当前文档列出 Workers Free 每个 HTTP 请求 CPU 时间为 10 ms，Durable Objects 免费额度也有日限额，超额后相应操作会失败。<citation src="1,3"></citation> → 给抓取、模型调用、用户数、存储和推送设硬预算与熔断；展示用量，接近上限时停止非关键任务；任何切换到可能收费的服务前都必须明确取得用户确认。

7. **单次抓取链路太长，用户看到的“1–2 秒”不代表稳定体验。** → 一个任务依次经过抓取、规则分类、多模型、官方页抓取、证据匹配和写库；任一环节超时或断连都可能让用户不知道是否已写入。Cloudflare 的 HTTP Worker 请求没有固定墙钟时长上限，但连接断开可能取消关联任务，长任务仍需设计重试与恢复。<citation src="1"></citation> → 做成有任务 ID 的异步状态机：待抓取、处理中、待确认、已完成、失败；幂等写入、可重试、可取消，断网重连后能恢复状态，避免重复写入。

8. **“只有管家写入”仍不够解决并发和数据一致性。** → 多个窗口、重复点击或 Cron 与用户操作同时写入时，可能覆盖状态、重复建条目或把已过期记录改回有效；Durable Object 也可能在运行时更新或关停时重启，不能假设内存状态一直存在。<citation src="4"></citation> → 用数据库约束和版本号做原子更新，给每个导入任务设幂等键；状态变更保留审计记录，重启后从持久状态恢复。

(clipboard Copy truncated at the start of item 8's “改法” sentence — “用数据库约束…”，which the rendered DOM above completes exactly as written.)

=== ITEMS 9–15 + 只能改 3 处 (from the page's rendered response text, verbatim) ===

9. **“GET /api/resources”没有交代身份与授权边界。** → 登录后能读，不代表只读到自己的项目；资源里还可能包含用户提交的链接、私有笔记或密钥元数据。若只在前端隐藏入口，接口仍可能被直接访问。→ 服务端每次请求校验会话、用户和项目归属；默认拒绝、明确区分公共资源与个人资源；对管理写入接口加 CSRF 防护、速率限制和审计。

10. **“密钥不出现在页面”不等于密钥安全。** → Bark Key、Telegram Bot Token 等如果出现在 API 响应、日志、错误堆栈或审计记录里，仍然会泄漏；推送服务也会收到通知内容。→ 密钥只在服务端加密存储，写入后只显示掩码；绝不回传明文，日志过滤密钥；允许撤销和轮换；推送默认只发最少必要内容，并明确告诉用户哪些字段会发到外部服务。

11. **对眼疾用户来说，视觉规格达标不等于可访问。** → 19px 字号、44px 点击区是底线，不解决屏幕阅读器标签、键盘焦点、缩放重排、对比度、读屏公告和错误信息可理解性；固定细缝和状态配色也需要在高对比度与放大后检查。→ 把键盘、VoiceOver / TalkBack、200%–400% 缩放、系统高对比度和横屏纳入验收；状态文字必须可读，切换标签后正确播报；避免布局在大字模式下裁切或横向溢出。

12. **四个真切换标签页、左右滑动和 URL 记忆容易互相打架。** → 左右滑动可能与页面滚动、屏幕阅读器手势冲突；标签、浏览器返回、锚点和上次记忆可能出现状态不一致。→ URL 作为可分享的当前状态来源；浏览器前进/后退同步标签；滑动仅作补充，不能成为唯一操作方式；提供明确的标签按钮和焦点状态。

13. **“每天一次到期检查”会让过期提醒失真。** → 到期时间可能跨时区、官方页面更新或抓取失败；Cron 不是实时保证，失败后若没有补偿机制，就可能错过提醒。→ 存 UTC 时间并展示用户本地时间；区分“已过期”和“到期检查失败”；保存上次成功检查时间，失败重试并在界面标示数据陈旧，而不是静默维持旧状态。

14. **“搜集羊毛”这个入口容易把候选内容误当成可信资源。** → Hacker News 搜索和 RSS 里的帖子可能是广告、钓鱼链接、过期优惠或恶意链接；即使不自动入库，候选列表也会诱导用户信任。→ 候选列表显著标“未经核实”，默认不展示“免费”结论；隔离外链预览，要求用户主动打开；最终入库仍走官方来源核验和确认流程。

15. **语音与自动朗读的默认行为可能制造干扰或泄露。** → Web Speech 在不同浏览器的支持、识别语言和权限行为不一致；自动朗读或推送可能在公共场所念出敏感项目内容。→ 默认关闭自动朗读和敏感内容推送；按项目分别设置；录音/识别状态、权限失败和数据去向要有可理解提示；不支持时提供键盘听写等明确替代路径。

### 只能改 3 处

- **把资源导入改为“候选 → 证据核验 → 用户确认 → 入库”。** 未经确认不自动认定免费额度、有效期或官方证据。
- **先补齐抓取与密钥安全边界。** SSRF 防护、重定向复验、服务端授权、密钥加密与日志脱敏列为上线阻断项。
- **把长链路改成可恢复的异步任务，并设置硬预算。** 任务状态可见、幂等重试、预算熔断，避免断连丢结果和意外收费。

(End of response. The chat then shows citation chips — Limits · Cloudflare Workers docs; Pricing · Cloudflare Durable Objects docs; Lifecycle of a Durable Object — and a 2nd opinion button.)

=== COUNT CHECK ===

The model produced 15 numbered risk/objection points (≥8 satisfied) and a closing “只能改 3 处改哪 3 处” with exactly 3 items, in simplified Chinese as requested.