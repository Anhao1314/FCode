# Fcode · flowcredit console — 实时 Agent 控制台

一个零依赖、零构建、可离线的 flowcredit agent 控制台（界面里的 agent 名字是 **Fcode**）：既能**真实运行任务**（接到 Python Runtime 上，
事件流式进入页面），也能**只读回放**已签名的 trace。形态为「对话主视图 + 右侧常驻证据栏」，
客户端只是 index.html + app.css + app.js + report.js 四个静态文件，由标准库 server 直接托管。

```
flowcredit/viewer/
  index.html          ← 前端外壳（零依赖、零构建）
  app.css             ← 静默化设计系统：颜色只表达状态语义，层级靠间距与字重
  app.js              ← 全部前端逻辑（回放 / 直播 / 建单向导 / 运行管理）
  report.js           ← 自包含审计报告生成器（结论 / 账单 / 证据 / 人工决定 / 链附录）
  server.py           ← 本地控制台服务（标准库）：静态文件 + JSON/SSE API + 运行管理
  traces/             ← 7 个演示场景的 trace JSON（随仓库提供，可重新生成）
  runs/               ← 每次真实运行的产物（task.sqlite + trace.json + meta.json，不入库）
  docs/console-live.png
  README.md
```

## 快速开始

在仓库根目录：

```sh
python3 flowcredit/viewer/server.py --repo . --pace 0.7
# 浏览器打开 http://127.0.0.1:8642/
```

- `--pace 0.7`：每轮模拟思考时长（秒），默认 0.7，`0` 则全速跑完；
- `--approval-timeout 300`：审批等待秒数，超时自动拒绝（默认 300）；
- `--repo` 指向仓库根（`flowcredit/src` 所在的位置），也可以用 `FLOWAGENT_REPO` 环境变量；
- 找不到 runtime 时服务仍然可用：页面退化为**静态回放模式**（composer 禁用），`/api/health` 会说明原因；
- 只想要静态回放：`cd flowcredit && python demo.py --serve`（打开 `viewer/index.html`，无实时运行）。

## 它能做什么

```
┌──────────────┬──────────────────────────────────┬──────────────────┐
│ ＋ ↓ ↺  ⌘K   │ 运行 · 预算耗尽 [corpus][task] ✔ 链验证通过 · 24 events │ 事件 │ 链 │ 原始 │
│──────────────│──────────────────────────────────│──────────────────│
│ 运行记录 搜索 │  任务 · console-operator          │ #1 ● task_created│
│ ☆ 演示·预算  │  «你输入的目标文本»               │ #2 ● model_started│
│ ● 判断恒星…  │  ┌ Plan ────────────────────────┐ │ #3 ● plan_validated│
│──────────────│  └──────────────────────────────┘ │ …                │
│ 演示场景     │  ┌ 预算 calls ▓▓░ 4/12 · reads… ┐ │                  │
│ ● 完整研究   │  #4 read_document(doc_fy2024) PASS │                  │
│ ● 越权工具   │     ⎿ FY2024 · 万元 · IFRS（折叠行）│                 │
│ ● 预算耗尽   │  #5 未完成的轮次        TERMINATED │                  │
│ …            │  ┌ 结果 failed BUDGET_EXCEEDED ─┐ │                  │
│──────────────│  │ [重试] [复制诊断]              │ │                  │
│ F 运行记录   │  ▢ 任务…   ▤ 完整研究   ◉/■     │ │                  │
└──────────────┴──────────────────────────────────┴──────────────────┘
```

- **composer 真的能派活**：输入任务 → Enter 发送 → Runtime 现场执行，
  Plan、预算、逐轮工具卡、事件日志**边产生边渲染**（Server-Sent Events 推送 trace 快照）。
- **三步建单向导**：点 `＋`（或空态 CTA）打开「类型 → 说明 → 审批」向导，
  7 个模板卡标出标准委托 / 演示、预算与轮次；提交后自动开跑并建会话标签，不必先记住模板名。
- **模板选择器**（`▤ 完整研究 ⌄`）：7 个场景模板决定授权、预算与故障注入
  （越权拒绝 / 预算耗尽 / 预算追加续跑 / 真实 SIGKILL 崩溃恢复 / 未知对账 / 计划受阻）。
- **运行中插话**：运行中 composer 仍可输入，消息排队到下一个轮次边界，
  以 `operator_message` 写入同一条哈希链；排队 / 入链 / 未送达三种状态都在气泡上标明。
