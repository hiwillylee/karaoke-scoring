"""下載並產生譜面試聽用的鋼琴取樣（assets/piano/）。

音源：Upright Piano KW（small），FreePats 專案
      https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html#UprightKW
授權：Creative Commons CC0 1.0 公眾領域宣告——可自由散佈、修改，不強制標示。
      （同一頁的 YDP Grand Piano 與 Salamander 是 CC-BY 3.0，需要標示，
        所以沒有選它們。）
錄音：Kawai 直立鋼琴，Gonzalo 與 Roberto 錄製於 2017 年 1 月。

產物已經 commit 進 repo，平常不需要重跑這支腳本；要更新音源或改範圍時才用：

    .venv/bin/python packaging/fetch_piano_samples.py

需要 py7zr（`uv pip install py7zr`）與 ffmpeg。
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "piano"

URL = ("https://freepats.zenvoid.org/Piano/UprightPianoKW/"
       "UprightPianoKW-small-SFZ+FLAC-20190703.7z")

# 只取人聲音域用得到的部分。取樣每 3 個半音一個，所以播放時最多只需拉伸
# ±1.5 個半音，聽不出變調感。
MIDI_LO, MIDI_HI = 42, 90
# 裁掉尾巴：原始取樣是完整的自然衰減（最長近 5 秒），但譜面試聽不需要那麼長，
# 而且音符密集時尾音疊在一起反而聽不清楚音高。
MAX_SECONDS = 3.0
FADE_SECONDS = 0.35


def main() -> None:
    if shutil.which("ffmpeg") is None:
        sys.exit("找不到 ffmpeg")
    try:
        import py7zr
    except ImportError:
        sys.exit("需要 py7zr：VIRTUAL_ENV=.venv uv pip install py7zr")

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        archive = tmp / "piano.7z"
        print(f"下載 {URL}")
        urllib.request.urlretrieve(URL, archive)

        with py7zr.SevenZipFile(archive) as z:
            z.extractall(tmp)
        src = next(tmp.glob("UprightPianoKW-small-*"))

        sfz = next(src.glob("*.sfz")).read_text()
        OUT.mkdir(parents=True, exist_ok=True)
        for old in OUT.glob("*.flac"):
            old.unlink()

        kept = []
        for region in sfz.split("<region>")[1:]:
            def field(key: str) -> str | None:
                m = re.search(rf"{key}=(\S+)", region)
                return m.group(1) if m else None

            sample, keycenter = field("sample"), field("pitch_keycenter")
            if not sample or not keycenter:
                continue
            midi = int(keycenter)
            if not (MIDI_LO <= midi <= MIDI_HI):
                continue

            dst = OUT / f"{midi}.flac"
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src / sample),
                 "-t", str(MAX_SECONDS),
                 "-af", f"afade=t=out:st={MAX_SECONDS - FADE_SECONDS}:d={FADE_SECONDS}",
                 "-ac", "1",          # 單聲道就夠了，體積少一半
                 str(dst)],
                check=True,
            )
            kept.append(midi)

        kept.sort()
        (OUT / "manifest.json").write_text(json.dumps({
            "source": "FreePats — Upright Piano KW (small)",
            "url": "https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html#UprightKW",
            "license": "CC0 1.0",
            "midi": kept,
        }, ensure_ascii=False, indent=2), encoding="utf-8")

        total = sum(f.stat().st_size for f in OUT.glob("*.flac"))
        print(f"完成：{len(kept)} 個取樣（midi {kept[0]}~{kept[-1]}），共 {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
