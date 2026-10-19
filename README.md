# FlowAgent

**模型不掌权、出错不乱来、全程可审计的 Agent Runtime。**

模型只能提议动作，主机掌握授权、预算、工具与凭证；Runtime 独立校验后才执行，每一步落进哈希链，崩溃可恢复，未知结果不重发。金融研究是第一个示例域，内核领域无关。

```sh
cd flowcredit && python demo.py
```

Python 3.11+，零第三方依赖，零配置，离线。在终端里给出场景菜单；无终端时直接跑完整故事。

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
 轨迹自检  通过：40 个事件，链头 75cd9f247c70…
```

## 三个卖点

| | 主张 | 代码里怎么落实 | 怎么验证 |
| --- | --- | --- | --- |
| **模型不掌权** | 模型只能提议，主机门控工具、参数、预算、授权 | 工具是封闭注册表；参数按 schema 校验；工具必须同时出现在任务范围与主机 grant 里；模型不能传财务数值 | `demo.py tool-denied`：提议一个未注册工具，被拒且读取计数为 0 |
| **出错不乱来** | 崩溃可恢复，unknown 不重发、不重复扣费，结果独立校验 | 调用在发送前扣预算；`unknown` 只能凭匹配的签名收据显式对账；成功必须由 Runtime 重算通过 | `demo.py crash`：真实 SIGKILL 后 9 轮 9 次调用，无一轮重复；`demo.py unknown` |
| **全程可审计** | 每步签名收据 + 哈希链，Trace 可回放、可评测、防篡改 | 每事件 `sha256(canonical_json({sequence,type,payload,prev_hash,at}))`，链头写入任务行 | `viewer/index.html` 用 `crypto.subtle` 重算全链，改一个字节就变红 |

## 架构

```mermaid
flowchart TB
    subgraph host["主机（可信边界）"]
        A["authorizer<br/>当前授权"] --> G["permissions<br/>工具 / 参数 / grant"]
        B["budget<br/>发送前扣减"] --> G
        C["credential provider<br/>延迟解析"] -.->|"默认关闭"| G
    end

    M["模型<br/>只提议"] -->|"1. proposal"| G
    G -->|"2. PASS"| T["tool registry<br/>只读工具"]
    G -->|"DENIED + 原因"| X["终态 denied"]

    T --> O["observation"]
    O --> MEM["working memory<br/>从事件日志重建"]
    MEM --> M

    O --> V["独立重算<br/>Runtime 校验"]
    V -->|"通过"| S["终态 succeeded"]
    V -->|"不符"| F["终态 failed"]

    subgraph durable["持久层"]
        ST["sqlite<br/>task + event 哈希链"]
        R["签名收据<br/>HMAC"]
    end

    G --> ST
    T --> ST
    V --> ST
    R --> ST
    ST --> TR["trace JSON"]
    TR --> VW["viewer<br/>零构建，重算哈希"]
```

一次调用穿过四道关：**门控 → 预算 → 执行 → 独立重算**。任何一道不过，任务都不会被标记为成功。

## 五个场景

```sh
cd flowcredit
python demo.py full          # 完整研究，9 轮
python demo.py tool-denied   # 越权工具：主机拒绝，工具从未执行
python demo.py budget        # 预算耗尽：发送前拦住，已占用不退
python demo.py crash         # 进程被 SIGKILL，重启续跑不重复
python demo.py unknown       # 供应商超时：不重发，凭签名收据对账
python demo.py all           # 顺序跑完并打印汇总表
```

```
 场景           终态                     轮次   调用   读取    花费µUSD   轨迹
 full         succeeded               9    9    9      4500   ok
 tool-denied  denied                  1    1    0       500   ok
 budget       failed                  5    4    4      2000   ok
 crash        succeeded               9    9    9      4500   ok
 unknown      succeeded               9    9    9      4500   ok
```

四个可靠性场景都不改 Runtime 代码——它们是不同的主机策略与故障注入。这一点本身就是设计主张：可靠性不是特判出来的。

## 能力清单

| 能力 | 状态 |
| --- | --- |
| 主机门控（注册表 / 任务范围 / grant / 参数 schema / effect） | 已实现 |
| 硬预算（calls / reads / cost / tokens 四维，发送前扣减） | 已实现 |
| 持久任务（sqlite WAL、`BEGIN IMMEDIATE`、序列号 CAS） | 已实现 |
| 事件哈希链（写入校验 + 读取重算 + 链头锚定） | 已实现 |
| 崩溃恢复（从事件日志重建工作记忆，不重放已完成轮次） | 已实现 |
| 未知结果（不重发 / 不退费 / 签名收据显式对账） | 已实现 |
| 独立验证（Runtime 重算，模型不能自报完成） | 已实现 |
| Evidence Authority（区分可用与不可用证据） | 已实现（金融域） |
| Trace 导出与可视化重算 | 已实现 |
| 真实供应商（一次性传输授权 + 凭证提供者 + 价格快照） | **门控关闭**，仅骨架 |

## 数字

- **23** 项单元与场景测试，全部离线
- **5** 个可复现场景，其中崩溃场景用真实 `SIGKILL`
- **0** 个第三方运行时依赖（只用标准库）
- **9** 轮完成一次完整研究，**4500 µUSD** 合成预算
- 哈希链 **40** 个事件，读取时全量重算

## 目录

```
flowcredit/          Python Runtime 与 Demo
  src/flowagent/
    core/            canonical JSON、契约与状态机、sqlite + 哈希链、签名收据
    runtime/         门控、预算、单轮 harness、多轮 loop（含恢复）
    tools/           封闭注册表；finance/ 只读工具与 Evidence Authority
    providers/       离线确定性 mock（三种策略）
    memory/          模型可见的观测摘要（从事件日志重建）
    trajectory/      记录、导出、独立重算
    demo/            CLI、终端渲染、五个场景、崩溃 worker
  viewer/            零构建单文件 Trace 可视化
  tests/             23 项 unittest
  docs/              架构、设计决策、框架对照、JD 映射
archive/             v1：Node.js 研究原型（保留，不参与 CI）
```

## v1 与 v2

`archive/node-prototype/` 是 v1：一个 Node.js 研究原型，用来回答"该不该训练模型"，结论是 `NO_GO`——规则基线解掉了全部冻结任务。它保留了 291 项测试、冻结预注册和一份诚实的负结果报告，标签 `archive/node-research-prototype`。

v2 不再问那个问题。它把 v1 里真正有价值的部分——可恢复、可审计、主机可控的执行语义——重写成 Python，并做成一条命令能跑完的演示。

## 边界

- 真实模型默认关闭。真实传输需要一次性授权（≤1h）、凭证提供者、主机复核的价格快照与硬预算，缺一不可。
- 演示中的金额、公司、资料全部是合成的，不是真实财报，也不构成任何投资或信贷意见。
- 签名收据证明的是"这次调用发生了、内容是什么"，不证明供应商账单准确。`external_billing` 恒为 `not-verified`。
- 哈希链保护的是本地记录的一致性。能同时改写数据库与签名密钥的攻击者不在威胁模型内。
- 未做：RAG、多智能体、MCP、FastAPI、前端工程化。这些不是遗漏，是刻意的范围边界。

## 许可

根目录代码未授开源许可。`archive/node-prototype/vendor/` 保留其原始 MIT 许可证。
