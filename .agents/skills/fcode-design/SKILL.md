---
name: fcode-design
description: Use whenever designing or changing FCode's frontend, interaction flows, visual language, settings, intake, reports, status, empty states, or user-facing architecture. Applies to "redesign", "restyle", "make it feel like…", "add a settings/choice/approval page", UI copy, CSS, or any change where a user will see or decide something. Captures the Paper & Proof aesthetic, the signer persona, and the host-governed agent interaction model. It is strength-first: amplify the signer's judgment, do not replace it. Read before writing UI code, CSS, copy, or new interaction state.
---

# FCode Design Skill

You are not designing a chat app. You are designing a **working paper that someone can sign**.

FCode 是受控 agent runtime：模型只提议，主机门控、预算、执行、复算，证据进哈希链。
界面不是模型的舞台，而是这条链的阅读器、决策面和签字页。

## Product thesis

**FCode 不替专家做判断，而是放大专家的判断。**

痛点导向会做成更快的搬报表工具；优势导向才会做成判断放大器。林岚最值钱的不是时间，
是她看出数字不可比、判断异常性质、决定证据够不够、把发现讲成结论、把标准传给 junior
的能力。Agent 的职责是把这些判断从搬运里解放出来，并让判断标准可复用。

## When to use this skill

- 新增或修改任何用户可见界面：运行页、需求确认、设置、报告、工具面板、空状态。
- 调整交互：选择卡、审批、停止、续跑、错误/阻塞、通知。
- 调整视觉：颜色、字体、间距、圆角、动效、图标、文案。
- 新增页面或状态，需要决定“放主区、浮层、侧栏还是行内”。
- 评审一个前端 PR：是否破坏证据、作用域或可签字性。

## Primary persona

**林岚，32 岁，精品尽调 / 风险咨询团队的项目负责人。**

她的核心资产不是时间，是**判断力、标准和签名**。

她最擅长的五个判断：

1. **看出两期数字其实不可比。** 单位、准则、合并范围、重述，她知道哪里有问题。
2. **判断异常是业务变化还是会计处理。** 毛利率下降，是价格战、成本结构，还是口径变了。
3. **决定证据够不够签字。** 什么时候可以下结论，什么时候必须再要一份材料。
4. **把复杂发现讲成合伙人/客户能接受的结论。** 保留什么、拒绝什么、怎么措辞。
5. **把自己的标准传给 junior。** 什么算干净、什么必须退回、什么可以放行。

痛点只是约束：PDF/Excel 搬运、单位/口径核对、引用错误、资料不能上云。它们解释
为什么现在做得慢，但不定义产品价值。

设计时先问两件事：

- **这个界面是让她做更多只有她能做的判断，还是把她降级成点“同意”？**
- **林岚会不会拿这个界面去签字？** 不会，就不要做。

### Amplify, don't replace

| 她的优势 | 框架怎么放大 |
| --- | --- |
| 判断数字不可比 | 把单位/口径/重述差异摆成判断面，而不是直接给结论 |
| 判断异常性质 | 给 2–3 种解释、反证、还需要什么证据 |
| 判断证据是否足够 | 明确 blocked / limitation，不替她拍板 |
| 讲给合伙人/客户 | 给多种表述草案、保留措辞和适用条件 |
| 把标准传给 junior | 记录 accept / reject 理由，形成 reviewer profile |

## Non-negotiables

1. **纸是底稿。** 白底、留白、细线、虚线分隔；不用阴影、渐变、发光、玻璃拟态伪造层级。
2. **墨只表达确定。** 近黑墨色承担结论；颜色只用于已验证、待确认、错误三种状态，且必须同时有文字标签。
3. **手写是人的痕迹。** 楷体只用于标题、结论、人工决定；机器数据用无衬线或等宽。
4. **数字像账本。** 金额、比例、哈希、预算用等宽 + `tabular-nums`；单位、期间、来源不能丢。
5. **线是校对痕。** 实线分区，虚线表示可裁切/可归档；装饰性分隔线没有存在资格。
6. **证据先于表达。** 没有 Runtime 复算或链验证，不得出现“已验证 / 已复算 / 可签字”。
7. **不造假控件。** 没后端支持的选项不出现；确需展示时标“只读 / 训练中 / 即将开放”，不能点了没反应。
8. **选择晚于理解。** 用户先说话，模型先回复；选项是理解的产物，不是开场问卷。
9. **放大判断，不替代判断。** Agent 准备判断面，专家拍板；自动签章、一键结论都不算产品能力。

## Visual system

规范全文：`flowcredit/docs/design-system.md`。样式页：`flowcredit/viewer/design.html`。
Token 与新增样式唯一入口：`flowcredit/viewer/design.css`。

### Tokens

