# P1-2 复审裁决（Groq gpt-oss-120b〔diff 前半，免费档 TPM 限制〕+ Agnes agnes-3.0-flash〔全文〕，对抗式）
| # | 来源 | 意见 | 裁决 | 处理 / 理由 |
|---|---|---|---|---|
| G1 | Groq | capsOf 按来源推断 web=true 是鉴权绕过 | 驳回 | web=true 是"限制"（不能当负责人），不是权限；来源只能由 members.json 或网页 cookie 写入 |
| G2 | Groq | srcState 里 ctx.relays 可能 undefined | 驳回 | 代码是 (ctx.relays \|\| []) |
| G3 | Groq | site 未校验协议/内网 | 驳回 | saveAgent 用 safeUrl（只收公网 https，拒 IP/本机/内网），members.json 是受信配置 |
| G4 | Groq | notice 拼 site 有 XSS | 驳回 | 前端 toast/消息一律 esc()；已核对 renderRelays、msgEl |
| G5 | Groq / Agnes3 | 前情里可能带产品名/敏感内容发给第三方网页 | 部分采纳 | 模板本身不写产品名和接口地址（单测断言）；用户原话不改写（改了会变意思）。**敏感项目不再发给网页成员**：新增来源级别 web=「第三方网页（经代发）」，敏感路由与中转站同样拦下并写审计（test_live 新增用例） |
| G6 | Groq | 返回结构与其他 async 不一致 | 驳回 | 字段与 dispatchAsync 其他分支相同（member/name/role/pending/task/notice/via） |
| G7 | Groq | ASYNC_KINDS 其他用处未处理 web | 采纳（顺带发现） | 核对 5 处：负责人/强档本来就排除；但 /bridge/pull（成员令牌）会按 member 取到网页任务 → 已改为排除 kind=web（新增用例） |
| A1 | Agnes | webSweep 先查后改，await 之间可能把已回传的任务重置 | 采纳 | 改派/失败/领取/回传全部改成条件更新 `… AND status/relay/claimed 未变 RETURNING id`，没改到就不写提示 |
| A2 | Agnes | 鉴权失败时遍历所有代发员算 HMAC | 采纳 | 删掉遍历；不带 relay 参数的回传按任务上的领取者鉴权 |
| A4 | Agnes | relay.name XSS | 驳回 | 前端所有位置 esc()；"经代发"标签是固定文字 |
| A6 | Agnes | 测试任务僵尸化 | 采纳 | 测试模式结束时作废测试期间排的网页任务并删测试代发员；任何网页任务排队超 24 小时标失败 |

## 全新上下文复核（Groq，只给补丁不给全文）
- 复核意见 1–3「path/rb/t 未定义、continue 不在循环里」：驳回——补丁只是替换片段，path/rb 是 handleHooks 作用域变量，t 是 for 循环里的 `const t = rows.find(...)`，`node --check` 通过且 test_live 全绿；复核员没看到上下文。
- 复核意见 4「错误返回格式不一致 / relay 可能为空」：驳回——全文件统一用 `[{error}, code]` 再 `json(o, c)`；进入 webReply 前已 `if (!relay) return 401`。
- 复核意见 5「s.q 可能返回 undefined」：驳回——ChatStore.q 固定返回 `.toArray()` 数组。
- 删掉遍历回退：复核员建议"保持原有回退遍历"——驳回（这正是 Agnes A2 指出的问题，回传改为按任务领取者鉴权）。
