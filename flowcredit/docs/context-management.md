# 上下文管理：合约化的压缩、状态与预算窗口

本文记录 2026-10-25 落地的三步通用化（设计讨论见 git 历史；三层记忆的立场
不变：派生而非存储、压缩而非原文、召回入链、记忆不可被模型改写、一切可重放）。

## 1. 观测压缩进 ToolSpec（`summarize` 合约）

压缩的责任从 memory 层下放到最懂结果的那一层：

- `ToolSpec.summarize(result) -> dict`：工具作者声明哪些字段是决策需要的；
- 注册表暴露 `registry.summarizers()`，`WorkingMemory` 只认合约、不认工具名；
- 未声明的工具走 `default_summarize`：标量保留（长串 head+真实长度）、
  列表变 count+首项、嵌套对象变键名表——形状驱动，永不放大。

general 工具的关键裁剪：`read_file` 不携带文件正文（head 600 字 + bytes +
sha256）；`run_command` 留 exit/duration/output 头；`fetch_url` 留
status/title/**content_truth**。finance 的七个 summarizer **逐字节搬迁**到
`tools/finance/summaries.py`——PROMPT_VERSION=v10 与 SFT 的黄金哈希不变
（`test_finance_prompt_v10_is_byte_identical` 仍然通过）。

`memory/context.py` 不再出现任何工具名。`domain-layer.md` 记录的两条
"剩余耦合"之一就此消除。

## 2. 状态派生进 DomainModule（`summarize_state` 合约）

`WorkingMemory.state()` 改为调用域视图；没有域的调用方得到中性回退
（rounds_recorded + tools_used），不撒谎也不沉默。

- finance：原 state 原样搬至 `tools/finance/summaries.py:summarize_state`，
  键集是 v10 prompt 合约的一部分；
- general（通用 agent 的状态卡）：**文件即事实**——

```
files:    written[{path, bytes, sha256}] · edited[] · read[]
commands: [{command, exit_code}]   # 非 0 退出进 blockers
fetches:  [{url, status}]
blockers: []
```

每个值都来自签名观测；卡片是投影，不是模型笔记。装配层
（demo/runner、console_manager、各 lab）在 `Harness(state_fn=...)` 一次性
传入，所有 Loop 站点自动获得。

## 3. 分层窗口 + Compaction-as-Event（预算感知 build）

**prompt 级遗忘，store 级永存**：观测记录永远全量保留（重放/重算/审计），
只有 prompt 有界（`observation_budget`，默认 24,000 字符）：

- 最近 N 轮压缩观测保持 inline；
- 更早的轮次折叠成 `observation_index` 一行一条：
  `round · tool · arguments 头 · result_hash 前 12 位`——确定性 digest，
  零幻觉、零成本；
- 新发生的折叠由 Loop 落成 **`context_compacted` 入链事件**
  （from/through/inlined-from/folded-count）。这是与"悄悄截断"型框架的
  分界线：审计问题"第 3 轮看见了什么"永远可以从 store 回答。

折叠单调：窗口不加深就不发第二个事件（`folded_through` 去重）。

## 测试

`tests/test_context_management.py`（16 项）：

- 合约：finance/general 全部 spec 携带 summarizer；read_file 摘要不含文件
  正文；run_command 留判定不留日志；fetch_url 带 content_truth；默认压缩器
  有界且形状正确；finance 摘要键集 = v10 合约；
- 状态：general 卡片投影 files/commands/fetches/blockers；失败命令进
  blockers；无域回退中性；finance 键集仍被钉住；
- 窗口：预算内全 inline；超预算最旧折叠、无重叠、inline 实际低于预算、
  折叠只产生一个 pending 标记；store 全量保留；
- 入链：折叠标记经 `harness.record("context_compacted")` 进链后
  `verify_chain` 通过。

## 仍然欠的（下一步）

- `recall_observation` 门控工具：把窗口外的观测显式拉回上下文（检索=治理
  动作，入链）；
- 产物簿：通用事实层 = path/hash/produced_by_run，接项目工作区做跨任务
  记忆；
- 模型摘要 digest：仅当轮数大到索引表也放不下时，标注
  `model-generated, advisory`；
- 评估：LongMemEval（ClaimLedger 线）量记忆质量，任务成功率 gate 任何
  prompt 合约变更（v10 除外，它被黄金哈希冻结）。
