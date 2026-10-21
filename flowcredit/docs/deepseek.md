# DeepSeek API 接入

DeepSeek 是**外部 Provider**，不是本地模型。它走 `providers/deepseek.py`，必须遵守
FCode 的外部调用纪律：密钥只从环境变量读、价格快照由 Host 提供、调用前按上界
预留预算、超时/断连不重试、失败不回退 mock。

## 一、能做什么

| 模式 | 类 | 输出 | 用途 |
| --- | --- | --- | --- |
| 完整提案 | `DeepSeekProvider` | `flowagent.plan/v1` JSON | `demo.api` 跑 full / open-ended 场景 |
| Packet 选择 | `DeepSeekPolicy` | `{"choice":"aN"}` | `demo.packet --policy deepseek` 验证 EPA |

两者都只提议：Host 仍然 gate、预算、执行、复算；DeepSeek 不执行工具。

## 二、准备

```bash
export DEEPSEEK_API_KEY=...          # 不要写进仓库
# 可选：export DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
```

价格必须从你自己的 DeepSeek 账单页读取，单位是 **µUSD / 1M tokens**，并写明读取
日期。代码不内置价格，避免用过期数字算预算。

- 输入价格：`--input-price-microusd-per-mtok`
- 输出价格：`--output-price-microusd-per-mtok`
- 缓存命中价格（可选）：`--cache-hit-price-microusd-per-mtok`
- 价格日期：`--price-as-of`（必填）
- 来源：`--price-source`（默认 host）

例如输入 0.27 美元/百万、输出 1.10 美元/百万，写成 `270000` / `1100000`
（1 美元 = 1,000,000 µUSD）。请按实际账单填写，不要照抄这个示例。

## 三、跑完整提案

```bash
cd flowcredit
PYTHONPATH=src python3 -m flowagent.demo.api \
  --workdir /tmp/fcode-deepseek-full --scenario full --fresh \
  --model deepseek-chat \
  --input-price-microusd-per-mtok <输入价> \
  --output-price-microusd-per-mtok <输出价> \
  --price-as-of 2026-10-21
```

open-ended：

```bash
PYTHONPATH=src python3 -m flowagent.demo.api \
  --workdir /tmp/fcode-deepseek-open --scenario open-ended --fresh \
  --model deepseek-chat \
  --input-price-microusd-per-mtok <输入价> \
  --output-price-microusd-per-mtok <输出价> \
  --price-as-of 2026-10-21
```

通过条件与本地模型相同：`full` 到 `succeeded/-250bp`，`open-ended` 到
`failed/INSUFFICIENT_EVIDENCE`，链验证通过，无 `PROPOSAL_MALFORMED`。

## 四、跑 packet 选择

```bash
PYTHONPATH=src python3 -m flowagent.demo.packet \
  --workdir /tmp/fcode-deepseek-packet --scenario full --fresh \
  --policy deepseek --model deepseek-chat \
  --input-price-microusd-per-mtok <输入价> \
  --output-price-microusd-per-mtok <输出价> \
  --price-as-of 2026-10-21
```

DeepSeekPolicy 只调用一次，没有 repair；输出不是合法候选就抛
`POLICY_INVALID_CHOICE`，不会偷偷再打一次 API。`PacketProvider` 会把
`cost_microusd` 和 `provider_request_id` 写进 receipt metadata。

## 五、预算与成本语义

`Harness` 在发送前按 provider 声明的上界预留。DeepSeek 的 `reserve()` 会先渲染
实际要发送的 prompt，按字符数估算 prompt tokens，再加 `max_tokens`：

```text
reserve_tokens ≈ ceil(chars(system + user) / 3) + 64 + max_tokens
reserve_cost   = input_price * prompt_estimate + output_price * max_tokens
```

- 默认 `max_tokens=256`；一个单步 plan 通常 50–100 tokens。
- 预留是上界，不是实际费用；FCode 不在结果返回后“退款”，这是设计选择：
  宁可少花，不能超支。
- Receipt 里记录实际 usage 估算（按价格快照）和 `external_billing: not-verified`。
- 如果 `usage` 缺失，metadata 标 `usage_missing`，不会假装成本为零。
- 价格快照、request id、prompt version 都进 metadata，便于审计复算。
- full-proposal 的 v10 上下文较长，如果模板的 20k token / 20k µUSD 预算不够，
  用 host 参数显式放宽：
  `--max-calls 16 --max-cost-microusd 40000 --max-tokens-budget 40000`。
  packet 模式通常只要 500–800 tokens/轮，优先用 packet。

## 六、失败语义

| 情况 | 行为 |
| --- | --- |
| 401/403 | `MODEL_AUTH_FAILED`，任务进 `recovery_required`，不自动重试 |
| 429/5xx/超时/断连 | `MODEL_CALL_FAILED`，任务进 `recovery_required`，不自动重试 |
| 返回非 JSON / 空 content | `MODEL_CALL_FAILED` |
| 返回 JSON 但不是合法 plan | `PROPOSAL_MALFORMED`，不重试 |
| packet choice 非法 | `POLICY_INVALID_CHOICE`，不 repair、不重试 |
| 缺 key / 缺价格 / http URL | 启动前失败，不会发出请求 |

外部调用没有“免费重试”：超时可能已经计费，重试会重复付费。

## 七、安全边界

- API key 只在进程环境变量里，不写事件、不写日志、不进报告。
- Base URL 必须是 `https://`；不允许明文 HTTP。
- 只把合成/演示数据发给 DeepSeek；不要发客户资料。
- DeepSeek 的返回只是提议；数字仍由 Runtime 复算，报告仍由证据链生成。
- 当前控制台默认仍是 offline-mock；`demo.api` / `demo.packet` 是 lab。
  接控制台前要先在真实 key 下跑通 full / open-ended / packet 三条路径。

## 八、当前验证与限制

2026-10-21 已用**假端点**跑通完整流程：`DeepSeekProvider` + full 场景 9 轮、49
事件、`succeeded`、链验证通过；packet policy 的请求/成本/非法 choice 测试通过。
**真实 DeepSeek API 尚未实测**，因为环境里没有 `DEEPSEEK_API_KEY`。

- 只支持 `deepseek-chat` 的 JSON mode，不假定支持 JSON Schema；结构化约束仍靠
  本地校验。
- Packet policy 没有 repair；这是为了不隐藏第二次计费。
- 预留 token 是按字符估算的，不是 DeepSeek 的精确 tokenizer；如果 prompt 远超
  估算，receipt 的实际 usage 会偏高，Host 需要把预算留出余量。
- 价格是快照，不是实时账单；receipt 标 `external_billing: not-verified`。
- 控制台尚未接入 DeepSeek；下一步是加 host 配置和 `/api/health` 展示，再做 UI 切换。