```css
--paper: #ffffff;       --paper-wash: #faf9f7;   --paper-well: #f6f4f0;
--ink: #171717;         --ink-2: #4b4b4b;       --ink-3: #8d8d8d;
--rule: rgba(23,23,23,.12);
--verified: #2f7d4f;    --pending: #8a6a1f;     --alert: #a83a2a;
```

- 字体：`--font-display` 楷体；`--font-body` 系统无衬线；`--font-mono` 等宽。
- 间距：4 的倍数（4/8/12/16/24/32/40）。
- 圆角：卡片 12、浮层 14、控件 8；胶囊只给状态/chip。
- 动效：160–220ms，`cubic-bezier(.2,.7,.2,1)`；不用弹簧、缩放弹跳、视差。

### Signature components

**案卷抬头** — 所有页面共用一个语法：等宽 kicker + 楷体标题 + 等宽元信息。

```text
CASE FILE   console-operator
判断恒星智算 2024 与 2025 两期合并毛利率是否可比
Fcode · 9 轮 · 49 个事件 · 全链验证通过
```

Kicker：`WORKBENCH` / `CASE FILE` / `NEW DELEGATION` / `PREFERENCES`。

**校对线** — 成功结论的数字下方固定出现，像一枚不旋转的校对章：

```text
[✓ 已复算]  Runtime 独立重算通过 · 2 处引用 · 49 个事件
```

它不是装饰，是产品承诺。失败或未验证的结果不能出现。

**选择卡** — 2–4 个具体结果，不是抽象分类。每项是“标题 + 一句为什么”，推荐项有 badge。
选中态用墨色边框 + 浅纸底，不用彩色填充。选择卡不是问卷：模型先回复，再给选项。

**案卷/印章** — 链验证、报告签发用 `seal` 组件。状态色只在章内出现。

## Interaction grammar

### Delegation

1. 用户先输入问题。
2. 后端 clarifier 返回：一句回复 + 理解摘要 + 0–4 个选项。
3. 用户点选或继续自由描述。
4. 信息足够时出现任务卡：目标、输出、审批、预算。
5. 用户确认后才创建运行。

规则：

- 一问一卡，最多 4 个选项。
- 能从原话推断的，不要问；上一轮选过的，不重复问。
- 永远保留“直接描述 / 不确定 / 取消”。
- 任务卡必须显示预算与预计轮次；花钱前要可见。
- 选择写入 `binding.spec`；不写入链的选择等于没发生。
- 当前 clarifier 是确定性占位；不要说“模型已经思考”。`thought` 是理解摘要，不是 chain-of-thought。
- 优先问判断，而不是只问物流：例如“这次最需要你判断什么”“你希望我准备到什么程度（只摆证据 / 给 2–3 种解释 / 给建议结论）”。

响应形状：

```json
{
  "reply": "我理解你关注「两期可比性」。结果怎么用？",
  "thought": "已识别：两期可比性；还缺：输出方式。",
  "choices": [{"field": "output", "value": "memo", "label": "一页结论 + 审计底稿"}],
  "spec": {"intent": "compare"},
  "ready": false,
  "task": null
}
```

### Decision surface

成功输出不是一张“答案卡”，而是一张判断面：

```text
事实        FY2024 17.50% / FY2025 15.00%
异常        下降 2.50pp，超过行业均值
解释 A      价格竞争导致（证据：收入增速低于销量）
解释 B      产品结构变化（证据：分产品毛利缺失）
解释 C      口径问题（证据：已排除单位/准则/重述）
待判断      是否接受“经营恶化”这一解释
会影响结论  如果分产品毛利无法取得，应保留意见
```

Agent 不替她选解释，而是把解释和反证摆齐；她选，或者要求补材料。
每个“待判断”都要能写进底稿，成为可复用的 reviewer profile。

### Run view

- 先显示任务、预算、计划，再显示轮次；结论卡在最后，不抢跑。
- 结果卡尽量包含事实、异常、2–3 种解释、待判断和“什么会改变结论”，而不是只给一句结论。
- 每个数字必须能点回证据；没有来源的数字要显式标“未验证”。
- 审批是行内卡片，不是弹窗：它停在轮次边界，不打断工具执行。
- 阻塞态写清：缺哪份材料、哪个口径、下一步能做什么；禁止“通用失败”。

### Surface choice

| 用户要做的决定 | 用什么 |
| --- | --- |
| 描述任务、连续选择 | 主区对话 / 需求确认 |
| 审批一步工具 | 行内审批卡 |
| 查看工具契约、链、原始 trace | 右侧案卷 |
| 改偏好、看记忆统计 | 主区设置页（不是小弹层） |
| 看完整底稿 | 居中报告浮层 |
| 删除/重建等破坏性动作 | 行内二次确认，不用浏览器 confirm |

### Settings

