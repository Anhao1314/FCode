# FlowCredit-Harness · T2-B 研究验收

唯一实现基线 T2-A `1f14d1a8bcaef2d5ea94b9c38ce6f202048197fa`；独立分支 `research/t2-b-independent-evaluation`，Mac 离线、无新依赖。

**研究决策：NO_GO。** 本轮实现更完整的评价合同与可恢复多步实验，但没有证据表明需要学习型决策。人工确定性候选解决当前全部任务；Gold 的停止证据覆盖仍有局限，严格盲测不可证明。T1 `TRAINING_READY=BLOCKED` 保留。

## 可复现交付

Node 24 / POSIX，干净检出后无需旧 Mac 路径、Finch、密钥或下载：

```sh
node scripts/verify-t2b.mjs
node scripts/verify-t2b.mjs all
```

第一个入口执行本轮安全验证和冻结对照；第二个先运行原 R0 291 + T1 14 + T2-A 14，再运行 T2-B 20 项及同一合成对照。策略分数没有 PASS 阈值，工程验证和科研有效性分开。

- [预注册](../research/t2-b/PREREGISTRATION.md)、[多步合同](../research/t2-b/CONTRACT.md)、[Gold v2](../research/t2-b/gold-v2.json)、[独立 verifier](../research/t2-b/verifier.mjs)。
- [最小执行层](../research/t2-b/loop.mjs)、[原策略和确定性候选](../research/t2-b/policies.mjs)、[公平实验](../research/t2-b/experiment.mjs)。
- [开发/验证语料](../research/t2-b/development.json)、[未见作者规格](../research/t2-b/held-out-spec.json)、[机械展开语料](../research/t2-b/held-out.json)。
- [策略冻结](../research/t2-b/policy-freeze.json)、[评测冻结](../research/t2-b/evaluation-freeze.json)、[实际结果](T2_B_RESULTS.json)、[审查与争议](T2_B_REVIEW.md)。

## 冻结与独立性

`cf32509` 封存 Gold、策略、开发/验证合同，policy-freeze 时间 06:43:13 UTC，heldOutExists=false。之后 Curator 以 fork_turns=none，只读取允许的 fixture、开发语料、合同和冻结记录，不读策略、verifier 或结果，独立编制四个未见任务。Root 机械展开，另用有理数算术核对作者给出的正例答案；`63312ff` 在首次正式评分前封存全部评测材料。

开发 2 项/1 家族、验证 2 项/1 家族、held-out 4 项/2 家族，共 8 项/4 个配对机制，不是 8 个独立金融问题。held-out 范围为合并收入与毛利范围修复、调整后/IFRS 毛利口径桥接。每对初始输入完全相同，最后一次发布的正文只变一个范围或口径条件；不能仅凭初始状态决定最终结论。

跨角色实体、来源家族、年度、声明机制/模板、反事实组、精确正文和初始关系指纹无碰撞。ID、split、来源 hash、Gold 和未来正文不进入策略回调；只有已返回收据的正文及其 nextCatalog 可以推进观察。所有策略收到相同的 canonical JSON 和相同初始授权/预算，独立根目录避免对照执行顺序耗尽别人的额度。

**BLIND_EVALUATION_NOT_PROVEN。** 声明的机制家族隔离不等于不同输入模板；各组共享 JSON schema、row helper、目标、工具、基本比较技能和串行发布结构。Root 设计合同/候选，子代理共享文件系统和模型家族，没有 OS 隔离或第三方保管。策划者对基本问题知情，不能称双盲、外部人类共识或广泛泛化。开发/验证案例被安全回归重复使用，没有用于策略调参；不是独立验证集。干净克隆重跑同一 held-out 是可复现性验证，不是第二个新盲测。当前公开候选语料不能作为未来永久秘密测试集。

## 实际对照与成本

所有策略均为本地程序；前三组直接引用未修改的原函数，候选也是人工规则。每 episode 四次提议/行动、三单位读取、合成费用零；真实 Token、费用或研究效用不由这些数值证明。同一证据下 inspection 一次可用、所有观察统一 key 顺序，是共同适配合同，没有修改原策略。读取和 inspection 均实际占用原 ModelBudgets。

| 策略 | 冻结任务级评分 | 数值完成 | 冻结正确停止 | 行动/读取 | held-out |
| --- | ---: | ---: | ---: | ---: | ---: |
| Fixed | 0/8 | 0 | 0 | 8/0 | 0/4 |
| T1 presence | 0/8 | 0 | 0 | 8/0 | 0/4 |
| 原 T2-A heuristic | 6/8 | 3 | 3 | 29/20 | 2/4 |
| 确定性候选 | 8/8 | 5 | 3 | 22/13 | 4/4 |

