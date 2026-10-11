# FlowCredit-Harness · R0 验收

本轮已完成以验收 T0 为唯一实现基线的正式本地仓库候选。最小方案保留一个包和原模块布局，只增加仓库门禁、统一离线验证入口、CI 与研发文档。所有 **76 个继承 JS/MJS 模块、辅助文件和原测试断言逐字节保持不变**；R0 新增 3 个 JS/MJS 文件（2 个仓库工具、1 个测试文件），没有重写 Harness。

## 验收结论

| 目标 | 实际结果 |
| --- | --- |
| 干净检出独立运行 | **TESTED_OFFLINE**：从本轮本地 Git 提交真正 clone，`--no-local --no-hardlinks`，无工作区覆盖、共享 object alternates、旧 Mac / Finch 导入、node_modules 或依赖安装；最小环境执行完整验证。 |
| M3-A/T0 不退化 | **291/291**，失败、取消、跳过和 TODO 均为 0；其中原 M3-A/T0 **280 项**全部保留，加 **11 项**仓库负例。真实 SIGKILL、预算、权限、unknown、收据、Evidence、轨迹质量/篡改/恢复仍由原测试覆盖。 |
| 自动化与 CI | 同一 `node scripts/verify.mjs` 已在独立检出实跑；workflow YAML 已解析，官方 action SHA 和所需 inputs 已核对。GitHub 托管 Ubuntu/macOS CI **尚未触发**，需要后续发布授权。 |
| 发布内容安全 | 119 个公开候选文件：代码、合同、合成结构样例和脱敏摘要；工作区、完整暂存区及所有可达提交树通过门禁。没有识别到密钥、原始敏感轨迹或运行状态。私有原始日志/身份/收据不在 Git。扫描为已定义模式和清单审查，不能证明任意敏感自由文本不存在。 |
| 历史与失败来源 | 原 M0–M4/M3-A 来源清单保留；新增 T0 98 个文件的摘要和 25 个私有证据文件的摘要；原件未迁移或改写。首次 R0 完整失败、扫描误报及修复记录全部保留。 |
| Finch 边界 | 原报告并发 **286/287**、同标准串行 **287/287** 的事实未改变；高负载因果/稳定性仍 **NOT_PROVEN**。本轮没有重跑或修复完整 Finch；其真实金融依赖闭包的 93 项测试仍包含在完整回归中。 |

## 真实执行证据

完整测试实现提交：`1de016f8ea19920b465846b88ee64b72e9c2ed54`。平台 `darwin`，Node `v24.19.0`。最终交付如有后续本地提交，仅更新本报告/审查说明；79 个模块与该已测试提交逐字节相同，最终检出另作发布与仓库子集复核。GitHub remote 未写入，未推送、合并、标记或部署。

| 运行 / 范围 | 通过/总数 | 失败 | 测试进程时间 | 原始 TAP SHA-256 |
| --- | --- | --- | --- | --- |
| candidate / trajectory / `run-JfDr5c` | 24/24 | 0 | 64.65s | `3a216e6e9ac0a24eb3267359c642c1e56ce500d3ea65415193d72a062fa4f1eb` |
| candidate / repository / `run-uDhdnO` | 11/11 | 0 | 9.89s | `0070da9c1abc01be4ac950ec57e04215c46857d076fa4ffe3cdbbc4972eb45be` |
| candidate / all / `run-ubeGvn` | 289/290 | 1 | 226.54s | `546f1c8d5208a2076ebefa0fc2e0bc160a310f923ed3eea6666a31366e2c794b` |
| candidate / repository / `run-zEKrEy` | 10/10 | 0 | 4.51s | `0a019f822e17cbdbfa825a43aab3c522b1a4aaf2c1bc189cf354ed85c6445a17` |
| independent-clean-clone / all / `run-ZsebzN` | 291/291 | 0 | 232.00s | `19353498b77e55549f3e5f1ffcd134f51f419f086c216cadeec39a63bb13e221` |

原始 TAP、stderr、summary 和每轮独立执行目录保存在受保护且 Git 忽略的 `validation/`、`work/` 中。公开报告仅包含统计和摘要。它们是本地执行证据，不是第三方签名认证或外部计费保证。

首次完整运行发生在修复完成前，**289/290**：新 runner 将 umask 077 传给原测试，使其故意创建的 0755 不安全目录实际成为 0700，导致缺少预期拒绝。保留现场的目录权限确认了原因。修复只让测试子进程恢复 umask 022；外层 run/log/tmp 目录仍是 0700。随后原 T0 **24/24** 通过，最终独立完整 **291/291** 通过，原断言没有改动。

独立审查另发现 P2：暂存删除必需文件可被仍存在的工作文件掩盖。已改为检查完整 index tree，并新增真实暂存删除负例；仓库测试从 10 增至 11。初始清单脚本路径错误和静态 import 扫描误识别 `--import` 字符串也分别留证；修正的是新工具，不是历史测试标准。详见 [审查记录](R0_REVIEW.md) 和 [失败目录](../history/failure-catalog.json)。

## 原件保护与研究范围

前后检查：T0 98 个公开文件、25 个验证文件；M3-A 79 个公开文件、40 个证据文件；M0/M1/M2/M4 共166个历史文件；Finch 280 个工作文件及 Git status/index/refs 均未改变。没有从旧 HEAD 重建未提交成果，没有复制历史私有签名身份或真实凭证。

**IMPLEMENTED**：独立本地 Git 基线、来源/失败目录、发布清单与工作区/index/history 检查、私有逐轮测试现场、统一零依赖入口、CI 配置、架构及研究边界文档。

**TESTED_OFFLINE**：完整独立检出 291 项、原 76 模块/合同不变、仓库负例、来源保护与可执行的 CI 同入口。当前实际运行平台是 macOS；Linux job 已配置但本地未实跑，Windows 不属于当前 POSIX 验证范围。

**BLOCKED / WAITING_AUTHORIZATION**：正式推送/发布、首次真实 Teacher 采样、Student 训练；根代码统一开源许可证需由所有者决定，vendor 原 MIT 保留。unknown、权限撤销及无可信来源许可等既有执行阻断不变。

**NOT_PROVEN**：实际 GitHub CI 成功、Linux/Windows 运行结论、操作系统网络隔离、任意敏感文本检测完整性、真实研究/训练收益、金融事实 Gold、来源法律权利、匿名化、真实 Token/计费、任意断电和外部不可篡改存证、Finch 高负载稳定性。

## 下一阶段

下一步建议先定义小规模 Teacher Dataset 协议与独立评测任务：确定 Student 学习目标、所需任务/回答文本、执行标签与事实标签的区别、逐来源训练许可、实体/来源/时间拆分、去重与泄漏控制，再比较静态 Plan / Mock / 后续授权 Teacher。T0 结构样例不能直接作为聊天 SFT 数据。详细问题与实验建议见 [研究基础](../docs/research-foundation.md)。本轮未实现这些未来功能。

截至验收报告生成，墙钟约 22.5 分钟；原生审查没有阻塞等待。主要成本是原持久化/SIGKILL 回归及一次新 runner 权限语义修复后的复测。保留失败后停止，无额外扩样或训练。
