# AI 群聊 v2（ai-groupchat）

24 小时在线的多 AI 群聊：一个议题 = 一个**项目**，负责人 **Hark** 按「擅长岗位 × 剩余免费额度 × 在线状态」挑 **AI成员**、分配角色，成员轮流发言、互相挑错，裁判收尾；成员掉线或额度用完时 Hark 自动换人。

- 地址：https://chat.pcmanai.com/ （主账号 tifni023，Worker `ai-groupchat`，workers.dev 关闭）
- 令牌 / 一次性登录链接：`/workspace/storage/secrets/ai-groupchat.json`（600；ACCESS_TOKEN、login_link）。打开一次 `/?k=令牌` 写 cookie（1 年，HttpOnly+Secure+SameSite=Lax），之后直接开 `/`；退出 `/logout`。
- 存储：SQLite 版 Durable Object `ChatStore`（v1 的房间和消息原样保留，自动补列；旧房间的 pro/con/rev/judge 显示为 gpt-oss-120b（提议者）等）。

## 文件
| 文件 | 作用 |
|---|---|
| `members.json` | **唯一权威配置**：AI成员卡（一模型一卡，多个来源 sources）、资源库·工具与算力 tools、中转站 relays、入选门槛 admission、角色、执行能力标签。改完 `python3 deploy.py upload`。 |
| `worker.js` | 后端：鉴权、房间/项目、派工、调用、探测、回调、搜索、打分。 |
| `page.html` | 前端（日式极简、手机优先、正文 19px、深色模式自动 + 手动切换）。 |
| `logos.json` | 品牌 logo 路径（simple-icons，CC0）；没有的品牌用字母徽标。 |
| `bridge.py` | 拉取模式小桥（内网 / 本机 / Tailscale / 网页工具接入）。 |
| `deploy.py` | 部署（多模块上传 + 每小时 cron + 自定义域；`temp-up/temp-down` 在独立账号建/删临时副本）。 |
| `test_live.py` / `ui_test.py` | 线上端到端测试 / 无头 Chromium 界面测试（截图在 `shots/`）。 |

## 概念
- **AI成员**（界面统一称呼，改 `members.json` 的 `term` 即可）：能干活的模型/智能体，一张卡。同一模型的多个渠道（Workers AI / Groq / NVIDIA / 中转站 / 网页 / 本机）是它的 **来源**，调用时自动挑：在线优先 → 额度高优先 → 免费优先；付费来源（`paid: true`）默认不自动用，需用户确认。
- **资源库 → 工具与算力**：沙盒、浏览器、远程桌面、代理节点、临时邮箱、电话号码、算力——只能被成员调用，不进群聊。成员卡写「可调用工具」，工具卡写「谁能用、权限、额度」。
- **项目**：每个房间就是一个项目（名称、发起时间、状态 进行中/已完成/失败）。成员卡里的「参与历史」列出加入时间、角色、状态，可点进房间。
- **擅长岗位 / 不擅长**：入职时按社区评价给初步标签（附链接+日期），不按价格或大小预设；项目结束后的**用户打分**和**成员互评**（裁判给各成员打分）存在 DO 里，同一岗位 ≥2 次且平均 ≥4 → 擅长（实测），≤2 → 不擅长（实测）。Hark 派工时实测分优先。
- **入选门槛**（`admission`）：至少有一项做得好的岗位，依据只认实际效果（评测/口碑/实测/打分）；中转站 `/v1/models` 扫到的新模型先进「候选」，不自动入群。

## 头像、额度环、在线状态
- 头像 = 品牌 logo，外圈额度环（与头像之间留约 2.5px 细缝，必须保留）；气泡底色 = 头像底色 = 品牌主色，文字黑/白按对比度自动选；近黑色品牌（OpenAI、Hark、Kimi…）在深色模式下改成浅色描边。
- 额度环：实查（Groq 响应头 `x-ratelimit-*`、New API 中转站 `/v1/dashboard/billing/*`）显示真实比例；查不到的按官方免费额度 − 本群本地记录估算并标「估算」；<20% 环变朱色。Workers AI 按官方每模型 neurons 单价 × 返回的 token 数本地记账（整个主账号共用，其他 Worker 的用量算不进来，所以是估算）。
- 在线状态（用户拍板 2026-10-23）：不再用状态点，头像彩色 = 可用，黑白 = 不可用（缺密钥、额度用完、限流、离线、小桥未连），未探测也显示黑白；名字旁有「可用/不可用/未探测」文字小框。每小时 cron（`17 * * * *`）只调免费接口（`/models`、计费、心跳、Telegram getMe）；Workers AI 不探测（探测也耗额度），按最近一次调用判断，收到 4006 就标红到 00:00 UTC。打开成员页时超过 1 小时没探测会后台补探一次；也可点「立即探测」。

