# FlowCredit-Harness · M3-A

DeepSeek Provider 候选已接入现有 M2 DurableHarness 和 M4-L0 动态循环。默认关闭真实传输；本轮仅验证离线注入 HTTP。没有读取真实模型凭证，没有发送真实模型请求。

这是正式仓库的本地、未提交候选。远端初始化时为空仓库；迁移取自本机已验收的实际工作文件，没有从旧 Finch HEAD 重建基线。

## 运行

需要 Node.js 24 或更高版本。核心和测试只使用 Node 内置模块，不需要安装依赖。

```sh
npm test
```

也可运行 `npm run test:legacy`、`npm run test:finance`、`npm run test:deepseek`。测试自动建立 Git 忽略的 `work/` 和 `validation/`；使用合成金融输入、注入 HTTP 和合成凭证。测试中的 live 模式边界用替换后的 fetch 验证，绝不触达 DeepSeek。

可移植验收范围是 139 项原生 Harness 回归、93 项真实金融模块回归和 24 项 M3-A 测试，共 256 项。Finch 完整 287 项另在原工作区只读运行，包含不属于最小 Harness 依赖闭包的 server/Buyer/AJV 测试，不能据此声称本仓库迁入了整个 Finch 应用。

## 使用边界

包入口导出 `createDeepSeekHarness`、`createDeepSeekLoop`、`createOfflineLoop`；返回 `create`、`run`、`status`、`reconcile` 四个方法。主机注入 Evidence service 和当前模型授权。DeepSeek 的 `mode` 默认为 `disabled`；离线协议模式为 `injected-http-test`，需要显式注入 HTTP。完整可执行装配和断言见 `packages/native-agent/test/deepseek.test.mjs`。

live 模式代码已实现，但本轮没有授权开启。它要求主机提供独立的逐调用传输审批、价格快照和延迟凭证解析器。实际输入 Token 上界和外部账单尚未证明；缺少明确风险接受时，调用会被阻断。测试中的价格和审批都是合成数据，不能用于真实调用。

模型只提出版本化 Plan。真实 Evidence Authority、只读工具、确定性计算、当前授权、预算和任务完成验证仍由原 Runtime 执行。M4-L0 的 Mock 分支对照保持独立，不能代表 DeepSeek 的研究能力。

## 交付文件

- [恢复和 Provider 合同](PROTOCOL.md)
- [独立审查与失败记录](AUDIT.md)
- [首次真实调用的授权准备清单](FIRST_REAL_CALL_AUTHORIZATION.md)
- [历史和迁移边界](history/README.md)
- `validation/`：本地测试日志、故障结果、独立检出核验及原件保护证明；默认不进入 Git。

**IMPLEMENTED**：可移植真实依赖闭包、默认关闭的 DeepSeek 入口、原 Harness/Loop 集成、版本化收据与保守恢复。

**TESTED_OFFLINE**：协议正常及异常响应、权限撤销、预算与共享额度、超时/取消、真实子进程 SIGKILL、收据对账、旧版回归和独立检出复测。

**NOT_PROVEN**：真实模型输出与研究增益、供应商实际 Token 上界、动态价格及外部计费、真实网络和服务端行为、整机回滚/断电一致性、跨运行根目录的账户级全局预算。
