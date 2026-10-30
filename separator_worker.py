"""separator_worker.py — 常駐的 Demucs 工作行程。

為什麼要常駐：實測一首 3 分鐘的歌，GPU 真正在推論只有約 5 秒，但「匯入
torch＋載入 htdemucs 權重」要花約 8 秒。以前每首歌都開一個新的 Python 行程
跑 `python -m demucs`，等於每首都重付一次這 8 秒。改成常駐之後，只有第一首
要等，後面每首直接省下。

仍然用獨立行程而不是塞進伺服器行程裡，是為了保留隔離性：顯示卡記憶體不足
或後端運算子不支援時，炸掉的是這個行程，伺服器不會跟著倒，還能退回 CPU 重來。

協定：stdin 一行一個 JSON 請求，stdout 一行一個 JSON 回應。
      stderr 留給診斷訊息，由父行程收走寫進記錄檔。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import traceback
from pathlib import Path


def hide_child_windows() -> None:
    """讓這個行程開出去的所有子行程都不要彈出主控台視窗。

    打包後的程式是視窗模式，一旦有人去啟動 ffmpeg.exe、ffprobe.exe 這類主控台
    程式，Windows 就會配一個黑視窗給它，使用者會看到莫名其妙的視窗閃過。

    自己寫的呼叫可以逐一加 creationflags，但 Demucs 讀音檔時是在套件內部自己
    去叫 ffprobe 與 ffmpeg（demucs/audio.py），改不到。所以直接把這個行程的
    Popen 預設值改掉，一次涵蓋所有情況。只影響本行程。
    """
    if os.name != "nt":
        return
    original = subprocess.Popen.__init__

    def patched(self, *args, **kwargs):
        kwargs["creationflags"] = kwargs.get("creationflags", 0) | subprocess.CREATE_NO_WINDOW
        original(self, *args, **kwargs)

    subprocess.Popen.__init__ = patched


def _emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    device = sys.argv[1] if len(sys.argv) > 1 else "cpu"

    hide_child_windows()

    # 必須在 torch 之後、用到裝置之前匯入，才會註冊 privateuseone 後端。
    # 沒裝 torch-directml 的版本（CUDA 版、CPU 版）就跳過。
    try:
        import torch_directml  # noqa: F401
    except Exception:  # noqa: BLE001
        pass

    try:
        from demucs.api import Separator
        from demucs.audio import save_audio
        separator = Separator(model="htdemucs", device=device, progress=False)
        samplerate = separator.samplerate
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        sys.stderr.flush()
        _emit({"ok": False, "fatal": True, "error": f"{type(exc).__name__}: {exc}"})
        return 1

    _emit({"ready": True, "device": device, "samplerate": samplerate})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        if req.get("quit"):
            break

        try:
            started = time.time()
            src = Path(req["input"])
            out = Path(req["outdir"])
            out.mkdir(parents=True, exist_ok=True)

            origin, res = separator.separate_audio_file(src)
            vocals, inst = out / "vocals.wav", out / "no_vocals.wav"
            # 伴奏軌＝原曲減去人聲，跟 demucs CLI 的 --two-stems=vocals 同一種算法
            save_audio(res["vocals"], str(vocals), samplerate=samplerate)
            save_audio(origin - res["vocals"], str(inst), samplerate=samplerate)

            _emit({"ok": True, "vocals": str(vocals), "no_vocals": str(inst),
                   "seconds": round(time.time() - started, 1)})
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc(file=sys.stderr)
            sys.stderr.flush()
            _emit({"ok": False, "error": f"{type(exc).__name__}: {exc}"})

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
