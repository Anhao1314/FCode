# 信用尽调（credit due diligence）

> 本域的三家公司、金额、评级和审计意见全部是合成数据。
> 「恒星智造」「远洋材料」「云岭设备」不是真实发行人；这些数字不构成任何
> 信贷、投资或评级意见。

## 产品面

第一个可运行的信用产品面是**上市公司 / 发债主体的信用核查备忘录**：

- 输入：合成年报、债务明细、评级报告、重述说明；
- 输出：8 个指标、一份由 Host 组装的 `memo.json` + `memo.md`、可验证的
  trace 哈希链；
- 证据不足时：memo `signed: false`，列出 `missing`，不写任何编造数值，
  终态 `failed / INSUFFICIENT_EVIDENCE`。

模型只提议读哪一个文档、算哪一个指标；它不能传数值，也不能写 memo。

## 代码位置

| 文件 | 作用 |
| --- | --- |
| `flowagent/tools/credit/world.py` | 3 家合成发行人、文档、8 个指标公式 |
| `flowagent/tools/credit/tools.py` | 5 个 `effect=read` 工具 |
| `flowagent/tools/credit/planner.py` | 14 个普通 todo 的蓝图与依赖 |
| `flowagent/tools/credit/verifier.py` | 独立重算，逐字段比较 |
| `flowagent/tools/credit/memo.py` | Host 组装 memo + 冻结结论策略 |
| `flowagent/domains/credit.py` | `CREDIT_DOMAIN`（`credit-due-diligence`） |
| `flowagent/demo/credit.py` | 模块驱动的 runner |
| `credit_demo.py` | 根入口 CLI |

`labs/credit_dd/` 保留为 Phase 0 的薄封装 seam proof，不再拥有第二套实现。
`CREDIT_DOMAIN` 已注册进 `flowagent.domains.DOMAINS`；金融域行为不变，
`fcode.prompt/v10` 的 golden hash 继续通过。

## 三家合成发行人

单位 CNY 千元。完整事实见 `world.py`。

| 发行人 | key | 特征 | 预期结论 |
| --- | --- | --- | --- |
| 恒星智造 | `hengxing` | 两期 standard audit，AA- 稳定，杠杆偏高 | `watch` |
| 远洋材料 | `yuanyang` | FY2024 EBITDA 300,000 → 270,000 重述，qualified audit，A → BBB downgrade | `reject` |
| 云岭设备 | `yunling` | 债务明细缺失，BBB 稳定 | `insufficient_evidence` |

### FY2025 指标

| metric | 恒星智造 | 远洋材料 | 云岭设备 |
| --- | ---: | ---: | ---: |
| `net_debt_to_ebitda` | 37714 | 57500 | —（缺债务明细） |
| `interest_coverage` | 41667 | 30000 | 36000 |
| `ocf_to_short_term_debt` | 3000 | 857 | — |
| `receivables_to_revenue` | 2296 | 2952 | 2118 |
| `related_party_funding_ratio` | 577 | 1467 | — |
| `contingent_liabilities_to_equity` | 281 | 1765 | — |
| `audit_opinion` | `standard_unqualified` | `qualified` | `standard_unqualified` |
| `rating_migration` | `stable` | `downgrade` | `stable` |

`—` 表示 `computed: false`，没有 `value_bp` / `value_code` / `display`，并带
`blockers: ["missing_debt_schedule"]`。

### 公式与单位

`value_bp = ratio × 10000`（整数四舍五入）；类别指标用 `value_code`。
`display` 由 Host 生成，不由模型填写。

| metric | 公式 | 单位 |
| --- | --- | --- |
| `net_debt_to_ebitda` | `(total_debt - cash) / ebitda` | x |
| `interest_coverage` | `ebitda / interest_expense` | x |
| `ocf_to_short_term_debt` | `operating_cash_flow / short_term_debt` | x |
| `receivables_to_revenue` | `accounts_receivable / revenue` | % |
| `related_party_funding_ratio` | `related_party_loan / total_debt` | % |
| `contingent_liabilities_to_equity` | `contingent_liabilities / equity` | % |
| `audit_opinion` | `standard_unqualified / qualified / disclaimer / adverse` | code |
| `rating_migration` | `upgrade / stable / downgrade` | code |

Phase 0 的 `value_x100` 已迁移为 `value_bp`：377 / 417 → **37714 / 41667**。
所有值都是整数，避免把浮点写进哈希链。

## 计划蓝图

14 个普通 todo + 条件终止（`report_blocked` 不是 todo）：

```text
c1  list_documents
c2  read_document(doc_ar_fy2024)
c3  check_restatement(doc_ar_fy2024)
c4  read_document(doc_ar_fy2025)
c5  read_document(doc_debt_fy2025)
c6  read_document(doc_rating_fy2025)
c7  compute net_debt_to_ebitda FY2025
c8  compute interest_coverage FY2025
c9  compute ocf_to_short_term_debt FY2025
c10 compute receivables_to_revenue FY2025
c11 compute related_party_funding_ratio FY2025
c12 compute contingent_liabilities_to_equity FY2025
c13 compute audit_opinion FY2025
c14 compute rating_migration FY2025
```

依赖：c5 → c7 / c9 / c11 / c12；c6 → c14。c5 缺失时标 `blocked`，四个依赖项
标 `abandoned`；c8 / c10 / c13 仍执行。计划最终 `is_blocked()`，Loop 以
`INSUFFICIENT_EVIDENCE` 停止。

