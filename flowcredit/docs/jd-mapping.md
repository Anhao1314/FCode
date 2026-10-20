# JD 映射

面向"Agent 开发工程师"岗位，把常见要求逐条对到**可指出的代码和可复现的命令**上。没有对应证据的，直接写"未覆盖"，不凑。

## 核心能力

| JD 常见要求 | 本项目的证据 | 怎么现场验证 |
| --- | --- | --- |
| 设计 Agent 执行循环 | `runtime/loop.py`：单轮提议 → 门控 → 执行 → 观测 → 判定，多轮驱动与终止策略分离 | `python demo.py full` 看 9 轮推进 |
| 工具调用与参数校验 | `tools/registry.py` + `tools/base.py::validate_arguments`：声明式 schema，未知键一律拒绝 | `python -m unittest tests.test_security.PermissionGateTest` |
| 权限与最小授权 | `runtime/permissions.py` 三道独立检查（注册表 / 任务范围 / 当前 grant） | `python demo.py tool-denied` |
| 上下文与记忆管理 | `memory/context.py`：派生而非累积；每条观测压缩成决策字段 | 读 `state()` 与 `_summarise()` |
| 失败处理与重试策略 | `runtime/harness.py::_unknown`：超时进 `recovery_required`，不重试，只能凭签名收据对账 | `python demo.py unknown` |
| 成本控制 | `runtime/budget.py` 四维硬预算，发送前扣减，不退 | `python demo.py budget` |
| 崩溃恢复 / 幂等 | `runtime/loop.py::restore` 从事件日志重建记忆；断言"没有任何一轮被重复提议" | `python demo.py crash` |
| 可观测性 | `trajectory/recorder.py` 观察者模式；trace 含完整事件链与预算快照 | `python demo.py full --open` |
| 评测与回归 | `tests/` 41 项；CI 跑 Python 3.11 与 3.13，Ubuntu 与 macOS | `python -m unittest discover -s tests -v` |

## 工程素养

| JD 常见要求 | 本项目的证据 | 怎么现场验证 |
| --- | --- | --- |
| 零依赖 / 可移植 | `pyproject.toml` 的 `dependencies = []`；CI 第一步就断言它为空 | CI 的 "Confirm there is nothing to install" |
| 数据持久化设计 | `core/store.py`：WAL、`BEGIN IMMEDIATE`、序列号 CAS、追加式事件 | 读 `_write` 与 `verify_chain` |
| 数据完整性 | `core/hashing.py`：canonical JSON（键排序、拒 float）+ sha256 链 | 改一个字节，`load` 抛 `CHAIN_TAMPERED` |
| 密码学基础用法 | `core/receipts.py`：HMAC-SHA256 签收据，`hmac.compare_digest` 比签名 | `test_a_receipt_cannot_be_forged` |
| 状态机建模 | `core/contracts.py` 显式迁移表，存储层强制 | `test_illegal_transition_is_rejected` |
| 类型注解与文档 | 全量类型注解；每个模块有 docstring 说明**为什么**这样设计 | 随便打开一个文件 |
| 测试设计 | 单元（门控/预算/存储/收据/验证/控制）+ 端到端（七个场景）+ 真实 SIGKILL | `test_scenarios.py`、`test_control.py` |
| 前后端基础 | `viewer/index.html`：单文件、无构建、`crypto.subtle` 重算哈希 | `python demo.py full --open` |
| 文档能力 | `docs/`：架构、12 条设计决策、框架对照、本文件 | — |

## 领域相关（金融）

| JD 常见要求 | 本项目的证据 | 边界 |
| --- | --- | --- |
| 金融数据口径与可比性 | `tools/finance/fixtures.py` 三个真实障碍：单位、口径、重述 | 合成数据，不是真实财报 |
| 确定性计算与模型分离 | `calculate_margin` 由代码算，模型只能请求；`verify()` 重算比对 | 只覆盖毛利率一个指标 |
| 证据溯源 | 结论带 `citations`（doc_id / period / value） | 未做逐句引用 |
| 合规与审计意识 | `Evidence Authority` 三个权限恒假；`external_billing` 恒 `not-verified` | 未做监管报送格式 |

## 明确未覆盖

诚实列出来，比含糊带过好：

- **RAG / 向量检索**：没有。当前工具是精确读取，不是检索。
- **多智能体编排**：没有。这是单任务单循环，`docs/design-decisions.md` 第 10 条解释了为什么。
- **真实供应商联调**：只有骨架，默认关闭。没有真实调用记录，也没有真实账单。
- **分布式**：单机 SQLite，没有多副本、没有分布式锁。
- **前端工程化**：viewer 是单文件，没有构建链、没有框架。
- **训练 / 蒸馏**：v1 的结论是 `NO_GO`，v2 不碰。

## 一句话总结

如果只能演示三分钟：`python demo.py all` 跑完七个场景，然后打开 `viewer/index.html` 拖进 trace，改一个字节让它变红。

这三步分别证明：**能跑、能失败得正确、能证明自己没撒谎。**
