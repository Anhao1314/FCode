# SEC 10-K 抽取（Phase 2c：两家发行人）

> 真实公开数据，仅用于抽取研究；不构成任何信贷、投资或评级意见。
> 本阶段只验证两家发行人的 profile 驱动抽取，不做 10 家评测，不接真实 LLM。

## 问题

Phase 2b 已经让一份 Cisco 10-K 的 21 个事实、5 个必需指标和 memo v2 跑通。
Phase 2c 只回答：

> 第二家发行人能否在不改生产 runtime、不加 LLM/第三方 HTML/PDF 库的前提下，
> 用同一套 extractor 和不同的 profile，精确抽出同一组事实、指标和行级 citation？

答案：能。Cisco 和 Home Depot 都是 21/21；两家 memo 都是
`pass / issued: true / pending_human_review`。代码里不再有 Cisco 的 CIK、
accession、primary document 或 `FIELD_LINES` 常量；规则在
`labs/sec_10k/data/<issuer>/profile.json`。

## 两家 filing

| 字段 | Cisco | Home Depot |
| --- | --- | --- |
| Company | Cisco Systems, Inc. | The Home Depot, Inc. |
| CIK | `0000858877` | `0000354950` |
| Accession | `0000858877-25-000111` | `0001628280-26-019436` |
| Fiscal year | FY2025 | FY2025 |
| Fiscal year end | 2025-07-26 | 2026-02-01 |
| Filed | 2025-09-03 | 2026-03-18 |
| Primary document | `csco-20250726.htm` | `hd-20260201.htm` |
| URL | <https://www.sec.gov/Archives/edgar/data/858877/000085887725000111/csco-20250726.htm> | <https://www.sec.gov/Archives/edgar/data/354950/000162828026019436/hd-20260201.htm> |
| Raw sha256 | `36be983637c033c8c03ffcbbc404f1cda0a437f6951959aab7f5cd124978b423` | `4fca0701d4981730e6d501d102966be40e5c144e7dad4b52f212cbcee2643f05` |
| Excerpt sha256 | `3b5f70f758adccec897e573e4975fbc6866e494313f814431bc464fe69e9b943` | `d672ffcf8b85fe5ac9bf46237f05ecf8bc9d70bf1b4e5281bcc72fc216ef2d65` |

**Cisco 选择说明**：IBM 的 primary 10-K 把合并财务报表以引用方式并入 Annual
Report exhibit，primary HTML 本身没有三张表；因此用 Cisco。Cisco 也有 FY2026
10-K，但生产计划是 FY2025 口径，使用 FY2025 filing 避免重标期间。

**Home Depot 选择说明**：最新 FY2025 10-K（52 周，截至 2026-02-01）的 primary
document 含合并财务报表，且可直接映射为 FY2025 / FY2024；零售业标签
（`Net sales`、`Receivables, net`、`Total stockholders’ equity`）和 Cisco 不同，
正好验证 profile。没有触发改用 Coca-Cola 的条件。

## 数据与 profile

```text
labs/sec_10k/
  fetch.py          # --issuer 下载 + profile 驱动 excerpt
  profiles.py       # FilingProfile / ColumnRule / FactRule 加载
  extract.py        # 通用 extractor
  world.py          # issuer-agnostic CreditWorld adapter
  spike.py          # --issuer / --all
  data/
    cisco/{profile.json, excerpt.txt, ground_truth.json, meta.json, raw/}
    home-depot/{profile.json, excerpt.txt, ground_truth.json, meta.json, raw/}
```

`profile.json` 主要字段：

- `sections`：`audit` / `balance` / `income` / `cash`（Cisco 还有 `debt` /
  `note`）；
- `columns`：current/prior 的数字单元格位置，以及表头 current/prior 文本；
  `confirmed: true` 仅用于 excerpt 中没有表头的已知表（Cisco MD&A total debt）；
- `facts`：section、label aliases、可选 `components`、current/prior 文档角色；
- `excerpt`：`between`（精确起始行 + 结束前缀）或 `around`（全局 anchor 前后
  行）。

代码中不出现 Cisco 的 CIK/accession/primary 或 `FIELD_LINES`；这些只在
`data/cisco/` 与测试里。`fetch.py` 只读 profile/meta 的 issuer 元数据。

## 管线

```text
SEC primary HTML
  -> html_to_text.py (html.parser; one <tr> per line; cells joined by " | ")
  -> fetch.py: data/<issuer>/excerpt.txt + meta.json
  -> extract.py: profile sections + label aliases + column rule
  -> 21 facts (current 11 + prior 10)
  -> Sec10kWorld(issuer_key, facts, meta, excerpt_lines, field_lines)
  -> production CreditPlanner -> verify_observation -> build_memo
```

完整 HTML 在 `data/<issuer>/raw/` 并被 gitignore；仓库只提交 excerpt、meta、
ground truth 和 profile。

## Ground truth 与 gate

两家各有 21 条：11 个当前期 + 10 个比较期数值；审计报告一份意见覆盖两期，
不重复计 `audit_opinion_prior`。每条都有 `value`、`unit`、`source_unit`、
`period`、`doc_id`、1-based `line`、逐字 `snippet`、`source_url`、`accession`。
`extract.py` 从不读取 ground truth；spike 事后逐字段比较，包含 `components`。

Home Depot 当前期：

