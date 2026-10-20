#!/usr/bin/env bash
# Build the FCode desktop app.
#
#   bash desktop/build.sh          # macOS: dist/FCode.app / other: dist/FCode/
#   PY=python3.12 bash desktop/build.sh
#
# Requires Python 3.11+ with Tk-free webview support: pywebview uses the
# system WebView (WKWebView on macOS, WebView2 on Windows).
set -euo pipefail

DESKTOP="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DESKTOP")"
PY="${PY:-python3.12}"

cd "$DESKTOP"
if [ ! -d .venv ]; then
  "$PY" -m venv .venv
fi
source .venv/bin/activate
pip install -q -U pip
pip install -q -r requirements.txt

rm -rf build dist _stage
pyinstaller --clean --noconfirm fcode.spec

echo
if [ -d "dist/FCode.app" ]; then
  echo "built: $DESKTOP/dist/FCode.app"
  echo "run:   open \"$DESKTOP/dist/FCode.app\""
else
  echo "built: $DESKTOP/dist/FCode/"
fi
echo "run records: ~/Library/Application Support/FCode/runs (macOS)"
