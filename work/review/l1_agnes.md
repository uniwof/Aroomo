<!-- model=agnes-3.0-flash secs=51 usage={'completion_tokens': 4000, 'prompt_tokens': 3120, 'total_tokens': 7120} -->
**文件/函数**：`page.html` / 新增的 `@media (min-width:1200px){main{...}}` 规则

**问题**：断点逻辑错误（未覆盖 1200-1476px 场景）

**为什么是问题**：
背景中提到原 Bug 是 "1000–1476px 宽时内容被侧栏盖住"。
新 CSS 规则：
```css
@media (min-width:1200px){
  main{
    margin-left: calc(var(--side) + max(0px, (100% - var(--side) - 900px) / 2));
    margin-right: 0
  }
}
```
当视口宽度 `W` 满足 `1200 <= W <= 1476` 时：
`100% - 288px (side) - 900px` 的值 <= 0。
`max(0, 负数)` 结果为 `0`。
`margin-left` 变为 `288px + 0 = 288px`。
此时 `main` 的左边缘紧贴侧栏右边缘。
但是，`main` 内部有 `padding: 4px 16px`。
如果设计意图是“侧栏和主内容之间至少有 16px 间距”（如测试代码中 `h1 >= L['dRight'] + 16` 暗示），那么 `main` 的 `padding-left` 提供了 16px，看似满足。
**但是**，请注意 `header.top` 和 `footer.composer` 在 1200px+ 时设置了 `margin-left: var(--side)`。
`footer.composer` 内部 `.cbox` 是 `max-width: 880px; margin: 0 auto`。
`main` 是 `max-width: 900px`。
在 1200px 宽度时：
可用宽度 = 1200 - 288 = 912px。
`main` 的 `margin-left` = 288。`main` 占据 288 到 1200 (实际上 max-width 900，所以占据 288 到 1188，右边留白 12px？不对，`margin-right:0` 且 `max-width` 限制，`margin: 0 auto` 被覆盖为 `margin-left: calc(...)`, `margin-right: 0`。
等等，`main{margin:0 auto}` 是默认。
新规则 `margin-left: calc(...)`, `margin-right: 0`。
在 1200px 时，`margin-left` = 288。`main` 宽度受 `max-width: 900px` 限制。
`main` 实际渲染宽度 = min(900, 1200-288) = 900px。
`main` 占据横向 [288, 1188]。
`footer.composer` `margin-left: 288`。可用宽度 912px。
`.cbox` 宽度 880px，居中于 [288, 1188] 容器内。
`.cbox` 左边缘 = 288 + (912-880)/2 = 288 + 16 = 304。
`main` 的 `padding-left` 是 16px。内容区（如 h1）左边缘 = 288 (main left) + 16 (padding) = 304。
两者对齐。
**然而，问题在于 1000-1199px 区间。**
注释说 “1000–1199 走抽屉”。
在 1000-1199px 时，`wide()` 返回 false。抽屉行为？
CSS 中，`@media (min-width:1200px)` 才让 `#drawer` 常驻（`transform:none`）。
那么在 1000-1199px 时，`#drawer` 的默认样式是什么？
看 diff 上下文：
`#drawer.open{transform:none...}` 是默认隐藏状态被打开的效果。
通常抽屉默认是 `transform: translateX(-100%)` 或类似。
如果 1000-1199px 走抽屉，那么 `main` 的 margin-left 是多少？
`main{max-width:900px;margin:0 auto...}`。
在 1000px 时，`main` 宽度 900，居中。左边距 (1000-900)/2 = 50px。
抽屉是 `position: fixed` 或 `absolute`？
通常抽屉是 overlay。
如果抽屉在 1000-1199px 不占位（overlay），那么 `main` 正常居中即可。
**但是**，测试代码 `ui_test.py` 中：
```python
for W in (1000, 1100, 1199, 1200, ...):
    ...
    if W >= 1200:
        # 检查侧栏常驻
    else:
        # 检查抽屉收起
        ok = ... and L['mainL'] >= 0 ...
```
在 W=1000 时，`mainL` (main 的 left) 是多少？
`main` `max-width` 900。视口 1000。
`margin: 0 auto`。
`margin-left` = (1000 - 900) / 2 = 50px。
`mainL` = 50。
条件 `L['mainL'] >= 0` 满足。
**潜在错误点：`calc` 中的 `100%` 参考系。**
`main` 的 `margin-left` 使用 `calc(...)`。
`100%` 在 `margin` 中通常指父元素（`body` 或 `html`）的宽度，即视口宽度。
`var(--side)` 是 288px。
`900px` 是 `main` 的 `max-width`。
公式：`margin-left = 288 + max(0, (Viewport - 288 - 900) / 2)`。
当 Viewport = 1200: `288 + 0 = 288`。
当 Viewport = 1476: `288 + (1476 - 288 - 900)/2 = 288 + (288)/2 = 288 + 144 = 432`。
`main` 左边缘 432。`main` 宽度 900。右边缘 1332。
视口 1476。右边留白 `1476 - 1332 = 144`。
左边（侧栏右边）到 `main` 左边缘距离：`432 - 288 = 144`。
左右对称。这是正确的居中逻辑（在侧栏右侧区域居中）。
**但是，有一个严重的 CSS 兼容性和渲染问题：**
`margin-left` 中使用了 `max()` 函数。
`max()` 是 CSS 数学函数，支持度目前较好，但需要注意 `calc()` 嵌套。
更重要的是：**`margin` 属性中的 `100%` 是指父元素的内容宽度还是边框宽度？**
对于 `margin`，`%` 是相对于包含块的宽度（Content Width）。
如果 `body` 或 `html` 有边框或 padding，计算会出错。通常假设没有。
**最关键的错误：`margin-right: 0` 导致不对称或覆盖失效。**
原规则 `main{margin: 0 auto}`。
新规则 `@media (min-width:1200px){main{margin-left: calc(...); margin-right: 0}}`。
这只设置了 `margin-left` 和 `margin-right`。
`margin-top` 和 `margin-bottom` 继承自 `main{margin: 0 auto...}` 中的 `0`。这没问题。
**然而，`margin-right: 0` 是错误的。**
如果 `main` 的 `max-width` 是 900px，且视口很大（比如 1920px）。
`margin-left` = 288 + (1920 - 288 - 900)/2 = 288 + 366 = 654。
`main` 左边缘 654。
`main` 右边缘 654 + 900 = 1554。
视口 1920。
右边留白 1920 - 1554 = 366。
左边（侧栏右边 288）到 `main` 左边缘 654。距离 366。
左右对称。
此时 `margin-right: 0` 并没有“生效”为 0 像素的视觉效果，因为 `max-width` 限制了宽度，且 `margin-left` 推开了它。
但是，如果 `margin-right` 真的被设为 0，而 `margin-left` 很大，布局引擎如何处理？
Block 级元素的 `margin` 计算：
如果 `width` 是 auto (这里受 max-width 限制，相当于 width 固定或受限)，且 `margin-left` 和 `margin-right` 都是固定值（非 auto），则盒子宽度由这些值决定。
这里 `width` 实际上是由 `max-width` 和父容器宽度决定的。
`margin-left` 是 calc 值。`margin-right` 是 0。
`margin-top/bottom` 是 0。
`padding` 是 `4px 16px ...`。
`border` 0。
`width` (content) = min(max-width, container_width - margin_left - margin_right - padding - border)。
Container width = Viewport - Side (288).
Container = V - 288.
Content = min(900, V - 288 - ML - 0 - 32).
ML = 288 + max(0, (V - 1188)/2).
Case 1: V > 1188.
ML = 288 + (V - 1188)/2 = 288 + V/2 - 594 = V/2 - 306.
Content = min(900, V - 288 - (V/2 - 306) - 32) = min(900, V/2 - 14).
如果 V = 1920. Content = min(900, 960 - 14) = 900.
`margin-right` 虽然定义为 0，但在 BFC 或常规流中，如果 `width` 被 `max-width` 锁定，且 `margin-left` 推到了左侧，`margin-right` 的值并不直接决定右边的空白，因为 `width` 没有拉伸到填满右边。
**但是，问题出在 `main` 的 `margin: 0 auto` 原始规则。**
`auto` 意味着 `margin-left` 和 `margin-right` 相等以居中。
新规则覆盖了 `margin-left` 和 `margin-right`。
`margin-right` 被显式设为 `0`。
如果 `Content` 宽度小于 `Container` 宽度，`margin-right` 为 0 意味着盒子紧贴容器左边界（由 `margin-left` 决定）之后，右边没有额外的 margin 推挤。
但在上述计算中，`margin-left` 是动态计算的，目的是让盒子在 `(Side, Viewport)` 之间居中。
让我们重新验证居中逻辑。
目标：盒子在 `[288, V]` 区间内居中。
区间宽度 `W_area = V - 288`.
盒子宽度 `W_box = 900` (假设未受 padding 影响过大，或者说 900 是 content width)。
所需 `margin-left` (相对于 body/html) = 288 + (W_area - W_box) / 2.
= 288 + (V - 288 - 900) / 2.
这正是代码中的 `calc` 公式（当 V > 1188）。
如果 `margin-right` 设为 0，盒子右边就是 `Left + 900`.
右边剩余空间 = V - (Left + 900) = V - (288 + (V-1188)/2 + 900)
= V - 1188 - V/2 + 594 = V/2 - 594.
左边（侧栏后）剩余空间 = Left - 288 = (V-1188)/2.
若 V=1400.
Left margin from 288 = (1400-1188)/2 = 106.
Right margin from V = 1400/2 - 594 = 700 - 594 = 106.
对称。
所以 `margin-right: 0` 在这里是**必要且正确**的，为了打破 `auto` 的居中性，配合特定的 `margin-left`。

**那么，真正的错误在哪里？**

1.  **`max()` 函数在 `calc()` 中的兼容性/渲染陷阱**：
    虽然现代浏览器支持，但某些旧环境或特定引擎（如某些 Webview）可能不支持 `max()`。如果 `max()` 不被支持，整个 `calc` 表达式失效，`margin-left` 变为 0 或自动值。如果变为 0，则 `main` 紧贴侧栏，可能被盖住或无间距。
    *把握度：中*（取决于目标浏览器范围，但作为 P0 修复，这是风险）。

2.  **`footer.composer` 的对齐问题**：
    `footer.composer` 有 `margin-left: var(--side)` (288px)。
    其内部 `.cbox` `max-width: 880px; margin: 0 auto`。
    在 V=1200 时：
    Footer 可用宽度 = 1200 - 288 = 912。
    `.cbox` 宽度 880。
    `.cbox` 左边距 (相对于 footer) = (912 - 880) / 2 = 16。
    `.cbox` 绝对左边 = 288 + 16 = 304。
    `main` 的 `margin-left` (V=1200) = 288 + 0 = 288。
    `main` 的 `padding-left` = 16。
    `main` 内容（h1 等）绝对左边 = 288 + 16 = 304。
    对齐完美。
    
    在 V=1400 时：
    Footer 可用宽度 = 1400 - 288 = 1112。
    `.cbox` 宽度 880。
    `.cbox` 左边距 (相对于 footer) = (1112 - 880) / 2 = 116。
    `.cbox` 绝对左边 = 288 + 116 = 404。
    `main` 的 `margin-left` = 288 + (1400 - 1188) / 2 = 288 + 106 = 394。
    `main` 的 `padding-left` = 16。
    `main` 内容绝对左边 = 394 + 16 = 410。
    **410 vs 404。差异 6px。**
    测试要求：`abs(L['mc'] - L['cc']) <= 4`。
    `mc` 是 `main` 内容中心？
    测试代码：`mc: Math.round(mn.left+mn.width/2)`。`mn` 是 `main` 的 boundingRect。
    `main` 宽度是 900 (max-width) 还是实际渲染宽度？
    `main` 的 `getBoundingClientRect` 包含 padding。
    `main` 宽度 = 900 (content) + 32 (padding) = 932px?
    不，`max-width` 通常作用于 content-box 或 border-box 取决于 `box-sizing`。
    假设 `* { box-sizing: border-box }` (常见默认或重置)。
    如果 `box-sizing: border-box`，`main` 总宽度 = 900。
    Padding 16+16=32。Content width = 868。
    
    让我们重新计算中心点。
    **假设 `box-sizing: border-box`**：
    V=1400.
    `main`