# FlowCredit-Harness

把每次模型调用当金融交易记账的受控 AI 研究执行框架，执行历史写成不可回滚的哈希链。

## 结论：`NO_GO`

三轮研究（T1、T2-A、T2-B）指向同一判断：确定性规则已经解掉全部冻结任务，因此不该训练模型。T2-B 里确定性候选拿到 8/8，四个冻结任务对全部解完，这一路没有学习型决策参与。

结论不是「模型不行」，而是「这批任务不需要模型」。规则已经解完，再训练模型只是把已知答案重学一遍。决策常量是 **`NO_GO`**。

T2-A 的四组指向同一判断：固定策略与 T1 语义映射各 2/12，启发式与研究候选各 12/12。规则打满，弱策略打空。

T1 的 `TRAINING_READY=BLOCKED` 保持有效，真实 Teacher 采样没有启动。

现在能信到哪一层要分清。数字来自离线合成语料与本地脚本，真实模型默认关闭，试点未授权。

## 是 Harness，不是 Agent

正式 Runtime 只暴露 2 个只读工具：`evidence.read` 与 `evidence.assess`。参数必须是空对象，写操作不在模型权限内。

**执行权在主机**。主机给权限、路由、预算与传输授权，模型只能提出动作。Runtime 独立校验工具名、schema 与 Evidence，通过后才执行。任务完成由独立校验器判定，模型不能自报完成。

执行与记录是两条链。Recorder 写失败不能改变已完成的任务，已签收的执行标签也不会被回写。

循环路径目前读不到具体数值。M4 的 `contextFor()` 仍把观测压成事实计数，所以循环只能数事实、不能读事实。M5 只打开了静态路径与轨迹的投影，循环是下一个增量。

模型侧同样收窄：thinking 显式关闭，禁止自评，模型尝试次数上限为 1。包入口三个：`.`、`./trajectory`、`./observable`。没有多智能体编排，没有记忆系统，也没有训练流水线。

## 为什么这样设计

模型调用最容易失控的环节是「不知道发没发出去」。一次超时可能已经计费，也可能根本没到供应商。两种情况该做的事相反，代码却无法从错误里分辨。

所以这里把调用当交易记账，三个机制各管一段。

| 机制 | 做法 | 失败时 |
| --- | --- | --- |
| 预留 | 发送前占预算与并发租约 | 拒绝发送 |
| 收据 | 只认本地签名且匹配的收据 | 保持 unknown |
| 锚定 | HMAC 链加独立 witness | 拒绝读取 |

**未知不退**是整套设计的核心。unknown 不自动重发、不自动退费、不自动换供应商。唯一出口是凭匹配的签名收据显式 `reconcile`。

witness（主机侧独立锚点）是唯一事实来源。witness 之后的孤儿条目从未被认证，所以既不信任也不删除。修复只允许 `M1_HISTORY_AHEAD` 一种情况，孤儿条目逐字节移进 `quarantine/` 并记录哈希。修复动作本身也签成记录。读取路径永远不修，只有显式 `recoverLatest()` 能移动字节。

## 已经做到哪一步

验收按轮次累积：R0 291 项，T1 14 项，T2-A 14 项，T2-B 20 项，M5 10 项。

T2-B 的四策略冻结对照如下，评分对象是任务级终态，不是模型能力。

| 策略 | 冻结任务级评分 |
| --- | ---: |
| Fixed | 0/8 |
| T1 presence | 0/8 |
| 原 T2-A 启发式 | 6/8 |
| 确定性候选 | 8/8 |

严格盲测仍不可证明，常量是 `BLIND_EVALUATION_NOT_PROVEN`。机制家族隔离不等于输入模板隔离。

- M5 是纯增量。新增 `packages/native-agent/src/recovery-store.mjs` 与可观测工具，关掉 history-before-witness 的永久阻塞。每次 `load` 的全量重放降为常数，`evidence.read` 开始返回紧凑 fact 投影。继承模块逐字节未改。
- T0 基线 98 个文件里有 76 个 `.js/.mjs` 模块，全部原样保留。
- Finch 有一个已知并发回归：并发跑 286/287，同标准串行复核 287/287。该问题未修复，高负载稳定性未证明。
- 真实数据试点 P0 协议已写好但未授权执行。硬预算 1,000,000 µUSD，调用上限 200 次，单次输出上限 512 token，并发 1。语料是 50 家 × 2 年度 = 100 个任务单元，当前零网络请求、零凭证、零花费。