## 外部智能体怎么接（连接器模板，成员页「添加外部 AI成员」）
| 连接方式 | 适合 | 怎么配 |
|---|---|---|
| Poke API | Poke（即时唤醒） | secrets 加 `POKE_API_KEY`（Poke Kitchen 里建的 V2 Key）。本群 POST `https://poke.com/api/v1/inbound/api-message`，消息里带回调地址和成员令牌；Poke 处理后 `POST /hook/reply` 写回。Poke 没有公开的回复拉取接口，所以是异步。 |
| 通用 Webhook | 任何有 HTTPS 端点的智能体 | 填 https 地址（只收公网 https，拒内网/IP/本机）；可选 `AGENT_xxx` 密钥。本群 POST JSON `{type:"agc.task", task, room, member, role, system, prompt, transcript, callback:{url, token}}`，头 `X-AGC-Timestamp` + `X-AGC-Signature = HMAC-SHA256(密钥或成员令牌, 时间戳.正文)`。直接返回 `{"text":"…"}` = 同步回复；否则稍后回调。 |
| Tailscale | 同一 tailnet 的智能体（CCCC、OpenCode、Claude Code…） | Worker 进不了 tailnet，两种办法：① tailnet 机器上 `tailscale funnel <端口>`，把 `https://<机器>.<tailnet>.ts.net/...` 填进地址（协议同 Webhook，建议加 `AGENT_` 共享令牌）；② 不填地址 = 拉取模式：在 tailnet 内任意机器跑 `bridge.py --http http://100.x.y.z:端口/…`，只出站 HTTPS，不开端口。成员页显示「Tailscale」和在线状态（小桥 10 分钟内拉取过 = 绿）。 |
| 本机 / 局域网（Cloudflare Tunnel） | 本机 HTTP 服务 | `cloudflared tunnel` 暴露成 https 子域名填进地址，协议同 Webhook。 |
| Telegram Bot | 在 Telegram 里有人/账号能回复的智能体 | secrets 加 `TELEGRAM_BOT_TOKEN`，填 chat_id，`POST /api/telegram/setup` 设 webhook（路径和 secret_token 由 ACCESS_TOKEN 派生）。对方引用任务消息回复或带 `#任务号` 即写回。Bot 收不到别的 Bot 的消息。 |
| 拉取模式小桥 | 内网、本机、网页工具（浏览器代发） | 跑 `bridge.py`：`AGC_TOKEN=<成员令牌> python3 bridge.py --member cccc --cmd "opencode run"` 或 `--http <本机端点>`。 |
| OpenAI 兼容 | 自建/中转站模型 | https 地址 + 模型名 + `AGENT_` 开头的密钥变量名。 |

成员令牌：成员详情抽屉「回调 / 小桥令牌」；= HMAC(ACCESS_TOKEN, "member:"+成员ID) 前 40 位，只能给该成员**自己的待办任务**写回复（任务 24 小时过期、只能写一次）、拉它自己的任务，不能读房间或调其他接口。

## 接口（除 /hook、/bridge 外都要访问令牌：cookie 或 `Authorization: Bearer 令牌`；cookie 写请求必须同源 Origin）
- `GET /api/members`（成员 + 工具 + 候选 + 入选门槛 + 连接器模板）、`GET /api/member/:id`（详情 + 参与历史 + 用量 + 打分 + 令牌）
- `POST /api/plan {topic, mode, ai?}` → Hark 推荐分工（`ai:true` 用 gpt-oss-120b 复核，耗少量额度；默认规则不耗额度）
- `POST /api/start {room?, message, mode, members?:[{id,role}], ai?}` → 新项目不给 members 就由 Hark 自动派；`POST /api/turn {room, member}` 逐个发言（异步成员返回 `pending`）
- `POST /api/round {message, mode?, members?, room?}` → 一次跑完整轮（给 Hark 用）
- `GET /api/rooms`、`GET /api/room/:id[?after=msgId]`、`DELETE /api/room/:id`、`POST /api/room/:id/{members|status|rate|review}`
- `GET /api/search?q=` → 项目 + 消息（房间名、成员、角色、时间、片段）
- `POST /api/probe`（立即探测）、`POST /api/agents` / `DELETE /api/agents/x-…`（自定义外部成员）、`POST /api/telegram/setup`、`GET /api/probe-model?model=@cf/…`
- 无令牌：`POST /hook/reply`（成员令牌）、`GET /bridge/pull?member=`（成员令牌）、`POST /hook/tg/<派生路径>`（Telegram secret_token）

