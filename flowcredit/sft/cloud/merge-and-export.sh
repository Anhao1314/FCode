#!/usr/bin/env bash
# Merge the QLoRA adapter into its 4-bit base (matching training numerics),
# then export a Q4_K_M GGUF for Ollama.
# ~10-20 min on T4. Output: /root/fcode-sft/out/fcode-qwen3-4b-Q4_K_M.gguf (~2.5 GB)
set -euo pipefail
ROOT=/root/fcode-sft
# shellcheck disable=SC1091
source "$ROOT/.venv/bin/activate"
mkdir -p "$ROOT/out" "$ROOT/llama.cpp"

echo "==> [1/3] merge LoRA -> fp16 (from the 4-bit training base)"
if [ -f "$ROOT/out/merged/config.json" ] && [ -f "$ROOT/out/merged/model.safetensors.index.json" ]; then
  echo "    merged checkpoint exists, skipping"
else
  python "$ROOT/cloud/merge_4bit.py" \
    --base "$ROOT/models/Qwen3-4B-Instruct-2507" \
    --adapter "$ROOT/saves/full" \
    --out "$ROOT/out/merged"
fi

echo "==> [2/3] fetch llama.cpp converter"
if [ ! -f "$ROOT/llama.cpp/convert_hf_to_gguf.py" ]; then
  # github.com is unreliable from this network; use a GitHub mirror with a
  # second mirror as fallback.
  rm -rf "$ROOT/llama.cpp"
  mkdir -p "$ROOT/llama.cpp"
  URL="https://gh-proxy.com/https://github.com/ggml-org/llama.cpp/archive/refs/heads/master.tar.gz"
  curl -L --fail --retry 3 --retry-delay 2 -o "$ROOT/llama.cpp.tar.gz" "$URL" \
    || curl -L --fail --retry 3 --retry-delay 2 -o "$ROOT/llama.cpp.tar.gz" \
      "https://ghproxy.net/https://github.com/ggml-org/llama.cpp/archive/refs/heads/master.tar.gz"
  tar xzf "$ROOT/llama.cpp.tar.gz" -C "$ROOT/llama.cpp" --strip-components=1
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
EOF

echo
echo "done -> $ROOT/out/"
ls -lh "$ROOT/out/"*.gguf "$ROOT/out/Modelfile" 2>/dev/null || true
echo
echo "download to the Mac:"
echo "  scp root@<ip>:$ROOT/out/fcode-qwen3-4b-Q4_K_M.gguf $ROOT/out/Modelfile ."
echo "  ollama create fcode-qwen3-4b -f Modelfile"