Fixed/T1 各提出 8 次过早计算，全部由实际门控拒绝，无金融结果。所有任务都有数值事实，T1 空事实分支仍未覆盖。确定性候选四对均改变受控行动路径；原规则仅开发/验证两对改变路径，未见两对都因读取预算耗尽停止。

候选在确认重述后计算 `50%,35%,-15pp`，未确认则保留冲突停止；held-out 取得第二份正文后分别计算 `45%,35%,-10pp` / `40%,42%,+2pp`，范围或口径仍不匹配则停止。中间结果真实改变下一观察，既非固定脚本分拆，也未读取未来正文。所有事实仅为合成作者答案，真实世界金融事实始终 NOT_PROVEN。

冻结 Preference 比较限定相同 task、初始 host/预算、成功终态类别及答案，以 reads/actions 词典序比较；u0 Tie，u1/r0/r1 候选较省，h0/h2 因原规则未完成而 INCONCLUSIVE。h1/h3 的冻结优选结果须与下述证据覆盖争议一起阅读。实验文件的 NO_GO 是保守默认元数据；最终科研判断来自这些实际结果与审查，程序没有授予采样权限。

## Q1：Gold v2 是否改善质量？

有可证伪的局部改善：原 c0 notes 可以提供一致单位，read.supplement 合理，normalize.units 可更省读取；旧 Gold、旧 12/12 和全部旧结果未重评分或改写。本轮将合法、相关、可接受、优选、成本、完成及合成事实分别记录。修复有负例支持：不相关期间资料不获信用，metadata-only 诊断不被当成事实补全，未确认重述不能消除冲突，自行耗尽可解任务预算后的局部安全停止不能自动算成功。所有结果不依赖模型自评或隐藏推理。

**完整性仍 INCONCLUSIVE。** 正式评分后的只读覆盖审计发现，原启发式 h1/h3 只保留 1/2 发布阶段就耗尽预算停止，冻结评分因 authored terminalGold=insufficient 给它成功。策略未看见最后一份正文，不能据此证明识别了任务内在不可解原因。这两个分数与 h1/h3 Preference 原样保留，不改标签、不改策略重跑“第一次盲测”。在当前结果中，它们是停止证据覆盖争议；不作为可信正样本/Preference pair。下一版本需独立定义 stop warrant/来源覆盖，不能用看完结果的补丁制造更高通过率。

争议为 32 个策略-任务终态中的 2 个，均属于原规则；不是“Gold 总体错误率 6.25%”。另外，完整资料的额外 assurance 检查是否合理取决于研究范围，当前标 legal-but-redundant，非金融事实错误。无外部专家共识，不宣称接受集合完整。

## Q2：未见评测有多独立？

策略版本先封存、Curator 后作者化、有限输入投影、来源/实体/期间/关系检查和反事实分组已验证。算法只逻辑隔离策略 API，恶意可信 JS 仍能读取同机文件；不存在真正双盲保证。只能称作者职责部分分离的冻结组合评测。

## Q3：多步增加了什么？

先补充正文、再发现版本冲突/仍缺口、再核验或补充、最终计算/停止，2–4 动作。held-out 对内最后一步正文差异使同一策略从计算转向停止；每轮有独立 child identity、intent、预算与签名 proposal/action receipt。新 EpisodeStore 复算 receipt→观察链，完成 prefix 在新步骤和终态返回前重新验证原 signed receipts、预算和当前授权。正式 M4 expectedAction 及原 Harness 没放宽，新工具仍是旧 T2-A 的实验工具。

## Q4：确定性规则还够吗？

当前够用：确定性候选 8/8，并完整取得其停止所依赖的来源。原单步启发式多步重用有读取效率局限，不能把候选优于旧规则误写为模型优于规则。三读取/四动作预算在 Curator 出题前冻结；预算敏感性未扩展实验，当前代码复杂度不等于智能。

## Q5：未来 Teacher 应展示什么？

当前没有已证实规则无法可靠解决的能力。值得提出而尚未证明的候选问题：从获准自然语言披露识别财务口径与单位的作用范围；解释调整后/IFRS 的具体 reconciliation；在多来源证据冲突下选择有收益的补证及形成可审查的停止理由。现环境把这些语义直接编码为已知字段，不能评价 Teacher 的语义理解。须先由独立作者/财务审查者标注实际可见证据、可接受路径与 stop warrant，再与强规则进行费用/预算公平对照；若规则依旧可靠，则不训练。

## Q6：是否进入 DeepSeek Flash Teacher Pilot？

**NO_GO。** 当前规则已解决全部冻结任务，Gold 的停止支持仍有争议，盲测/外部泛化无证据；没有学习价值与付费收益证明。真实 Pilot 至少先闭合这些研究门槛、资料许可/隐私/保管、真实 Recorder/live 来源合同，再单独审阅模型/价格/Token 上界、凭证托管、费用硬预算、unknown 收据对账与停止授权。本轮既不申请即时调用，也不自动进入 T3、Student 训练或 GitHub 发布。

