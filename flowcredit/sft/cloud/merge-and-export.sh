#!/usr/bin/env bash
# Merge the LoRA adapter into fp16 weights and export a Q4_K_M GGUF for Ollama.
# ~10-20 min on T4. Output: /root/fcode-sft/out/fcode-qwen3-4b-Q4_K_M.gguf (~2.5 GB)
set -euo pipefail
ROOT=/root/fcode-sft
# shellcheck disable=SC1091
source "$ROOT/.venv/bin/activate"
mkdir -p "$ROOT/out" "$ROOT/llama.cpp"

cat > "$ROOT/cloud/merge_lora.yaml" <<'YAML'
model_name_or_path: /root/fcode-sft/models/Qwen3-4B-Instruct-2507
adapter_name_or_path: /root/fcode-sft/saves/full
template: qwen3
finetuning_type: lora
export_dir: /root/fcode-sft/out/merged
export_size: 4
export_device: cpu
export_legacy_format: false
YAML

echo "==> [1/3] merge LoRA -> fp16"
llamafactory-cli export "$ROOT/cloud/merge_lora.yaml"

echo "==> [2/3] fetch llama.cpp converter"
if [ ! -f "$ROOT/llama.cpp/convert_hf_to_gguf.py" ]; then
  git clone --depth 1 https://github.com/ggml-org/llama.cpp "$ROOT/llama.cpp"
fi
pip install -q -i https://mirrors.aliyun.com/pypi/simple/ -r "$ROOT/llama.cpp/requirements/requirements-convert_hf_to_gguf.txt"

echo "==> [3/3] convert + quantize"
python "$ROOT/llama.cpp/convert_hf_to_gguf.py" "$ROOT/out/merged" \
  --outfile "$ROOT/out/fcode-qwen3-4b-f16.gguf" --outtype f16
if [ ! -x "$ROOT/llama.cpp/build/bin/llama-quantize" ]; then
  echo "    building llama-quantize"
  cmake -S "$ROOT/llama.cpp" -B "$ROOT/llama.cpp/build" -DGGML_CUDA=OFF -DLLAMA_CURL=OFF >/dev/null
  cmake --build "$ROOT/llama.cpp/build" --target llama-quantize -j"$(nproc)" >/dev/null
fi
"$ROOT/llama.cpp/build/bin/llama-quantize" \
  "$ROOT/out/fcode-qwen3-4b-f16.gguf" "$ROOT/out/fcode-qwen3-4b-Q4_K_M.gguf" Q4_K_M

cat > "$ROOT/out/Modelfile" <<'EOF'
FROM ./fcode-qwen3-4b-Q4_K_M.gguf
PARAMETER temperature 0
PARAMETER num_ctx 4096
SYSTEM "你是 FCode 运行时内的模型。你只能提议动作，永远不能执行。每次回复输出恰好一个 JSON 对象。"
EOF

echo
echo "done -> $ROOT/out/"
ls -lh "$ROOT/out/"*.gguf "$ROOT/out/Modelfile" 2>/dev/null || true
echo
echo "download to the Mac:"
echo "  scp root@<ip>:$ROOT/out/fcode-qwen3-4b-Q4_K_M.gguf $ROOT/out/Modelfile ."
echo "  ollama create fcode-qwen3-4b -f Modelfile"
