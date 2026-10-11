# FlowCredit-Harness · T0

Evidence-Native Trajectory Recorder 已接入已验收的 M3-A Loop。本轮只验证真实 Harness 执行产生的离线轨迹，不采样真实 Teacher，也不训练 Student。M3-A 的所有源模块、测试与金融依赖保持原样。

需要 Node.js 24+，不需要安装依赖。

```sh
npm test
npm run test:trajectory
```

完整适用范围为 M3-A 的 256 项加 T0 的 24 项，共 280 项。原 256 项测试目标和断言未改写。完整验收结果及时间统计见 [验收报告](reports/ACCEPTANCE.md)。

包新增 `flowcredit-harness/trajectory` 子路径，导出 `createTrajectoryLoop`，返回 `create`、`run`、`reconcile`、`capture`、`export`、`recoverRecording`。执行方法直接调用原 Loop；记录方法明确独立，记录失败不能改写执行成功状态。默认 DeepSeek 关闭，只接受本轮离线模式；原 M3-A 包入口不变。可执行装配见 `packages/native-agent/test/trajectory.test.mjs`。

轨迹从已签名、已锚定的 Loop/子任务历史、模型收据、费用预留及 Evidence 记录重建。无需修改执行 Checkpoint、调用身份、预算、权限、工具执行顺序或 unknown 恢复合同。正常重启重复 capture/export 得到相同引用和字节；历史 unknown 保留，只有原 Runtime 显式对账后才可能出现新的已验证成功快照。

原始轨迹、签名身份、来源元数据和运行状态只保存在权限受限、Git 忽略的本地目录。公开样例只含工具行动、观察计数、费用状态、独立验证标签和作用域化引用；不含目标原文、来源正文/URL/原 contentHash、模型文本、账户能力或凭证。这些是结构化行动/结果候选，不能直接充当聊天 SFT 数据或金融事实 Gold。

- [数据和恢复合同](TRAJECTORY_CONTRACT.md)
- [质量与完整性审查](TRAJECTORY_AUDIT.md)
- [脱敏离线样例](examples/offline-structural-candidates.jsonl) 和 [样例声明](examples/manifest.json)
- `validation/`：本地原始实验、失败日志、最终回归和原件保护证据，默认不进入 Git。
- `history/m3-a-documents/`：原 M3-A 合同文档副本和源文件摘要；历史原件留在原目录。

**IMPLEMENTED**：独立原生轨迹投影、私有签名存储、同一执行去重、质量分类、来源逐项授权、脱敏确定性导出。

**TESTED_OFFLINE**：真实 Harness/金融模块执行、分支、拒绝、unknown、SIGKILL、显式恢复、并发去重、撤权、过期及篡改；完整回归和独立检出结果见验收报告。

**BLOCKED**：没有当前授权、来源逐项许可、匹配收据或完整锚定历史时不得导出正样本。历史先写入而 witness 未发布的中断窗口保持 `M1_HISTORY_AHEAD`，不得猜测提交。真实 Teacher 采样及训练未获授权，T0 入口拒绝 live。

**NOT_PROVEN**：真实研究增益、Teacher/Student 效果、Token/外部计费保证、真实法律使用权、匿名化、断电/整机回滚一致性、跨根目录账户总预算。结构化轨迹标签只说明本地 Runtime 的执行与验证结果。