## 工程验证与失败保留

候选：R0 run-tKZEes **291/291**（368.1秒）、T1 run-m8mn1Q **14/14**（74.2秒）、T2-A run-9fh9pD **14/14**（79.3秒）、T2-B run-dxbNIU **20/20**（33.5秒），共 **339/339**。独立无硬链接clone：R0 run-3NCVCx **291/291**（369.6秒）、T1 run-MxCCVq **14/14**（74.0秒）、T2-A run-qoYAXs **14/14**（80.4秒）、T2-B run-DKZC5X **20/20**（39.5秒），共 **339/339**。无失败、跳过、取消或todo。两环境对照JSON逐字语义一致；独立clone为63312ff，新Git目录、无旧work/validation，测试后Git干净。

首轮完成 prefix 篡改检测真实 0/1；signed state/supersession/array legality 0/3；第一修复 11/16，暴露 JSON 期间 key 顺序与新测试未显式恢复 dead locks；随后 17/17。Gold 审查反例 0/3（错误相关性、自耗预算评分、读取未确认 note 越过版本证明），修复后 20/20。保留全部失败 TAP/源码快照/原状态；未降低断言，原 319 项始终不变。之后没有修改冻结策略/Gold/评分或源码。

额外真实故障：目录已发布但正文不可用，结果 UNKNOWN/T2_SOURCE_UNAVAILABLE，读取 reservation=unknown、lease=held，重新运行未发起新调用；收入分母为零的计算 DENIED，工具未执行。正式 Source/预算故障不是策略研究“成功”。SIGKILL 明确先拒绝 TASK_BUSY，再经原 recoverLock 验证死进程恢复；无收据则继续 unknown。有可信匹配收据也只能显式 reconcile；错误引用拒绝，不自动猜测。

原T2-A HEAD、干净Git状态与159个原文件指纹未变；候选与clone的92个继承JS/MJS逐字相同。新源代码100个模块，全部相对依赖，无npm或外部库。两冻结文件的所有SHA均匹配。原ModelAPI/DeepSeek/T0/T1、Authority、预算/收据与M4合同由不改门槛的继承回归验证。公开候选只含合成资料、代码、合同及脱敏摘要；发布清单/index/可达历史再由原门禁检查。原始记录、签名key、失败状态和源码只保存在Git忽略的0700根/0600文件，70份定向状态另保留受保护副本，未删除原状态。复本签名绑定原路径，只作证据，不冒充迁移后可运行状态。证据导航为本地 validation/t2b/T2_B_EVIDENCE_INDEX.json；没有实际发布或Linux远端CI执行。

## 状态与效率

| 状态 | 本轮结论 |
| --- | --- |
| IMPLEMENTED | Gold v2 七维评分/受限 Preference、冻结划分、独立多步执行层、观察发布、签名历史与恢复 |
| TESTED_OFFLINE | 8 个授权合成任务、32 个程序策略-任务执行、4 对反事实、20 项故障/安全验证、继承回归与干净克隆 |
| BLOCKED | T1 训练就绪、真实 Teacher Pilot、Student 训练；没有自动训练导出 |
| INCONCLUSIVE | stop 证据覆盖、Gold 完整性/共识、真实策略最优性、预算敏感性、研究价值外推 |
| NOT_PROVEN | BLIND_EVALUATION_NOT_PROVEN、外部真实金融事实/学习收益、真实 Token/计费、断电/整机回滚/多机一致性、远端 Linux CI |

Finch 并发 286/287、串行 287/287 的旧结论保留，未修复或复跑冻结 Finch。Windows ACL/MCP/WSL/GPU、Xiaojing/G1 未调用或修改。没有模型下载、真实 API、凭证读取、训练、依赖安装、推送、合并、部署或许可证改变。

从06:22:50 UTC开始到07:03:01最终核验，约 **40分11秒**；随后只封存报告/发布检查。研发、设计与定向验证到06:48:19约 **25分29秒**；正式实验与核验阶段 **14分42秒**（含并行测试、结果分析与记录整理）。完整测试子进程累计 **1118.7秒**，定向/失败测试累计 **100.4秒**，合计约 **20分19秒**；并行时间不与总历时相加，实验额外时长由原始阶段记录保留。子代理阻塞等待0秒，三批工程/评价修复，原因是prefix/语义完整性、canonical期间表示及显式lock恢复、Gold相关性/自耗预算/未确认版本处理。正式held-out评分后没有策略/Gold返工。主要耗时是两环境的签名持久故障回归与可达历史审计；并行跑时R0较历史单次记录变慢，但未额外诊断硬件瓶颈。

本轮在明确 NO_GO 及工程复现闭环后停止。

