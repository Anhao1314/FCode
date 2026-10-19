# v1：Node.js 研究原型（已归档）

这个目录是项目的**第一版**，保留原样，不参与 CI，也不再修改。

## 它是什么

一个用 Node.js 24 写的研究 Harness，用来回答一个具体问题：**在金融证据研究上，到底该不该训练一个模型？**

三轮实验给出的答案是 `NO_GO`：

| 轮次 | 做了什么 | 结果 |
| --- | --- | --- |
| T1 | 两状态数据集构建 | 训练就绪 `BLOCKED`，只有两个状态可学 |
| T2-A | 单步动作 Benchmark，12 任务 / 6 配对 / 4 策略 | 规则 12/12，固定策略 2/12 |
| T2-B | 多步盲测，8 任务 / 4 配对 | 规则 8/8，判定 `NO_GO` |

结论不是"模型不行"，而是"这批任务不需要模型"——任务被设计成可机械验证，也就被设计成了规则能写死的形状。

## 为什么保留

- **负结果是资产。** 291 项测试、冻结预注册、独立审查、失败目录 `history/failure-catalog.json` 都在这里。
- **它是 v2 的规格书。** v2 的 `core/`、`runtime/`、`tools/` 语义几乎逐条对应这里的 `durable-store.mjs`、`durable-harness.mjs`、`loop-contract.mjs`。
- **可以对照读。** 同一套安全语义，两种语言，两种取舍。

## 怎么读

- `docs/architecture.md` — 分层与边界
- `PROTOCOL.md` — 模型与恢复合同
- `TRAJECTORY_CONTRACT.md` — 轨迹与质量分级
- `reports/T2_B_ACCEPTANCE.md` — 为什么 `NO_GO`
- `history/` — 历代原件哈希与失败记录

## 怎么跑（可选，需要 Node 24）

```sh
cd archive/node-prototype
node scripts/verify.mjs            # 291 项
node scripts/verify-t2b.mjs        # 20 项，含 NO_GO 复现
```

这些命令依赖 `publication-files.json` 白名单与三份冻结哈希清单，路径都是相对本目录的，移动位置后需要重新校准。CI 不再运行它们。

## 标签

`archive/node-research-prototype` 指向归档前的最后一个提交。需要完整的 v1 历史时用它，不要从当前分支反向推断。
