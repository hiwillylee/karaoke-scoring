#!/bin/bash
# 建立本機分析環境：Demucs（音源分離）+ CREPE（音高抽取）+ librosa（訊號處理）
#
# 版本說明：系統 python3 為 3.14（torch 尚無對應 wheel），而 Homebrew 的
# python3.13 在本機為損壞狀態（platform.mac_ver() 回空值），因此改用 uv
# 管理的 CPython 3.12。
set -e
cd "$(dirname "$0")"

if ! command -v uv >/dev/null; then
  echo "找不到 uv，請先安裝：brew install uv"
  exit 1
fi
if ! command -v ffmpeg >/dev/null; then
  echo "找不到 ffmpeg，請先安裝：brew install ffmpeg"
  exit 1
fi

echo "==> 準備 CPython 3.12"
uv python install 3.12

echo "==> 建立 .venv"
uv venv --python 3.12 .venv

echo "==> 安裝依賴（torch 約 2.5GB，第一次會跑一陣子）"
VIRTUAL_ENV="$PWD/.venv" uv pip install torch torchaudio demucs torchcrepe librosa soundfile numpy scipy cryptography segno pykakasi "yt-dlp[default]"

echo "==> 檢查安裝"
.venv/bin/python - <<'PYEOF'
import sys, torch, librosa, torchcrepe  # noqa: F401
import demucs.separate  # noqa: F401
print(f"python {sys.version.split()[0]}")
print(f"torch {torch.__version__}  MPS 可用: {torch.backends.mps.is_available()}")
print(f"librosa {librosa.__version__}")
print("torchcrepe 就緒（音高抽取；沒有它會退回 pyin，八度誤判會變多）")
PYEOF

echo
echo "==> 完成。啟動方式："
echo "    .venv/bin/python server.py"
echo "    然後開 http://localhost:8000"
