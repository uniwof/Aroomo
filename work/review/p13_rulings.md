# P1-3 点子库 复审裁决（Groq openai/gpt-oss-120b〔p13_groq.md〕+ Agnes agnes-3.0-flash〔p13_agnes.md，首跑因提示文件截断 UTF-8 失败，rv.py 改 errors=replace 后重跑成功〕，对抗式只挑错）
鉴权前提（核对 worker.js）：kind=cookie 网页登录；bearer=用户自己的 ACCESS_TOKEN（与网页同权，/api/agents 等同样不区分）；operator=主负责人令牌（受限：不能写 Key、不能删点子）。单用户应用，点子没有"拥有者"。

| # | 来源 | 意见 | 裁决 | 处理 / 理由 |
|---|---|---|---|---|
| G1 | Groq | webPrompt 的 background 未转义 → 提示注入 | 驳回 | background 是用户自己写的点子正文，按规格就是要原样给成员；"转义"只会改坏中文内容。敏感项目根本不发网页成员（P1-2 sens 拦截 web 级别，worker.js okSrc） |
| G2/A7 | Groq/Agnes | 关联点子缺权限校验（任意人可关联任意点子） | 驳回 | 能调 /api/start 的只有 cookie/bearer/operator 三种已授权身份；单用户，无点子归属概念 |
| G3/A5 | Groq/Agnes | ideaContext 对 notes 未转义/提示注入 | 驳回 | 同 G1；notes 由 writeback 写入，已限 1000 字/条、最多 50 条，ideaContext 只取最后 3 条且整体截 2000 字 |
| G4 | Groq | r.ideaCtx 返回前端可能 XSS | 驳回 | 前端不渲染 ideaCtx；点子详情的 title/text/rooms 全部走 esc()（page.html 1228–1229 已核对） |
| G5 | Groq | tags/notes 存 TEXT 当数组用、未序列化 | 驳回 | 写入一律 JSON.stringify，读取 ideaRow() JSON.parse（worker.js 1115、1120、1134、1557） |
| G6 | Groq | **删房间留下孤儿点子关联** | 驳回（已核实 + 加回归测试） | 关联存在 rooms.idea 列上，删房间是 DELETE FROM rooms 整行删除（worker.js 1500），点子侧没有反向引用表；项目数 ideaList 用 GROUP BY rooms 实时算、详情 rooms 实时查。回写的结论里留着项目名是"历史"，不是链接（前端不可点）。新增 test_live 用例「删项目不留孤儿关联」：删后详情不列已删项目、项目数归 0、结论保留 |
| G7 | Groq | webPrompt 新参数其他调用点没传 | 驳回 | 唯一调用点 dispatchAsync 已传；默认参数为空，单测覆盖空背景 |
| A1 | Agnes | getRoom 多一次点子查询，性能 | 驳回 | 主键查询，DO 内同步 SQLite 毫秒级；没关联点子的项目不查 |
| A2 | Agnes | 敏感项目向 operator 泄露背景 | 驳回 | operator 本来就能读点子库（规格：负责人可读/建/改）；敏感项目对第三方网页/中转站的拦截在路由层已有 |
| A3/A6 | Agnes | POST /api/ideas、writeback 缺鉴权 | 驳回 | 路由前统一鉴权，未登录 401；operator 可建/改/回写是规格要求，只有删除限网页（test_live 断言 Bearer 删除 → 403） |
| A4 | Agnes | 删点子的 UPDATE+DELETE 不在一个事务 | **采纳** | 改为 s.batch([...]) 同一同步块执行（DO SQLite 同一同步段内写入原子提交） |

## 全新上下文复核（Agnes 新会话，p13fresh_agnes.md；Groq 因免费档请求体上限 413 未能跑全文）
- 复核同意 G2/G4/G5/G6/G7/A1/A2/A3/A6 的驳回，同意 A4 的修法。
- 复核意见「G1/G3 驳回不当：notes.title/text 可含【前情】【输出格式】等，伪造提示分隔块」：**采纳**——ideaContext 输出里把【】统一换成「」（p1.js），新增单测（先红 12/13，后绿 13/13）。内容本身照原样保留，不做其他转义。
- 复核意见「writeback 的 rm0.title 未限长」：驳回——rooms.title 建房时已截 40 字（worker.js 833），notes 最多 50 条。
- 复核意见「body.idea=0 校验宽松」：驳回——String(0)='0' 不符合 ideaGet 的点子 id（查不到）→ 返回「没有这个点子」400。

## P1-3 fix1（线上全测暴露：签到用例在线上失败 255/256）
原因：线上当天早些时候的 P1-2 测试已给 x-webt 签到，kv `webcheckin:x-webt:<日期>` 在删成员后仍留着，同 id 重建的成员继承了「今天已签到」——测试数据暴露的真缺陷（删后重建同 id 的成员不该继承）。修法：saveAgent 新建时删掉该 id 今天的签到键。新增 test_live 用例：旧代码 253/254（红），新代码 254/254（绿）。另加 ui_test 断言锁定设计项 A/B/C。
复审（Groq + Agnes，p13fix1_*.md）：
- 「按前缀删会删掉历史签到」：采纳——改为只删今天这一条（kvDel）。
- 「删+插不在事务里」：驳回——DO 单线程同步 sql.exec，同一请求内无交错；且删的是已删除成员的旧状态，插入失败也不需要恢复它。
- 「!prev 判定过宽」：驳回——prev 是查询行对象或 undefined，不会是 0/空串。
- 「ui 颜色字符串格式不稳」：驳回——已 trim().toLowerCase()，背景色 rgb() 格式 Chromium 固定；唯一测试浏览器是 Chromium。
- 「删除后读取可能未持久化，需 sleep」：驳回——DO SQLite 同步写，后续请求必然看到。
全新上下文复核：两位审查员各自独立给出同一条（历史签到），已采纳；其余意见互不重合，不再另开第三轮。
