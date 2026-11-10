"""repair_charts.py — 用已存在的人聲軌重建曲庫裡的參考譜。

適用於「分析流程改了，但不想重跑 Demucs」的情況：Demucs 分離出來的
vocals.m4a 已經存在曲庫裡，音高抽取與後處理可以直接拿它重跑一次。

會先把原本的 chart.json 備份成 chart.json.bak。

用法：
    .venv/bin/python repair_charts.py            # 全部
    .venv/bin/python repair_charts.py <資料夾名>  # 指定一首
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

import analyze as A

ROOT = Path(__file__).resolve().parent
LIBRARY = ROOT / "library"


def decode(src: Path, dst: Path) -> Path:
    """m4a → wav。librosa 讀不了 AAC，得先過 ffmpeg。"""
    subprocess.run(
        [A.ffmpeg_bin(), "-y", "-loglevel", "error", "-i", str(src),
         "-ar", str(A.ANALYSIS_SR), "-ac", "1", str(dst)],
        check=True,
    )
    return dst


def rebuild(song_dir: Path) -> dict:
    vocals = song_dir / "vocals.m4a"
    if not vocals.exists():
        raise FileNotFoundError(f"{song_dir.name} 沒有 vocals.m4a，只能重跑完整分析")

    with tempfile.TemporaryDirectory() as tmp:
        wav = decode(vocals, Path(tmp) / "vocals.wav")
        frames = A.extract_frames(wav, lambda *_: None)

    prepared = A.prepare_frames(frames)
    notes = A.frames_to_notes(prepared)
    techniques = A.detect_techniques(notes, prepared)
    return {
        "hopMs": frames["hopMs"],
        "durationMs": round(frames["durationMs"], 1),
        "frames": {
            "midi": [round(float(v), 3) for v in frames["midi"]],
            "conf": [round(float(v), 3) for v in frames["conf"]],
            "rms": [round(float(v), 4) for v in frames["rms"]],
        },
        "notes": notes,
        "techniques": techniques,
    }


def main() -> None:
    targets = sys.argv[1:]
    dirs = [d for d in sorted(LIBRARY.iterdir()) if d.is_dir()]
    if targets:
        dirs = [d for d in dirs if d.name in targets]
    if not dirs:
        print("曲庫裡沒有符合的歌曲")
        raise SystemExit(1)

    for d in dirs:
        meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
        name = meta.get("name") or d.name
        old = json.loads((d / "chart.json").read_text(encoding="utf-8"))
        print(f"\n=== {name} ({d.name}) ===", flush=True)

        started = time.time()
        new = rebuild(d)

        om = [n["midi"] for n in old["notes"]]
        nm = [n["midi"] for n in new["notes"]]
        print(f"  note 數  {len(om)} → {len(nm)}")
        print(f"  音域     {min(om):.1f}~{max(om):.1f} → {min(nm):.1f}~{max(nm):.1f}")

        # 逐音框比對，看有多少被拉低了八度
        oldf = np.array(old["frames"]["midi"])
        newf = np.array(new["frames"]["midi"])
        k = min(len(oldf), len(newf))
        both = (oldf[:k] > 0) & (newf[:k] > 0)
        dropped = both & (np.abs(oldf[:k] - newf[:k] - 12) < 1.5)
        print(f"  修正八度 {int(dropped.sum())} / {int(both.sum())} 框"
              f"（{dropped.sum() / max(1, both.sum()) * 100:.1f}%）")

        bak = d / "chart.json.bak"
        if not bak.exists():
            bak.write_text(json.dumps(old, ensure_ascii=False), encoding="utf-8")
            print(f"  已備份 → {bak.name}")
        (d / "chart.json").write_text(json.dumps(new, ensure_ascii=False), encoding="utf-8")

        # meta 的 notes／techniques 存的是「數量」給曲庫列表顯示用，不是陣列
        meta["notes"] = len(new["notes"])
        meta["techniques"] = len(new["techniques"])
        (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        print(f"  完成（{time.time() - started:.0f}s）")


if __name__ == "__main__":
    main()
