# M3-A Provider 与恢复合同

## 原有职责继续有效

M2 ProviderModelApi 负责当前模型授权、路由身份、持久调用意图、预算预留、并发租约、结果收据和显式对账。DurableHarness 负责工具执行、Checkpoint、恢复与独立结果验证。M4-L0 继续用每轮独立子任务和调用身份，绑定观察上下文和循环策略；Runtime 决定终止。

M3-A 只增加 DeepSeek profile、可信传输门控和两种原 Runtime 装配。没有重写 ModelBackend、DurableHarness、ModelBudgets、Authority、Risk 或 Repayment。

## 官方接口对应

固定 `POST https://api.deepseek.com/chat/completions`，固定模型 `deepseek-flash`。非流式 `stream: false`，显式 `thinking: {type: "disabled"}`，`response_format: {type: "json_object"}`；消息包含 JSON 指令和 Plan 示例。DeepSeek 的 thinking 默认开启，因此必须显式关闭；JSON mode 只保证 JSON 形态，Plan 的严格字段、版本、步数和工具校验仍在本地执行。[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)、[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)、[JSON Mode](https://api-docs.deepseek.com/guides/json_mode/)

不接受模型别名、自动供应商切换、重定向或原生 function/tool 调用。输出必须是唯一 choice、`finish_reason: stop`、assistant 内容、精确模型标识、有效响应身份与 system_fingerprint。已有适配层限制响应大小、严格 UTF-8、重复 JSON 键和 Plan schema。动态循环每轮只能提出一个动作，再由原循环策略校验。

usage 先执行原 M2 整数、求和和预算上限检查，再验证 DeepSeek 必需的 cache hit/miss、prompt_tokens_details，以及可选 cached_tokens/reasoning_tokens。缓存分项必须加总为 prompt_tokens；显式关闭 thinking 后不接受非零 reasoning。无法确认 usage 时，费用保持未知，不能以零计费。已观察到的超额计数仍优先触发原 M2 额度冻结。

## 真实传输门控

主机属于可信计算边界；模型、任务输入、客户端不可以选择模式、HTTP、凭证或扩大 grant。包门面不暴露原始 registry/backend/modelApi；这不是对任意同进程代码的沙箱。

1. 默认 `disabled`，预检在模型 attempt、凭证解析和 HTTP 之前拒绝。
2. live 只使用构造时捕获的原生 fetch，不能同时提供注入 HTTP。必须有主机 `authorizeTransmission` 和 `credentialProvider`，价格类型必须是 `host-reviewed-snapshot`。
3. 传输批准须精确匹配 request、principal、grant、当前 authorization、route config、pricing 和 prompt hash，有效期不超过一小时。还须提供价格复核摘要及 `acceptUnprovenTokenAndBillingBounds: true`；后者是明确接受尚未证明的风险，绝非硬计费上界证明。
4. 原 Runtime scope、M4 每轮 dispatch permit、持久 reservation 的 dispatched 状态和 held 并发 lease 必须存在并匹配意图，才能解析凭证。
5. 异步凭证解析之后，再次检查当前模型授权、传输批准和取消状态，然后发送 HTTP。凭证只进入单个 Authorization 请求头；不读环境变量，不写状态或收据，不记录供应商错误原文。

价格复核摘要只验证格式和审批绑定，不验证外部报价真实性或新鲜度。主机必须独立核验价格来源。现有 UTF-8 字节加 512 的输入计数不是供应商 tokenizer 的证明，`max_tokens` 也不能证明实际外部总账单。

同一持久根目录、同一主机 scope/grant 的静态 Harness 与动态 Loop 共用 `model-calls`、budget group 和并发池，不能靠切换入口重置配额。不同根目录、scope 或新 grant 的账户级统筹是主机责任，本轮未证明。

## unknown 与收据

持久意图 → 额度预留及并发租约 → dispatched → 适配器结果 → 签名收据 → task/loop Checkpoint。发送边界之后的网络错误、超时、取消、进程中断，以及无法确认的结果保持 unknown。即便局部判断可能没有实际发送，也不在持久 dispatched 之后自动退费或释放未知责任。

恢复不自动重发，不自动换供应商，不把供应商 request id 或客户端 JSON 当可信收据。只有本地可信签名、完整匹配 intent 和当前合同的收据，才可经显式 `reconcile` 确认结果；完整但非法输出可确认 invalid，仍不能执行工具。未持久化收据继续阻断。持久化收据之后中断可对账恢复；Loop 对账原轮之后只允许产生下一轮的新身份。

M3-A 收据版本为 `flowcredit.model-result/m3-a-v1`，新增 DeepSeek 元数据及传输批准摘要，保持 `actualCostMicrousd: null` 和外部计费未确认。旧 M2 收据合同不变，不能静默升级旧状态或把注入模式收据改成 live。

历史 witness、Checkpoint 版本、当前授权重验、篡改/截断/历史回滚拒绝继续由原存储合同执行。SIGKILL 实验是进程中断验证，不能证明任意断电文件系统一致性或整机及 witness 同时回滚后的新鲜度。