Hark 调用示例：
```sh
T=$(python3 -c "import json;print(json.load(open('/workspace/storage/secrets/ai-groupchat.json'))['ACCESS_TOKEN'])")
curl -s -H "Authorization: Bearer $T" -H 'content-type: application/json' -d '{"message":"议题：……","mode":"debate"}' https://chat.pcmanai.com/api/round
```

## 部署 / 测试
```sh
bash /workspace/rb/socks/socks_start.sh     # cfapi.sh 需要自建 SOCKS
python3 deploy.py                           # 上传 + cron + 绑域名（upload / domain / cron 可单独跑）
python3 deploy.py temp-up / temp-down       # 独立账号临时副本（测 AI 用，测完删）
python3 test_live.py [--no-ai] [BASE TOKEN_FILE]
python3 localproxy.py & python3 ui_test.py [BASE TOKEN_FILE]
```
外部密钥有两条路，调用时 **Worker secret 优先，其次页面密钥区**：
1. **页面「资源库 → API 密钥」（推荐，用户自己填）**：每个来源一行（名称、官方免费额度+出处、去哪复制、谁会用、状态 未填/已填/已验证/验证失败），粘贴 Key → `POST /api/keys {name,value}`（只收页面 cookie + 同源 Origin；Bearer 也拒绝，保证 Key 不经过 Hark）→ Worker 用 `HMAC-SHA256(ACCESS_TOKEN,"agc-keystore-v1")` 派生 AES-GCM 密钥加密（附加数据=变量名）存 DO 表 `apikeys` → 当场调该来源最轻量的验证接口（`/models`、New API 的 `/dashboard/billing/subscription`、Gemini `models`、E2B `/sandboxes`、Daytona `/api/sandbox`、Lambda `/api/v1/account`、InstaBox `/v1/machines`、Kaggle 列表接口；NVIDIA/Agnes 的 `/models` 不鉴权，所以用 max_tokens=1 的最小对话）。接口只回末 4 位，永不回显；`DELETE /api/keys/<名>` 删除，`POST /api/keys/<名>/verify` 重验。Modal（只有 gRPC）、Poke、Lightning（锁站）、Beam 没有轻量验证接口，显示「已填（未验证）」。来源清单在 `members.json` 的 `keys`。
2. **Worker secret**：secrets 文件加对应字段再 `deploy.py upload`（只适合有明文的人）。Hark 保险库里的 Key 只能经网关注入沙盒请求，拿不到明文，所以不走这条。

免 Key 来源：Pollinations 匿名档（`text.pollinations.ai/openai`，模型 openai-fast = gpt-oss-20b）已接为 gpt-oss-20b 的一个来源；按 IP 每 30 秒 1 次，Cloudflare 共享出口常被占满（10-23 实测两次 402，代码会按 `Retry after` 等一次再试），只作兜底。

算力平台（资源库 → 工具与算力）：Modal、Kaggle、Lightning AI、Lambda Cloud、Beam、E2B、Daytona、InstaBox 各一张工具卡 + 密钥区一行（额度均 2026-10-23 打开官方页核实，出处在 `keys[].free_src`）。11 个开源权重成员（gpt-oss、llama、mistral、qwen、gemma、glm-4.7-flash、nemotron、granite）多了一条 `invoke.kind = "selfhost"` 的来源「自建 GPU 端点——待部署」，只做标注、不可调用；以后在 Modal/Daytona/Lightning 部署 vLLM 端点后改成 openai 来源即可。

