# 给接手 Hark 的开场说明（Aroomo · AI 成员群聊）

> 2026-10-25 01:15 BST 由原 Hark 更新（替换 10-23 版）。原 Hark 额度用完，由你接手开发。读完本文再动手。

## 0. 你要接手什么
用户 Roman Diya 的网页版「AI 公司」群聊，产品名 **Aroomo**，线上 https://chat.pcmanai.com/ （Cloudflare Worker `ai-groupchat`，用户主账号 tifni023@gmail.com，自定义域，workers.dev 已关）。
把用户能免费用的模型/智能体做成「AI 成员」，按擅长岗位 × 剩余额度 × 在线状态派活；负责人主持，成员互评打分。

**线上当前提交：`ab151eb`（P1-5）。下一步：部署 `9a9eaee`（P1-6 fix1），再做界面清单。**

## 1. 和用户相处的规矩（必须遵守）
1. 简体中文；用户有眼疾，**少发消息，结果一次说清楚**，每批交付附可直接执行的验收脚本。
2. 不自我辩解、不写防御性措辞；不确定也给出标注过的判断。
3. 隐私第一：密钥、令牌绝不出现在消息、文档、仓库里。
4. 付费、命名、Logo、域名购买必须用户拍板。**免费优先**，不升级付费版。
5. 动手前先调研同类（先查 Aroomo 自己的仓库/资源库，再查 GitHub ≥500 星、活跃、许可证明确的项目），定稿前让 Groq、Agnes 做**反对式评审**（要求只挑错、不附和；我方不同意要反驳；逐条裁决写进 review/）。
6. 用户长时间没回复时可以继续做下一批，付费和命名仍要问。
7. Grok 目前没额度，不要交接给 Grok。

## 2. 绝对不能改
Logo、漫画杂志风（粗描边、硬投影、黄色按钮、橙色波浪顶栏、贴纸）、珊瑚主色、额度圆环（在线彩色头像 / 离线黑白头像，头像与圆环留细缝）、产品名 Aroomo。正文字号 ≥19px；新动效必须挂在 `prefers-reduced-motion` 和应用内 `:root.rm` 规则下。

## 3. 先读顺序（都在本交接包里）
1. `repo/` 源码（git 仓库，`git log` 可看全部提交说明）。也可以用 `aroomo-main.bundle` 执行 `git clone aroomo-main.bundle aroomo`。
2. `work/PROGRESS.md`：每一项的红绿测试数字、复审结论、回滚点。**最权威的进度记录。**
3. `ux-advice/建议清单.md`：用户已批准的界面/功能改进清单，第八节是优先级。
4. `repo/docs/P1-*-改动说明.md`、`repo/docs/P1-6-备用入口方案.md`
5. `repo/00-交接文档-HANDOFF.md`（全部需求）、`repo/README.md`、`repo/skills/ai-groupchat-operator.md`
6. `work/review/`：每批的 Groq/Agnes 原文与裁决。

## 4. 已上线（线上全测都通过）
| 项 | 提交 | 线上测试 |
|---|---|---|
| P1-1 服务端配对资格、防 Key 外泄等 | 003dee5 | 208/208 |
| L1 桌面 1000–1476px 侧栏盖住内容（P0） | 8208041（= f5a7657） | 全过 |
| P1-2 网页成员（代发队列） | 104eb2c | 243/243 |
| P1-3 点子库 + 设计 A/B/C 锁定 | 4382007 | 257/257 |
| P1-4 主持模式、快速建项目、暂停/继续、消息内决策按钮、模式说明 | 50b3073 | 274/274，ui --round 93/0 |
| P1-5 主负责人代收资源 submit_resource | **ab151eb（当前线上）** | 298/298，ui --round 94/0 |

## 5. 待办（按顺序）
1. **部署 P1-6 fix1 `9a9eaee`**（本地 test_live 305/305 全绿）：
   - 先确认 Cloudflare DO 当天额度已恢复（UTC 0 点重置）；
   - 部署前备份线上脚本；部署后只跑**一轮**线上全测（含真实模型）+ `ui_test.py --round`；
   - 不全绿就回滚到 `ab151eb`；
   - 部署后用 `/api/usage` 的 `do.sessionsThisInstance / callsThisInstance` 核对会话复用已生效；
   - **需要 `compatibility_flags = ["nodejs_als"]`**。
2. **界面清单**（`ux-advice/建议清单.md` 第八节）：L2、L3+D4（结论卡+自动状态）、M2、M3、L5+C5+D2、C1（选中改浅橙 #f9e6d8，状态胶囊中性，只有「待你确认」用黄，黄色按钮不动）、N1、D1（清线上测试数据，**不得删审计日志**）、C2、L6、L4、L9、L8、L10、M1、M4、M5、N4–N8、C4、第六节八维度。C3 柔和气泡做成设置开关，`prefers-contrast: more` 时自动开，其余默认关（默认值等用户定）。尽量合成少数几批上线，省额度。
3. P1-6 第 3 条备用入口：只有方案，等用户提供第二个免费 CF 账号和限权令牌（Workers Scripts: Edit + Account Settings: Read）。