| fact | value (USD) | line | doc |
| --- | ---: | ---: | --- |
| revenue (`Net sales`) | 164,683,000,000 | 52 | doc_10k_fy2025 |
| operating_income | 20,890,000,000 | 59 | doc_10k_fy2025 |
| depreciation_amortization | 3,273,000,000 | 57 | doc_10k_fy2025 |
| interest_expense | 2,412,000,000 | 62 | doc_10k_fy2025 |
| cash_and_equivalents | 1,389,000,000 | 12 | doc_10k_fy2025 |
| total_debt | 55,772,000,000 | 25 | doc_10k_fy2025 |
| short_term_debt | 9,431,000,000 | 25 | doc_10k_fy2025 |
| operating_cash_flow | 16,325,000,000 | 85 | doc_10k_fy2025 |
| accounts_receivable | 5,597,000,000 | 13 | doc_10k_fy2025 |
| equity | 12,813,000,000 | 46 | doc_10k_fy2025 |
| audit_opinion | `standard_unqualified` | 6 | doc_10k_fy2025 |

比较期 FY2024：revenue 159,514,000,000；operating income 21,526,000,000；
D&A 3,034,000,000；interest 2,321,000,000；cash 1,659,000,000；total debt
53,383,000,000；short-term debt 4,898,000,000；OCF 19,810,000,000；
receivables 4,903,000,000；equity 6,640,000,000。Cisco 的 21 条见
`labs/sec_10k/README.md` 与 `data/cisco/ground_truth.json`。

### 组件相加与列位置

Home Depot 没有单行 Total debt：

```text
total_debt = 4,464 + 4,967 + 46,341 = 55,772 million
short_term_debt = 4,464 + 4,967 = 9,431 million
```

`total_debt` 返回 3 个 `components`（lines 25 / 31 / 35）和 3 条 citation；
`short_term_debt` 返回 2 个 components。每个 component 有自己的 value、line、
snippet、doc_id；memo 的 `net_debt_to_ebitda` 自动带 3 条债务 citation。
Cisco 的债务是单行，不返回 components。

列位置由 profile 的 `columns` 指定，并在 section 内检查 `header_current` /
`header_prior` 的先后顺序；不匹配时返回 `unconfirmed_columns`，不会默认
“第二个数字单元格”。Cisco 的 MD&A total debt 没有表头，profile 显式写
`confirmed: true`；其余 section 都有表头校验。

## 审计意见

`_audit_code` 继续按“先否定、后肯定”：

1. `disclaimer`：`disclaimer of opinion` / `do not express an opinion`；
2. `adverse`：`adverse opinion` / `do not present fairly`；
3. `qualified`：`qualified opinion` / `basis for qualified opinion` /
   意见段里的 `except for` + `present fairly`；
4. `standard_unqualified`：`in our opinion` + `present fairly`；
5. 其余 `None`。

`_find_audit_paragraph` 优先选意见段，`except for` 不作选段条件；模糊文本
进入 missing，不猜。

## 指标与 memo

两家 5 个必需指标：

| metric | Cisco | Home Depot |
| --- | ---: | ---: |
| net_debt_to_ebitda | 13552 bp (1.36x) | 22507 bp (2.25x) |
| interest_coverage | 91469 bp (9.15x) | 100178 bp (10.02x) |
| ocf_to_short_term_debt | 27127 bp (2.71x) | 17310 bp (1.73x) |
| receivables_to_revenue | 1183 bp (11.83%) | 340 bp (3.40%) |
| audit_opinion | `standard_unqualified` | `standard_unqualified` |

两家都缺 `related_party_funding_ratio`、`contingent_liabilities_to_equity`、
`rating_migration`；它们在 memo v2 中是可选指标，只进入 `missing_optional` /
`optional_gaps` 和 caveat，不阻止签发。两家的结论都是冻结策略算出的
`pass / no threshold fired / issued: true / signed: false /
pending_human_review`，`verified: true`，`optional_verified: false`。

`build_memo` 接收 `synthetic` / `research_only` / `source_url` / `accession` /
`cik`，lab 不再事后修改 memo。memo 的 5 个指标都有 citation，且每条 citation
都能在 excerpt 回读。

## 验收

```sh
cd flowcredit
python3.12 -m unittest discover -s tests
python3.12 demo.py all
python3.12 -m unittest tests.test_multi_agent_lab
python3.12 credit_demo.py --all
PYTHONPATH=src python3.12 labs/sec_10k/spike.py --issuer cisco
PYTHONPATH=src python3.12 labs/sec_10k/spike.py --issuer home-depot
PYTHONPATH=src python3.12 labs/sec_10k/spike.py --all
```

结果：

- 两家各 21/21，全部字段（含 components）精确匹配；
- 两家 memo pass/issued/pending；5 个必需指标与 ground truth 一致；
- `--all` 两家都 `ok: true`；
- 金融 v10 golden、demo 7 场景、multi-agent、credit A/B/C 不回归；
- `flowcredit/src/` 零改动。

## Go / No-Go

**Go（建议进入 Phase 2d：10 家评测）**：第二家发行人独立通过 21/21，
profile 规则没有新增 issuer 分支；Home Depot 的零售标签、85 行 excerpt、
三行债务组件都通过了。

进入 10 家前仍需注意：

- 10 家会有更多表格结构；profile 可能需要新 label/component 规则，但不应改
  通用 extractor 或 runtime；
- 每家都必须有 hand-verified ground truth；19–20/21 先修 profile，不进入 10 家；
- 可选指标缺失是产品语义，不要为了凑 8 个指标去猜；
- 没有 XBRL 双源校验；真实评测前继续保留 HTML citation 回读；
- 真实 LLM 仍未接入。
