# 信用尽调 lab（Phase 0 缝验证）

> 本目录中的公司、金额、评级、审计意见和文档全部是合成数据。
> 「恒星智造」不是真实发债主体，这些数字不构成任何投资或信贷意见。

这是一个只存在于 `flowcredit/labs/` 的信用域种子，用来回答一个 go / no-go
问题：**现有 FCode Runtime 能不能在不改内核的前提下，跑完一次两指标信用核查，
并在证据缺失时诚实拒绝？**

## 证明什么

1. 一个 lab 内的 `CreditWorld` + 4 个只读工具 + `CreditPlanner` + 独立 verifier，
   能通过真实 `TaskStore` / `ReceiptStore` / `Harness` / `Loop` /
   `MockProvider(policy="research")` / `TraceRecorder` 跑完 FY2025 两指标核查。
2. 两个指标都由 Runtime 从 `CreditWorld` 独立重算；trace 哈希链可验证。
3. 删除债务明细后，终态不是 `succeeded`，trace 里不会出现
   `net_debt_to_ebitda` 的 `computed: true` 数值。
4. `flowcredit/viewer/`、`flowcredit/demo/runner.py`、`flowcredit/demo/fixtures.py`
   零修改；没有新增第三方依赖；模块没有注册进 `DOMAINS`。

## 不证明什么

- 不实现完整信用域的 8 个指标，只做 `net_debt_to_ebitda` 与 `interest_coverage`。
- 不接真实年报、评级报告或债务明细；没有 PDF/OCR/表格抽取。
- 不生成信用 memo、不做 viewer 集成、不做报告模板。
- 不证明真实模型（LLM）能完成这个任务；这里仍是确定性 mock。
- 不证明崩溃恢复、unknown 对账、预算门控在信用域上已经端到端验证过；这些是
  内核已有能力，本 lab 只跑通正常路径与缺证据路径。
- 不证明 `DomainModule` 可以不经装配层直接选择；Phase 0 的 module 实例只在
  本 lab 内使用。

## 怎么跑

```sh
cd flowcredit
PYTHONPATH=src python3.12 labs/credit_dd/spike.py
python3.12 -m unittest tests.test_credit_dd_spike -v
```

spike 输出一个 JSON；只有两个用例都符合预期时 `ok` 才为 `true`。

## 合成世界

公司：`恒星智造`（虚构制造业），单位 CNY 千元，两个财年。

| 字段 | FY2024 | FY2025 |
| --- | ---: | ---: |
| revenue | 1,200,000 | 1,350,000 |
| ebitda | 180,000 | 175,000 |
| cash | 150,000 | 120,000 |
| interest_expense | 30,000 | 42,000 |
| operating_cash_flow | 120,000 | 90,000 |
| accounts_receivable | 220,000 | 310,000 |
| total_debt | 600,000 | 780,000 |
| short_term_debt | 200,000 | 320,000 |

三份文档，每份都有 `doc_id` / `title` / `period` / `unit` / `body` /
`line_refs`（字段 → 1-based 行号）：

- `doc_ar_fy2024`：FY2024 年报摘要；
- `doc_ar_fy2025`：FY2025 年报摘要；
- `doc_debt_fy2025`：FY2025 债务明细，含 `total_debt`、`short_term_debt`、
  `related_party_loan`、`contingent_liabilities`。

`CreditWorld(partial=True)` 时 `doc_debt_fy2025` 不可用：
`list_documents` 不列出它，`read_document` 返回
`{"found": false, "doc_id": "doc_debt_fy2025", "reason": "missing_document"}`。

`CreditWorld` 还记录哪些文档真的被读过。指标需要但未读的文档会得到
`debt_schedule_not_read` / `annual_report_not_read`，而不是从不可引用的数据
里算出数字。

## 两个指标

`compute_credit_metric(metric, period)` 只从 world 取数；模型不能传数值。

- `net_debt_to_ebitda` = `(total_debt - cash) / ebitda`
  - FY2025：`(780,000 - 120,000) / 175,000 = 3.77x` → `value_x100 = 377`
  - FY2024：没有 FY2024 债务明细文档，返回
    `computed: false, blockers: ["missing_debt_schedule"]`
- `interest_coverage` = `ebitda / interest_expense`
  - FY2025：`175,000 / 42,000 = 4.17x` → `value_x100 = 417`
  - FY2024：`180,000 / 30,000 = 6.00x` → `value_x100 = 600`

`value_x100` 是整数，避免把浮点写进哈希链。每条结果的 `inputs` 与
`citations`（`doc_id` / `line` / `field`）都指向可回读的原文行。

## 计划与失败语义

蓝图固定为 6 步，按依赖顺序：

| id | 工具 | 参数 |
| --- | --- | --- |
| c1 | `list_documents` | — |
| c2 | `read_document` | `doc_ar_fy2024` |
| c3 | `read_document` | `doc_ar_fy2025` |
| c4 | `read_document` | `doc_debt_fy2025` |
| c5 | `compute_credit_metric` | `net_debt_to_ebitda`, `FY2025` |
| c6 | `compute_credit_metric` | `interest_coverage`, `FY2025` |