## 前端界面 v3（2026-10-23，以 Grok App 为底子）
- 结构：左侧抽屉（☰ / 左边缘右滑打开；≥1000px 常驻 288px）= 新项目 + 对话/项目/AI成员/资源库 + 最近项目（置顶「资源管家 · 私聊」+ 今天/更早）+「设置」（独立页面）；顶栏 = ☰ · 搜索胶囊 · 新项目；对话页底部大圆角输入栏（＋菜单、模式胶囊、发送）；成员详情/新项目/模式/打分/阵容/设置/确认都是底部弹层（抓手下拉关闭，桌面为右侧面板）；Toast 提示（错误不自动消失）；骨架加载；空状态图标。
- 体系：字体只用系统 sans（SF/苹方）+ 系统 mono（CSP 不允许外部字体）；暖中性前景背景（浅 #fbfbfa、深 #121211）；唯一 accent 珊瑚（coral-scale.json 色阶，支持时用 oklch）；正文 19px，可点 ≥44px；`prefers-reduced-motion` 关闭动效。
- 用户硬规矩照旧：额度圆环 + 2.5px 细缝（`.av`：52px，face inset 7px，stroke 3.5）、彩色/黑白头像、无状态点、「可用/不可用/未探测」小框、品牌色气泡、`模型名（角色）`。
- PWA：`/manifest.webmanifest`、`/icon.svg`、`/icon-192.png`、`/icon-512.png`、`/icon-maskable-512.png`、`/apple-touch-icon.png` 由 `pwa.js`（`pwa/` 里是同样的 PNG；临时图标=圆环+头像，正式 Logo 待命名后用户定）提供，**未登录也可读**（不含数据）；页面 CSP 加了 `manifest-src 'self'`。401 页加了「粘贴登录链接」框（主屏幕 App 与 Safari 不共享 cookie 时用）。这两处是 worker.js 仅有的改动，API 不变。
- 设计依据：`ui-research/grok-借鉴.md`、`ui-research/调研报告.md` 第 10 节；旧版前端备份 `ui-research/page-v2-backup.html`。
- 截图测试要中文字体：`mkdir -p ~/.fonts && ln -sf /workspace/tools/fonts/*.ttf ~/.fonts/`（否则截图里中文是方框）。

## 安全
- 全站令牌门；cookie 写请求同源检查（CSRF）；CSP `default-src 'none'`；外部地址 SSRF 校验（只收公网 https，拒内网 IP/localhost/.local/IPv6 字面量/自身域名，fetch 不跟随重定向）；自定义成员只能引用 `AGENT_` 开头的 secret（防止把 ACCESS_TOKEN 或别家 Key 发往任意地址）；回调/小桥用派生的成员令牌，作用域只到该成员的待办任务；Telegram webhook 路径 + secret_token 双校验；Workers 日志关闭（免得 `?k=令牌` 进日志）；请求体 32KB 上限。

## 已知问题
见交付回报。


## 第二批（2026-10-23）
- **资源库**（原「工具库」）：4 个分段标签页，真切换（只显示一类）：API 密钥 / 工具与算力 / 技能 / 学习与网站资源。`role=tablist/tab/tabpanel`，方向键可切；记住上次（localStorage `agc-restab`）；`#res/keys|tools|skills|sites` 直达，浏览器前进后退同步；左右滑动只是补充。每个标签有搜索、小分组、空状态。
- **资源数据**：`resources.json`（技能 148 条 + 网站 45 条）由 `data/build_resources.py` 从 `data/skills.tsv`、`data/recorded.tsv`、`data/sites.py` 生成：官方页能打开且出现 `evidence` 原文 → 已核实；否则未核实；到期日 < 今天 → 已过期。GitHub 来源 404 的自动去掉链接。deploy 时打包成 `resources.js`。新增只读 `GET /api/resources`（要登录），不改原有 API。
- **资源管家**（成员 id `steward`，置顶私聊 room `steward`）：`POST /api/steward/msg|check|gather`（只认页面 cookie）。链接 → 抓正文（每跳重定向重新过 `safeUrl` 防 SSRF，≤4 跳、10 秒、600KB；X 帖走 fxtwitter，失败明说）→ 免费模型抽 JSON（Groq 官方 → PM 公益站 → Workers AI，每天上限 60 次，超了用规则）→ 只在**非社交/论坛域名的官方页**找到证据原句（统一连字符/全半角/空白后比对）才标已核实 → 写 DO 表 `res_items`（按 URL 去重，可在页面删除）。问题 → 双字切词检索资源库，免费/已核实优先，付费标「需你确认」。到期检查挂在现有 Workers cron（每小时第 17 分，英国 8 点后每天一次），只在 7 天内到期或新过期时发私聊。「搜集羊毛」手动触发，抓 Hacker News 搜索 API + linux.do 福利 RSS，只进「候选（未经核实）」。不建 Hark 定时任务。
- **设置页**（`#v-settings`）：外观、文字大小 19/21/23/25（整页 `zoom`，最小 19）、减少动效（`html.rm`）、朗读语速/裁判结论自动朗读、完成提醒（Bark Key 在密钥区；可选 Telegram chat_id）、敏感内容与来源路由、退出登录（先确认）。`GET/POST /api/settings`、`POST /api/notify/test`。
- **来源级别 / 敏感路由**：每个来源带 `level`（官方 API / 中转站/公益站 / 免 Key 公共接口 / 外部智能体 / 内置）。新项目可勾「敏感」（题目含密码、卡号、API Key 等自动勾），房间 `sens=1`；默认策略 `blockRelay`：敏感项目里中转站/公共接口来源一律不发，只剩这类来源的成员暂停并说明，不静默换源；每次使用/拦截写 `audit` 表，`GET /api/room/:id/audit`，项目头「路由记录」查看。
- **语音/朗读/推送**：输入栏话筒（Web Speech，不支持时提示用 iPhone 键盘听写）；每条成员消息有朗读按钮；裁判出结论时可自动朗读、可 Bark/Telegram 推送（推送只含标题，敏感项目不含标题）。
- 测试：`test_live.py --no-ai` 77 项、`ui_test.py` 54 项；截图 `shots/v4-*`。