- **多会话并行**：每次委托一个会话标签，后台会话保持 SSE 流式，切换标签不丢画面；
  后台完成时用 Notification 提醒（默认关闭，可在 `⌘K` 里开启）。
- **审批门**（`🔒 关键审批 ⌄`）：默认只在关键工具（`reconcile_basis`、`report_blocked`）执行前暂停；
  也可切到「逐步审批」或「自动」。审批卡显示倒计时、参数与策略，允许 / 拒绝都写入哈希链；
  拒绝会终止运行（`OPERATOR_DENIED`），超时自动拒绝；可勾选「本次运行内不再询问该工具」。
- **人工控制**：运行中可调整计划（跳过 / 提前某个 todo）、追加预算（只能调高，下一轮生效）；
  失败于 `BUDGET_EXCEEDED` / `ROUND_LIMIT` 时，结果卡提供「追加预算并继续」，
  从事件日志续跑，不重发已付的读取。右侧证据栏可只看人工事件（审批 / 修订 / 预算 / 续跑 / 消息）。
- **随时停止**：运行中 composer 发送键变为 ↑（发送消息），顶栏的「运行中」胶囊点击后在**轮次边界**停止，
  终态记为 `failed · STOPPED_BY_OPERATOR`，已产生的事件与哈希链依然完整可验。
- **工具卡按 runtime 的工具词汇渲染**（`read_document` / `calculate_margin` / `report_blocked` …）：
  默认折叠成「工具 + 参数 + 判定 + 一行结果预览」；运行中的卡自动展开，完成后自动收起
  （手动展开过的轮次不会被自动收起）。行内提供文档列表、文档正文、口径换算、重述对比、
  毛利率三联指标等结构化细节，`原始数据` 折叠里是全量 JSON。
- **运行记录**（服务端持久化在 `runs/*/meta.json`）：搜索、双击重命名、☆ 固定置顶；
  状态点区分 succeeded / failed / denied / 运行中。
- **失败运行可操作**：结果卡里的「重试」以同一目标 + 模板重新提交；「复制诊断」生成一段
  可直接粘贴的诊断文本（运行 id、模板、终态、失败码、链验证、时间）。
- **审计报告**：运行结束后的「签发报告」生成自包含 HTML 工作底稿（结论、账单、证据、
  人工决定、链附录），内嵌预览可打印 / 存 PDF / 下载；下载件不依赖本机即可打开与转发。
- **完成通知**：Notification API，默认关闭（⌘K 里开启），仅在页面不聚焦时提醒。

### 键盘与命令面板

| 键 | 行为 |
| --- | --- |
| `⌘K` / `Ctrl+K` | 命令面板：动作（重试 / 导出 / 验链 / 展开折叠 / 通知开关）+ 运行记录 + 演示场景 |
| `⌘.` / `Ctrl+.` | 停止当前运行 |
| `⌘↵` / `Ctrl+Enter` | 允许当前审批 |
| `⌘⌫` / `Ctrl+Backspace` | 拒绝当前审批（终止运行） |
| `Enter` / `⇧Enter` | 发送 / 换行 |
| `R` | 重放当前场景（静态回放） |
| `Esc` | 关闭命令面板 / 建单向导 / 报告预览 / 模板菜单 / 审批菜单 / 收起浮动证据栏 |

## API（`server.py`，标准库实现）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | live 是否可用、runtime 路径、pace |
| GET | `/api/templates` | 7 个场景模板（标题 / 目标 / 故事 / 预算 / 轮数上限） |
| GET | `/api/runs` | 运行历史（含 `tracePath` / `name` / `pinned` / `approval`） |
| POST | `/api/runs` | `{"objective": "…", "template": "full", "approval": "consequential"}` → `{"id": "run-…"}` |
| GET | `/api/runs/{id}/stream` | SSE：`hello / snapshot / done / failed`，快照含 `pending` / `approval` |
| POST | `/api/runs/{id}/stop` | 在下一个轮次边界停止 |
| POST | `/api/runs/{id}/decision` | `{"approvalId": "…", "allow": true, "remember": false}` → 放行或拒绝 |
| POST | `/api/runs/{id}/messages` | `{"text": "…"}` → 运行中插话；排队到下一轮边界写入 `operator_message` |
| POST | `/api/runs/{id}/plan` | `{"action": "skip"\|"promote", "todoId": "t4"}` → 下一轮生效 |
| POST | `/api/runs/{id}/budget` | `{"maxCalls": 20, "maxReads": 30, "maxCostMicrousd": 30000}` → 只能调高，下一轮生效 |
| POST | `/api/runs/{id}/resume` | 追加预算并续跑：`{"maxCalls": …, "maxReads": …, "maxCostMicrousd": …, "extraRounds": 6}` |
| POST | `/api/runs/{id}/meta` | `{"name": "…", "pinned": true}` → 更新并持久化运行记录 |

