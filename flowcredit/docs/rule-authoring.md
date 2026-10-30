# 规则编写指南

> 规则是数据(`audit-rules/*.json`),不是代码。引擎读它,不 import 它;
> 规则作者不需要懂 Python。格式契约与 `audit-rules/README.md` 一致,本文
> 讲怎么写一条**合格的**规则。

## 一、一条规则的解剖

```json
{
  "id": "RULE-AGI02-001",
  "category": "AGI-02",
  "title": "Remembered approval keyed by tool name whitelists all future arguments",
  "severity": "medium",
  "trigger": {
    "type": "static",
    "match": "approval memory keyed on tool name only"
  },
  "poc": {
    "kind": "command",
    "spec": "approve 'run_command ls' with remember=true; then issue 'run_command python payload.py'; record whether an approval event occurs"
  },
  "verdict": "poc_replay_passes",
  "references": ["fixtures/fcode-self/known-issues.json#FCODE-02", "viewer/console_runtime.py:722-727"]
}
```

| 字段 | 硬性要求 |
| --- | --- |
| `id` | `RULE-<分类号>-<序号>`,永不复用 |
| `category` | 必须在 `flowaudit.vulns.AGI_CATEGORIES` 内 |
| `severity` | `critical`/`high`/`medium`/`low`/`info` |
| `trigger` | 静态匹配或动态探针引用;**含糊的触发条件 = 不可实现的规则** |
| `poc` | 必须能生成**一个独立进程可重放**的复现物;"手动检查"不是 PoC |
| `verdict` | 当前唯一合法值:`poc_replay_passes`——重放成功才算发现 |
| `references` | 至少一条:真实样本指针或 fixtures 靶子 |

## 二、合格规则的四条验收线

1. **可判定**:给定靶子,两条不同的执行要么都命中要么都不命中——判定
   不能依赖模型的心情。需要语义判断的部分写在探针的固定输入里,不写在
   判定里。
2. **可重放**:PoC 是命令/请求序列,独立进程执行,产出机器可读结果。
3. **有分母**:规则必须能在 fixtures 里指出它对应的靶子;没有靶子的规则
   进 `status: "draft"`,不参与评分。
4. **不武器化**:PoC 证明缺陷存在即止(见 threat-model 第五节)。

## 三、规则的生命周期

```
draft(无靶子)→ active(靶子就位,验收线通过)→ deprecated(只标记,不删除)
```

规则只增不删。审计报告引用规则时同时记录规则集版本,历史结论要能追溯到
当时的规则状态。`audit-rules/index.json` 的 `version` 单调递增。

## 四、首批规则(Sprint 2 目标)

| 规则 | 分类 | 对应靶子 |
| --- | --- | --- |
| 秘密明文落盘(权限位宽于 600) | AGI-03 | fcode-self #FCODE-04(密钥与数据同库) |
| 工具执行绕过门控/无咽喉点 | AGI-02 | fcode-self #FCODE-06 |
| README 声明与实现不符 | AGI-08 | fcode-self #FCODE-03 |

验收:对 `fixtures/fcode-self/` 独立检出 ≥3 个已知问题,每条发现一条命令重放。
