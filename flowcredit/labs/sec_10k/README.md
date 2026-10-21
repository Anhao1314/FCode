# SEC 10-K 抽取 lab（Phase 2c：两家发行人）

> 真实公开数据；仅用于 FCode 抽取研究，不构成任何信贷或投资意见。
> 这里不做投资结论，只验证“不同发行人能否用同一套 profile 驱动抽取”。

## 两家 filing

| 字段 | Cisco | Home Depot |
| --- | --- | --- |
| Company | Cisco Systems, Inc. | The Home Depot, Inc. |
| CIK | `0000858877` | `0000354950` |
| Ticker | `CSCO` | `HD` |
| Accession | `0000858877-25-000111` | `0001628280-26-019436` |
| Fiscal year | FY2025 | FY2025 |
| Fiscal year end | 2025-07-26 | 2026-02-01 |
| Filed | 2025-09-03 | 2026-03-18 |
| Primary document | `csco-20250726.htm` | `hd-20260201.htm` |
| Source URL | <https://www.sec.gov/Archives/edgar/data/858877/000085887725000111/csco-20250726.htm> | <https://www.sec.gov/Archives/edgar/data/354950/000162828026019436/hd-20260201.htm> |
| Raw sha256 | `36be983637c033c8c03ffcbbc404f1cda0a437f6951959aab7f5cd124978b423` | `4fca0701d4981730e6d501d102966be40e5c144e7dad4b52f212cbcee2643f05` |
| Excerpt sha256 | `3b5f70f758adccec897e573e4975fbc6866e494313f814431bc464fe69e9b943` | `d672ffcf8b85fe5ac9bf46237f05ecf8bc9d70bf1b4e5281bcc72fc216ef2d65` |
| Excerpt lines | 122 | 85 |

Home Depot 的 primary document 含合并资产负债表、收益表和现金流量表；fiscal 2025
（52 周，截至 2026-02-01）可直接映射为 FY2025 / FY2024，因此不需要切换到
Coca-Cola。Cisco 的 IBM 选择说明仍保留在 `docs/sec-10k-extraction.md`。

## 数据目录

```text
labs/sec_10k/
  fetch.py          # 按 --issuer 下载并重建 excerpt/meta
  html_to_text.py   # html.parser -> block/table lines
  profiles.py       # FilingProfile 加载器（规则本身是 JSON 数据）
  extract.py        # 通用 extractor：section + labels + column rule + components
  world.py          # Sec10kWorld: CreditWorld-compatible adapter
  spike.py          # 按 issuer 跑抽取 + 生产信用计划 + memo
  data/
    cisco/
      profile.json        # sections / labels / columns / excerpt anchors
      excerpt.txt         # 122 lines
      ground_truth.json   # 21 hand-verified facts
      meta.json           # CIK, accession, URL, retrieved_at, sha256
      raw/                # full HTML; gitignored
    home-depot/
      profile.json
      excerpt.txt         # 85 lines
      ground_truth.json   # 21 hand-verified facts
      meta.json
      raw/
```

代码里没有 Cisco 的 CIK、accession、primary document、`FIELD_LINES` 或
`issuer_key = "cisco"`；这些只存在于 `data/<issuer>/profile.json` 和测试数据中。

## 运行

```sh
cd flowcredit
PYTHONPATH=src python3.12 labs/sec_10k/spike.py --issuer cisco
PYTHONPATH=src python3.12 labs/sec_10k/spike.py --issuer home-depot
PYTHONPATH=src python3.12 labs/sec_10k/spike.py --all
python3.12 -m unittest tests.test_sec_10k_extract -v
```

抓取/重建（需要真实 SEC user agent，联系人不会写入仓库）：

```sh
SEC_USER_AGENT='FCode research <you@example.com>' \
  python3.12 -m labs.sec_10k.fetch --issuer cisco --reuse-raw
SEC_USER_AGENT='FCode research <you@example.com>' \
  python3.12 -m labs.sec_10k.fetch --issuer home-depot --latest --reuse-raw
```

`fetch.py` 的 `--issuer` 选择 `data/<issuer>/`；`--cik` / `--company` 可覆盖
profile；`--latest` 从 submissions feed 发现最新 10-K；`--reuse-raw` 使用已下载
的完整 HTML 并校验已有 sha256。请求间隔 ≥0.2s。

## Text pipeline

`html_to_text.py` 只用 `html.parser`：

- 块元素一行；
- 每个 `<tr>` 一行，单元格用 ` | ` 分隔；
- 保留括号负数、`$`、`%`、逗号；
- 1-based 行号，对同一份 HTML 稳定可复现。

`profile.json` 的 `excerpt` 规则支持两种模式：

- `between`：精确起始行 + 结束前缀，可从上一段之后或某个 anchor 之后搜索；
- `around`：全局 anchor 前后若干行（Cisco 的 MD&A total debt 使用）。

Cisco 的六段规则复现原 122 行 excerpt；Home Depot 的四段规则选择审计报告、
资产负债表、收益表和现金流量表，共 85 行。两者都在 80–150 行范围内。

## Ground truth

每个 issuer 的 `ground_truth.json` 是人工读 filing/节选后写的，不由
`extract.py` 生成。每条包含 `value`、`unit`、`source_unit`、`period`、
`doc_id`、1-based `line`、逐字 `snippet`、`source_url`、`accession`。

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
| accounts_receivable (`Receivables, net`) | 5,597,000,000 | 13 | doc_10k_fy2025 |
| equity | 12,813,000,000 | 46 | doc_10k_fy2025 |
| audit_opinion | `standard_unqualified` | 6 | doc_10k_fy2025 |