实现要点：运行在服务进程内的线程中驱动真实 runtime；观察者线程每 ~120ms 从 SQLite 的
WAL 只读连接上取已提交事件，重建 trace 快照（recorder 的轮次数据与事件链合并）并推给浏览器；
`runs/{id}/task.sqlite` 与 demo 的库结构一致（同样可用 `sqlite3` 直接查证）。
静态文件（html/css/js）一律 `Cache-Control: no-cache`，改完刷新即生效。

## 人工控制语义

| 动作 | 生效时机 | 边界 |
| --- | --- | --- |
| 审批 allow / deny | 立即解除阻塞；暂停点在 `gate` 之后、`execute` 之前 | 拒绝 = 终止运行（`OPERATOR_DENIED`）；超时自动拒绝；`remember` 只在本次运行内对同一工具生效 |
| 计划 `skip` / `promote` | 下一轮开始时重建计划 | 跳过不可撤销；被拒绝的指令写 `control_rejected`；跳过必要步骤会得到诚实的 `INSUFFICIENT_EVIDENCE` |
| 预算调整 | 下一轮开始时 | 只能调高；发送前扣减的语义不变 |
| 运行中消息 | 下一轮 `before_round` | 只写入事件链，不打断当前工具调用；消息过长或运行已结束会被拒 |
| 续跑 | 仅接受 `BUDGET_EXCEEDED` 或 `ROUND_LIMIT` | 从旧 trace 重建工作记忆并续写同一哈希链，已付的读取不重发 |

所有人工决定都进签名链：`approval_requested / approval_granted / approval_denied / approval_aborted /
plan_steered / budget_adjusted / control_rejected / task_resumed / operator_message`。右侧证据栏的「人工」筛选只显示这些事件。

## 只读回放模式

不启动 `server.py` 时，页面就是纯回放查看器：

- **链自检**：与 Runtime 相同的 canonical JSON 算法在浏览器里 SHA-256 重算全链，
  顶栏 `✔ 链验证通过 · N events`，篡改一个字节即变红；盾牌按钮手动重验。
- **每轮卡片**：见上文的工具卡说明；`PASS / DENIED · 错误码`、收据 chips
  （tokens / µUSD / latency / `账单 not-verified`）、预算用量、原始数据折叠。
- **unknown 语义可视化**：模型调用未知卡片（不重发、不退费、不换供应商）+ 后续轮次
  「已对账 · receipt …」蓝 chip；终态前未完成的轮次标 `TERMINATED`。
- **交互**：拖放 trace JSON、`?trace=` 参数、`r` 重放、`⌘K` 面板、`Esc` 收起浮动面板。
- 轨迹路径自动探测：`traces/{key}.trace.json` → `../work/demo/{key}.trace.json` → `work/demo/{key}.trace.json`。

## 设计说明

- 取智谱 ZCode 工作台的视觉语言并做静默化：`#161616` 窗口底、`#1b1b1b` 卡片、
  10% 白描边、`#262626` 选中胶囊、Geist/Inter 系无衬线正文 + 等宽数据。
- 颜色只表达状态语义（ok / warn / bad / running），不做装饰；层级靠间距与字重；
  内容默认折叠、按需展开；动效只保留状态变化（≤160ms）——「简洁可以让人用的很久」。
- 零依赖、零构建、完全离线：无字体 / 框架 / 打包步骤，与项目「标准库 + 可离线」的约束一致。
- 页面不向外部网络发送任何数据；模型调用只会到达你本机 `server.py` 拉起的 runtime。

## 数据是从哪来的

`traces/` 里的 7 个文件随仓库提供，由 Python Runtime 的离线 demo 生成，可随时重跑：

```sh
cd flowcredit && python demo.py all
cp work/demo/*.trace.json viewer/traces/
```
