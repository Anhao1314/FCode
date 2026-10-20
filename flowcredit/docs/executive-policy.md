# Executive–Policy（EPA）· P1 决策包

> Host 负责“想清楚”，4B 负责“选一下”，Ledger 负责“留下证据”。

## 问题

旧接口把完整计划、16 个工具和全部历史交给模型，让它自由生成 JSON。对 4B 来说，
这一轮同时要求理解长上下文、选工具、生成参数、规划下一步、保证格式合法。

P1 把模型输入改成一张 **DecisionPacket**：当前状态、最近一张证据卡、2–5 个合法动作。
模型只回答 `{"choice": "a1"}`，不生成 tool、不生成参数、不管理记忆。

## 运行链路

```text
plan + memory + budget
  → ActionCompiler
      → 0 个候选：Host 阻塞 / 问用户
      → 1 个候选：Host 直接执行（fast path，auto_action）
      → 2–5 个候选：DecisionPacket → Policy → ActionChoice
  → Host 校验 → gate → execute → verify
  → EvidenceCard 更新状态
```

## 关键契约

| 契约 | 内容 |
| --- | --- |
| `ActionCandidate` | id / todo_id / tool / arguments / why / effect / version |
| `DecisionPacket` | objective / round / state / last_evidence / memory_cards / budget / candidates / output |
| `ActionChoice` | candidate_id / reason |
| `PacketProvider` | 把 Policy 选择适配成现有 Provider/Proposal，复用 Harness 的状态机、预算、receipt |
| `auto_step` | 单候选时由 Host 直接提交，记录 `auto_action`，不扣模型预算 |

## Trace 事件

- `policy_requested`：完整 packet + `packet_hash`；
- `policy_decided`：选中的 candidate、packet hash；
- `auto_action`：无需模型调用，记录 candidate、step、packet hash。

这样“为什么调用/没调用模型”可以回放，且不记录隐藏 chain-of-thought。

## P1 实测

```sh
cd flowcredit
PYTHONPATH=src python3 -m flowagent.demo.packet \
  --workdir /tmp/fcode-packet-full --scenario full --fresh
```

| 场景 | 状态 | 轮次 | 模型调用 | fast path | packet | 旧上下文 | 降幅 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `full` | succeeded | 9 | 8 | 1 | 1,541 B | 7,624 B | **79.8%** |
| `open-ended` | failed（如实阻塞） | 9 | 9 | 0 | 1,541 B | 7,624 B | **79.8%** |

`full` 仍然是 `-250 bp`，链验证通过；最后一步 `calculate_margin` 只有一个合法动作，
由 Host 直接执行，所以模型调用从 9 降到 8。

## 当前边界

- `MockPolicy` 是 rule-first-candidate，只用于验证结构，不代表模型能力。
- 控制台默认仍走旧的 Provider 路径；packet 模式目前只在 lab 和测试里启用。
- 候选动作来自蓝图 todo，还不是模型生成的计划。
- SFT 仍是 v10 全上下文格式；P2 才会切到“DecisionPacket → choice”。
- 发生阻塞时 packet 会保留一个 `report_blocked` 候选；模型可以诚实停下。

## P2 要做什么

1. `LocalPolicy`：约束解码输出 `choice`，一次修复，失败回退 Host 规则；
2. SFT 数据改成候选选择格式，加入 hard negatives 和 blocked 样本；
3. 评测平面：动作正确率、blocked 精确率/召回率、引用覆盖率、每决策 tokens；
4. 把 packet 模式接进控制台，同时保留旧 Provider 作为故障注入/基线。
