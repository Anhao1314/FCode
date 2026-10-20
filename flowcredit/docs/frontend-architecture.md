# 前端收敛：一个主区，三种模式

Phase 1+2 的第一刀已完成：删除重复的建单向导，统一入口，清理对应 CSS。
本轮**不改视觉 token、不改 SSE、不改运行状态**。

## 当前结构

```text
Sidebar（唯一导航）
Main（mode = run | intake | settings | ledger）
Rail（只随 run 出现）
Composer（run / intake）
Overlay（report / palette）
```

- 新建委托只有一个路径：`startIntake("")`。
- `#new-run`、composer `＋`、`⌘N`、palette「新委托」、空状态按钮、`/new` 全部进入需求确认。
- 设置、账本继续是主区模式，不是弹层。
- 报告和命令面板保留为浮层。
- 审批、判断记录留在行内。

## 本轮删除

- `#wizard-layer` 整块 HTML；
- `wizard` 状态、`openWizard`/`closeWizard`/`renderWizard`/`wizardNext`/`submitWizard`/`bindWizard`；
- palette 的「高级建单向导」；
- 向导相关 `.wizard-*` / `.wz-*` CSS；
- 旧设置弹层 `.settings-panel` 半径规则和 `.set-label` 映射。

净减约 **220 行**（JS 154、HTML 17、CSS 约 60）。

## 仍待收敛

1. `app.css` 仍有 Codex / Manus / 早期纸墨等历史层；下一步按“组件 vs 布局”迁移，而不是再加 override。
2. `app.js` 仍有 `currentTrace/currentCheck/live/sessions` 多份状态；下一步引入单一 store 和 `renderMode()`。
3. `main.innerHTML` 仍有多个直接写入点；下一步收敛到视图函数。
4. 75 个分散的 `addEventListener` 还未改为根委托。
5. 旧向导留下的历史注释需要随 CSS 清理一起删除。

## 约束

- 零构建、零第三方运行时依赖不变。
- 新样式只进 `design.css`；`app.css` 最终只保留布局。
- 收敛期间不改视觉效果；先保持像素稳定，再谈美化。
- 所有入口、键盘、空状态、窄屏都要重新验收。
