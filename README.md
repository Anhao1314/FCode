<div align="center">
  <img src="flowcredit/viewer/brand/logo.svg" alt="FCode" width="72" />

  # FCode

  ## Audit the agents.

  **挖掘 agent 应用的缺陷与安全问题。**

  一个审计 agent 应用的 agent：每条发现附带可重放的证据，审计过程自身进哈希链。

  内核是一个本地优先、可恢复、可审计的 Agent Runtime。

  `MODEL PROPOSES · HOST VERIFIES · YOU DECIDE`

  <img src="flowcredit/viewer/docs/desktop-home.png" alt="FCode Work 控制台" width="100%" />
</div>

---

FCode 交付一个**审计 agent 应用的 agent**：对其他 agent 应用执行测绘、静态审计、动态探针与治理测试，输出带 PoC 的缺陷发现。支撑它的是一条围绕**责任链**构建的 Agent Runtime——模型负责理解与提议，Runtime 负责计划、权限、预算、工具、验证与恢复，人保留关键决定的控制权。

它不是给聊天窗口加上工具，而是让每一次行动都有依据、每一个结果都能检查、每一次失败都有明确的下一步——**包括审计行动本身**。

## 审计者自己必须先可信

一个 agent 说"这里有漏洞"，不等于漏洞存在；一个审计 agent 自己被注入，等于整个产品失效。

FCode 把"发现"拆成可验证的过程：

```text
Rule (AGI taxonomy) → Candidate finding → PoC → Independent replay
                                                        │
                                                        ↓
Audit event chain ← Receipt ← Gated execution (budget / approval)
      │
      └──── "Who audits the auditor" = verify_chain, replayable ────┘
```

- **目标内容是不可信输入**：被审计应用的 README、prompt、工具输出一律是数据，不是指令。
- **发现 = PoC 重放成功**：模型声称只是候选；重放由独立进程执行，走同一套门控与预算。
- **审计过程可回放**：每一步测绘、探针、审批、重放都是哈希链上的事件。

分类法、方法论与规则契约见文档地图：[threat-model](flowcredit/docs/threat-model.md) · [audit-methodology](flowcredit/docs/audit-methodology.md) · [rule-authoring](flowcredit/docs/rule-authoring.md)。

## 四个核心层

| 核心 | 已实现 | 边界 |
| --- | --- | --- |
| **大脑** | Provider 抽象；mock、本地与 OpenAI 兼容模型；模型只输出动作提议 | 模型回答不等于结果已验证 |
| **规划** | 目标分解、todo、轮次循环、计划修订、失败停止 | 当前以单 Agent 执行为主 |
| **记忆** | SQLite 事件日志、上下文重建、运行历史、案例与事实投影、断点续跑 | 不是无限记忆或完整知识系统 |
| **工具** | 封闭注册表、权限门控、预算、签名收据、文件／命令／网页工具、MCP 桥 | 受限命令不是操作系统级沙箱 |

审计域（`flowaudit`）构建在这条内核之上，依赖方向单向：`flowaudit → flowagent`，由测试强制。

## 开始工作

需要 **Python 3.11+**。离线演示零第三方依赖、零配置。

```bash
git clone https://github.com/Anhao1314/FCode-FlowCredit.git
cd FCode-FlowCredit/flowcredit
python demo.py
```

### 打开 Work 控制台

在 `flowcredit` 目录执行：

```bash
python viewer/server.py --repo . --port 8642
```

打开 `http://127.0.0.1:8642/`。

Work 用于规划与执行，Chat 用于流式对话；任务历史、审批、运行控制、证据与 Trace 回放共享同一个 Runtime。真实模型接入见 [Kimi 配置](flowcredit/docs/kimi.md)，密钥只保存在本机，不进入仓库。

## 八个场景，检验八种纪律（Runtime 自检）

```bash
python demo.py general-research --fast  # 通用委托：写、跑、修、复跑、归档
python demo.py full                     # 多轮研究：取证、口径桥接、独立复算
python demo.py tool-denied              # 越权工具：主机拒绝，工具不执行
python demo.py budget                   # 预算耗尽：发送前拦截
python demo.py budget-resume            # 追加预算：从失败点续跑
python demo.py crash                    # 真实 SIGKILL：恢复后不重复轮次
python demo.py unknown                  # 结果未知：不重发，凭收据对账
python demo.py open-ended               # 证据不足：诚实停止
python demo.py all                      # 顺序运行全部场景并自检轨迹
```

