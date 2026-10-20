# FCode SFT 云端训练包（阿里云 T4）

在一台 Ubuntu 22.04 + T4 16GB 的实例上，把 FCode 的哈希链轨迹变成 LoRA 适配器，
再导出为 Ollama 可用的 Q4_K_M GGUF。全程约 ¥100 以内（含冒烟与迭代）。

## 0. 数据已就绪（本机生成）

```
sft/data/train_smoke.jsonl   254 条   （180 条来自真实轨迹 + 74 条生成）
sft/data/train_full.jsonl   2400 条   （180 条来自真实轨迹 + 2220 条生成）
sft/data/stats_*.json        生成统计（prompt_version 与来源计数）
```

重新生成（本机，零依赖）：

```bash
cd flowcredit
PYTHONPATH=src python3 -m flowagent.sft.export \
  --out sft/data/train_full.jsonl \
  --traces "viewer/traces/*.trace.json" "viewer/runs/*/trace.json" \
  --generate 60
```

训练与推理共用同一个渲染器（`flowagent/providers/prompt.py`，`PROMPT_VERSION`
写进每条样本）；`tests/test_sft_export.py` 证明导出的 prompt 与真实运行时逐字节一致。

## 1. 上传到实例

```bash
# 本机执行（替换 <ip>）
scp -r flowcredit/sft/cloud root@<ip>:/root/fcode-sft/
ssh root@<ip> 'mkdir -p /root/fcode-sft/data'
scp flowcredit/sft/data/*.jsonl root@<ip>:/root/fcode-sft/data/
```

## 2. 环境（一次性，约 10 分钟）

```bash
bash /root/fcode-sft/cloud/setup.sh
```

装好 venv、torch（cu12 自带运行时）、LLaMA-Factory、ModelScope，并下载
`Qwen3-4B-Instruct-2507` 权重（ModelScope 内网，几分钟）。

## 3. 冒烟（先做，~¥3）

```bash
bash /root/fcode-sft/cloud/train-smoke.sh
```

验收：loss 在下降、`/root/fcode-sft/saves/smoke` 里有 adapter。链路没通之前别开全量。

## 4. 全量（2.5-4 小时）

```bash
bash /root/fcode-sft/cloud/train-full.sh
```

## 5. 合并 + 导出 GGUF（10-20 分钟）

```bash
bash /root/fcode-sft/cloud/merge-and-export.sh
```

产物：`/root/fcode-sft/out/fcode-qwen3-4b-Q4_K_M.gguf`（~2.5 GB）+ `Modelfile`。

## 6. 回本机，装进 Ollama

```bash
scp root@<ip>:/root/fcode-sft/out/fcode-qwen3-4b-Q4_K_M.gguf .
scp root@<ip>:/root/fcode-sft/out/Modelfile .
ollama create fcode-qwen3-4b -f Modelfile
ollama run fcode-qwen3-4b '{"context": ...}'   # 接 providers/local.py 后由运行时调用
```

然后释放实例（不是停止）。

## 7. 验收 = 运行时本身

训练指标不是验收标准。把适配器接进 `providers/local.py`（骨架已就绪）后：

- 跑 7 个场景，任务到 `succeeded` 且 `trace` 链验证通过才算数；
- 提案 JSON 合法率（`parse_proposal_text` 失败即 `MODEL_OUTCOME_UNKNOWN`，会被如实记账）。

## 常见问题

- **模板报错**：LLaMA-Factory 版本较老时 `template: qwen3` 可能不存在，改用 `template: qwen`。
- **显存 OOM**：保持 `per_device_train_batch_size: 1`，把 `cutoff_len` 从 2048 降到 1536；
  仍不行则 `gradient_accumulation_steps` 加倍、`lora_rank` 降到 8。
- **模型 ID 不存在**：把 `MODEL_ID` 换成 `Qwen/Qwen3-4B`（thinking 版需在推理端
  `/no_think`；本数据集不含思考链，2507 指令版更匹配）。
- **下载慢**：权重走 ModelScope；pip 已用阿里云镜像；GitHub 只用于 llama.cpp，
  若被限速可换 gitee 镜像。