## 6. 每批硬性流程
先备份 → TDD 红绿（先证明新用例在旧代码上失败）→ 本地 `npx wrangler dev --local` → `test_live.py --no-ai`、`ui_test.py`、`tests/caps` 与 `tests/p1.test.mjs` 单测全绿 → Groq + Agnes 对抗式复审 + 全新上下文复核，逐条裁决 → 全绿才部署 → 部署前备份线上 → 部署后线上真实模型测试 + `ui_test.py --round` → 不全绿立即回滚。

## 7. 缺点和坑（一定要看）
**额度**
- Cloudflare DO 免费版每天 10 万次请求，UTC 0 点重置；10-24 晚因一天跑了多轮线上全测被用穿，网站停了几小时。规矩：**当天用量超过 50% 就停止部署和线上全测**；每次部署只跑一轮全测。fix1 上线后用量约降到原来的 1/11。
- Workers AI 免费额度整个主账号共用（其他 Worker 也用），用量胶囊里的数是本站自计约值，以 Cloudflare 后台为准。
- Groq 免费档每分钟 8000 token，大 diff 会 413 / 截断，要拆开送审。

**部署**
- **不要用仓库里的 `deploy.py`**，它会重写绑定。原 Hark 用的是 `work/deploy_prod.py`（multipart 上传 worker.js + members.js/logos.js/resources.js/pwa.js/toolgw.js/caps.js/p1.js/opskill.js/training.js + page.html）。
- **大坑：脚本上传会带上全部 secret 绑定**：ACCESS_TOKEN、GROQ/NVIDIA/GEMINI/AGNES/POKE/HAPPYCODING/VYCE/PM 的 API Key、TELEGRAM_BOT_TOKEN、AGENT_* 。原 Hark 从它沙盒里的私密文件读这些值，**你那边没有这个文件**。如果直接整包上传，又不带这些值，线上的 Key 会被清掉，外部成员全部掉线、登录令牌失效。请改用「保留已有 secret」的方式：Cloudflare 上传 metadata 加 `"keep_bindings": ["secret_text"]`，或用 `wrangler deploy`（不动已有 secret）。只有新增 Key 时才 `wrangler secret put`。先在 Cloudflare 后台确认现有绑定清单，再部署。
- 需要用户提供 Cloudflare API 令牌（主账号，只给 Workers Scripts: Edit 权限，可加 Account Settings: Read），用你那边的安全登录/保险库收，不要让用户贴在聊天里。
- 本机：同一条命令里不要写 `pkill workerd`（会把自己的 shell 杀掉）；两个 wrangler 实例不能同时跑。
- 原 Hark 的工作区曾被平台回滚过一次，丢过本地提交。每完成一项就把 bundle、补丁、进度备份到网盘。

**产品已知问题**
- 本机 `ui_test.py` 固定有 4 项失败（阵容条、资源管家私聊头部、朗读按钮、全局搜索），原因是本机空库没数据；线上全过。这是基线，不是回归。
- P1-2 网页成员要用户先在设置里登记一个「网页代发员」才会真正运行；代发员执行端不在本仓库。
- 主持模式的自动点名是规则挑人，没接外部负责人的模型（外部负责人可用 `run_turn` 自己点名）。
- 多个标签页同时暂停/继续同一个项目没有做协同。
- 发件箱补发成功的消息不会自动触发成员回应，要点「再来一轮」。
- 删除正在当负责人的成员后，该槽位显示「未设置」（回退副负责人/Hark）。
- 候选池同一模型并发确认，理论上可能多出一张卡（未复现）。
- 线上还有测试数据（测试甲/乙/丙、重复的测试项目），清理在 D1，不能删审计日志。
- 界面清单 N1 提到的「读消息时被强制拉到底部」是读代码得出的（`refreshRoom()` 每次都 scrollTo），没实测。

## 8. 你需要向用户要的东西（都走你那边的安全表单）
1. Cloudflare 主账号的 API 令牌（Workers 编辑权限）。
2. Aroomo 的登录链接 / 访问令牌（用户自己有，或在 Cloudflare 后台看 ACCESS_TOKEN 绑定）——测试脚本 `test_live.py` 用环境变量 `AGC_BASE`、`AGC_TOKEN`。
3. 跑真实模型测试和复审要用的 Groq、Agnes API Key。

## 9. 测试命令（在仓库根目录）
```
# 本机
npx wrangler dev --local --port 8793        # 先建 .dev.vars（ACCESS_TOKEN=任意值），不要提交
AGC_BASE=http://127.0.0.1:8793 AGC_TOKEN=<本地令牌> python3 test_live.py --no-ai
AGC_BASE=http://127.0.0.1:8793 AGC_TOKEN=<本地令牌> python3 ui_test.py
node --test tests/
# 线上（耗额度，先看用量）
curl -H "Authorization: Bearer <令牌>" https://chat.pcmanai.com/api/usage
AGC_BASE=https://chat.pcmanai.com AGC_TOKEN=<令牌> python3 test_live.py
AGC_BASE=https://chat.pcmanai.com AGC_TOKEN=<令牌> python3 ui_test.py --round
```
`work/` 里的 .sh 脚本是原 Hark 沙盒的路径和代理写法，**只作参考，要改路径后才能用**。
