# SEC 10-K 抽取 spike（Phase 2a）

> 真实公开数据，仅用于抽取研究；不构成任何信贷、投资或评级意见。
> 本阶段只验证单份 10-K 的确定性抽取，不做 10 家评测，不接真实 LLM。

## 问题

Phase 1 的信用域能在合成数据上跑通 8 个指标和 Host memo。Phase 2a 只回答：

> 一份真实的 SEC 10-K，能不能在不改 Runtime、不引入第三方运行时依赖、
> 不用 LLM 抽数的前提下，被确定性地转成同一套事实、指标和行级 citation？

答案：能。21/21 事实精确匹配（11 个当前期 + 10 个比较期），5 个可算指标与
ground truth 一致；缺失的 rating / related-party / contingent 如实进入
`missing`，memo 为 blocked、`issued: false`、`signed: false`。

## Filing

| 字段 | 值 |
| --- | --- |
| Company | Cisco Systems, Inc. |
| CIK | `0000858877` |
| Accession | `0000858877-25-000111` |
| Form | 10-K |
| Fiscal year | FY2025（2025-07-26） |
| Filed | 2025-09-03 |
| Primary document | `csco-20250726.htm` |
| URL | <https://www.sec.gov/Archives/edgar/data/858877/000085887725000111/csco-20250726.htm> |
| Raw sha256 | `36be983637c033c8c03ffcbbc404f1cda0a437f6951959aab7f5cd124978b423` |
| Excerpt sha256 | `3b5f70f758adccec897e573e4975fbc6866e494313f814431bc464fe69e9b943` |

**IBM 为什么没用**：IBM 的 FY2025/FY2026 10-K primary document 把合并财务报表
以引用方式并入 Annual Report to Stockholders；primary HTML 本身没有利润表、
资产负债表和现金流量表。任务要求单份 primary document，因此改用 Cisco。
**为什么是 FY2025**：生产 `CreditPlanner` 和 memo 是 FY2025 口径
（`doc_ar_fy2024` / `doc_ar_fy2025`、`as_of: FY2025`）。Cisco 也有更新的
FY2026 10-K，但使用它需要把生产计划的期间重新标注，超出了本 spike 的边界。

`labs/sec_10k/fetch.py` 默认 pin 这个 accession；`--latest` 可以从 submissions
feed 发现最新 10-K。SEC 请求要求 `SEC_USER_AGENT`，请求间隔 ≥0.2s，联系人
不写进仓库。

## 数据管线

```text
SEC primary HTML
  -> html_to_text.py (html.parser; one <tr> per line; cells joined by " | ")
  -> full line list
  -> fetch.py excerpt selector (six deterministic ranges)
  -> data/excerpt.txt (122 lines)
  -> extract.py (section + label + first/second numeric cell)
  -> 21 facts with doc_id / line / snippet
  -> Sec10kWorld -> CreditPlanner -> verify_observation -> build_memo
```

### HTML 转文本

只用标准库 `html.parser`：

- 块元素一行；
- 每个 `<tr>` 一行，单元格用 ` | ` 分隔；
- 保留括号负数、`$`、`%`、逗号；
- 1-based 行号，对同一份 HTML 稳定可复现。

完整 HTML 放在 `labs/sec_10k/data/raw/` 并被 gitignore；仓库只提交节选。

### 节选

`fetch.py` 用精确标题/结束前缀选择六段：

1. 审计报告标题到 `In our opinion` 段；
2. 合并资产负债表到 `TOTAL LIABILITIES AND EQUITY`；
3. 合并利润表到 `NET INCOME`；
4. 合并现金流量表的经营部分到 `Net cash provided by operating activities`；
5. MD&A 的 `Total debt |` 行及上下文；
6. Note 12 `12.Borrowings` 的短期债务表到 `Total |`。

节选共 122 行，满足 80–150 行要求。

## Ground truth 协议

`data/ground_truth.json` 是人工读 filing/节选后写的，不由 `extract.py` 生成。
每个事实包含：

```json
{
  "fact": "revenue",
  "value": 56654000000,
  "unit": "USD",
  "source_unit": "USD millions",
  "period": "FY2025",
  "doc_id": "doc_10k_fy2025",
  "line": 57,
  "snippet": "Total revenue | 56,654 |  |  | 53,803 |  |  | 56,998",
  "source_url": "https://www.sec.gov/...",
  "accession": "0000858877-25-000111"
}
```

单位换算：10-K 报 USD millions；公开事实值统一为 USD，
`value = millions × 1_000_000`，`source_unit` 保留原始单位。

### 21 个事实（11 当前期 + 10 比较期）

当前期：