场景复用同一个 Runtime，通过不同主机策略与故障注入验证治理语义——它们同时是**审计 agent 的自检工具**：这套治理语义就是审计者用来给别人的应用打分的标尺，标尺必须每天证明自己没坏。

## 验证，而不是感觉

在 `flowcredit` 目录执行：

```bash
python -m unittest discover -s tests -q
node --test viewer/tests/*.test.js
python demo.py all
PYTHONPATH=src python -m flowagent.benchmark --output work/runtime-benchmark/latest
```

当前完整回归：**661 项 Python 测试、166 项前端测试、8 个端到端场景、19 个版本化 Runtime 任务**。

## 审计产品状态（诚实版）

- **已交付**：AGI 分类法 v1（9 类，每类锚定真实样本）、审计方法论、规则契约、`flowaudit` 包骨架、模块方向守卫、规则库与靶子库。
- **Ground truth 已就位**：`flowcredit/fixtures/fcode-self/` 记录 FCode 自身经 2026-10-30 全面评估确认的 7 个问题（含 file:line 证据）。**用自己当第一个靶子是刻意的。**
- **引擎验收线**：独立检出 ≥3 个已知问题、每条发现一条命令可重放——Sprint 2 关闭前必须达到。
- **尚未实现**：规则引擎、PoC 重放、目标适配器、审计控制台。这些是下一阶段的工作，本文档不会提前声称它们存在。

## 诚实的边界

- 当前是治理较强的**单 Agent Runtime**，不是产品级多 Agent 集群。
- 本地工具与命令有应用层约束，但不构成操作系统级安全沙箱；动态探测以授权为前提、备份为前置。
- Chat 附件以文本注入为主，不等于完整多模态理解管线。
- Chat 回答有事件链与收据，不代表每个回答都经过领域 verifier 验证。
- 恢复覆盖当前工作区、事件与收据对账，不能恢复任意外部副作用。
- 审计分类法覆盖**已知模式**；未知模式的发现依赖人工审计，报告会明示覆盖率边界。
- 审计发现面向修复，不面向武器化。

知道何时不能完成，和完成工作同样重要。

## 文档地图

| 方向 | 文档 |
| --- | --- |
| 项目入口与完整使用说明 | [Runtime README](flowcredit/README.md) |
| 系统架构 | [architecture](flowcredit/docs/architecture.md) |
| **Agent 应用威胁模型（AGI 分类法）** | [threat-model](flowcredit/docs/threat-model.md) |
| **审计方法论与证据纪律** | [audit-methodology](flowcredit/docs/audit-methodology.md) |
| **规则编写指南** | [rule-authoring](flowcredit/docs/rule-authoring.md) |
| 任务基准、指标与证据 | [runtime-benchmark](flowcredit/docs/runtime-benchmark.md) |
| 环境配置示例 | [environment](flowcredit/docs/environment.md) |
| 通用 Agent 能力 | [general-capabilities](flowcredit/docs/general-capabilities.md) |
| 上下文与记忆 | [context-management](flowcredit/docs/context-management.md) |
| 视觉与交互系统 | [design-system](flowcredit/docs/design-system.md) |
| 技术债与重构记录 | [refactor-evaluation](flowcredit/docs/refactor-evaluation.md) |

## 项目结构

```text
flowcredit/
  src/flowagent/   Agent Runtime 内核：Provider、工具、记忆、场景（域无关）
  src/flowaudit/   审计产品：分类法、PoC、目标适配器、报告（依赖内核，单向）
  audit-rules/     版本化审计规则库（数据，非代码）
  fixtures/        已知缺陷靶子（fcode-self = 自审计 ground truth）
  viewer/          Work / Chat 控制台、SSE 与 Trace 回放
  desktop/         桌面应用入口与构建脚本
  tests/           Python 单元、集成与端到端测试
  docs/            架构、设计、能力与评估文档
archive/           v1 Node 研究原型，不参与当前 CI
```

---

<div align="center">

**If it cannot be verified, it is not done.**
**An audit that cannot be replayed is not an audit.**

Apache License 2.0 · [LICENSE](LICENSE)

FCode 是一个独立开源项目，不是 Moonshot AI 官方产品。

</div>
