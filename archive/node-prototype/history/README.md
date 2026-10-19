# 历史、来源与版本边界

原 `native-agent-round1`、M1、M2、M4-L0 的代码、日志、失败案例和收据留在原只读目录，没有迁移运行状态或修改原测试。`accepted-artifact-hashes.json` 记录原历史文件摘要；`source-provenance.json` 记录迁入文件的准确来源摘要。没有迁入真实凭证。

迁入 M4-L0 的 22 个源模块和 14 个测试/辅助模块，旧测试文件逐字节保持不变。五个源模块做有限修改：baseline 和 model-api 的相对导入；provider-adapters 的可选 DeepSeek profile；m2-runtime 的可信 Evidence service 注入；loop-runtime 的原装配复用。新增四个 DeepSeek/包门面模块。M1 durable store、DurableHarness、ModelBudgets、原 Authority 和计算均未改写。

金融闭包包含 25 个原文件及许可证，直接复制实际 Finch RC 工作文件，不从旧 Git 提交读取。包括 EvidenceAssessmentService、Evidence Authority、提取/复核、ModelBackend、Risk 计算和六个原测试套件；源内容与 provenance 摘要一致。未迁入完整 Finch server/Buyer 应用和 AJV 依赖。

| 层 | 保留的合同 |
| --- | --- |
| 首轮 | native-task / native-plan / native-tools `experimental-v1`，原 51 项标准 |
| M1 | durable-history、model-ledger、model-intent、model-result、model-authorization `m1-v1`；新增 28 项标准 |
| M2 | model-intent、model-result、model-authorization、provider-call-ledger、model-budget `m2-v1`；新增 34 项标准 |
| M4-L0 | offline-loop、loop-context、loop-policy `m4-l0-v1`，每轮子任务和上下文身份；新增 26 项标准 |
| M3-A | 新增 deepseek-profile、deepseek-transmission、model-result `m3-a-v1`；24 项新测试 |

旧 M2 仍使用自己的收据版本和默认适配行为。新 DeepSeek profile 的目的、模式、消息、价格和界限进入配置身份，变化后不能把旧 intent/receipt 静默视为兼容。不导入旧实验私有签名身份，不把原 Mock 的签名收据升级成真实供应商收据。

这些摘要保存来源证据和变更边界，不是第三方签名或外部供应商证明。本地完整原件另作前后哈希及 Git 状态保护检查。
