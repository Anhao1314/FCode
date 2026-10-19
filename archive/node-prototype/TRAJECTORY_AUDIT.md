# T0 质量和完整性审查

两名真实 Codex 原生子代理并行启动，均在前五分钟提供初步风险；Root 同时实现不依赖审查结果的最小闭环。只有 Root 修改代码。子代理首轮聚焦相关合同，主实现完成后各进行一次实际改动复审，并在同次复审内检查修复；没有重复运行测试或重读整个仓库。

`trajectory-architect`（GPT-6 High）确认当前标签和 provenance 没有阻断性缺陷，建议来源逐项许可，指出 review hash 不证明真实权利，稳定引用可跨文件关联，结构化 rows 不能用于聊天 SFT。Root 增加精确逐来源 clearance；其余限制保留为 NOT_PROVEN。

`integrity-auditor`（GPT-6 Extra High）发现捕获在异步写 blob 后可能用已撤销的授权提交 manifest；又发现导出批准在文件写入期间到期时仍可能留下正向文件。Root 增加捕获提交前重新投影，以及先暂存、再重验并原子发布的导出路径。独立审查按代码检查确认修复，未发现剩余把 unknown 或模型自评转成正向标签的具体路径。它未修改代码或执行测试。

## 失败保留与修复

1. `validation/trajectory.initial.log`：8 项中 6 通过、2 失败。原底层锁把 Evidence package 错误包装为通用写错误；Root 在新 Recorder 内规范化安全错误码。新篡改测试定位错了双层 blob envelope；修正为真正修改 raw verification，未降低 HMAC 拒绝断言。对应原场景保留在 `trajectory-cases.initial-failure.json`。
2. `validation/trajectory.recovery.log`：16 项中 12 通过、4 失败。新 SIGKILL 用例遗漏了原 M3 必须显式 recoverLock 的步骤，因此首先得到 TASK_BUSY。补回原恢复流程，并增加先拒绝再恢复的断言；没有自动解锁或改变 Runtime。原场景保留在 `trajectory-cases.recovery-failure.json`。
3. `validation/trajectory.lock-recovery.log`：16/16 通过，是复审修复前的中间结果，不作为最终权限证明。
4. `validation/trajectory.review-fixes.log`：23/23 通过，包括复审要求的捕获撤权、许可 staging 期间到期后无正向文件、逐来源授权和受控导出篡改。

所有中断现场、历史 unknown、orphan blobs、签名记录和失败状态留在受保护本地目录，不移除失败证据，不更改 M3-A 原 256 项目标和断言。

## 关键限制

历史先于 witness 的 SIGKILL 窗口显式 BLOCKED，不通过删历史恢复 PASS。Recorder 不替代模型收据对账、预算门控或 Evidence Authority。原始非法模型响应内容若只保存 hash，不能恢复成训练文本。

文件系统断电、整机与 witness 同时回滚、任意同进程可信主机的恶意代码、分布式撤权原子性和跨根目录预算未证明。逐来源 rights clearance 是主机证明责任，不能靠伪造 64-hex 摘要获得真实权利；已发布本地文件后续使用仍须遵守 expiry 和用途。

本轮没有真实 Teacher 决策或研究增益。真实工具和金融计算来自未修改的 M3-A 金融模块；模型选择仍由注入 HTTP 或原离线 Mock 提供。最终 24 项 T0 测试与最终完整/独立检出日志是 Root 执行证据，审查意见是独立代码检查证据，两者不混用。