## 2026-10-23 下午：角色卡 · 分类纠错 · 工具网关 · 主/副负责人 · 配对码与操作员令牌 · MCP · wizardzines 风格 · Logo 与产品名

### 产品名（唯一配置）
`members.json` → `product`（当前 `Aroomo`）。页面 `<title>`、主屏图标名、PWA manifest `name/short_name`、配对开场白、岗位说明书标题、接手须知、MCP serverInfo、操作技能文件里的 `{{PRODUCT}}` 都从这里取；改名只改这一处再 `python3 deploy.py upload`。Logo：用户定稿 `/workspace/storage/logo-agent-room-v3/`（图形不改，单色；页面内联为 `#i-logo`，浅色黑、深色白；favicon / apple-touch-icon 180 / PWA 192·512·maskable 由 `pwa.js` 打包，maskable 内容缩到 80% 留安全区）。

### 风格：wizardzines 漫画杂志风（覆盖之前的「暖中性 + 单一珊瑚」）
规律与取舍：`ui-research/wizardzines-借鉴.md`；色值对比度：`ui-research/wizardzines/wz-contrast.txt`（全部 ≥4.5:1）。橙色波浪顶栏（自绘 SVG mask）、2px 墨色描边、硬错位阴影、黄色按钮、便利贴粉彩作分类色；正文仍 19px 系统字，标题系统粗体，只有装饰贴纸旋转（减少动效时不转）。抽屉「新项目」按钮复用顶栏帘子色 `--head`。

### 成员角色卡（成员详情 / 负责人卡）
顶部固定卡片：左＝带额度圆环的大头像（2–3px 细缝，在线彩色/离线黑白）+ 名字 + 文字状态；右＝#特征标签七彩 chip（最多 5 个，其余「+N」）、剩余额度条、距额度恢复倒计时、最近 7 天调用柱图 + 成功率 + 平均耗时。下面是图标分段栏（`role=tablist/tab/tabpanel`，每格 ≥44px、`aria-label`、选中黄底描边、下方显示中文小标题、方向键/左右滑切换、记住上次标签 `agc-mtab`）。
标签排名（查看频率 × 重要程度）：① 简介（能做什么、擅长/不擅长/社区评价——每次打开都看，决定派不派）② 额度与用量（高频，但数字已在固定卡片图形化，这里放明细：每来源额度、按天用量、怎么拿更多）③ 历史项目（参加过的项目 + 打分记录，回溯用）④ 调用记录（模型调用 + 工具/技能调用，含「等你确认」的付费动作）⑤ 接入与能力（来源与连接方式、执行能力、可调用工具、数据限制、隐私、回调令牌——设置时才看）。大字最大两档时卡片比一屏还高，改为卡片随页滚动、分段栏单独吸顶（待用户决定 #1）。
后端：新表 `calls`（模型与工具每次调用：成员、房间、来源/工具、动作、结果、耗时、token），`/api/member/:id` 多返回 `stats`（7 天）、`calls`、`quota.resetAt`、`fc`、`gwFns`。

