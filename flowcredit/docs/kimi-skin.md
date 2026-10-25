# Kimi 皮肤：实测色号与动效

这份文档记录 2026-10-25 在 kimi.com（1600×1000 首页 + 对话页）上直接读取的
计算样式，以及它们如何映射到 FCode。几何测量见 `desktop-design.md`；这里只写
颜色、圆角、阴影、字体与动效。

## 色号

| 用途 | Kimi 实测值 | FCode token |
| --- | --- | --- |
| 页面 / 侧栏画布 | `#FBFAF9` | `--canvas` |
| 次级面（用户气泡、卡片、悬停） | `#F5F5F5` | `--panel` / `--inset` |
| 主表面（输入框、菜单、新建对话） | `#FFFFFF` | `--raised` |
| 主文字 | `rgba(0,0,0,.90)` | `--text-1` |
| 次级文字 | `rgba(0,0,0,.60)` | `--text-2` |
| 弱化文字 / 侧栏历史标题 | `rgba(0,0,0,.45)` | `--text-3` |
| 禁用 / 占位 | `rgba(0,0,0,.30)` | `--text-4` |
| 分隔线 | `#00000021` ≈ `rgba(0,0,0,.13)` | `--line-strong` |
| 输入框边框 | `rgba(0,0,0,.09)`（对话页） | `--line` |
| 强调 / 焦点 / 链接 | `#1783FF` | `--accent` |
| 正向 | `#16C456` | `--ok`（正文用 `--ok-ink`） |
| 警告 | `#FF9500` | `--warn`（正文用 `--warn-ink`） |
| 危险 | `#FF3849` | `--bad`（正文用 `--bad-ink`） |

状态色只用于圆点、图标与细边框；正文仍用更深的 `--*-ink`，保持白底可读性。
`--accent` 换成 Kimi 蓝后，焦点环、链接和选中态自动跟随；发送键仍保持 Kimi
的黑色实心按钮。

## 圆角与阴影

| 组件 | Kimi 实测 | FCode |
| --- | --- | --- |
| 新建对话 | 40 高 / r12 / 0.5px `rgba(0,0,0,.13)` | `.side-new` |
| 导航行 | 36 高 / r8 / 0 8 内边距 | `.side-desk` / `.nav-item` |
| 历史对话行 | 28 高 / r8 / 文字 45% | `.chat-row` |
| 输入框 | 768×114 / r24 / 1px `.09` | `.composer-box` |
| 输入框阴影 | `0 4px 12px rgba(0,0,0,.03)` + `0 5px 16px -4px rgba(0,0,0,.07)` | `--shadow-stage` |
| 用户气泡 | r12 / padding 10×12 / `#F5F5F5` | `.chat-bubble` |
| 菜单 | r12 / 轻描边 / 软阴影 | `.tpl-menu` / `.model-menu` |

对话正文 16/26，编辑器 16/24，消息列 780，输入框 768；这些与 Kimi 的
`--markdown-B1_Content`、`.chat-editor-content`、`.chat-content-list` 一致。

## 浮窗锚点（模型 / 审批菜单）

Kimi 的模型浮窗（`.kimi-menu-positioner` + `.kimi-menu`）实测：

- **右缘与触发芯片右缘严格对齐**（浮窗 right 1198 == 芯片 right 1198），
  垂直间隙 4px（芯片下方 504 = 芯片底部 500 + 4）；
- 面板 290 宽、r16、无外边框，`inset 0 0 0 0.5px rgba(0,0,0,.13)` 的发丝描边
  加 `0 4px 16px rgba(0,0,0,.10)` 软阴影，内边距 8；
- 进入动画：`scale(.85) → 1`，原点取**离芯片最近的角**，opacity 同步，
  `.15s cubic-bezier(0,0,.2,1)`；
- 行结构：模型名 14/20（90% 黑）+ 描述 12/18（45%），标签色 `#1783FF`。

FCode 对应实现（`kimi.css`）：`#model-menu { right: 54px }`——54 = 操作行右
内边距 10 + 发送键 36 + 间距 8，即芯片右缘到输入框内缘的距离；审批浮窗镜像为
`left: 54px`。停靠态向上展开（视口底部没有向下空间），原点取右下 / 左下角。
480px 以下退回贴边，避免越出画布。

## 动效

Kimi 的动效很克制，只有三档：

| 场景 | 曲线 | FCode |
| --- | --- | --- |
| 背景 / 颜色 / 阴影 | `.15s` 线性（个别用 ease-in-out） | `--t` + 组件规则 |
| 图标底色 | `.3s ease-in-out` | `.c-btn` / `.c-icon` |
| 位移 / 缩放 / 透明度 | `.15s cubic-bezier(.23,1,.32,1)` | `--ease` |
| 侧栏开合 | `.3s ease-in-out` | `.sidebar` / `.sidebar-frame` |

具体符号：

- **5 点螺旋加载**：Kimi 的 `core-spiral-loading-dot-*` 只改变透明度
  （0.149 → 0.451），不上下跳。FCode 用 5 个 `<i>`、每点错开 `.12s`，
  `kimiDot 1.2s linear infinite`。
- **状态呼吸**：运行中的圆点用 `kimiPulse`（0.45 ↔ 0.85，alternate），
  取代原来的闪烁。
- **等待额度**：`chat-wait` 用渐变文字 `kimiShimmer`，对应 Kimi 的
  `shimmer` / `skeleton-loading`。
- **菜单进入**：`kimiFade`（透明度 + 4px 位移 + 0.99 缩放，`.15s`）。
- **新建对话图标**：悬停时放大 1.12；输入框的 “+” 悬停时旋转 90°，
  打开后换成 “×”；发送箭头悬停上移 1px。
- 所有动效都尊重 `body.reduce-motion` 与 `prefers-reduced-motion: reduce`。

## 加载顺序与边界

```text
app.css        令牌 + 外壳几何
design.css     组件视觉
chat.css       对话消息
desktop.css    Kimi 测量比例（html.desktop-app）
kimi.css       Kimi 色号 + 动效（最后加载，只覆盖皮肤）
```

`kimi.css` 不改变布局和治理语义：运行时间线、审批卡、预算、链验证仍是
FCode 自己的证据界面；Kimi 皮肤只负责外壳、对话、输入框和菜单。品牌标志、
FCode 的域模块与运行入口刻意保留，不做成 Kimi 的复制品。

## 验收

在 `http://127.0.0.1:8643/?desktop=1` 上逐页检查：

```sh
# 计算样式对比（body / sidebar / composer / bubble / send）
# 首页、对话、运行详情、设置、模型菜单、附加面板、900px 窄屏
```

浏览器实测：`body #FBFAF9`、`.sidebar #FBFAF9`、新建对话 `224×40 / r12`、
导航行 `224×36 / r8`、输入框 `768×114 / r24`、用户气泡 `#F5F5F5 / r12`、
助手正文 `16/26`、发送键 `36×36`；无控制台错误、窄屏无横向溢出。
