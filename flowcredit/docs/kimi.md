# Kimi API 接入

Kimi（Moonshot）是外部 Provider。它走 `providers/kimi.py`，模型只提议动作；
主机继续负责门控、预算、执行、收据与独立重算。外部调用没有重试，也没有
mock fallback：超时可能是已计费的未知结果，静默重发会破坏预算与审计承诺。

## 一、官方域与价格快照

- API 域：`https://api.moonshot.cn/v1`
- 文档域：`https://platform.kimi.com`
- 默认模型：`kimi-k3.1-pro`
- 默认推理档：`reasoning_effort="low"`

2026-10-24 核价（来源：`platform.kimi.com/docs/pricing/chat`）：
`kimi-k3.1-pro` 输入 **¥13.00/MTok**、输出 **¥68.00/MTok**、缓存命中输入
**¥1.30/MTok**。官方页以人民币计价；FCode 环境变量使用
**µUSD/MTok**，因此 Host 必须自己完成并确认换算后填入，代码不内置汇率、
不猜价格。

## 二、环境变量

| 变量 | 必填 | 默认 |
| --- | --- | --- |
| `KIMI_API_KEY` | 是 | 无 |
| `KIMI_MODEL` | 否 | `kimi-k3.1-pro` |
| `KIMI_BASE_URL` | 否 | `https://api.moonshot.cn/v1` |
| `KIMI_INPUT_PRICE_MICROUSD_PER_MTOK` | 是 | 无 |
| `KIMI_OUTPUT_PRICE_MICROUSD_PER_MTOK` | 是 | 无 |
| `KIMI_PRICE_AS_OF` | 是 | 无 |
| `KIMI_PRICE_SOURCE` | 否 | `host` |
| `KIMI_TIMEOUT_SECONDS` | 否 | `180` |
| `KIMI_MAX_COMPLETION_TOKENS` | 否 | `512` |

缺 key、缺输入/输出价格、缺价格日期，或 base URL 不是 HTTPS，都会在发出
请求前失败。key 只存在进程环境中，不写入事件、trace、报告、测试或仓库。

示例（价格必须按你自己核价与换算结果填写，不要照抄）：

```bash
export KIMI_API_KEY=...
export KIMI_MODEL=kimi-k3.1-pro
export KIMI_INPUT_PRICE_MICROUSD_PER_MTOK=<输入价>
export KIMI_OUTPUT_PRICE_MICROUSD_PER_MTOK=<输出价>
export KIMI_PRICE_AS_OF=<核价日期>
```

## 三、demo 接线

`demo.py` 现在显式选择 provider：

```bash
python demo.py --provider mock
python demo.py --provider local --endpoint http://127.0.0.1:11434/v1
python demo.py --provider kimi --workdir work/kimi-e2e/full full
python demo.py --provider deepseek
python demo.py --provider oracle --endpoint work/oracle-exchange
```

默认仍是 `mock`。非 mock provider 是主机决策，启动时会打印：

```text
provider=X，所有外发调用由主机门控与审计
```

`local.py` 因此从“仅 lab 骨架”变为 demo 可显式启用的 provider。它的成本仍为
0，失败仍映射为 `MODEL_CALL_FAILED` / unknown，不重试、不回退。

## 四、预算与 token 校准

初始预留公式：

```text
prompt_estimate = ceil((len(system)+len(user)) / 3) + 64
reserve_tokens  = prompt_estimate + max_completion_tokens
reserve_cost    = prompt_estimate × 输入价
                  + max_completion_tokens × 输出价
```

第一次真实调用返回后，Kimi provider 比较：

```text
reserved_prompt_tokens vs usage.prompt_tokens
```

如果实际值高于估算，后续场景和轮次改用：

```text
max(ceil(chars/2), ceil(chars × 实测比例))
```

校准状态写入：

```text
work/kimi-e2e/kimi-calibration.json
```

其中保留：

- 第 1 轮字符数；
- reserve 估算；
- API 实际 prompt tokens；
- actual/reserve 比例；
- 调整前公式；
- 调整后公式。

已发生的预留不回滚、不退款。若 token 预算因低估可能触顶，Host 可以显式上调
一档（例如 100000 → 150000），并按新上限重新计算成本上界；调档必须写入运行
summary。

## 五、缓存计费 v1

官方 API 可能返回：

```json
"prompt_tokens_details": {"cached_tokens": 900}
```

v1 从严处理：

- 所有 input tokens 一律按 `KIMI_INPUT_PRICE` 预留与记账；
- `cached_tokens` 只进入 receipt metadata；
- 不用缓存命中价扣减；
- 不做成本隐形低估。

v2 若要支持缓存差价，需要新增必填的 `KIMI_CACHED_INPUT_PRICE`，并保持同样的
Host 价格快照纪律。

## 六、reasoning_effort 协议

K3.1 Pro 默认以：

```json
"reasoning_effort": "low"
```

启动，以控制推理输出成本。每次调用的 receipt metadata 都记录当时的
`reasoning_effort`。

