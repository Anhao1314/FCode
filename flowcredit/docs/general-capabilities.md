# 受控通用能力：原生工具集与 MCP 桥接

> 状态：第一阶段（原生受控工具集）与第二阶段（MCP 桥接 v1）均已实现。
> 本文档是设计决策的记录，也是"独立重算的推广"的正式定义。
> 说明：任务书提到的 `docs/mcp-tradeoffs.md` 在仓库中并不存在（全库检索无命中）；
> 其权衡内容已并入本文第二节。

## 0. 主张

FCode 不自建浏览器自动化、自进化或终端执行这类重能力。通用能力靠**接入**，
FCode 提供的是接入时的治理：门控、预算、收据、unknown 语义、事件链。
本批次的目标是让治理之下的 Agent 达到通用 Agent 的能力基线（读写文件、抓取网页），
同时证明核心主张——**任何外部能力接入时都必须留下收据**。

治理不变量（红线，测试锁定）：

1. 任何新工具走既有 门控 → 预算 → 收据 → unknown 语义 路径；
2. 注册表保持封闭——MCP 工具是"导入注册表"，不是绕过注册表；
3. 模型永远只能提议；效果类授权（read/write/network）写在主机 grant 里，
   任务不声明就保持 Phase 1 的只读承诺；
4. 路径校验与 SSRF 防护在**工具实现内**强制，绝不在前端或提示词里。

## 1. 能力来源分层

```
原生受控工具（第一阶段，参考实现）
        │  同一注册表、同一门控、同一预算、同一收据
MCP 桥接（第二阶段，外部工具正式导入通道）
```

- **原生层**（`src/flowagent/tools/general/`）：`ls_workspace` / `read_file` /
  `write_file` / `fetch_url`。领域无关，注册为 `general-work` 域，与财务域并列共存。
- **MCP 层**（`src/flowagent/tools/mcp/`）：仓库根 `mcp.json`（主机审阅后生效）
  声明的 stdio server，启动时连接、`tools/list` 导入，每个工具以
  `mcp__{server}__{tool}` 命名进注册表，inputSchema 直接作为门控参数校验。

## 2. 关键设计决策

### 2.1 效果类授权：分类权在主机

`Permissions` 原本无条件拒绝 write/network。本批次把它改为：
grant 里的 `allowed_effects`（缺省 `["read"]`）决定本任务可执行的效果类。
财务域 grant 不写这个键 → 行为零变化；通用域 grant 显式写
`["read", "write", "network"]` → 三方一致（注册表 ∩ 任务范围 ∩ 主机 grant）才放行。
grant 里出现未知效果类 → `GRANT_EFFECTS_INVALID`，大声拒绝。

MCP 工具不自声明副作用：**一切导入默认 consequential（过审批）**，
只有主机在 `mcp.json` 按工具标注 `readonly: true` 才归入读取类。
"分类权在主机"与"模型不能自审"同源。

### 2.2 沙箱：路径监狱 + git 版本化 + 哈希收据

- 每个运行的沙箱锚定 `runs/{runId}/workspace/`；路径在
  `WorkspaceSandbox.resolve` 内归一化：绝对路径、`..`、空组件、反斜杠、
  NUL、`.git` 一律 `SANDBOX_PATH_DENIED`；`resolve()` 后做包含检查，
  符号链接逃逸（沙箱内链接指向外部）同样拒绝。
- 沙箱惰性初始化为 git 仓库，**每次有效写入自动 commit**（内联身份，
  不读全局 git 配置）；内容不变的重写不伪造历史（无 commit），但收据
  仍记录前后哈希，无操作可见。
- `write_file` 收据：`sha256_before`（新文件为 null）/ `sha256_after` /
  `commit` / `bytes`。审批界面展示的是**主机在执行前算好的真实 unified diff**
  （`WorkspaceSandbox.diff_preview`），与写入走同一套路径校验。
- 崩溃恢复语义照旧：write 的观察已入链，`rebuild_plan` 重放后 todo 已
  done，恢复后不重写。

### 2.3 fetch_url：解析后钉住（防 DNS 重绑定）

- 输入 url，输出正文文本；上限 1 MiB，超时 30s，至多 3 次重定向
  （每一跳从头重新校验）。
- SSRF：`getaddrinfo` 解析后**逐一**校验所有地址（环回/私网/链路本地/
  唯一本地等非全局地址一律拒绝，放行清单 `FCODE_FETCH_ALLOW_HOSTS`
  或构造参数可显式豁免主机），然后**连接钉死的已校验 IP**；
  HTTPS 用自定义 `HTTPSConnection` 保持 SNI 与证书校验在原域名上。
  DNS 重绑定（校验与连接之间换答案）因此没有可乘之机。
- 收据记录 url、最终域名、状态码、内容 sha256、字节数、时延。
- 诚实标注：结果携带 `content_truth: "not-verified"`——运行时复核的是
  文件状态哈希、预算与链完整性，**网页内容的真实性如实声明不保证**。

