# flowagent

一个**主机可控、可恢复、可审计**的 Agent Runtime。模型只能提议动作，Runtime 独立校验后才执行；每一步落进哈希链，崩溃可恢复，未知结果不重发。金融研究是第一个示例域，内核领域无关。

```sh
python demo.py
```

需要 Python 3.11+，零第三方依赖，零配置，离线运行。

## 这一版能做什么

`python demo.py` 会跑完一个 9 轮的完整研究：判断一家公司两期毛利率是否可比。资料里埋了三个真实障碍——单位不同（万元 / 百万元）、口径不同（adjusted 需桥接到 IFRS）、以及一份重述说明替换了旧数。模型逐轮提议，主机逐轮门控，最后 Runtime 用确定性算术重算并比对，通过才判成功。

预期输出（节选）：

```
第 6 轮   预算 calls 5/12  reads 5/20  cost 2500/20000 µUSD
  模型提议  reconcile_basis  doc_id=doc_fy2025_adjusted
  主机门控  PASS  schema, scope and grant all agree
  工具返回  FY2025  adjusted → IFRS  差异 -28 百万元
  预算扣减  calls 6/12  reads 6/20  cost 3000/20000 µUSD
...
 终态  SUCCEEDED（Runtime 独立重算通过）
  2024 毛利率  17.50%
  2025 毛利率  15.00%
  变化        -2.50 pp
```

每次运行会写出 `work/demo/full.trace.json`：完整事件哈希链，可直接阅读，也可被独立重算校验。

## 常用参数

```sh
python demo.py --fast              # 关掉轮次间停顿
python demo.py --list              # 列出场景
python demo.py --trace-out out.json
```

## 现在还没有的

Phase 1a 只实现了 `full`。`tool-denied`、`budget`、`crash`、`unknown` 四个可靠性场景、Trace 可视化 viewer、单元测试与 CI 属于 Phase 1b；`docs/` 下的架构与设计决策文档属于 Phase 1c。`--list` 会标出每个场景的状态。

## 三条约束

**模型不掌权。** 工具是封闭注册表，参数按 schema 校验，且必须同时出现在任务范围与主机 grant 里。模型不能传财务数值，不能声明完成。

**出错不乱来。** 调用在发送前扣预算，unknown 不重发、不退费。任务状态迁移由固定表约束，非法迁移在写入时被拒。

**全程可审计。** 每个事件 `sha256(canonical_json({sequence,type,payload,prev_hash,at}))`，链头写入任务行。读取时重算全链，任何一处改动都会让 `load` 抛 `CHAIN_TAMPERED`。

## 目录

```
src/flowagent/
  core/        hashing（canonical JSON）、contracts（状态与校验）、store（sqlite + 哈希链）
  runtime/     state_machine、permissions（主机门控）、budget、harness（单轮）、loop（多轮）
  tools/       base/registry，finance/（只读工具 + Evidence Authority）
  providers/   base、mock（离线确定性）
  memory/      context（模型可见的观测摘要）
  trajectory/  recorder、exporter（导出与独立重算）
  demo/        CLI、终端渲染、合成场景
```

## 为什么不用 `pip install`

`python -m flowagent.demo` 需要 `src` 在 `sys.path` 上，因此要么 `PYTHONPATH=src`，要么 `pip install -e .`。`python demo.py` 自己处理了这件事，是零配置入口。这一点与"零安装"要求存在冲突，已在 Phase 1a 汇报中列为待决项。
