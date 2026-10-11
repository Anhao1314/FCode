# FlowCredit-Harness · T0 验收报告

本轮完成最小 Evidence-Native Trajectory Recorder，唯一实现基线为本机已验收 M3-A。成果仅为独立本地未提交候选；没有真实 Teacher 请求、模型密钥读取、依赖安装、GPU/训练、模型下载、提交、推送或部署。

## 验收结果

| 目标 | 结果与证据 |
| --- | --- |
| 记录真实 Harness 完整可关联执行 | IMPLEMENTED / TESTED_OFFLINE：原 M3 DeepSeek 注入适配驱动 M4 Loop 和真实金融工具；私有轨迹关联目标、版本/时间、每轮 child/request/Plan、实际步骤结果、来源、独立验证、费用和最终状态。 |
| 重启恢复与去重 | TESTED_OFFLINE：同一执行快照重复 capture/export 得到同一记录和字节；四次真实 SIGKILL 分别验证 orphan blob 复用、witness/latest 显式恢复、history-before-witness 阻断和模型 unknown 后签名对账。历史 unknown 未改写，最终只导出一个正向 row。 |
| 质量分类 | IMPLEMENTED：verified-success、verified-failure、insufficient-evidence、unknown、unverified-failure、in-progress；只有独立 Runtime 确认的成功是正向结构化候选，负例不是正样本，模型自评不参与。 |
| 来源、隐私与可核验导出 | TESTED_OFFLINE：逐来源清单/许可/use/schema/snapshot/principal 绑定；当前授权重验、到期拒绝、私有暂存后原子发布、签名许可 sidecar；规范 JSONL 与 hash 可由原 Runtime 重建，篡改拒绝。公开样例只含结构、计数和作用域化引用。 |
| 原安全机制 | 原 M3-A 的 68 个 JS/MJS 源码及测试模块逐字节未变，全部原测试标准保留；capture/export 不执行模型或金融工具，不写执行 Checkpoint、重发、自动退款或换供应商。 |
| 完整回归与独立检出 | 候选 **280/280**，同机独立 clone 加相同未提交候选覆盖 **280/280**，均失败/取消/跳过为零；其中原 M3-A 256 项与 T0 24 项。独立目录无需旧 Mac 路径或 node_modules。 |

Finch 另作只读保护回归：串行运行 **287/287**。首次在两套同步写盘实验并发时为 **286/287**，失败项为旧修订冲突断言（实际名称见下）。该失败没有被删掉、归为 PASS 或修改断言。

## 保留的并发基线失败

原测试名：evidence changed during eligible model explanation cannot publish a receipt against the later revision。

它等待模型回复，同时刷新 Evidence；其夹具默认模型 timeout 为 100ms。在两套持久恢复套件并发写盘时，预期 REVISION_CONFLICT 的 rejection 未出现。源码仍在生成后读取当前 Evidence 并检查 fingerprint；模型 timeout 也可先结束等待并走 fallback。推测刷新提交超过 100ms，导致待测时间顺序与夹具假设不同；现有证据不能证明这一具体因果，也不能据串行通过声称高负载稳定性已解决。

首次失败保留为 validation/finch-protection.concurrent-failure.log；同一未改代码和全部原断言串行复核结果为 validation/finch-protection.log。没有修改冻结 Finch/Copilot 或放宽测试。这项高写盘并发下的旧测试稳定性标为 NOT_PROVEN，需独立任务研究，T0 不扩大范围修复它。

## 原件保护与交付

M3-A 原 79 个候选文件和 40 个原证据文件未变；首轮/M1/M2/M4-L0 共 166 个历史文件未变；Finch 280 个工作文件及 Git status/index/refs 未变。独立检出来源与候选一致，未从旧 HEAD 重建基线，未制造提交。所有原运行状态留在受保护的 work/validation 下且 Git 忽略，公开候选只包含源码、合同、审查摘要和两个脱敏合成结构样例。

- 数据合同：../TRAJECTORY_CONTRACT.md
- 审查和 T0 失败修复记录：../TRAJECTORY_AUDIT.md；原生子代理摘要：review-record.json
- 样例：../examples/offline-structural-candidates.jsonl 与 manifest.json；这是本地候选的合成结构展示，不授予真实训练或外部数据发布权。
- 本地原始证据：validation/candidate-tests.log、independent-tests.log、trajectory.initial.log、trajectory.recovery.log、trajectory.review-fixes.log、trajectory.invalid-output-focused.log、verification.json、protection-verification.json 和各独立实验目录。

## 状态边界

**IMPLEMENTED**：可执行 Loop 轨迹捕获、私有签名及版本合同、同执行去重、质量门、确定性结构导出、来源逐项与当前授权/隐私门控。

**TESTED_OFFLINE**：真实 Harness/确定性金融工具、注入 DeepSeek 与 Mock 对照、条件分支、拒绝、未知、四个真实中断、显式恢复、并发、重复和篡改；完整与独立检出标准通过。

**BLOCKED**：history-before-witness 的 M1_HISTORY_AHEAD；缺失/撤销的访问或来源许可；没有可信收据的 unknown 正样本；真实 Teacher 采样、GPU/Student 训练和发布未授权。T0 facade 明确拒绝 live。

**NOT_PROVEN**：模型真实研究增益、金融事实/信用 Gold、Teacher/Student 效果、外部 Token/价格/计费、许可法律真实性、匿名化、断电及整机 witness 回滚、分布式撤权原子性、跨根预算和上述 Finch 负载稳定性。结构候选不含聊天 SFT 所需目标/回答文本；非法模型响应原合同若只保存 hash，不能恢复原文本。

## Fast & Verified 时间记录

| 指标 | 实测 |
| --- | --- |
| 开发至实现冻结窗口 | 24 分 35 秒，含并行相关测试 |
| 最终交付核验总墙钟 | 约 36 分钟；精确时间记录在 validation/timing.json |
| 测试墙钟区间并集 | 6 分 45 秒 |
| 测试进程累计时间 | 9 分 43 秒，含并行运行与失败 |
| 阻塞等待子代理 | 0 秒；首轮异步研究及一次复审均与 Root 工作重叠 |
| 实现/测试返工 | 4 轮；另有 1 次 Finch 原标准串行诊断重跑 |

时间取本地日志 birth/mtime 与测试报告 duration；开发窗口、测试墙钟和累计进程时间会重叠，不相加当作净编码时间。主要瓶颈是 fsync 的持久化/SIGKILL 实验及签名历史重读；并发写盘也扰动了已有 100ms 夹具时间假设。所有原断言、签名和恢复检查保留。

已到本轮停止点，不自动增加样本、调用真实 Teacher 或进入 Student 训练。