### 分类规则（用户 14:58）
- **模型 = 被调用的一方**：成员的来源（官方 API、中转站、公益站、Workers AI 账号绑定、自建端点）。Workers AI 从「工具与算力」移到「API 密钥 → 模型」（账号绑定，不用填 Key）。
- **工具 = 供成员调用的能力**：沙盒（E2B、Daytona、InstaBox）、网络（查网页）、云手机（Phonebox、Airtap）、浏览器（Freestyle）、电话号码（Saperly）。
- **真算力只算能跑自己代码/GPU 的平台**：Modal、Kaggle、Lightning、Lambda、Beam。
- **仅 Hark 可用**（不假装能接）：Hark 沙盒、Hark 浏览器、远程桌面、代理节点池、临时邮箱、Poke 手机号。

### 工具网关（`toolgw.js` + worker.js「工具网关」节）
- 支持函数调用的成员（OpenAI 兼容来源，`limits.tools !== false`）发言时带 OpenAI `tools`：`fetch_url`、`run_code`、`use_tool`；最多 2 轮工具调用；端点不支持 tools 时自动去掉重试。
- 已接（执行器端到端跑通）：查网页（免 Key）；E2B、Daytona 跑 Python/bash（一次性沙盒，跑完删除；沙盒实测记录 `steward-test/工具网关执行器实测-2026-10-23.txt`）。其余有 API 的工具：Key 填写 + 动作登记 + 风险等级 + 确认 + 上限 + 记录都已生效，执行器「待测」（不对外发请求）。
- Key 与模型 Key 同一套：页面粘贴 → AES-GCM 加密存 DO，只回末 4 位。
- 花钱/不可逆动作（开 GPU 实例、发短信、买号码等）先写「等你确认」，只能在网页（cookie）确认；每工具每日上限（付费类 ≤3），全部工具每日 100 次；敏感项目默认不调工具（设置可放开）。
- 工具卡（角色卡式）：调用方式、冷启动、免费额度与周期、当前剩余（官方没接口就写「无法自动查询」+ 官方用量页）、按本群用量估算还能用多久、到期、并发/速率、计费规则（**超额自动扣费醒目标出**），每张卡写核实日期和官方来源，核不到标「未核实」。
- 接口：`GET /api/tools`、`POST /api/tools/run`（cookie/操作员）、`POST /api/tools/confirm`（仅 cookie）、`GET /api/calls`。

### 主/副负责人（设置 → 负责人）
两种模式可混搭：**A 内置大脑**（下拉选成员里的模型，或自定义 OpenAI 兼容端点 + Key + 级别；服务端自己派工，派工前先读岗位说明书）；**B 配对码**（外部智能体接管）。也可选外部智能体成员（Telegram/Webhook/小桥）。主不可用（离线/额度用完/报错）→ 本轮交副并在群里写一句；外部负责人超时（默认 3 分钟，可调 1–30 分钟）→ 交副；已配对的副自动升为主（原主降为副）并在资源管家私聊通知；都不可用 → 回退 Hark 内置规则。敏感项目里负责人也按来源路由。接口：`GET/POST /api/lead`、`POST /api/lead/test`。

### 配对码 · 操作员令牌（**权限很大，只给信任的人/智能体**）
- 配对码在网页（设置 → 负责人 → 关联智能体，选「配给主/副」）生成，**不依赖任何特定 Hark 账号**；现任操作员也能为接任者生成（`POST /api/pair/new`）。每码 10 分钟、只能成功配对一次；可随时不限次数重新生成，新码生成时之前未用的码全部作废；新码配对成功前现任令牌不变。生成/作废/配对都写审计。
- 复制出去的是一段完整中文开场白（网址、操作技能链接、配对码、权限范围、复述确认、先问用户的事），不含个人信息。
- 对方（Hark、Poke、Manus 等任何能发 HTTPS 请求的智能体）`POST /api/pair {code,name,platform}` → 成员令牌（拉取任务/交回答）+ **操作员令牌**（`op_`+48 hex，只存 HMAC）+ MCP 地址 + 接入说明。网页显示「已关联：名称（平台）」。
- 操作员能：读房间/成员/资源库/调用记录、发消息、建项目、派任务、改阵容/状态/打分/互评、改负责人与设置（不能写 Key）、调工具（付费仍要网页确认）、为接任者生成配对码。不能：看/导出/改任何 Key、任何 DELETE、确认付费动作、看/吊销令牌、改 ACCESS_TOKEN。
- 激活：先 `GET /api/lead/brief`（岗位说明书 + 培训手册 + 状态快照）→ `POST /api/lead/ack`（≥20 字复述）才激活；副负责人令牌待命只读。主/副令牌各自独立、可在网页各自吊销；只对现任主/副有效，换人即作废。所有操作员请求写 `opaudit` 表，网页可看。
- 岗位说明书网页可编辑（`POST /api/lead/charter`，仅 cookie），默认版写在 worker `CHARTER_DEFAULT`；交接备注 `POST /api/lead/handoff-note`。
- 操作技能：`skills/ai-groupchat-operator.md`，公开地址 `/skills/ai-groupchat-operator.md`（deploy 时替换产品名）。
- 只能聊天、不能发网络请求的智能体不能当操作员负责人，改用 Telegram Bot / 小桥成员接入。WhatsApp：不做新连接器；可选方案是用对方自己的 WhatsApp 智能体（如 Poke）走配对码，或经 Telegram/小桥转发。