| fact | value (USD) | line | doc |
| --- | ---: | ---: | --- |
| revenue | 56,654,000,000 | 57 | doc_10k_fy2025 |
| operating_income | 11,760,000,000 | 70 | doc_10k_fy2025 |
| depreciation_amortization | 2,811,000,000 | 85 | doc_10k_fy2025 |
| interest_expense | 1,593,000,000 | 72 | doc_10k_fy2025 |
| cash_and_equivalents | 8,346,000,000 | 13 | doc_10k_fy2025 |
| total_debt | 28,093,000,000 | 107 | doc_debt_fy2025 |
| short_term_debt | 5,232,000,000 | 122 | doc_debt_fy2025 |
| operating_cash_flow | 14,193,000,000 | 100 | doc_10k_fy2025 |
| accounts_receivable | 6,701,000,000 | 15 | doc_10k_fy2025 |
| equity | 46,843,000,000 | 48 | doc_10k_fy2025 |
| audit_opinion | `standard_unqualified` | 6 | doc_10k_fy2025 |

比较期（FY2024，同一行的第二个数字单元格）：

| fact | value (USD) | line | doc |
| --- | ---: | ---: | --- |
| revenue_prior | 53,803,000,000 | 57 | doc_10k_fy2024 |
| operating_income_prior | 12,181,000,000 | 70 | doc_10k_fy2024 |
| depreciation_amortization_prior | 2,507,000,000 | 85 | doc_10k_fy2024 |
| interest_expense_prior | 1,006,000,000 | 72 | doc_10k_fy2024 |
| cash_and_equivalents_prior | 7,508,000,000 | 13 | doc_10k_fy2024 |
| total_debt_prior | 30,962,000,000 | 107 | doc_debt_fy2025 |
| short_term_debt_prior | 11,341,000,000 | 122 | doc_debt_fy2025 |
| operating_cash_flow_prior | 10,880,000,000 | 100 | doc_10k_fy2024 |
| accounts_receivable_prior | 6,685,000,000 | 15 | doc_10k_fy2024 |
| equity_prior | 45,457,000,000 | 48 | doc_10k_fy2024 |

**prior-year 口径**：比较列由同一个 `extract.py` 抽取，不使用
`world.py` 里的手写常量。`ground_truth.json` 的 21 条全部参与 gate：每条都必须
在 `value`、`unit`、`source_unit`、`period`、`doc_id`、`line`、`snippet` 上
精确匹配。审计报告只有一份意见，同时覆盖 FY2025 和 FY2024，因此不重复计一条
`audit_opinion_prior`；`Sec10kWorld` 的 FY2024 视图复用当前审计意见。
债务附注的 `total_debt` / `short_term_debt` 同一行包含两列，所以 prior 值仍
引用 `doc_debt_fy2025`；其余 prior 值引用 `doc_10k_fy2024`。

`depreciation_amortization` 使用现金流量表的
`Depreciation, amortization, and other` 行；它包含 “and other”，是 10-K 的
D&A 代理口径，README 已写明。

### 审计意见分类

`_audit_code` 按“先否定、后肯定”的顺序分类，任何模糊文本返回 `None`，不默认
standard：

1. `disclaimer`：`disclaimer of opinion` 或 `do not express an opinion`；
2. `adverse`：`adverse opinion` 或 `do not present fairly`；
3. `qualified`：`qualified opinion` 或 `basis for qualified opinion`，或意见段
   里的 `except for` + `present fairly`；
4. `standard_unqualified`：`in our opinion` + `present fairly`，且前三类都不成立；
5. 其余返回 `None`。

`_find_audit_paragraph` 优先选 `in our opinion` / `do not express an opinion` /
`disclaimer of opinion` 所在段，而不是更早的 `Basis for Qualified Opinion`
标题；`except for` 本身不是选段条件。因此，标准意见在别的段落提到
`except for` 不会被误判为 qualified。模糊段落会以
`unrecognised_audit_opinion` 或 `missing_audit_opinion` 进入 missing，而不是
猜一个类别。

## 抽取器

`extract.py`：

- 按 `###` section 切分节选；
- 在正确 section 里找 label 前缀；
- 当前期取 label 后第一个数字单元格，比较期取第二个；跳过 `$`、`—`、空单元格；
- 括号数字视为负数；`interest_expense` 取绝对值；
- `audit_opinion` 按上一节的优先级分类，模糊文本返回 missing；
- 找不到 section/label/number 时返回 `status: "missing"` + `reason`，不带
  `value`，不补 0，不猜。

**没有使用 XBRL。** 本 spike 的 21 个事实全部来自 HTML 节选；没有
`companyfacts` 依赖，也没有“XBRL 取数 + HTML 找 citation”的双源路径。
如果未来某个 HTML 表格太脆，可以增加 XBRL 数值源，但仍必须在节选里找到同一
数值的 HTML 行作为 citation，并在文档中逐 fact 说明。