成功门验证**所有** `compute_credit_metric` observation：结果 todo 必须都是
`done`，每个声明的结果工具至少有一个 observation，每一个都从 world 重算通过。
一个结果 observation 时保留金融域的单结果形状；多个结果 observation 时
`task.result` 使用 `{"verified": true, "results": [...]}`，顺序与事件链一致。

## 结论策略（冻结）

顺序：`insufficient_evidence` → `reject` → `watch` → `pass`。

- `insufficient_evidence`：任一必需指标没有 `computed: true`。
- `reject`：audit ∈ {disclaimer, adverse}；或 rating downgrade；或
  `net_debt_to_ebitda > 50000`；或 `interest_coverage < 20000`。
- `watch`：audit qualified；或 `net_debt_to_ebitda > 35000`；或
  `interest_coverage < 40000`；或 `ocf_to_short_term_debt < 2000`；或
  `receivables_to_revenue > 2500`；或 `related_party_funding_ratio > 1000`；或
  `contingent_liabilities_to_equity > 1000`。
- `pass`：其余。

`memo.rule_fired` 记录第一条触发的规则，例如
`net_debt_to_ebitda > 3.5x`、`rating_migration == downgrade`。

这是产品策略，不是信贷建议；阈值冻结在 `memo.py::conclusion_for`。

## Memo

`memo.py` 从已验证 observation、world 和重述结果组装，不调用模型：

- `memo_version: "credit-memo/v1"`、`issuer`、`issuer_key`、`as_of`、
  `synthetic: true`；
- `conclusion`、`rule_fired`、`metrics`、`trend`、`caveats`、
  `reviewer`、`missing`、`blockers`、`chain_head`、`verified`、`signed`；
- 每个 metric 至少 1 条 citation；memo 会回读 `doc_id` / `line` / `field`，
  不合法则抛 `MEMO_CITATION_INVALID`；
- `signed: true` 只在 `insufficient_evidence` 之外且所有指标 verified 时成立；
- 拒绝 memo 用 `signed: false`、`missing`、`blockers`，不写编造数值。

恒星智造示例（truncated）：

```json
{
  "memo_version": "credit-memo/v1",
  "issuer": "恒星智造（合成数据）",
  "issuer_key": "hengxing",
  "as_of": "FY2025",
  "synthetic": true,
  "conclusion": "watch",
  "rule_fired": "net_debt_to_ebitda > 3.5x",
  "metrics": [
    {
      "metric": "net_debt_to_ebitda",
      "value_bp": 37714,
      "display": "3.77x",
      "kind": "ratio",
      "citations": [{"doc_id": "doc_debt_fy2025", "line": 3, "field": "total_debt"}]
    }
  ],
  "trend": null,
  "caveats": [],
  "reviewer": {"decision": null, "reason": ""},
  "chain_head": "…",
  "verified": true,
  "signed": true
}
```

远洋材料的 trend 使用 FY2024 **重述后** EBITDA 270,000 / 利息 50,000 =
5.40x（54000 bp），FY2025 为 3.00x（30000 bp），`change_bp = -24000`；memo
caveat 明确写出 `FY2024 EBITDA 从 300,000 重述为 270,000。`

云岭设备的 memo `signed: false`，`missing` 列出
`net_debt_to_ebitda` / `ocf_to_short_term_debt` /
`related_party_funding_ratio` / `contingent_liabilities_to_equity`，只包含
可计算的 4 个指标，不写编造数值。

`memo.json` 与 `memo.md` 写入 run 目录；`memo.md` 的数字全部来自 JSON。
`memo_sha256` 是对 memo 的 canonical JSON 计算的 SHA-256；CLI 同时输出
`chain_head`。

## CLI

```sh
cd flowcredit
python credit_demo.py --issuer hengxing
python credit_demo.py --issuer yuanyang
python credit_demo.py --issuer yunling
python credit_demo.py --all
```

`--all` 顺序跑三家，只有三家结论都达到预期时 exit 0。输出字段包括
`issuer`、`status`、`failure_code`、`conclusion`、`rule_fired`、`metrics`、
`memo_path`、`memo_sha256`、`chain_head`、`verified`，以及
`chain_verified`、`signed`、`missing`、`memo_md_path`。

默认 run 目录是 `flowcredit/work/credit/<issuer_key>/`（`work/` 已在
`.gitignore` 中）：

```text
task.sqlite
trace.json
memo.json
memo.md
```

## 测试

- `test_credit_domain.py`：三家发行人的 8 个指标精确值、14 步蓝图、
  5 个只读工具、restatement、verifier 篡改拒绝、domain 注册；
- `test_credit_memo.py`：memo citation 可回读、signed/verified 规则、
  A/B/C 结论、B 的 restated trend 与 caveat、C 的 missing、pass 纯策略单测、
  `credit_demo.py --all`；
- `test_credit_dd_spike.py`：lab 薄封装与 Phase 0 seam；
- `test_sft_export.py`：金融 v10 golden hash 与信用 context fields/metrics。

## 边界与下一步

**已实现**：合成数据、8 指标、3 家发行人、Host memo、拒绝签字、CLI、
trace/chain、指标级 citation、金融 v10 不回归。

**未实现**：真实公开数据、PDF/OCR/表格抽取、真实 LLM、viewer 集成、
10 家以上评测集、真实评级机构数据。Phase 2 的目标是真实公开数据 + 10 家
发行人评测；在此之前，本域只证明“可审计的信用核查编排与拒绝语义”。