`advance` 只做两件事：成功的 observation 把对应 todo 标 `done`；工具明确报告
缺证据时标 `blocked`。没有重试、没有自动补步骤。

`partial=True` 时：

- `c4` 读到 `found: false` → `blocked`，原因是 `missing_document`；
- 依赖 c4 的 `c5` 标 **`abandoned`**（不是 `blocked`），因为它根本没有执行；
- `c6` 只依赖 FY2025 年报，仍然执行并得到 417；
- 计划最终 `is_blocked()` 为真，`Loop` 以 `INSUFFICIENT_EVIDENCE` /
  `PLAN_BLOCKED` 停止，终态 `failed`。

选 `abandoned` 而不是 `blocked` 的理由：`blocked` 表示“这个动作跑了但做不了”，
`abandoned` 表示“依赖失败，未尝试”。两者都不可恢复，但语义不同；trace 里
不应把未执行的 c5 说成执行过。

## 独立校验

`verifier.py` 不读 observation 里的 `inputs` 当答案。它：

1. 从 `CreditWorld` 重新调用 `compute_credit_metric(metric, period)`；
2. 对 `computed` / `metric` / `period` / `value_x100` / `inputs` / `citations` /
   `blockers` 逐字段比较；
3. 任何一项不同就抛 `AgentError("RESULT_VERIFICATION_FAILED", ...)`。

`CreditVerifier` 是 `Harness.verify(observation)` 的适配器：它从任务的
`tool_succeeded` 事件里取出**每一个** `compute_credit_metric` observation，
逐个重算，再把两个指标合并成最终 result。这样 c5、c6 两次计算都经过同一条
验证路径，而不是只验证最后一个。

`module.py` 里的 `verify` 是单 observation 版本，供 `DomainModule` 协议使用；
spike 使用 `CreditVerifier` 覆盖整条链。

## 内核缝改动（Phase 0 唯一的内核修改）

原来的 `Loop` 在 `runtime/loop.py:217` 直接写死：

```python
if observation.tool == "calculate_margin" and observation.result.get("computed"):
```

第二个域的 `compute_credit_metric` 永远不会触发 verifier，计划跑完后直接
`PLAN_EXHAUSTED` → `failed`。Phase 0 因此加了一个最小、向后兼容的参数：

```python
Loop(..., result_tools=("compute_credit_metric",))
```

并把成功条件改为：

```python
observation.tool in self.result_tools
and observation.result.get("computed")
and plan.is_complete()
```

`plan.is_complete()` 是必需的：c5 之后 c6 还没跑，不能提前成功；partial 模式下
c4 是 `blocked`，计划永远不算 complete，因此 c6 的 417 也不会把整个任务
误判为成功。默认值 `("calculate_margin",)` 保持金融域行为不变（192 个既有测试
全绿）。

这是 Phase 0 的 go / no-go 发现：`DomainModule` 协议本身够用，但 `Loop` 的
终止策略原先没有接到协议上。后续如果要把信用域产品化，应该把
`result_tools` 提升为 `DomainModule` 的声明字段，而不是在装配层手写。

另一个较小的内核耦合：`memory/context.py` 的 `_summarise` 是金融域形状，
`list_documents` 要求每个条目有 `id`。lab 在 `list_documents` 条目里同时给出
`doc_id` 和 `id`，不改内核；这是兼容 shim，不是信用域的真实字段需求。

## spike 输出

```json
{
  "ok": true,
  "cases": [
    {
      "name": "happy-path",
      "status": "succeeded",
      "failure_code": "",
      "metrics": {"net_debt_to_ebitda": 377, "interest_coverage": 417},
      "events": 34,
      "chain_head": "…",
      "verified": true
    },
    {
      "name": "partial-world",
      "status": "failed",
      "failure_code": "INSUFFICIENT_EVIDENCE",
      "metrics": {},
      "events": 28,
      "chain_head": "…",
      "verified": true
    }
  ]
}
```

`events` 是实际事件数（含 `model_started`、`plan_validated`、`tool_*`、
`plan_updated` 与终态事件），不是固定的 0。事件数与链头随运行时间戳变化；
决策序列和指标值是确定的。

## 文件

| 文件 | 作用 |
| --- | --- |
| `world.py` | `CreditWorld`、合成事实、文档、两条指标公式 |
| `tools.py` | 4 个 `effect=read` 的 `ToolSpec` 与输出契约 |
| `planner.py` | 6 步蓝图、todo 归属、blocked/abandoned 规则 |
| `verifier.py` | 独立重算 + 链级 `CreditVerifier` |
| `module.py` | lab 内 `DomainModule` 实例（未注册） |
| `spike.py` | 两个用例的真实 Runtime 装配与 JSON 输出 |

## 下一阶段（不在本阶段）

- 扩展到 8 个指标（短期债务占比、经营现金流/债务、应收账款周转等）；
- 接真实年报/债务明细的抽取与行级引用；
- 把 `result_tools` 提升为 `DomainModule` 字段，并注册模块；
- 信用 memo 模板与 viewer 集成；
- 在信用域上重跑崩溃恢复、unknown 对账与预算场景。
