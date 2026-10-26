# L1 复审裁决（Groq gpt-oss-120b + Agnes agnes-3.0-flash 对抗式；Groq 全新上下文复核）
（原文件在工作区回滚中丢失，按当时裁决重写；Groq 原始输出同样丢失，只有 Agnes 原文 l1_agnes.md 保留）
| # | 来源 | 意见 | 裁决 | 依据 |
|---|---|---|---|---|
| 1 | Groq | main 只设 margin-left、margin-right:0 会右侧溢出/不对称 | 驳回 | 实测 1200/1280/1440 横向溢出 0；聊天页 main 中心 744/784/864 = 输入框中心；Agnes 推导同结论 |
| 2 | Groq（两次） | footer.composer/header 失去或"双倍"左偏移 | 驳回 | diff 只把 main 移出该选择器；实测中心一致 |
| 3 | Groq（两次） | 还有 1000px 断点 | 驳回 | grep 无残留；JS wide() 已同步 1200 |
| 4 | Groq | 900px 硬编码 | 采纳 | --mainw 变量 |
| 5 | Groq | 放大后断点变化 | 驳回 | 放大使视口变窄 → 走抽屉，正是要的 |
| 6 | Groq | 滚动条使 100% 偏小 | 驳回 | margin 百分比按包含块；实测中心差 0 |
| 7 | Groq 复核 | max() 旧浏览器不支持 | 采纳 | 先写 margin-left:var(--side) 兜底 |
| 8 | Groq | 测试加 DPR 1.5/2 | 驳回 | 布局与 DPR 无关 |
