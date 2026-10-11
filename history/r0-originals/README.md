# FlowCredit-Harness

Evidence-native 的原生金融研究 Harness：由主机控制授权、模型路由、预算与工具；通过可恢复执行和独立验证积累可审计的研究轨迹。当前是 **R0 本地正式仓库候选**，以已验收 T0 为唯一实现基线。

需要 **Node.js 24、Git、macOS 或 Linux**。无外部依赖、无需安装、无需 npm、无需模型密钥。

```sh
node scripts/verify.mjs
```

这与 CI 使用相同入口，运行 **280 项原 M3-A/T0 测试 + 11 项仓库安全测试**。每次测试在新的受保护目录中执行，日志和失败现场分别保留。快捷验证：`node scripts/verify.mjs repository`；DeepSeek / Recorder 子集：`node scripts/verify.mjs deepseek`、`node scripts/verify.mjs trajectory`。子集不代表完整验收。

当前能力包括 Durable Harness、独立 Model API、DeepSeek 注入式 HTTP 协议、M4 动态循环，以及 T0 签名轨迹、质量门和可核验结构导出。76 个继承模块与测试原样保留。真实模型默认关闭；unknown 不自动重发，预算预留不自动退还；工具与完成状态由 Runtime 独立校验。T0 入口保持离线。

| 目录 / 文件 | 用途 |
| --- | --- |
| `packages/native-agent/` | 原 Harness、Model API、Loop、Trajectory 和适用测试 |
| `vendor/flowcredit-finance/` | 原 Evidence Authority、确定性计算和真实金融测试闭包 |
| `scripts/`、`test/`、`.github/workflows/` | 发布文件审查、独立测试入口和 CI |
| `history/`、原协议文档 | M0–M4、M3-A、T0 的来源摘要与版本边界 |
| `examples/` | 已检查的合成结构样例，不是可直接训练的聊天 SFT 数据 |
| `work/`、`validation/` | Git 忽略的本地受保护实验现场，禁止公开 |

包入口保持 `flowcredit-harness` 与 `flowcredit-harness/trajectory`。装配实例及行为合同在原 `packages/native-agent/test/deepseek.test.mjs` 和 `trajectory.test.mjs` 中；新使用者先读 [架构](docs/architecture.md) 与 [开发 / CI](docs/development.md)。

- [R0 验收与真实测试证据](reports/R0_ACCEPTANCE.md) · [独立审查](reports/R0_REVIEW.md)
- [模型与恢复合同](PROTOCOL.md) · [轨迹与质量合同](TRAJECTORY_CONTRACT.md)
- [发布与隐私边界](SECURITY.md) · [许可证范围](LICENSE.md)
- [下一阶段数据集研究问题](docs/research-foundation.md)
- [已验收 T0 报告](reports/ACCEPTANCE.md) · [历史失败目录](history/failure-catalog.json)

Finch 已知并发回归 **286/287**、相同原标准串行复核 **287/287** 的历史事实完整保留；高负载稳定性未证明，也未在 R0 修复。当前仓库只包含 Harness 所需的真实金融依赖闭包，不包含完整 Finch Buyer/服务器套件。

R0 不证明真实模型研究增益、金融事实 Gold、数据法律使用权、匿名化、真实计费或断电一致性。Teacher 采样、Student 训练、正式发布与推送均需另行授权。仓库根代码尚未另授开源许可；金融 vendor 的原 MIT 许可证保留。