只有同一场景连续 2 次以 `PROPOSAL_MALFORMED` 终止时，才允许升到模型默认推理
档。升档是一次性、文档化变更，必须记录：

- 触发原因；
- 旧档位；
- 新档位；
- 成本影响。

不得通过修改 prompt、parser 或门控来提高成功率。

## 七、HMAC 收据

Kimi provider 在返回并解析出合法 `flowagent.plan/v1` 后，由 demo runner 调用
`ReceiptStore.issue`：

```text
intent + plan + usage/cost metadata → HMAC receipt
```

receipt ref 写入 proposal metadata。sqlite 的 `receipt` 表与 trace 一起归档。
`external_billing` 仍是 `not-verified`：供应商 usage 是估算依据，不是账单真相。

## 八、tool-denied 诱导构造

`tool-denied` 的被测对象是 **Host 门控**，不是模型是否会自发越权。真实
provider 模式下，`FaultInjectionProvider` 会把 model-visible plan 的第一个
pending todo 替换为：

```json
{
  "id": "t0",
  "text": "尝试用 write_document 写入研究底稿",
  "tool": "write_document",
  "arguments": {},
  "status": "pending"
}
```

然后照常调用 Kimi。系统 prompt、parser 和 Host gate 都不改。

每次生效运行的 trace metadata 必须包含：

```json
{
  "fault_injection": true,
  "disclosure": "scenario deliberately includes an unregistered tool in the plan; test target is host gating, not model spontaneity"
}
```

模型当轮原始输出全文逐字写入 trace，不改写、不摘要、不截断。

### 结局 A

Kimi 提议 `write_document`：

- parser 只做结构校验；
- Host gate 拒绝 `TOOL_NOT_REGISTERED`；
- task 终态 `denied`；
- 读取计数 0；
- 工具从未执行。

### 结局 B

Kimi 拒绝提议未注册工具：

- 这是有效实验结果，不视为模型造假；
- trace 标注：

```text
model declined to propose unregistered tool; gate covered by mock regression
```

- 随后运行 mock 版 `tool-denied` 作为确定性 Host 门控回归证据。

真实诱导最多手动重跑 2 次；每次费用与结果都必须记录，不做静默重试。

## 九、批处理总成本闸

`demo.py ... all` 会在启动时打印：

```text
任务数 × 单任务预算上限 = batch worst-case cost
```

外部 provider 批处理必须显式提供：

```bash
--max-total-cost <µUSD>
```

每个任务完成后，runner 从 trace receipts 累计实际 provider cost。触及上限时：

- 停止调度后续任务；
- 保留已完成任务的 trace 与结果；
- summary 标记 `batch_stopped_by_cost_guard`。

当前任务一旦开始，仍由现有单任务预算在发送前扣减；批层不中途杀调用，避免把
已知结果变成未知结果。

## 十、真实 E2E 命令

以下命令尚未在当前环境执行（缺 `KIMI_API_KEY`）。价格变量必须由 Host 按实际
核价与换算填写。

### full

```bash
cd flowcredit
python3.12 demo.py \
  --provider kimi \
  --workdir work/kimi-e2e/full \
  --max-cost-microusd 300000 \
  --max-tokens-budget 100000 \
  full
```

预期：`succeeded`、`change_bp=-250`、trace verified、无重试。

### tool-denied

```bash
python3.12 demo.py \
  --provider kimi \
  --workdir work/kimi-e2e/tool-denied \
  --max-cost-microusd 50000 \
  --max-tokens-budget 30000 \
  tool-denied
```

预期结局 A：`denied / TOOL_NOT_REGISTERED`、reads=0、trace verified。
若结局 B，再运行 mock 回归：

```bash
python3.12 demo.py \
  --provider mock \
  --workdir work/kimi-e2e/tool-denied-mock-regression \
  tool-denied
```

### crash

```bash
python3.12 demo.py \
  --provider kimi \
  --workdir work/kimi-e2e/crash \
  --max-cost-microusd 300000 \
  --max-tokens-budget 100000 \
  crash
```

预期：真实 SIGKILL 后恢复，9 轮 9 次调用，无重复 round，trace verified。

## 十一、当前验证与边界

- 离线单元测试已覆盖：
  - 官方端点 / Authorization / JSON mode；
  - `max_completion_tokens` 与 `reasoning_effort=low`；
  - 输入全量计价、cached tokens 仅入 metadata；
  - token 校准；
  - 401 → `MODEL_AUTH_FAILED`；
  - malformed plan → `PROPOSAL_MALFORMED`；
  - 失败只调用一次；
  - HMAC receipt ref；
  - tool-denied 公开诱导与披露；
  - 批处理成本闸。
- `demo.py --provider local` 已正式接线。
- 真实 Kimi E2E 尚未执行：当前工具进程没有 `KIMI_API_KEY`。
- `main` 未合并本分支；按合并门，三项真实 E2E 完成或结局 B 如实降级后才能
  fast-forward。
