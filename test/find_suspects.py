"""列出曲庫裡最可疑的音符，方便人工確認後補進 octave_labels.json。

標準答案是這類問題唯一可靠的立足點，但人工確認很花時間，所以先把最可疑的
挑出來——照奇/偶諧波比排序，比值愈低愈可能是低了一個八度。

用法：
    .venv/bin/python test/find_suspects.py              # 每首列前 10 個
    .venv/bin/python test/find_suspects.py 七里香         # 只看某一首
    .venv/bin/python test/find_suspects.py 七里香 30      # 列前 30 個

確認的方式：開 http://localhost:8000，在譜面確認畫面把時間軸拉到該秒數，
聽原唱、看音程條落在哪。確認後把時間點與正確音高填進 test/octave_labels.json。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from octave_common import (  # noqa: E402
    SUSPECT_RATIO, library_songs, load_chart, load_vocals, note_ratio, song_name,
)


def main():
    args = [a for a in sys.argv[1:]]
    limit = 10
    match = None
    for a in args:
        if a.isdigit():
            limit = int(a)
        else:
            match = a

    songs = [d for d in library_songs() if match is None or match in song_name(d)]
    if not songs:
        print("曲庫裡沒有符合的歌曲")
        return 1

    for d in songs:
        name = song_name(d)
        chart = load_chart(d)
        y, sr = load_vocals(d)
        rows = []
        for n in chart["notes"]:
            r = note_ratio(y, sr, n)
            if r is not None:
                rows.append((r, n))
        rows.sort(key=lambda x: x[0])
        bad = sum(1 for r, _ in rows if r < SUSPECT_RATIO)

        print(f"\n=== {name} ===")
        print(f"    {bad}/{len(rows)} 個 note 疑似低八度（{bad / max(1, len(rows)) * 100:.1f}%）")
        print(f"    {'秒數':>8} {'目前 midi':>10} {'奇/偶比':>8}   建議")
        for r, n in rows[:limit]:
            hint = f"→ {n['midi'] + 12:.1f}" if r < SUSPECT_RATIO else "（比值不算低）"
            print(f"    {n['startMs'] / 1000:8.1f} {n['midi']:10.2f} {r:8.3f}   {hint}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
