# flowagent

一个**主机可控、可恢复、可审计**的 Agent Runtime。模型只能提议动作，Runtime 独立校验后才执行；每一步落进哈希链，崩溃可恢复，未知结果不重发。金融研究是第一个示例域，内核领域无关。

```sh
python demo.py
```

需要 Python 3.11+，零第三方依赖，零配置，离线运行。在终端里会给出场景菜单；无终端时直接跑完整故事。

## 这一版能做什么

`full` 会跑完一个 9 轮研究：判断一家公司两期毛利率是否可比。资料里埋了三个真实障碍——单位不同（万元 / 百万元）、口径不同（adjusted 需桥接到 IFRS）、以及一份重述说明替换了旧数。模型逐轮提议，主机逐轮门控，最后 Runtime 用确定性算术重算并比对，通过才判成功。

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

## 五个场景

```sh
python demo.py full          # 完整研究，9 轮
python demo.py tool-denied   # 越权工具：主机拒绝，工具从未执行
python demo.py budget        # 预算耗尽：发送前拦住，已占用不退
python demo.py crash         # 进程被 SIGKILL，重启续跑不重复
python demo.py unknown       # 供应商超时：不重发，凭签名收据对账
python demo.py all           # 顺序跑完并打印汇总表
```

`all` 的实际输出：

```
 场景           终态                     轮次   调用   读取    花费µUSD   轨迹
 full         succeeded               9    9    9      4500   ok
 tool-denied  denied                  1    1    0       500   ok
 budget       failed                  5    4    4      2000   ok
 crash        succeeded               9    9    9      4500   ok
 unknown      succeeded               9    9    9      4500   ok
 全部 5 个场景的轨迹均通过自检
```

四个可靠性场景都不改 Runtime 代码——它们是不同的主机策略与故障注入，这一点本身就是设计主张。

## 看轨迹

每次运行写出 `work/demo/<scenario>.trace.json`：完整事件哈希链，可直接阅读。

```sh
python demo.py full --open
```

会用浏览器打开 `viewer/index.html` 并加载该 trace。也可以手动打开 viewer，把 JSON 拖进去。viewer 用 `crypto.subtle` 重算整条链，任何一处被改动都会立刻变红——这不是日志高亮，是真的重算。

## 三条约束

**模型不掌权。** 工具是封闭注册表，参数按 schema 校验，且必须同时出现在任务范围与主机 grant 里。模型不能传财务数值，不能声明完成。

**出错不乱来。** 调用在发送前扣预算，unknown 不重发、不退费。任务状态迁移由固定表约束，非法迁移在写入时被拒。崩溃后从事件日志重建工作记忆，已完成的轮次不会重放。

**全程可审计。** 每个事件 `sha256(canonical_json({sequence,type,payload,prev_hash,at}))`，链头写入任务行。读取时重算全链，任何一处改动都会让 `load` 抛 `CHAIN_TAMPERED`。

## 测试

```sh
python -m unittest discover -s tests -v
```

23 项，覆盖权限门控（未注册 / 越权 / 超 grant / 参数非法）、预算三个维度、状态机非法迁移、并发写 CAS、事件篡改、收据伪造、独立重算拒绝伪造观测、trace 篡改，以及五个场景的端到端断言（其中崩溃场景用真实 SIGKILL，断言"没有任何一轮被重复提议"）。

CI 在 Ubuntu 与 macOS 上跑 Python 3.11 与 3.13，包含 `python demo.py all` 与零配置入口冒烟。

## 目录

```
src/flowagent/
  core/        hashing（canonical JSON）、contracts（状态与校验）、store（sqlite + 哈希链）、receipts（签名收据）
  runtime/     state_machine、permissions（主机门控）、budget、harness（单轮）、loop（多轮 + 恢复）
  tools/       base/registry，finance/（只读工具 + Evidence Authority）
  providers/   base、mock（离线确定性，三种策略）
  memory/      context（模型可见的观测摘要，从事件日志重建）
  trajectory/  recorder、exporter（导出与独立重算）
  demo/        CLI、终端渲染、五个场景、崩溃 worker
viewer/        零构建单文件 Trace 可视化
tests/         23 项 unittest
```

## 现在还没有的

`docs/` 下的架构说明、设计决策（至少 10 问）、JD 映射与框架对照属于 Phase 1c。Node 研究原型仍在仓库根目录，1c 会归档到 `archive/`。

## 为什么不用 `pip install`

`python -m flowagent.demo` 需要 `src` 在 `sys.path` 上，因此要么 `PYTHONPATH=src`，要么 `pip install -e .`。`python demo.py` 自己处理了这件事，是零配置入口。这一点与"零安装"要求存在冲突，已在汇报中列为待决项。
