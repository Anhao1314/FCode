# 前端收敛：一个主区，一套状态

Phase 1–3 已完成。目标不是换视觉，而是把历史层收成一个可维护的结构：
**Paper & Proof 的外观不变，主区只有一个渲染入口，状态只有一个事实源，动态列表只挂一层事件。**

## 当前结构

```text
Sidebar（唯一导航）
Main（data-view = run | loading | error | intake | empty | ledger）
Settings（workspace 内的主区页面，打开时让位）
Rail（只随 run 出现）
Composer（run / intake）
Overlay（report / palette）
```

- 新建委托只有一个路径：`startIntake("")`。
- `#new-run`、composer `＋`、`⌘N`、palette「新委托」、空状态按钮、`/new` 全部进入需求确认。
- 设置、账本继续是主区模式，不是弹层；报告和命令面板保留为浮层。
- 审批、判断记录留在行内。

## Phase 1：删掉重复入口

- 删除 `#wizard-layer` 整块 HTML；
- 删除 `wizard` 状态与 `openWizard/closeWizard/renderWizard/wizardNext/submitWizard/bindWizard`；
- 删除 palette 的「高级建单向导」及 `.wizard-*` / `.wz-*` CSS；
- 净减约 **220 行**（JS 154、HTML 17、CSS 约 60）。

## Phase 2：主区写入与样式分层

- 全部主区写入收口到 `renderMain(html, { mode, scroll })`；16 个直接写入点归零。
- 主区带 `data-view`，同时记录 `store.mode`。
- 删除 app.css 的 3 个废弃 `:root`（约 33 条声明）；`design.css` 是唯一 token 入口。
- 补齐 `--accent` / `--accent-soft` / `--accent-fill` 三个别名。
- 删除 11 个无引用类和 21 处死 selector。

## Phase 3：结构收口

### CSS：布局与组件分离

- `app.css` **124 行**，只保留外壳结构：box-sizing、shell、侧栏/主区/右栏几何、滚动容器、浮层定位、状态行布局、结构性响应式规则。
- `design.css` **1,830 行**：`:root` token、自 app.css 迁入的组件层、Paper & Proof 覆盖层。
- 迁移按原顺序进行，Paper & Proof 规则仍在最后；声明多重集在删除废弃 `:root` 后与迁移前一致。
- `app.css` 不再含 `:root`、字号、颜色、字距、文本、圆角声明；所有 `var(--x)` 都在 `design.css` 中定义。

### State：单一 UI store

```js
const store = {
  key: null,        // 当前视图键
  sessionId: null,  // 当前激活会话 id
  trace: null,      // 非会话视图的 trace
  check: null,      // 当前链校验结果
  mode: "run",      // 最近一次主区模式
};

function activeSession() { ... }  // sessions.get(store.sessionId)
function shownTrace() { ... }     // 激活会话 trace，其次 store.trace
```

- 删除 `currentKey` / `currentTrace` / `currentCheck` / 模块级 `live`，旧状态引用为 **0**。
- `sessions` 仍是会话注册表，不是第二份 UI 状态。
- `store.trace` 与 `s.trace` 指向同一对象，不复制 trace。
- 删除会话时同时清理 `store.sessionId`；设置页关闭时恢复 `store.mode`。

### Interaction：容器委托

- `addEventListener` 从 **73** 降到 **38**。
- 动态列表的监听器全部收口到稳定容器：
  `#nav`、`#run-nav`、`#tabs`、`#rail-tabs`、`#rail-body`、`#palette`、`#tpl-menu`、`#approval-menu`、`#settings-page`、`#main`。
- 保留的监听器：4 个 SSE 事件、`pywebviewready`、`DOMContentLoaded`、输入框/搜索/rename 的输入事件、slash menu、拖放、全局键盘。
- 行内交互语义不变：双击重命名、两步删除确认、菜单互斥、Enter/Space 打开运行、Escape 关闭浮层。

### View：显式视图入口

```js
const MODE_ENTRY = {
  run: payload => render(payload.trace, payload.title),
  intake: () => renderIntake(),
  ledger: () => openLedger(),
  settings: () => openSettingsPage(),
};
function renderMode(mode, payload = {}) { ... }
```

- 导航入口只走 `renderMode`；`render` / `renderIntake` / `openLedger` / `openSettingsPage` 是具体实现，不反向调用，避免递归。
- 设置页是 workspace 内的页面，不用 `renderMain`，但会同步 `store.mode = "settings"`。

### Modules：零构建 ES module 边界

- 新增 `flowcredit/viewer/core/format.js`（45 行），用原生 ES module 导出纯函数：
  `canonical`、`sha256Hex`、`verifyChain`、`esc`、`pct`、`pp`、`num`、`shortHash`、`stripTags`。
- `app.js` 改为 `type="module"` 并从 `./core/format.js` 导入；无打包器、无第三方依赖。
- `report.js` 保持独立 classic script：报告必须是可离线打开的独立产物，刻意不依赖控制台。
- `icons-doodle.js` 保持 classic script，先于 module 执行，提供 `window.DOODLE_ICONS`。
- 桌面打包 `desktop/fcode.spec` 同步补齐 `design.css`、`icons-doodle.js` 与 `core/`；此前漏拷会导致桌面端没有 Paper & Proof 样式和手绘图标。

## 当前数字

| 项目 | 数值 |
| --- | --- |
| `app.js` | 4,622 行 |
| `design.css` | 1,830 行 |
| `app.css` | 124 行 |
| `core/format.js` | 45 行 |
| `index.html` | 333 行 |
| `main.innerHTML` 直接写入 | 1 处（`renderMain` 内） |
| 旧状态引用 | 0 |
| `addEventListener` | 38 |
| 后端测试 | 171 通过 |

## 仍待收敛

1. `app.js` 仍有 4,600+ 行；下一步按视图拆 module：run、intake、settings、ledger，各自只依赖 `core/format.js` 与共享 store。
2. `renderSettings()` 仍返回大段 HTML；拆视图时一并迁出。
3. `app.css` 保留了少量布局容器的背景/分隔线；若继续压缩，需要先定义“结构线”和“组件线”的边界。
4. `design.css` 仍有 6 处 `!important`，集中在减少动效与少量覆盖；拆视图后逐条确认能否删除。
5. 视觉验收目前靠浏览器逐页检查；可补一个零依赖截图基线脚本，但不要为了测试引入构建链。

## 约束

- 零构建、零第三方运行时依赖不变。
- 新样式只进 `design.css`；`app.css` 只保留布局。
- 收敛期间不改视觉效果；先保持像素稳定，再谈美化。
- 所有入口、键盘、空状态、窄屏都要重新验收。
- 事件链仍是唯一事实源；UI 状态必须能从 trace/events 重建。