- 设置是主区的一页，不是侧栏弹层；打开时对话页让位，返回恢复滚动位置与运行视图。
- 作用域必须标清：`本机` / `下次委托` / `运行时`。
- 本机偏好即时生效，不设“保存”；破坏性操作二次确认。
- 只读信息（Provider、链、数据目录）不要伪装成可编辑控件。

## Architecture rules for the UI

1. **事件链是唯一事实源。** UI 状态必须能从 trace/events 重建；不要发明只在内存里的“真相”。
2. **用户选择要落盘。** 选择进入 `TaskSpec` → `binding.spec`；否则不可回放、不可审计。
3. **乐观更新必须能对账。** SSE 快照/增量到达后，以服务端为准；失败要退回并说明。
4. **权限、预算、审批由主机决定。** UI 不替模型放行，也不隐藏拒绝原因。
5. **不要把“模型说完成”当完成。** 只有 verify/recompute 通过才能显示“已验证”。
6. **不新增第二套状态。** 能复用 `live` 会话、trace、`currentCheck` 就不要另建 store。
7. **本地数据边界清晰。** 客户资料默认不出本机；外部采集走主机配置源并留来源。
8. **空状态也是产品。** 空状态要告诉用户下一步能做什么，不放装饰性插画堆头。

## Reviewer profile

除了案例和事实，还要记住**她怎么判断**：

- 她接受过什么异常解释，拒绝过什么证据；
- 她惯用的保留措辞、limitation 写法；
- 她对某类客户/行业的阈值；
- 她退回 junior 底稿的原因。

这些不是“用户画像”，而是 reviewer profile。下一次 agent 按她的标准准备判断面，
而不是从零开始；但最终拍板仍然是她的。

## Copy and voice

- 说“核查、复算、出处、底稿、阻塞”，不说“智能涌现、魔法、一键封神”。
- 结论先行，证据随后；每个数字带单位、期间、来源。
- 失败要具体：缺什么、卡在哪、下一步能做什么。
- 不用感叹号、不用 emoji 代替状态、不写“AI 可能”。
- 英文只做 kicker/元信息；正文以中文为主。
- 按钮用动词：“开始委托”“追加预算并继续”“重新验证”，不用“确定/提交”这种空词。

## Workflow for any UI change

1. **说出用户最值钱的判断。** 不是“这个页面有什么字段”，而是“她在这里要拍板什么”；说不出来就不该加。
2. **选表面。** 用上面的 Surface choice；不要在弹层里塞页面级任务。
3. **检查已有模式。** 先看 `design.css`、`design.html`、`app.js` 里是否已有同类组件；能复用就不新建。
4. **先定状态与落盘。** 新交互是否需要 spec/event？需要就先接线，再画界面。
5. **写文案。** 按 Copy and voice；把失败路径也写出来。
6. **实现。** 新样式只进 `design.css`；旧 `app.css` 只做布局兼容。
7. **验证五个面。** 运行页、需求确认、设置、报告、窄屏；再检查减少动效。
8. **更新规范。** 新组件/新 token 必须同步 `design-system.md` 和 `design.html`。

## Definition of done

- [ ] 一句话能说清用户在这里做的判断。
- [ ] 它放大了一个只有用户能做的判断，而不只是省时间。
- [ ] 没有把专家降级成点“同意”的人。
- [ ] 没有新增颜色；状态色都有文字标签。
- [ ] 没有假控件；不可用能力明确标注。
- [ ] 每个数字有来源/单位/期间，或明确标“未验证”。
- [ ] 选择/审批/阻塞写进事件链或 `binding.spec`。
- [ ] 预算与预计轮次在开始前可见。
- [ ] 运行页、设置、需求确认、报告、窄屏无回归。
- [ ] `prefers-reduced-motion` 与设置里的动效开关都生效。
- [ ] 新样式在 `design.css`，规范页已更新。

## Anti-patterns

- 把设置塞回左下角小弹层。
- 用户一进来就抛三步问卷；模型还没回复。
- 用彩色渐变/发光表示“AI 在工作”。
- 用 emoji、3D 图标、玻璃卡片替代手绘线稿和校对线。
- 所有按钮都做成胶囊；所有卡片都加大阴影。
- 显示“已验证”但没有 Runtime 复算依据。
- 为了“体验”隐藏预算、拒绝原因或阻塞原因。
- 选项里出现当前根本执行不了的任务，却不标注。
- 一键给结论、自动签章，或把专家做成审核按钮。
- 用“省了多少小时”作为唯一价值；她的签名覆盖面和判断质量才是。

## References

- 产品理念：`flowcredit/docs/philosophy.md`
- 视觉规范：`flowcredit/docs/design-system.md`
- 样式页：`flowcredit/viewer/design.html`
- Tokens / 新样式：`flowcredit/viewer/design.css`
- 澄清式委托契约：`flowcredit/docs/intake.md`
- 运行时架构：`flowcredit/docs/architecture.md`
- 交互实现：`flowcredit/viewer/app.js`
