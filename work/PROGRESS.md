# Aroomo 剩余 P1 + 界面清单 进度（Hark，2026-10-24 晚）
注意：18:38 BST 左右工作区被系统回滚到约 18:07 的快照（本地提交 8208041、若干脚本、线上备份文件丢失）；线上已部署的 8208041 不受影响。已按线上逐字节重建为本地提交 f5a7657（tag live-L1）。之后每步把关键产物同步到 /workspace/storage/backups/aroomo-p1-rest/。
基线：线上 003dee5；本机 fresh 基线 test_live 205/205、单测 19/19、ui_test 4 项失败（空数据：阵容条/资源管家私聊头部/朗读按钮/全局搜索）。
工具：/workspace/work/p1-rest/{fresh.sh,seq.sh,red.sh,red_ui.sh,deploy.sh,rollback.sh,prodtest.sh,deploy_prod.py,review/rv.py}

## L1（P0）—— 已上线（线上部署的提交 8208041 = 本地 f5a7657，page.html 与线上逐字节一致）
- 红：新 ui_test 打 003dee5 → L1 12 项全失败；绿：fresh 本机 test_live 205/205、单测 19/19、ui L1 12/12（另 4 项基线空数据）
- 复审：Groq+Agnes，Groq 全新上下文复核；采纳 2（--mainw 变量、max() 兜底）、驳回 6
- 线上（部署后）：test_live（含真实模型 /api/round、中文、互评）208/208；ui_test --round 全部通过（含 L1 12 项）
- 回滚：bash /workspace/work/p1-rest/rollback.sh 003dee5

## P1-2 网页成员 —— 已上线 104eb2c
- 红：新 test_live 打 003dee5 → 208/238（P1-2 30 条失败）；绿：fresh 本机 test_live 240/240、caps 19/19、p1 8/8、ui 4 项失败=基线空数据（L1 12 + P1-2 1 通过）
- 复审：review/p12_*.md、p12_rulings.md（采纳 5、驳回其余）
- 线上：test_live（含真实模型）243/243；ui_test --round 全部通过
- 线上部署前备份：/workspace/storage/backups/aroomo-live/live-pre-P1-2.multipart；回滚：rollback.sh f5a7657（= 8208041 内容）

## P1-3 点子库 —— 已上线 a0066ad → fix1 4382007（线上全绿）
- 红：新 test_live 打旧代码 241/252（P1-3 11 条失败，out/red_p13.txt）；单测【】替换先红 12/13
- 绿（fresh 本机）：caps 19/19、p1 13/13、test_live --no-ai 253/253、ui 仅基线 4 项空数据失败（P1-3 三项 + 抽屉五入口通过）
- 复审：review/p13_groq.md、p13_agnes.md、p13fresh_agnes.md（全新上下文；Groq 413 太大）→ p13_rulings.md：采纳 3（删点子同批执行；背景【】→「」；孤儿关联不成立但加回归测试），驳回其余
- 文档：docs/P1-3-改动说明.md；线上部署前备份 /workspace/storage/backups/aroomo-live/live-pre-P1-3.multipart
- 线上（a0066ad）：test_live 255/256（唯一失败 = P1-2 签到用例：当天早先测试的签到 kv 被同 id 重建成员继承 → 真缺陷，fix1 修）；ui_test --round 全部通过
- 回滚：bash rollback.sh 104eb2c
## P1-3 fix1 + 设计项 A/B/C 断言 —— 已上线 4382007
- 本机 fresh：caps 19/19、p1 13/13、test_live 254/254、ui 仅基线 4 项空数据失败（A/B/C 断言通过）
- 线上（4382007，含真实模型）：test_live 257/257；ui_test --round 全部通过（含设计项 A/B/C）
- 线上部署前备份 live-pre-P1-3fix1.multipart；回滚：bash rollback.sh a0066ad（或 104eb2c 回到 P1-2）
- saveAgent 新建时删除该 id 今天的 webcheckin 键；test_live +1（旧代码 253/254 红 → 新 254/254 绿）
- 设计项 A/B/C：代码里早已是 --head #c4651a / 深色 --line #efe9dc / #status 16px（104eb2c 起就在线上），本批只加 ui_test 断言锁定（本机 PASS）
- 复审 p13fix1_*.md：采纳 1（只删今天这条）、驳回 4（p13_rulings.md 末节）

## P1-4 主持模式+快速建项目（含 N2/N3/L7）—— 已上线 50b3073（线上全绿）
- 红：test_live 256/270（P1-4 14 条失败）、ui P1-4 4 项失败、p1 单测 13/18、「再来一轮解除暂停」旧代码 paused=True
- 绿（fresh 本机 p14c）：caps 19/19、p1 18/18、test_live --no-ai 271/271、ui 仅基线 4 项空数据失败（P1-4 四项通过）
- 复审：review/p14_groq.md、p14_agnes.md、p14front_groq.md、p14fresh_agnes.md → p14_rulings.md（采纳 3：再来一轮也解除暂停、说明 19px、方向键；驳回其余）
- 线上 39e3aa9：test_live（含真实模型）274/274；ui_test --round 1 项失败（新项目敏感开关）——原因是测试脚本等一轮结束用「发送键不再禁用」判断，而 P1-4 让进行中的发送键变成可点的「暂停」，测试提前放行、后面点「新项目」时页面仍在讨论中。按规矩立即回滚线上到 4382007（rollback.sh 4382007 已执行）。
- fix1：ui_test 改为等 busy 结束（只改测试，不改产品代码）
- fix1 本机：test_live 271/271、caps 19/19、p1 18/18、ui 仅基线 4 项；本机 ui_test --round 中「新项目敏感开关」通过（验证等待逻辑）
- 线上 50b3073（含真实模型）：test_live 274/274；ui_test --round 93 PASS / 0 FAIL「全部通过」
- 线上部署前备份：live-pre-P1-4.multipart、live-pre-P1-4fix1.multipart（=4382007 回滚后的线上）
- 回滚：bash rollback.sh 4382007（回到 P1-3）

