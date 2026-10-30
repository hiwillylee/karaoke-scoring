"""diagnose.py — 診斷某首歌為什麼只抽到少少的音。

逐階段列出音框存活率，並掃描切段參數，指出瓶頸在哪一關。

用法：
    .venv/bin/python test/diagnose.py <歌曲檔案>
    .venv/bin/python test/diagnose.py <歌曲檔案> --no-separate   # 已經是人聲軌
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import analyze as A  # noqa: E402


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    src = Path(sys.argv[1])
    skip_sep = "--no-separate" in sys.argv
    work = A.ROOT / "work" / "_diag"
    work.mkdir(parents=True, exist_ok=True)

    if skip_sep:
        vocals = src
    else:
        print("── 音源分離 ──")
        vocals, _ = A.separate(src, work, lambda m, p: print(f"   {m}"))

    print("\n── 音高抽取 ──")
    fr = A.extract_frames(vocals, lambda m, p: print(f"   {m}"))
    midi, conf = fr["midi"], fr["conf"]
    total = len(midi)
    dur_s = fr["durationMs"] / 1000
    voiced = int((midi > 0).sum())

    print(f"\n長度 {dur_s / 60:.0f}:{dur_s % 60:04.1f}　音框 {total}（每框 {fr['hopMs']}ms）")
    print(f"pyin 判定有音：{voiced} 框（{voiced / total * 100:.1f}%）")

    live = conf[midi > 0]
    if len(live):
        qs = np.percentile(live, [10, 25, 50, 75, 90])
        print("有音框的 voiced_prob 分佈：" +
              "　".join(f"P{p}={v:.2f}" for p, v in zip([10, 25, 50, 75, 90], qs)))
    for thr in (0.3, 0.5, 0.6, 0.75, 0.9):
        n = int((conf >= thr).sum())
        print(f"   conf >= {thr:<4} → {n:6d} 框（{n / total * 100:5.1f}%）")

    print("\n── 切段參數掃描（目前設定："
          f"conf>={A.PARAMS['pitch']['minConfidence']}, "
          f"最短{A.PARAMS['pitch']['minNoteDurationMs']}ms, "
          f"斷點{A.PARAMS['pitch']['maxGapMs']}ms）──")
    base = dict(A.PARAMS["pitch"])
    print(f"{'minConf':>8}{'最短ms':>8}{'斷點ms':>8}{'音數':>8}{'音/秒':>8}{'中位長度ms':>12}")
    for mc in (0.75, 0.6, 0.5, 0.35):
        for min_dur in (120, 90, 70):
            for gap in (60, 100):
                A.PARAMS["pitch"]["minNoteDurationMs"] = min_dur
                A.PARAMS["pitch"]["maxGapMs"] = gap
                notes = A.frames_to_notes(fr, min_confidence=mc)
                if not notes:
                    continue
                lens = [n["endMs"] - n["startMs"] for n in notes]
                mark = "  ←目前" if (mc == base["minConfidence"]
                                    and min_dur == base["minNoteDurationMs"]
                                    and gap == base["maxGapMs"]) else ""
                print(f"{mc:>8}{min_dur:>8}{gap:>8}{len(notes):>8}"
                      f"{len(notes) / dur_s:>8.2f}{np.median(lens):>12.0f}{mark}")
    A.PARAMS["pitch"].update(base)

    print("\n參考：一般流行歌大約 1.5～3.5 音／秒；低於 1 通常代表有音框被過度過濾。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
