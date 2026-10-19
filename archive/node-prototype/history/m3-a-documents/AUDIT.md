# M3-A 独立审查和实验记录

## 原生子代理

`provider-protocol-reviewer` 使用 GPT-6 High，首轮只读研究官方 DeepSeek 协议和现有适配边界；Root 实施后进行一次实际改动复审，没有实现适配器，也没有重复运行测试。它指出 thinking 默认开启、JSON mode 不是 schema 承诺、精确模型校验和 cache usage 需要补充。针对性复审发现缺少必需 cache 分项时仍可被标成 reported。Root 修复为 invalid usage/未知费用，并补充缺失分项与 null details 负例；复审确认修复，无剩余协议阻断。

`runtime-safety-reviewer` 使用 GPT-6 Extra High，独立只读审查授权、凭证、预算、收据与中断路径，Root 实施后只进行一次针对性复审，没有修改代码或执行测试。它确认在可信主机边界内没有发现绕过持久调用及预算门控的阻断性路径，并要求明确下列限制：价格摘要不证明报价；输入 Token 上界未证明；风险接受不是硬账单上限；包导出不是同进程沙箱；跨 root/scope/grant 不具备账户级全局限额。

Root 独自修改核心代码并执行所有实际测试。两份审查均区分注入实验与真实供应商保证。

## 保留的失败及修复

- `validation/migration.initial.log` 保留第一次依赖检查和测试启动失败。初选 Evidence adversarial suite 动态引入完整 Finch server/Buyer 的 AJV 依赖，检查因此阻断。随后收敛到真实 Harness 所需闭包和六个原样金融核心套件，没有安装依赖或用 Mock 替换 Authority/计算。完整 Finch 287 项另作原件只读保护检查。
- `validation/deepseek-tests.before-cache-review.log`、`deepseek-cases.before-cache-review.json` 保留 usage 修复之前 24 项通过的事实。这个通过结果未覆盖审查发现的缺失缓存字段，不能当成问题不存在的证明。修复后扩充同一负例目标，保留最终日志；未降低旧标准或删改旧测试。
- `validation/verification.initial-scan-failure.*` 保留最终路径扫描的误报：原 ModelBackend 负例使用 `file:///tmp/model` 验证拒绝不安全 endpoint。保留该原测试不变；扫描分别记录这个固定负例、检查机器绝对路径及完整 import 闭包，没有删除或放宽测试断言。
- 每次测试在独立临时任务目录保留签名历史、预算、收据和失败状态；本地实验状态在 Git 忽略目录中，不作为发布源码上传。

## 新增负例与恢复结果

| 实验 | 受控结果 |
| --- | --- |
| 默认关闭、缺少/失配/过期批准、未接受未证明预算风险 | HTTP 和凭证解析为零，预检阻断 |
| dispatch 之后撤销批准，或凭证等待期间撤销模型授权 | 不发送 HTTP；保留 unknown 和预留责任 |
| 原始 adapter 或离开 Runtime 的 API 调用 | scope/dispatch 拒绝，不绕过 Harness |
| 客户端扩大 grant、费用不足、静态/Loop 共用额度 | 发送前拒绝；切换入口不重置同 root 的配额 |
| 错误模型、非法 JSON/重复键、模型自授权限、finish/metadata/thinking 异常 | 无工具执行；完整输出错误保留 invalid 收据 |
| usage 矛盾、负数、缺少缓存字段；输出超额 | 未知费用或额度冻结，不能自动退款 |
| 401/402/429/503/302、错误 status 类型、超时、取消 | 保留 unknown，重建 API 后不自动重发 |
| 忽略取消的传输 | 仍受活动请求及持久 lease 限制，不开放重复调用 |
| 真实 SIGKILL 于 model_started、dispatch_persisted、adapter_returned | 原请求 unknown，恢复不重发 |
| 真实 SIGKILL 于静态 receipt_persisted | 显式签名收据对账后恢复，无 HTTP 重发 |
| 真实 SIGKILL 于 Loop receipt_persisted | 对账原轮，仅下一轮新 request 可发送 |
| 传输模式摘要篡改、profile 变化、当前授权不再匹配 | 收据/恢复拒绝，不静默迁移 |

新增 M3-A 测试包含五次真实子进程 SIGKILL。原 139 项继续覆盖 M1 历史回滚、并发、失败发布、M2 身份/预算及 M4 条件分支、上下文、越权、终止和中断。合成内容经原 Evidence extractor 和确定性计算产生结果；供应商决策由注入返回，研究增益未验证。

## 本地证据

最终全量及独立检出结果见 `validation/candidate-tests.log`、`validation/independent-tests.log`、`validation/verification.json`。原件保护见 `validation/protection-verification.json`；Finch 原件回归见 `validation/finch-protection.log`。独立检出在空远端的独立 clone 中覆盖相同未提交候选文件后运行；没有制造提交来完成检出验证。

没有安装依赖、读取真实 Key、发送付费模型请求、修改历史目录、提交、推送或部署。真实授权 checklist 尚未执行。