### 2.4 unknown 语义的推广

工具层引入"结果未知"：AgentError 携带 `details={"outcome": "unknown"}`
（fetch 超时/断连、MCP 调用超时/进程失联）时，Harness 记
`tool_unknown` 事件并以 `TOOL_OUTCOME_UNKNOWN` 终止任务——读取已计费、
**绝不重发**、不伪装成干净失败。这与模型侧 unknown（不重发、不退费、
凭签名收据对账）同一纪律；工具侧的收据式对账（带外签名结果）刻意
不在本期发明，留待确有需求时立项。

### 2.5 提案参数上限的再定界

`validate_plan` 的参数上限从 1 KiB **再定界**为 96 KiB（不是取消）：
1 KiB 假设了只读工具的标识符级参数，`write_file` 携带的是成文内容。
工具 schema 仍以 `Param.max_length`（write_file 内容 65 536 字符）在
**门控时**拒绝超限提案—— oversized 内容在审批前就被拒绝，不会审批通过
后才发现写不下。字符串/布尔/数值/字符串数组的输入校验同步补齐
（MCP inputSchema 映射需要）。

## 3. 独立重算的推广（收据哲学，不是放弃）

财务域重算**数字**：runtime 从世界复算毛利率并比对。通用任务重算
**可复核的账**：

| 对象 | 复核方式 |
| --- | --- |
| 文件状态 | `general-work` 验证器从磁盘重读文件、重算 sha256，与 write 观察记录的 `sha256_after` 比对；不一致即 `RESULT_VERIFICATION_FAILED` |
| 预算 | 既有 calls/reads/cost/tokens 计量，逐轮入链 |
| 链完整性 | `verify_trace` 哈希链重算 |
| 网页内容真伪 | **不可复核** → 显式 `not-verified`，绝不伪装成已验证 |

"运行时独立验证结果"因此从"能重算数字"推广为"能重算的都重算，
不能重算的如实声明"。这是收据哲学的推广，不是放弃。

## 4. MCP 桥 v1 的边界

做：stdio 传输（本地进程）、`initialize`/`tools/list`/`tools/call`、
JSON-RPC 2.0（stdlib 实现，行分隔）、逐工具导入与拒收（schema 含
object/union/非字符串数组等门控无法校验的类型 → 拒收并给出理由）、
失联降级（`/api/mcp` 如实报告 per-server 可用性；调用时预检失败为
confirmed `MCP_SERVER_UNAVAILABLE`，发出后超时/失联为 unknown）。

不做（v2 及以后）：HTTP 传输、MCP resources/prompts、外部计费工具定价
（配置位 `billing` 已预留，值恒为 `not-configured`）、shell/终端工具
（自由形态动作的审批与沙箱是独立设计，单独立项）、浏览器自动化、
自进化、多 Agent 编排。

密钥纪律：`mcp.json` 的 env 值支持 `"env:VAR_NAME"` 从启动进程解析，
密钥不落盘；配置内容不进 trace。

## 5. 验收与证据

- 离线测试：`tests/test_general_capabilities.py`（沙箱逃逸矩阵、SSRF
  各地址段、DNS 重绑定、钉住连接、超时→unknown、前置拒绝为 confirmed、
  1 MiB 上限、重定向再校验、收据字段与 not-verified、门控效果类、
  超限内容门控拒绝、planner、文件状态验证、全流程 Loop 成功、篡改
  失败、tool_unknown 只执行一次）、`tests/test_mcp_bridge.py`（真实
  子进程 stdio 全链路：握手、导入命名、schema 校验、主机分类、调用、
  isError confirmed、超时 unknown、进程死亡降级、坏 server 不遮蔽好
  server）。全量 328 项测试通过（原 287 项零回归）。
- 里程碑演示（录屏/截图）：viewer 创建通用委托"调研公开主题，写
  research.md"→ fetch_url 真实抓取收据 → write_file 真实 diff 审批
  （键盘放行）→ 预算走表 → `verify_trace` 通过 → 工作区文件存在且
  哈希与收据一致。见仓库 `flowcredit/viewer/docs/` 下演示截图。

## 6. 遗留风险

- fetch_url 的正文抽取是 stdlib HTML 解析（与 connectors 共用），
  对重度脚本渲染的页面只能拿到静态文本；这是诚实边界，不是缺陷。
- MCP 工具在本期不进入通用计划的默认蓝图（模型可提议、门控可放行，
  但 mock 蓝图只含 fetch/write）；真实 provider 提议 MCP 工具的端到端
  验证留给有真实模型的批次。
- 工具侧 unknown 目前是终态（不重发、等操作者重启新委托）；带签名
  收据的工具级对账通道未发明。
- `runs/{runId}/workspace` 与运行目录同生命周期；工作区导出/归档策略
  未定。
