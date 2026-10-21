# 信用尽调 lab（Phase 0 缝证明）

> 本目录中的公司、金额、评级和审计意见全部是合成数据。
> 生产实现已经移入 `flowagent.tools.credit`；这里只保留 Phase 0 的 seam
> proof，不再拥有第二套 world / tools / planner / verifier。

## 现在是什么

- `labs/credit_dd/world.py`、`tools.py`、`planner.py`、`verifier.py`、
  `module.py` 都是 **thin re-export**，指向 `flowagent.tools.credit` 和
  `flowagent.domains.credit`。
- `spike.py` 选择生产 `CreditWorld(issuer="hengxing")`，跑生产十四步蓝图、
  5 个只读工具和真实 `TaskStore` / `ReceiptStore` / `Harness` / `Loop` /
  `MockProvider(policy="research")` / `TraceRecorder`。
- 生产产品面（3 家发行人、8 个指标、Host memo、CLI）见
  [`credit_demo.py`](../../credit_demo.py) 与
  [`docs/credit-due-diligence.md`](../../docs/credit-due-diligence.md)。

## 证明什么

1. 生产信用域能通过真实 Runtime 跑完：8 个指标、37714 / 41667 等值、
   trace 哈希链可验证。
2. 缺债务明细时，c5 被 blocked，c7/c9/c11/c12 被 abandoned，
   c8/c10/c13/c14 仍可执行；终态 `failed / INSUFFICIENT_EVIDENCE`，
   trace 里没有 `net_debt_to_ebitda` 的 computed 数值。
3. lab 没有复制实现：测试用 `is` 断言 lab 的 `CreditWorld`、
   `build_credit_tools`、`CreditPlanner`、`verify_observation` 与生产模块
   是同一个对象。

## 不证明什么

- 不证明真实年报、PDF/OCR、真实 LLM 或真实评级数据可用；全部合成。
- 不生成 memo；memo 由生产 `flowagent.tools.credit.memo` 和
  `credit_demo.py` 负责。
- 不注册用户数据，不做 viewer 集成。

## 怎么跑

```sh
cd flowcredit
PYTHONPATH=src python3.12 labs/credit_dd/spike.py
python3.12 -m unittest tests.test_credit_dd_spike -v
```

spike 输出两个用例：

```json
{
  "ok": true,
  "cases": [
    {
      "name": "happy-path",
      "status": "succeeded",
      "failure_code": "",
      "metrics": {
        "net_debt_to_ebitda": 37714,
        "interest_coverage": 41667,
        "ocf_to_short_term_debt": 3000,
        "receivables_to_revenue": 2296,
        "related_party_funding_ratio": 577,
        "contingent_liabilities_to_equity": 281,
        "audit_opinion": "standard_unqualified",
        "rating_migration": "stable"
      },
      "events": 74,
      "chain_head": "…",
      "verified": true
    },
    {
      "name": "partial-world",
      "status": "failed",
      "failure_code": "INSUFFICIENT_EVIDENCE",
      "metrics": {},
      "events": 53,
      "chain_head": "…",
      "verified": true
    }
  ]
}
```

`events` 与 `chain_head` 随运行时间戳变化；决策序列和指标值确定。

## 历史

Phase 0 在这个目录里首次证明 `DomainModule` seam：2 个指标、6 步蓝图、
`value_x100`。Phase 0.5 把 `result_tools` 移回模块并让 Loop 验证所有结果
observation；Phase 0.6 恢复金融 v10 的字节一致 prompt。Phase 1 把实现提升到
`flowagent.tools.credit`，本目录保留为薄封装和回归入口。