## 不证明什么

- 不证明真实模型研究增益，也不证明模型优于确定性规则。
- 不证明金融事实 Gold，合成作者答案不是真实世界的金融结论。
- 不证明数据法律使用权，公有领域只解决版权，不构成训练授权。
- 不证明匿名化，原文不进 Git 也不等于主体身份已经脱敏处理。
- 不证明真实计费准确，`actualCostMicrousd` 恒为 null，供应商账单从未被外部核验。
- 不证明断电一致性，SIGKILL 只覆盖进程中断，不等于文件系统任意崩溃后的状态。
- 签名验证的本地成功不等于金融事实 Gold，也不等于模型研究能力。
- 真实世界金融事实始终是 `NOT_PROVEN`，这是全部结论的上游常量。

另有四条操作边界。根代码未授开源许可，`vendor/` 保留 MIT。`work/`、`validation/` 被 Git 忽略，禁止公开。Teacher 采样、Student 训练与发布推送需要另行授权。真实数据试点 P0 未授权执行，当前零网络请求、零凭证、零花费。

## 快速开始

需要 Node.js 24、Git、macOS 或 Linux。零外部依赖，无需 npm，无需模型密钥。

### 主入口

```sh
node scripts/verify-t2.mjs all
```

三段验收（R0 + T1 + T2-A）。主入口依次跑 R0 291 项、T1 14 项与 T2-A 14 项，其中 291 项由 280 项原 M3-A/T0 测试加 11 项仓库安全测试组成。T2-B 与 M5 各有自己的 `all` 入口。失败保留现场，不覆盖上一轮日志。

### 分项门槛

| 命令 | 覆盖范围 | 项数 |
| --- | --- | ---: |
| `node scripts/verify.mjs repository` | 发布清单与提交审计；非外部信任锚 | 11 |
| `node scripts/verify.mjs` | 全量回归 | 291 |
| `node scripts/verify-t1.mjs` | T1 数据构建实验 | 14 |
| `node scripts/verify-t2.mjs` | 仅 T2-A 专项 | 14 |
| `node scripts/verify-t2b.mjs` | T2-B 多步盲测 | 20 |
| `node scripts/verify-m5.mjs` | M5 增量与继承模块恒等 | 10 |

子集不代表完整验收。`deepseek`、`trajectory` 等子集见 [开发与 CI](docs/development.md)。当前没有单条命令覆盖全部 349 项，最长链是 `node scripts/verify-t2b.mjs all` 的 339 项，M5 的 10 项另跑。每次执行都在新生成的受保护副本里跑。

## 目录与文档索引

### 研究结论

- [T2-A 验收与研究决策](reports/T2_A_ACCEPTANCE.md)
- [T2-A 实验合同](research/t2-a/CONTRACT.md)
- [T2-A 冻结预注册](research/t2-a/PREREGISTRATION.md)
- [T2-A 独立审查](reports/T2_A_REVIEW.md)
- [T1 研究结论](research/t1/STUDY.md)
- [T1 数据合同](research/t1/CONTRACT.md)
- [T1 验收](reports/T1_ACCEPTANCE.md)
- [T2-B 验收](reports/T2_B_ACCEPTANCE.md)
- [R0 验收与真实测试证据](reports/R0_ACCEPTANCE.md)
- [R0 独立审查](reports/R0_REVIEW.md)
- [T0 验收报告](reports/ACCEPTANCE.md)
- [历史失败目录](history/failure-catalog.json)

### 合同与文档

- [模型与恢复合同](PROTOCOL.md)
- [轨迹与质量合同](TRAJECTORY_CONTRACT.md)
- [仓库架构](docs/architecture.md)
- [开发与 CI](docs/development.md)
- [研究基础与下一阶段问题](docs/research-foundation.md)
- [真实数据试点协议 P0](docs/real-data-pilot-protocol.md)
- [M5 兼容性决策](docs/COMPATIBILITY_M5.md)

### 安全与许可

- [发布与隐私边界](SECURITY.md)
- [许可证范围](LICENSE.md)
- [试点独立授权清单](REAL_DATA_PILOT_AUTHORIZATION.md)
