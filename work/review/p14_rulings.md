# P1-4 复审裁决（Groq openai/gpt-oss-120b〔worker.js diff，免费档请求体上限，输出被 max_tokens 截断在第 4 条〕+ Agnes agnes-3.0-flash〔worker+p1+page 全 diff〕，对抗式只挑错）
鉴权前提：路由前统一鉴权（未登录 401）；cookie=网页、bearer=用户自己的令牌（与网页同权，Hark 内置负责人和用 ACCESS_TOKEN 的 MCP 也走它）、operator=主负责人令牌。

| # | 来源 | 意见 | 裁决 | 理由 / 处理 |
|---|---|---|---|---|
| G1 | Groq | @ 点名未校验成员身份，可召唤非项目成员 | 驳回 | parseMentions 只在本项目阵容（lineup）里匹配，单测覆盖「@路人甲」「a@kimi.com」不算；返回的 speakers 只来自 lineup |
| G2 | Groq | cookie/bearer 也能出决策题，应只许 operator | 驳回 | 规格是"负责人能出题、只有用户能拍板"；Hark 内置负责人和用 ACCESS_TOKEN 的 MCP 就是 bearer，禁掉会让内置负责人无法出题；用户自己出题无害 |
| G3/A1 | Groq/Agnes | pause 没有权限检查 | 驳回 | 全局鉴权已拦未登录；规格要求"你随时可暂停"（用户）且负责人可用 pause_project，所以三种身份都应能暂停/继续 |
| G4 | Groq | decide 的 msg 解析不严谨（输出截断） | 驳回 | Math.floor(+msg)||0 后再按 id+room+kind='decision' 查行，查不到 404；非数字 → 0 → 404 |
| A2 | Agnes | 幂等实现有竞态 | 驳回（Agnes 自己也撤回） | 条件 UPDATE … json_extract(v,'$.choice') IS NULL RETURNING 原子；DO 单线程同步 sql；note 只在第一次成功时写（test_live 断言只写一次） |
| A3 | Agnes | 多标签页同时暂停/继续可能重复启动 | 驳回（记为遗留） | 单用户应用；DO 串行处理 turn，最坏是同一位多说一次，不破坏数据；跨标签页协同不在 N2 规格内 |
| A4 | Agnes | quickLineup 排除 lead- 前缀是假设 | 驳回 | 与现有 cleanLineup 同一规则（lead- 是负责人槽位的保留前缀） |
| H1 | 自查（复审时顺带发现） | 暂停落在最后一位时 rest 为空，服务器仍处于暂停；之后点「再来一轮」（不带新消息）不解除暂停 → 每位都被跳过 | **采纳** | startRound 对已有项目的任何新一轮都清除暂停；新增 test_live 用例（旧代码直接复现为 paused=True：out/red_p14_again.txt；新代码绿） |

## 前端复审（Groq，只给 page.html diff，p14front_groq.md）
| # | 意见 | 裁决 | 理由 / 处理 |
|---|---|---|---|
| F1 | 模式说明 17px、「当前」15px 低于正文 19px | **采纳** | 用户硬规矩「正文 ≥19px」优先于清单 L7 写的 17px：说明改 19px（行高 1.45），「当前」标记 17px |
| F2 | 模式按钮触控区可能 <44px | 驳回 | .menu button 已有 min-height:56px；ui_test 实测每行 56px |
| F3 | 有的 setBusy 只传 2 个参数 → RUNNING=false | 驳回 | 这是有意的：只有 runRound 进行中才进入「暂停」态；ui_test 断言前后标签 |
| F4 | 快速建项目里 NP_SENS=false 让敏感标记失效 | 驳回 | NP_SENS 只是弹层渲染用的 UI 状态（与原「开始」按钮相同写法），敏感标记用 sensitive 参数传给服务器 |
| F5 | 单选组缺方向键导航 | **采纳** | 加上下/左右方向键在 5 个模式间移动焦点（按钮本身仍可 Tab） |
| F6 | sendLabel 拼 innerHTML 未转义 | 驳回 | st 只会是「暂停/继续/发送」三个常量 |
| F7 | 新动效没挂 prefers-reduced-motion | 驳回 | 本批没有新增动效（scrollTo 是原有逻辑，原本就按 :root.rm 处理平滑滚动） |

## 全新上下文复核（Agnes 新会话，p14fresh_agnes.md）
- 同意 G1/G2/G4/A2/A4 驳回与 H1 修法。
- 「pause/decide 没校验 bearer 对应用户是否拥有该房间（越权）」：驳回——单用户应用，ACCESS_TOKEN 只有一个且就是房主本人；没有"其他用户"。
- 「hostPick / parseMentions 边界」：复核员自己核对后撤回（rest[k.length]||'' 已处理末尾）。
