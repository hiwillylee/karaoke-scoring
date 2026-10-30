"""後端 DSP 驗證：音高抽取、note 切段、技巧偵測。

以合成訊號（已知音高、已知技巧）餵進 analyze.py 的函式，斷言結果。
不經過 Demucs —— 分離品質另以真實歌曲人耳驗收。

執行：.venv/bin/python test/test_analyze.py
"""
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import analyze as A  # noqa: E402

SR = 44100
PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"  {'✓' if ok else '✗'} {name}{('  → ' + detail) if detail else ''}")


def tone(midi_curve, dur, sr=SR):
    """依 midi 曲線（函式 of t）合成帶泛音的音，模擬人聲。"""
    t = np.arange(int(sr * dur)) / sr
    f = 440 * 2 ** ((midi_curve(t) - 69) / 12)
    ph = 2 * np.pi * np.cumsum(f) / sr
    env = np.minimum(1, t * 30) * np.minimum(1, (dur - t) * 30)
    return env * (0.6 * np.sin(ph) + 0.25 * np.sin(2 * ph) + 0.1 * np.sin(3 * ph))


def build(segments, gap=0.25):
    """segments: [(midi_curve_fn, duration)]；音與音之間插入靜音。"""
    parts, marks, cursor = [], [], 0.0
    for fn, dur in segments:
        parts.append(np.zeros(int(SR * gap)))
        cursor += gap
        marks.append(cursor * 1000)
        parts.append(tone(fn, dur))
        cursor += dur
    parts.append(np.zeros(int(SR * gap)))
    return np.concatenate(parts), marks


def analyze_signal(sig, tmp: Path):
    sf.write(tmp, sig, SR)
    frames = A.extract_frames(tmp, lambda *_: None)
    notes = A.frames_to_notes(frames)
    tech = A.detect_techniques(notes, frames)
    return frames, notes, tech


def main():
    tmp_dir = Path(__file__).resolve().parent.parent / "work"
    tmp_dir.mkdir(exist_ok=True)
    tmp = tmp_dir / "_dsp_test.wav"

    print("\n[1] 音高準確度與 note 切段")
    targets = [60, 64, 67, 72]  # C4 E4 G4 C5
    sig, marks = build([(lambda t, m=m: np.full_like(t, m), 1.0) for m in targets])
    frames, notes, tech = analyze_signal(sig, tmp)

    check("切出 4 個 note", len(notes) == 4, f"實得 {len(notes)}")
    if len(notes) == 4:
        errs = [abs(n["midi"] - m) * 100 for n, m in zip(notes, targets)]
        check("每個 note 音高誤差 < 20 cents", max(errs) < 20,
              "誤差 " + ", ".join(f"{e:.1f}" for e in errs) + " cents")
        onset_errs = [abs(n["startMs"] - mk) for n, mk in zip(notes, marks)]
        check("起音時間誤差 < 60ms", max(onset_errs) < 60,
              "誤差 " + ", ".join(f"{e:.0f}" for e in onset_errs) + " ms")
    check("純長音不應誤判技巧", len(tech) == 0, f"誤判 {[e['type'] for e in tech]}")

    print("\n[2] ビブラート：5.5Hz、±35 cents")
    sig, _ = build([
        (lambda t: np.full_like(t, 62.0), 1.2),
        (lambda t: 67.0 + 0.35 * np.sin(2 * np.pi * 5.5 * t), 1.6),
    ])
    _, notes, tech = analyze_signal(sig, tmp)
    vib = [e for e in tech if e["type"] == "vibrato"]
    check("偵測到 1 次ビブラート", len(vib) == 1, f"實得 {len(vib)}")
    if vib:
        rate = vib[0]["detail"]["rateHz"]
        depth = vib[0]["detail"]["depthCents"]
        check("顫音速度接近 5.5Hz", abs(rate - 5.5) < 1.2, f"{rate}Hz")
        check("顫音深度接近 35 cents", abs(depth - 35) < 18, f"{depth} cents")
        check("顫音落在第 2 個 note", vib[0]["noteIndex"] == 1, f"index={vib[0]['noteIndex']}")
    check("平穩的第 1 個 note 未被誤判",
          not any(e["noteIndex"] == 0 for e in tech))

    print("\n[3] しゃくり：由下方 120 cents 滑上目標")
    def shakuri(t):
        rise = np.clip(t / 0.15, 0, 1)
        return 65.0 - 1.2 * (1 - rise)
    sig, _ = build([(shakuri, 1.0)])
    _, notes, tech = analyze_signal(sig, tmp)
    check("偵測到しゃくり", any(e["type"] == "shakuri" for e in tech),
          f"實得 {[e['type'] for e in tech]}")

    print("\n[4] フォール：尾音下滑 150 cents")
    def fall(t):
        drop = np.clip((t - 0.85) / 0.15, 0, 1)
        return 65.0 - 1.5 * drop
    sig, _ = build([(fall, 1.0)])
    _, notes, tech = analyze_signal(sig, tmp)
    check("偵測到フォール", any(e["type"] == "fall" for e in tech),
          f"實得 {[e['type'] for e in tech]}")

    print("\n[5] 八度跳修正")
    raw = np.array([60.0, 60.1, 72.05, 60.0, 59.9, 48.1, 60.0])
    fixed = A.fix_octave_jumps(raw)
    check("八度離群值被拉回", max(abs(fixed - 60.0)) < 0.3,
          np.array2string(fixed, precision=2))

    # 真的飆上高八度並唱一陣子，不可以被當成誤判壓回去
    leap = np.array([60.0, 60.1, 59.9, 60.0] + [72.0] * 20 + [72.1, 71.9])
    fixed_leap = A.fix_octave_jumps(leap)
    check("真的跳高八度不被壓回低八度", max(abs(fixed_leap[4:] - 72.0)) < 0.3,
          f"高音段最大偏差 {max(abs(fixed_leap[4:] - 72.0)):.2f} 半音")

    tmp.unlink(missing_ok=True)
    print(f"\n{'=' * 46}")
    print(f"通過 {len(PASS)}　失敗 {len(FAIL)}")
    if FAIL:
        for f in FAIL:
            print(f"  失敗：{f}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