## 接入信用域

`labs/sec_10k/world.py` 实现与生产 `CreditWorld` 相同的方法：

- `list_documents` / `read_document` / `check_restatement` /
  `compute_credit_metric` / `report_blocked` / `verify_citation` /
  `apply_state`；
- `display_name` / `issuer_key` / `restatement`（无重述）。

文档映射：

| 生产 ID | 本 spike 的文档 |
| --- | --- |
| `doc_ar_fy2025` | `doc_10k_fy2025`（本期列） |
| `doc_ar_fy2024` | `doc_10k_fy2024`（上期列） |
| `doc_debt_fy2025` | MD&A total debt + Note 12 short-term debt |
| `doc_rating_fy2025` | 不存在，`read_document` 返回 missing |

`Sec10kWorld` 复用生产的 `CreditPlanner`、`verify_observation` 和
`memo.build_memo`，没有复制一套计划/验证/memo 逻辑。

### 可算指标

EBITDA 代理 = `operating_income + depreciation_amortization` =
11,760 + 2,811 = 14,571 million。

| metric | value |
| --- | ---: |
| net_debt_to_ebitda | 13552 bp（1.36x） |
| interest_coverage | 91469 bp（9.15x） |
| ocf_to_short_term_debt | 27127 bp（2.71x） |
| receivables_to_revenue | 1183 bp（11.83%） |
| audit_opinion | `standard_unqualified` |

缺失：

- `related_party_funding_ratio`：10-K 没有可回读的关联方借款总额；
- `contingent_liabilities_to_equity`：Note 14 是定性/分类披露，没有单一
  “contingent liabilities” 总额；
- `rating_migration`：10-K 没有评级报告。

这些指标返回 `computed: false` + `blockers`，不写 0，不猜。**这是产品语义，
不是抽取 bug**：10-K 本身没有这些披露，memo 因此 `issued: false`、
`decision_status: blocked`，等待人工复核；不要为了凑 8 个指标去补值。

### Memo

生产 memo 被复用，lab 只覆盖真实数据元信息：

```text
recommended_conclusion = insufficient_evidence
conclusion_authority   = policy
decision_status        = blocked
issued                 = false
signed                 = false
verified               = false
missing                = [related_party_funding_ratio,
                          contingent_liabilities_to_equity,
                          rating_migration]
synthetic              = false
research_only          = true
source_url             = <SEC URL>
accession              = 0000858877-25-000111
```

`memo.md` 明确写“真实公开数据（SEC 10-K），仅用于 FCode 抽取研究；不构成任何
信贷或投资意见”，不会出现合成数据声明，也不会出现投资/信贷建议。memo 路径与
trace 链头在 spike JSON 中输出；运行产物在 `work/sec_10k/`（gitignored）。

## 验收

```sh
cd flowcredit
python3.12 -m unittest discover -s tests
python3.12 demo.py all
python3.12 -m unittest tests.test_multi_agent_lab
PYTHONPATH=src python3.12 labs/credit_dd/spike.py
PYTHONPATH=src python3.12 labs/sec_10k/spike.py
```

Phase 2a.1 的结果：

- 21/21 事实的 `value`、`unit`、`source_unit`、`period`、`doc_id`、`line`、
  `snippet` 与 ground truth 精确匹配（11 当前期 + 10 比较期）；
- 5 个可算指标与 ground truth 一致；3 个缺失指标没有编造值；
- 四类审计意见（standard / qualified / adverse / disclaimer）分类正确，模糊
  文本返回 `None`；
- 每条 citation 都能在 `excerpt.txt` 回读；
- memo `recommended_conclusion=insufficient_evidence`、`issued=false`、
  `decision_status=blocked`，`missing` 包含 `rating_migration`；
- 231 个既有测试 + 4 个新增测试、金融 v10 golden、`demo.py all`、multi-agent、
  credit spike 全部不回归。

## Go / No-Go

**Go（建议进入 Phase 2b）**：21/21 事实精确匹配，5/5 可算指标一致，抽取路径
完全确定性、零第三方、零 LLM。下一阶段先扩到第二份 10-K，而不是直接做 10 家
评测。

但需要带着以下边界进入：

- 本 spike 只覆盖一家发行人、一份 filing；HTML 表格规则很窄，换发行人可能
  需要新的 section/label 规则；
- 没有 XBRL 双源校验；真实评测前应至少为每个 fact 增加一个“HTML citation
  回读”断言（本 spike 已有）；
- rating / related-party / contingent 在 10-K 中缺失是产品语义，不是抽取
  bug；不要为了凑 8 个指标去猜；
- 真实 LLM 仍未接入；当前验证的是抽取与世界适配，不是模型质量。
