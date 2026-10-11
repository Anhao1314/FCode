# T0 数据、质量和导出合同

唯一实现基线是本机已验收 M3-A 候选。原 26 个 Runtime 源模块、17 个测试/辅助模块、金融闭包和原测试引导器均逐字节保留；仅新增轨迹模块、测试和受保护的测试目录引导，并扩展 package 子路径及测试命令。没有改动 DurableHarness、Model API、ModelBudgets、Authority 或确定性金融计算。

## 关联与原始记录

`flowcredit.trajectory/t0-v1` 私有快照包含：原 Loop store 身份与任务 ID、版本/sequence/签名 witness/history hash，研究目标，Loop 策略和时间事件，Evidence binding 和来源元数据，以及每轮 childId/requestId/context/Plan/步骤状态和结果、签名模型收据、调用 ledger、费用 reservation 和 lease。来源正文不复制，继续由原 Evidence Runtime 按访问能力保存；引用由来源 ID/contentHash、Evidence revision 和 assessmentHash 绑定。

关联链为 `loop -> round -> child -> intent.requestId -> receiptRef -> step.id/resultHash -> Evidence source/revision -> Runtime verification`。每个非空子任务都由原 `matchChild` 和当前授权校验，已成功步骤的结果与当前 Evidence 投影重新比对；完成和证据不足状态由原 `terminalResult` 重新计算。没有子任务、意图、收据或工具结果时记录缺口，不能虚构字段或观察。`tool_started` 是已持久化执行意图，进程可在真实工具入口前中断；未收到匹配成功结果时不能声称工具已完成。

原模型只保留通过验证的 Plan、响应摘要和收据。非法响应若原合同只保存 hash，T0 不声称恢复了其文本；无法恢复的响应/计费继续未知。没有采集隐藏推理或原生 function/tool API。

Recorder 在执行之后或重启后显式调用，不插入执行回调，不调用 run/execute/reconcile 来获得标签。捕获和导出借用原任务锁获得一致视图，只读取执行状态；签名轨迹存储使用独立根目录。记录失败不会更改任务最终状态。

## 持久身份和恢复

trajectoryId 由原 Loop storeId 与 loopId 派生；snapshotHash 来自完整、规范化私有投影。自己的 capturedAt 只进入追加 manifest，原 Runtime 时间保留在快照。相同执行相同状态重复捕获复用 immutable blob 和 manifest 项，导出每个轨迹只产生一个稳定 rowId，不追加重复训练行。不同执行或恢复后的新状态有不同快照；不宣称跨运行语义去重。

轨迹 blobs、manifest/history/witness、导出及审批记录均为本地 0700 目录和 0600 文件。已有不安全目录、符号链接和篡改被拒绝；签名/HMAC 使用原持久存储能力，未迁移历史签名身份。

SIGKILL 后保留原 M3 规则：可信主机先使用已有 `recoverLock`，确认进程已死亡再释放遗留锁。Recorder 不自动解锁。blob 已发布、manifest 尚未提交的 orphan 可在当前授权及相同 Runtime 投影验证后复用。witness 已发布而 latest 落后的窗口需显式 `recoverRecording`，它调用原 witness 匹配的 `recoverLatest`。历史已写入而 witness 未发布的窗口继续阻断 `M1_HISTORY_AHEAD`，不删除现场或自动采信未锚定历史。unknown 的模型结果只能由原 Harness 显式签名收据对账；Recorder 不能完成对账或触发重发。

## 质量分离

| 原执行情况 | 轨迹质量 | 导出处理 |
| --- | --- | --- |
| completed，原 Runtime 重算成功且结果完全匹配 | verified-success | 正向结构化执行候选 |
| 签名确认非法模型输出；独立工具 gate 拒绝；独立确认轮数耗尽 | verified-failure | 负向诊断候选，positiveEligible=false |
| 两次真实 Runtime 空读取并独立确认不足 | insufficient-evidence | 不进入训练行 |
| 调用未知、没有可信结果、恢复未确认 | unknown | 不进入训练行，不退款或重发 |
| 临时工具错误、预算错误等不能独立复现结论 | unverified-failure | 保留现场，不进入训练行 |
| 非终止状态 | in-progress | 保留现场，不进入训练行 |

成功仅指 `offline-runtime-execution-only`。来源 fetched/user-declared 状态、有效 JSON、Plan、费用收据或模型自评分都不是金融正确性标签。模型自评从未参与 label。Mock 与 DeepSeek 注入分别标记 origin，`teacherSampling=false`。负向样例不是自动偏好对或 SFT 正样本。

## 使用许可与可复现导出

`flowcredit.trajectory-dataset/t0-v1` 使用规范化 JSONL；相同快照和 schema 的每次导出字节及 dataHash 一致。每条 row 保留 trajectory/snapshot 引用、作用域化目标/任务/请求/上下文/收据/观察/验证引用、已注册行动和观察计数、最终状态和费用状态，可在受保护本地记录中追溯全部链路。独立核验必须在当前授权下重新投影原 Runtime 并比对，不可只信文件自带 hash。受控导出文件篡改会导致重新导出冲突。

导出默认拒绝。可信主机须提交 `flowcredit.trajectory-rights/t0-v1` 批准，精确绑定 snapshot、principal、来源 ID/contentHash/kind/verification、schema 和 `offline-training-candidate` 用途，逐来源给出 allow、许可依据及证据引用。有效期最多一小时；复核者、许可和隐私摘要是主机证明材料的引用，代码不验证其法律真实性。`retrieved` 不代表版权或训练许可，`user-declared` 不代表同意。

捕获在 blob 之前及提交 manifest 之前重验当前授权和投影。导出在主机许可回调后重验；新文件先以私有临时文件写入和 fsync，再在原子发布前重验授权与到期时间。最终时间检查与 link 之间没有异步等待。审批签名 sidecar 保留确切用途、来源许可和 expiry，与数据 hash 关联。此前已合法发布的本地文件不会因 expiry 自动删除；后续消费者必须核验许可期限、用途和当前授权，不能把持有文件当永久训练授权。没有自动上传、训练或发布流程。

默认导出禁止自由文本、实际目标/任务 ID、来源 URL/正文/原 contentHash、完整 assessment、provider 内容、ACL/authorization/accessToken、密钥或原状态路径。保留结构化 counts/status 和作用域化引用。引用仍可关联相同轨迹，不构成匿名化证明。公开 `examples/` 是经检查的合成输入实例；原始轨迹和许可证据始终留在 Git 忽略目录。

这些候选可供行动序列和结果模式分析，尚不具备聊天 SFT 所需目标、回答和模型文本。真实 Teacher 数据用途、再许可、隐私、外部计费及研究正确性都需要下一阶段独立验证和授权。
