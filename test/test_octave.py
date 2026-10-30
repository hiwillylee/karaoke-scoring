"""八度判斷的回歸測試——用真實錄音，不是合成音。

test_analyze.py 用合成訊號驗證 DSP 的各個環節，那是必要的，但它測不出這個
問題：真實人聲的二次諧波可以比基頻大好幾倍，pyin 會整句鎖在諧波上。那份
測試在 analyze.py 被改壞好幾次的過程中始終全綠。

這裡改用曲庫裡真實的人聲軌，對照人工確認過的標準答案（test/octave_labels.json）。

曲庫是使用者資料、不進版控，所以在別台機器上會因為缺歌而跳過——這是刻意的
取捨：真實音訊的標準答案比合成音有價值得多。

執行：.venv/bin/python test/test_octave.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from octave_common import (  # noqa: E402
    SUSPECT_RATIO, find_song, library_songs, load_chart, load_labels, load_vocals,
    note_at, suspect_rate,
)

PASS, FAIL, SKIP, WARN = [], [], [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"  {'✓' if ok else '✗'} {name}{('  → ' + detail) if detail else ''}")


def warn(name, detail=""):
    WARN.append(name)
    print(f"  ~ {name}{('  → ' + detail) if detail else ''}")


def main():
    labels = load_labels()
    tol = labels.get("toleranceSemitones", 0.6)

    print("[1] 人工確認的八度標準答案")
    for song in labels["songs"]:
        match = song["match"]
        d = find_song(match)
        if d is None:
            SKIP.append(match)
            print(f"  – {match}：不在曲庫，跳過")
            continue

        chart = load_chart(d)
        y, sr = load_vocals(d)
        print(f"  {match}（{d.name}）")

        for pt in song["points"]:
            t_ms, want, strict = pt["tMs"], pt["midi"], pt.get("strict", True)
            note = note_at(chart["notes"], t_ms)
            label = f"{match} {t_ms / 1000:.1f}s 應為 midi {want}"

            if note is None:
                detail = "此處沒有 note（可能被信心值或音量門檻濾掉）"
                (check(label, False, detail) if strict else warn(label, detail))
                continue

            diff = abs(note["midi"] - want)
            detail = f"實際 {note['midi']:.2f}，差 {diff:.2f} 半音"
            if abs(diff - 12) < 1.5:
                detail += "（正好差一個八度）"
            if strict:
                check(label, diff < tol, detail)
            elif diff < tol:
                print(f"  ✓ {label}  → {detail}（參考用，正確值未確認）")
            else:
                warn(label, detail + "（正確值未確認，不計成敗）")

    print()
    print(f"[2] 全曲可疑率（奇/偶諧波比 < {SUSPECT_RATIO} 的 note 佔比）")
    print("    這是趨勢指標，不斷言成敗。乾淨的譜約 1~2.5%。")
    for d in library_songs():
        name = json.loads((d / "meta.json").read_text(encoding="utf-8")).get("name") or d.name
        chart = load_chart(d)
        y, sr = load_vocals(d)
        bad, total = suspect_rate(y, sr, chart["notes"])
        if not total:
            continue
        print(f"    {name[:32]:34s} {bad:3d}/{total:3d}  {bad / total * 100:5.1f}%")

    print()
    print("=" * 46)
    line = f"通過 {len(PASS)}　失敗 {len(FAIL)}"
    if WARN:
        line += f"　待確認 {len(WARN)}"
    if SKIP:
        line += f"　跳過 {len(SKIP)}"
    print(line)
    if not PASS and not FAIL:
        print("（曲庫裡沒有任何被標記的歌曲，這份測試沒有實際驗證到東西）")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
