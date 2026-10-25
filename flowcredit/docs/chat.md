# Chat：可流式回答的对话面

FCode 现在有两种模型交互，边界是刻意画清的：

| | 对话（Chat） | 委托运行（Delegation） |
| --- | --- | --- |
| 模型输出 | 可读文本（流式） | 一个受门控的工具动作/计划 |
| 是否执行工具 | **不执行** | 执行，逐次过门控、预算、审批 |
| 结果 | 回答、追问、重生成、编辑 | 文件/报告 + 独立重算 |
| 审计 | 每次调用扣预算、进事件链、签收据 | 完整 trace + 哈希链 + 收据 |
| 入口 | 侧栏「新对话」、首页输入框 | 侧栏「委托运行」、首页模板 chips |

需要执行的对话，用消息上的「转为委托」交接给受治理的运行；对话本身不碰工具注册表，
因此不存在“聊天绕过门控”的路径。

## 能力

- **流式回答**：SSE 逐段渲染，Markdown（标题/列表/引用/代码围栏/行内代码/链接）。
- **追问**：同一线程保留活跃分支，模型看到完整历史（受 `CHAT_HISTORY_MESSAGES` 限制）。
- **重新生成**：追加 `chat_regenerate` 事件，旧回答被 supersede，事件链不删。
- **编辑上一条**：追加 `chat_edit` 事件，编辑点之后的旧分支全部 supersede。
- **文本附件**：最多 3 个、每个 ≤64 KiB、总计 ≤128 KiB；内容折进用户消息，事件链保留原文。
- **停止生成**：中断 fetch，服务端把已生成的部分记成 `chat_cancelled`，UI 显示“已停止生成”。
- **线程持久化**：线程与消息在 `chat.sqlite` 的 `task`/`event` 表里，重启后可从侧栏继续。
- **分页与归档**：侧栏按 `updated_at` 分页加载；删除是 tombstone（`chat_thread_meta.archived`），
  事件链、收据和直接按 id 读取都不受影响。

## 治理

对话没有工具，所以不走 `Permissions.gate` / verifier；但**模型调用本身仍然受治理**：

- 发送前用 `Budget.charge_call` 预留 tokens/cost；预算耗尽返回 `BUDGET_EXCEEDED`，不重试。
- 每次回答写一个 `chat_assistant` 事件，进入与运行相同的 SHA-256 事件链。
- 每次成功回答签一条 HMAC 收据；`external_billing` 仍是 `not-verified`。
- 事件链只追加；编辑/重生成通过 supersede 事件表达，不改写历史。

## 服务端

- `flowagent/chat.py`：`ChatService`——线程、预算、事件投影与取消。
- `flowagent/chat_config.py`：设置 > 环境 > 默认的 provider 解析、价格校验、本地配置文件。
- `flowagent/chat_provider.py`：mock 与 OpenAI 兼容流式客户端（SSE 分帧、错误分类）。
- `POST /api/chat/send`：`{threadId?, text, attachments?, model}` → SSE。
- `POST /api/chat/threads/{id}/edit`：`{messageId, text, attachments?, model}` → SSE。
- `POST /api/chat/threads/{id}/regenerate`：`{messageId, model?}` → SSE。
- `GET /api/chat/threads?limit=50&offset=0`：线程分页，返回 `threads` / `total`。
- `GET /api/chat/threads/{id}`：完整线程（直接审计仍可用）。
- `DELETE /api/chat/threads/{id}`：**归档**而不是删除事件。侧栏隐藏，事件链与收据保留；
  需要彻底清理时由操作者直接处理本地数据库。

流式事件：`start` / `wait` / `reasoning` / `delta` / `done` / `error`。客户端断开时
`_stream_chat` 关闭生成器，服务端在 `finally` 里落 `chat_cancelled`。
本地服务默认只绑定回环地址；监听非回环地址时必须同时给出 `--token`，否则拒绝启动。

Provider：