### MCP（推荐给支持 MCP 的客户端）
`POST /mcp`（Streamable HTTP，JSON 响应），`Authorization: Bearer <操作员令牌>`；21 个工具与操作员接口一一对应（`get_brief`、`ack_brief`、`create_project`、`run_turn`、`run_round`、`set_lead`、`new_pair_code` …），每个工具转成对本 Worker 自己接口的内部请求，权限与审计完全一致。已用官方 Python MCP 客户端实测（test_live）。网页设置里显示地址和一键复制的配置片段。

### Hark 连接器模板
「添加外部 AI成员」新增 Hark 模板（拉取模式），保存后弹出可复制给对方 Hark 的中文接入说明 + 「接手须知」（`/api/handoff`；成员令牌用 `/bridge/handoff`）。敏感项目默认不派给外部 Hark / 关联智能体（`route_policy.blockHark`）。

### 已取消
「主负责人私聊」（网页给负责人留言再由 Hark 拉取）按用户 15:59 取消；负责人给用户的通知写在资源管家置顶私聊里。

### 测试
`test_live.py --no-ai` 153 项、`ui_test.py` 64+ 项（含角色卡 sticky/tablist/记忆/大字、工具卡、负责人设置）；截图 `shots/v5-*`。

## 2026-10-24 v6（评审修复 / favicon 深色版 / 资源管家两档）
- **favicon**：`/favicon.svg` = `ICON_SVG` 同一图形，只把填充交给 SVG 内 `<style>`：浅色标签栏黑、`prefers-color-scheme:dark` 时白；`/favicon.ico` 同源。`/icon.svg`（PWA）与 PNG 版不变。
- **抽屉 Logo**：抽屉左上角改为内联定稿 Logo（路径同 ICON_SVG），`fill=currentColor` 跟随 `--ink`（浅黑深白）。
- **评审修复**：桌面 ≥1000px 隐藏顶栏铅笔（抽屉常驻已有「新项目」）；最近项目「进行中」小框 15px；对话页读屏 h1；侧栏当前项 `aria-current=page`。评审记录 `ui-research/review/v6-评审-2026-10-24.md`。
- **资源管家两档**：小档（分类/抽取）Groq `openai/gpt-oss-20b` → PM `glm-4.5-flash` → Workers AI `@cf/openai/gpt-oss-20b`，每天 ≤60 次（kv `steward_calls:<UTC日>`）；强档（到官方页核实免费额度/到期日）按 `STRONG_BASE` 初判分 + 岗位标签/状态/额度动态挑当天最强的免费成员（排除生图/视频、外部关联智能体、负责人专用、资源管家、付费来源），每天 ≤20 次（kv `steward_vcalls:<UTC日>`），失败依次降到小档、再到规则（官方页逐字比对原句）。模型给的原句必须真在官方页里才算「已核实」。`GET /api/steward/tiers` 看当天两档。
- **每周汇总**：英国时间周一 8 点后第一次 cron 生成（新增/更新/核实失败/14 天内到期），发资源管家私聊 + 通知主负责人；主负责人用操作员令牌 `GET /api/steward/weekly`、MCP `steward_weekly`，或 `get_brief` 的 `snapshot.stewardWeekly` 读取；页面 cookie 可 `POST /api/steward/weekly` 手动生成。