Home Depot 比较期（FY2024）：revenue 159,514,000,000；operating income
21,526,000,000；D&A 3,034,000,000；interest 2,321,000,000；cash 1,659,000,000；
total debt 53,383,000,000；short-term debt 4,898,000,000；OCF 19,810,000,000；
receivables 4,903,000,000；equity 6,640,000,000。全部引用 `doc_10k_fy2024`。

**总债务组件**（Home Depot 没有单行 Total debt）：

```text
total_debt = Short-term debt
           + Current installments of long-term debt
           + Long-term debt, excluding current installments
           = 4,464 + 4,967 + 46,341 = 55,772 million

short_term_debt = Short-term debt + Current installments
                = 4,464 + 4,967 = 9,431 million
```

`total_debt` 返回 3 个 `components` 和 3 条 citation（lines 25 / 31 / 35）；
`short_term_debt` 返回 2 个 components（lines 25 / 31）。每一行都有逐字
`snippet`，不是用一行假造的 “Total debt”。Cisco 的债务仍是单行，不返回
components。

## Extractor rules

`extract.py` 是确定性、标准库实现，规则来自 `profile.json`：

- 按 `###` section 标记切分 excerpt；
- 每个 fact 有 section、label aliases（如 `Total revenue` / `Net sales` /
  `Receivables, net` / `Total stockholders’ equity`）；
- 当前/比较列的位置由 profile 的 `columns` 指定，并优先用表头文本验证顺序；
  表头不匹配时返回 `unconfirmed_columns`，不默认“第二个数字”；
- `components` 规则逐行取数并求和，返回每个 component 的 value / line /
  snippet / doc_id；
- 括号数字视为负数；`interest_expense` 取绝对值；
- 审计意见按 `disclaimer` → `adverse` → `qualified` → `standard_unqualified`
  的优先级分类，模糊文本返回 `None`/missing；
- 找不到 section/label/number 时返回 `status: "missing"` + `reason`，不补 0、
  不猜。

## Credit world and memo

`world.py` 不再有 issuer 常量；调用方传入 `issuer_key`、`facts`、`meta`、
`excerpt_lines`、`field_lines`。`Sec10kWorld` 复用生产 `CreditPlanner`、
`verify_observation` 和 `memo.build_memo`，按 `meta` 的 FY2025/FY2024 生成
current / prior / debt / missing-rating 视图。

两家的 5 个必需指标都完整：

| metric | Cisco | Home Depot |
| --- | ---: | ---: |
| net_debt_to_ebitda | 13552 bp (1.36x) | 22507 bp (2.25x) |
| interest_coverage | 91469 bp (9.15x) | 100178 bp (10.02x) |
| ocf_to_short_term_debt | 27127 bp (2.71x) | 17310 bp (1.73x) |
| receivables_to_revenue | 1183 bp (11.83%) | 340 bp (3.40%) |
| audit_opinion | `standard_unqualified` | `standard_unqualified` |

两家的 `related_party_funding_ratio`、`contingent_liabilities_to_equity`、
`rating_migration` 都缺失；它们是 memo v2 的可选指标，所以只进入
`missing_optional` / `optional_gaps` 和 caveat，不阻止签发。两家的 memo 都是：

```text
memo_version           = credit-memo/v2
recommended_conclusion = pass
rule_fired             = no threshold fired
issued                 = true
signed                 = false
decision_status        = pending_human_review
verified               = true
optional_verified      = false
missing_required       = []
missing_optional       = [related_party_funding_ratio,
                          contingent_liabilities_to_equity,
                          rating_migration]
caveats                = [10-K 未披露 rating_migration /
                          related_party_funding_ratio /
                          contingent_liabilities_to_equity；
                          这些可选指标未参与策略结论。]
```

Cisco 的 `net_debt_to_ebitda` 有 4 条 citation；Home Depot 有 6 条（3 条债务
组件 + cash + operating income + D&A）。`audit_opinion` 在两家都引用审计意见
段落（Cisco line 6，Home Depot line 6）。memo 路径和 trace 链头在 spike JSON
中输出。

## Tests

`tests/test_sec_10k_extract.py` 覆盖：

- 两家各 21/21 的 value/unit/period/doc_id/line/snippet/components 精确匹配；
- 每条 citation（含组件）回读 excerpt；
- prior-year 值来自同一 extractor，FY2024 world 视图不使用手写常量；
- Home Depot 的 total_debt 3 个 components、short_term_debt 2 个 components；
- 表头不匹配时返回 missing，不默认列位置；
- 四类审计意见与模糊拒绝；
- 两家 spike `ok`、memo pass/issued/pending、可选缺口；
- `--all` CLI 两家都通过；
- lab `.py` 文件中没有 Cisco 专用常量。

## Limits

- 两家发行人、两份 filing；不是 10 家评测。
- 没有 XBRL 双源校验；HTML 表格规则仍是窄规则，但已按 profile 拆分。
- rating / related-party / contingent 在 10-K 中缺失是产品语义，不是抽取
  bug；不要为了凑 8 个指标去猜。
- 没有接入真实 LLM；memo 结论来自冻结策略，不是投资建议。
- Home Depot 的总债务是 3 行组件相加；如果未来某家发行人的债务口径不同，应在
  该 issuer 的 profile 中新增 components/column 规则，而不是改通用 extractor。