| key | 配置 | 价格 |
| --- | --- | --- |
| `mock` | 无 | 0 |
| `kimi` | `KIMI_API_KEY`、`KIMI_MODEL`、`KIMI_BASE_URL` | `KIMI_INPUT_PRICE_MICROUSD_PER_MTOK` / `KIMI_OUTPUT_PRICE_MICROUSD_PER_MTOK`（必填） |
| `deepseek` | `DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL`、`DEEPSEEK_BASE_URL` | `DEEPSEEK_INPUT_PRICE_MICROUSD_PER_MTOK` / `DEEPSEEK_OUTPUT_PRICE_MICROUSD_PER_MTOK`（必填） |
| `local` | `FCODE_LOCAL_ENDPOINT`、`FCODE_LOCAL_MODEL` | 0 |

OpenAI 兼容 SSE；Kimi 使用 `max_completion_tokens`，不发送 `temperature`（K2/K3 只接受 1）；
`KIMI_MIN_CALL_INTERVAL_SECONDS` 生效，等待时会向客户端发 `wait` 事件。

## 模型配置（设置页）

设置 → 模型与工具 现在直接配置对话模型：

- **默认对话模型**：mock / Kimi / DeepSeek / 本地，只对未手动选择过的会话生效；
- **Kimi / DeepSeek 卡片**：API Key、模型名、输入/输出价（µUSD/MTok）、最小调用间隔、最大补全 tokens；
- **本地卡片**：OpenAI 兼容端点、模型名、可选 Key。

规则：

- 配置保存在用户配置目录的 `chat-config.json`（macOS: `~/Library/Application Support/FCode/`，
  可用 `FCODE_CONFIG_DIR` 覆盖；**不在 viewer 静态根下**），权限 0600，
  **不进仓库、不进事件链、不出现在任何 API 响应里**（GET 只返回
  `api_key_set` 与 `sk-…后四位`）；
- 优先级：**设置页 > 环境变量 > 默认**；留空保存 = 清除该项回落到环境变量，
  「清除密钥」按钮只清 Key；
- 价格必填且必须为正整数（fail-closed 计费不放松）；Kimi 用
  `max_completion_tokens`、不发 `temperature`；
- **写接口只接受 `application/json`，并拒绝跨站 `Origin`/`Sec-Fetch-Site`**；
  静态服务器对 `chat-config.json` 与 `.sqlite` 一律 404；
- Kimi/DeepSeek 的 `base_url` 不允许从设置/API 覆盖（只认环境变量或内置域名），
  避免一次配置写入把已保存的 key 引到别处；本地模型的端点仍可编辑；
- **当前只作用于对话**；委托运行的 provider 仍由环境变量配置
  （provider 泛化合并后统一）。

API：`GET/POST /api/settings/chat-config`、`GET /api/chat/models`。

## 边界（诚实）

- **对话不调用工具**。这是治理选择，不是能力缺口：要让模型执行，走委托运行。
- **附件只收纯文本**（代码、Markdown、JSON、CSV 等）。图片/PDF/Office 不在 v1；IAB 的文件选择器本身也不支持上传。
- **每线程预算**默认 60 次调用 / 300,000 µUSD / 200,000 tokens；可用 `FCODE_CHAT_MAX_*` 调整。
- **没有图片理解、没有跨线程记忆、没有并行工具调用**。这些仍属于委托/评估那条线。
- **pacing 是进程级、按端点计的**（provider + base URL）；对话与委托运行共享同一张
  预约表，同一个 Kimi 组织 RPM 不会被两条调用路径同时打满。对话首调立即开跑，
  委托运行首调保守等一个间隔。
- 对话回答不可“独立重算”；它的可信性来自模型调用收据与事件链，不来自 verifier。界面不把回答标成“已验证”。

## 验收

```sh
cd flowcredit
python3 viewer/server.py --repo . --port 8643
open 'http://127.0.0.1:8643/?desktop=1'
python3 -m unittest tests.test_chat
node --test viewer/tests/*.test.js
```

聊天里的 Markdown 渲染、SSE 分帧和单条消息渲染是不依赖 DOM 的纯函数，放在
`viewer/core/chat-format.js` 与 `viewer/core/chat-view.js`；`viewer/tests/` 用
Node 内置 test runner 覆盖转义、围栏未闭合、行内格式、多行 `data:` 帧与
消息状态，不需要浏览器或测试框架。

Mock 下可以完整验证流式、追问、重新生成、编辑、附件、停止；真实 Kimi 需要在环境里
配置 API key 与价格快照，然后在模型菜单选择 Kimi。
