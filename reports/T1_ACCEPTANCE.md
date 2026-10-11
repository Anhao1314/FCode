# FlowCredit-Harness T1 验收

唯一实现基线：R0 本地提交 `e389b6aac80ea5260db9879efdd6ec2651d37a50`。独立候选分支 `research/t1-offline-dataset`；所有旧 Runtime、金融计算与测试源文件保持原样。

**研究结论：已形成两种可信的下一工具行动候选，但当前数据不具备足够学习价值与独立评测条件，训练就绪为 BLOCKED。** 不是模型训练或真实 Teacher 采样验收。

## 交付

- [研究目标、实验设计与下一阶段条件](../research/t1/STUDY.md)
- [数据、标签、许可、恢复与隔离合同](../research/t1/CONTRACT.md)
- [最小构建实现](../research/t1/dataset.mjs)、[封闭合成语料](../research/t1/corpus.mjs)
- [两行脱敏行动样例](../research/t1/examples/action-candidates.jsonl)与[样例清单](../research/t1/examples/manifest.json)
- [独立审查与已复现缺陷](T1_REVIEW.md)

## 实验判断

| 场景 | 结果与含义 |
| --- | --- |
| 有事实 / 空证据 | 实际通过 Harness 执行 assess / 受限 reread，两种可追溯策略行动；空证据仍是 T0 insufficient-evidence，T0 导出仍零行 |
| 真实确定性计算 | 合成夹具毛利率 17.85%、流动比率 3.94 可复算；TAI 与 deterministicRisk 仍 null；不是金融事实 Gold |
| 控制策略 | 两行候选上 always-read 1/2、always-assess 1/2、独立条件规则 2/2；不是模型效果或泛化指标 |
| 重复 / 重启 / 并发 | 同输入一行；同内容导出同身份；不增加模型调用 |
| 来源 / 输入隔离 | 跨 split 同来源两侧拒绝；不同空实体归一化后同输入也两侧拒绝；没有可用未见评测集 |
| 失败 / 越权 / unknown | 零正向训练候选；unknown 预留与并发 lease 保留，重启不自动重发 |
| 数据与权限攻击 | 原始 blob、导出审计、capture、来源、用途 / 哈希许可、未来标签、权限撤销均被拒绝 |
| 真实 SIGKILL | 原子发布前中断，无最终样本；原锁阻断，显式死进程锁恢复后只发布一次，零新模型调用 |

## 验证记录

针对性初版 `run-Pic7TV`：14/14，48.8 秒。新增审查负例 `run-NDrXrb`：13/14，49.5 秒，许可对象变更失败原样保留。修复与增强后 `run-mdaIlR`：14/14，56.3 秒。完整旧回归与独立检出结果将在执行后追加；此段不能单独视为最终验收。

另保留一次早期夹具探索错误：调用方把位置参数误写为 options 对象，得到 ASSESSMENT_NOT_FOUND；仅改正探索调用，未修改实际模块或旧断言。

每次 runner 均复制完整公开文件集到新的受保护目录，环境变量白名单、无依赖安装。TAP、stderr、摘要、运行状态与失败现场均在忽略的 `validation/` 和 `work/` 内。它们不会进入 Git；公开报告只保留脱敏结论。子进程 SIGKILL 不等于断电测试。

## 状态与限制

| 状态 | 内容 |
| --- | --- |
| IMPLEMENTED | 实际轨迹到下一动作 SFT 的最小构建器；独立规则验证、签名来源重验、新用途许可、分区与去重、签名原子导出、失败审计 |
| TESTED_OFFLINE | 注入式 DeepSeek + 原 Loop/Recorder/Evidence；合成金融计算；两分支与攻击、中断和保守恢复；不代表真实 Teacher 决策 |
| BLOCKED | 当前只有两个固定规则状态；未见评测集不足；真实训练放行与真实 Teacher 采样尚未授权 |
| NOT_PROVEN | Student 学习收益、策略最优性、真实财务事实、真实数据许可与通用匿名化、跨批全局 split、近重复隔离、真实模型/计费/Token 上界、断电或多机一致性 |

Finch 的已知并发 286/287、同标准串行 287/287 历史结论保留；本轮未运行完整 Finch、未修复或掩盖其问题。没有读取真实密钥、调用付费 API、下载模型、GPU/Student 训练、推送、合并、部署或许可证变更。