## P1-5 主负责人代收资源 —— 已上线 ab151eb（线上全绿）
- 接口：POST /api/steward/submit {url?,text?,note?,source?}（只认已激活主负责人操作员令牌；访问令牌 Bearer/网页 cookie → 403；副负责人待命 → 403，升主后可用）；MCP submit_resource；GET /api/steward/submissions（subs 表）
- 流水线：库内已有 → duplicates；同一条 10 分钟内处理中 → 原子占位 subClaim 去重；链接 ingestLink、纯文字 ingestText（ingestPage 共用），官方页逐字核实才「已核实」；不发任何消息；条目 via=lead/via_by/via_note/via_src 同一条 INSERT 写入；每周汇总 counts.lead +「其中主负责人代收 N 条」
- 常驻规则：STANDING_RULES → get_brief.standingRules、MCP initialize instructions、配对开场白、skills/ai-groupchat-operator.md「常驻规则」节；配对成功页/已关联卡片提示「以后直接把链接发给负责人即可」（.pairtip 19px）
- 红：新 test_live 打 50b3073 → 278/295（P1-5 17 条失败，out/red_p15.txt）；新 ui_test 打 50b3073 → P1-5 卡片项失败（out/redui_p15.txt）
- 绿（fresh p15c）：caps 19/19、p1 18/18、test_live --no-ai 295/295、ui 仅基线 4 项空数据失败（P1-5 项通过）
- 复审：review/p15_groq.md、p15_agnes.md、p15fresh_groq.md、p15fresh_agnes.md → p15_rulings.md（采纳 3：sub_log→subs 表、原子占位、不删真实占位；驳回其余）
- 线上部署前备份 live-pre-P1-5.multipart（= 50b3073）；线上 ab151eb（含真实模型）test_live 298/298；ui_test --round 94 PASS「全部通过」
- 回滚：bash rollback.sh 50b3073

## P1-6 Cloudflare 额度保险 —— 本地全绿、线上未通过（已回滚，线上仍是 ab151eb）
- 97b3cd0（第 1、2 条）：GET /api/usage + 顶部用量胶囊（80% 提醒 / 100% 横幅）+ 1027 识别 + 发件箱（IndexedDB→localStorage，cid，待发送，自动补发）+ /api/start 按 cid 原子幂等；第 3 条只出方案 docs/P1-6-备用入口方案.md
  - 红：test_live 298/303（P1-6 5 条）、ui P1-6 三项失败；绿 p16c：caps 19/19、p1 18/18、test_live 303/303、ui 仅基线 4 项
  - 复审 review/p16_*.md → p16_rulings.md（采纳 4）
  - 部署前备份 live-pre-P1-6.multipart（= ab151eb）；部署 97b3cd0 后线上测试第一条就报「Exceeded allowed volume of requests in Durable Objects free tier」（DO 免费 10 万次/天被今天的多轮线上全测用穿，官方：每次 stub RPC 调用 = 1 次计费请求，UTC 0 点重置）→ 按规矩立即 rollback.sh ab151eb（已执行，script put True）。线上 DO 读写到 UTC 0 点（英国 01:00）前都不可用，与提交无关。
- fix1 9a9eaee（本地全绿，未部署）：根因修复——每个 Worker 请求只开一个 DO RPC 会话（ChatStore.session() 返回 RpcTarget + AsyncLocalStorage，需 compatibility_flags nodejs_als；deploy_prod.py 与 run_local.sh 已加）；用量同时统计 DO 请求（dos:<day>），按较高的算；前端识别 DO 额度用完报错 → 横幅 + 发件箱。
  - 红：新 test_live 打 97b3cd0 → 304/305（DO 用量项失败；会话数项旧代码空过 → 已改为要求 >0）；绿 p16f1b：caps 19/19、p1 18/18、test_live 305/305、ui 仅基线 4 项（DO 额度报错识别项通过）
  - 实测：一轮 test_live 4335 次 s.q → 382 个 DO 会话（约 11 倍降幅）
  - 复审 review/p16f1_*.md → p16f1_rulings.md（采纳 2，全新上下文复核全部驳回）
- 下一步（UTC 0 点 = 英国 01:00 之后）：bash 验收.sh usage 确认 DO 恢复 → backup_live.sh P1-6fix1 → deploy.sh 9a9eaee（deploy_prod.py 已带 nodejs_als）→ prodtest.sh 9a9eaee p16f1（线上只跑这一轮）→ 不全绿 rollback.sh ab151eb。部署后用 /api/usage 的 do.sessionsThisInstance / callsThisInstance 核对会话复用在线上生效。

## 未开始（下一位接手按顺序做）
- 界面建议清单第八节其余项（本轮未开始：线上 DO 额度用穿，当晚无法部署和线上验收）（L2–L10、C1、C2、C4、C5、M1–M5、N1、N4–N8、D1–D4、第六节、C3 开关）
工具：redui2.sh <旧提交> 8793 <tag>（UI 红）；killp.sh <端口…>（不要在同一条命令里写 pkill workerd，会把自己的 shell 杀掉）；red2.sh <旧提交> 8793 <tag>（两个 wrangler 不能同时跑，先 killp）；backup_live.sh <tag>；uiround_local.sh；验收.sh
