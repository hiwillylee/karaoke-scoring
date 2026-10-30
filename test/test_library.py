"""曲庫與網址處理的驗證（不需要網路）。

執行：.venv/bin/python test/test_library.py
"""
import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import fetcher  # noqa: E402
import library  # noqa: E402

PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"  {'✓' if ok else '✗'} {name}{('  → ' + detail) if detail else ''}")


def main():
    tmp = Path(tempfile.mkdtemp())
    try:
        print("\n[1] 網址判別")
        cases = [
            ("https://www.youtube.com/watch?v=abc", "youtube"),
            ("https://youtu.be/abc", "youtube"),
            ("https://music.youtube.com/watch?v=abc", "youtube_music"),
            ("https://www.bilibili.com/video/BV1xx", "bilibili"),
            ("https://b23.tv/abcd", "bilibili"),
            ("https://example.com/song.mp3", None),
            ("https://notyoutube.com.evil.com/x", None),
        ]
        for url, expect in cases:
            got = fetcher.platform_of(url)
            key = got[0] if got else None
            check(f"{url[:42]:42} → {expect}", key == expect, f"實得 {key}")

        check("非網址不會被當成網址", not fetcher.looks_like_url("サクラキミワタシ"))
        check("網址會被認出來", fetcher.looks_like_url(" https://youtu.be/x "))

        print("\n[2] 來源 ID：同一首歌的不同網址要一致")
        a = fetcher.source_id_of({"extractor_key": "Youtube", "id": "rpVvPAFaoqM"})
        b = fetcher.source_id_of({"extractor_key": "Youtube", "id": "rpVvPAFaoqM"})
        c = fetcher.source_id_of({"extractor_key": "BiliBili", "id": "BV1xx"})
        check("YouTube 與 YT Music 正規化後相同", a == b, a)
        check("不同平台不會撞號", a != c, f"{a} vs {c}")

        print("\n[2b] Bilibili 分 P 標題清理")
        title_cases = [
            ("20世纪民谣《阳光彩虹小白马》 p01 阳光彩虹小白马", "20世纪民谣《阳光彩虹小白马》"),
            ("阳光彩虹小白马 p01 20世纪民谣《阳光彩虹小白马》", "阳光彩虹小白马"),
            ("演唱會合集 p03 第三首別的歌", "演唱會合集 - 第三首別的歌"),
            ("tuki.『サクラキミワタシ』Official Music Video",
             "tuki.『サクラキミワタシ』Official Music Video"),
            ("", ""),
        ]
        for raw, want in title_cases:
            got = fetcher.clean_title(raw)
            check(f"標題清理 {raw[:24]!r}", got == want, f"實得 {got!r}")

        print("\n[3] 曲庫存取")
        lib = library.Library(tmp / "library")
        chart = {"durationMs": 1000, "notes": [{"startMs": 0, "endMs": 500, "midi": 60}],
                 "techniques": [], "hopMs": 16, "frames": {"midi": [], "conf": [], "rms": []}}
        src = tmp / "a.m4a"
        src.write_bytes(b"fake audio")

        meta = lib.add("abc123def456", "サクラキミワタシ", chart, src, src,
                       source="YouTube", sourceId="Youtube:rpVvPAFaoqM")
        check("加入後查得到", lib.meta("abc123def456") is not None)
        check("音符數有記錄", meta["notes"] == 1, str(meta["notes"]))
        check("依來源找得到", lib.find_by_source("Youtube:rpVvPAFaoqM") is not None)
        check("來源不同就找不到", lib.find_by_source("Youtube:other") is None)

        print("\n[4] 歌名搜尋")
        lib.add("def456abc789", "YOASOBI 群青", chart, src, None)
        check("日文片段搜得到", len(lib.search("サクラ")) == 1)
        check("英數不分大小寫", len(lib.search("yoasobi")) == 1)
        check("全形半形視為相同", len(lib.search("ＹＯＡＳＯＢＩ")) == 1)
        check("查無結果回空", len(lib.search("不存在")) == 0)
        check("空字串回全部", len(lib.search("")) == 2)

        print("\n[5] 路徑安全")
        for bad in ["../../etc/passwd", "..", "a/b", "", "ABC123DEF456", "x" * 40]:
            check(f"拒絕可疑 ID {bad[:18]!r}", lib.dir_of(bad) is None)
        check("正常 ID 可用", lib.dir_of("abc123def456") is not None)

        print("\n[6] 設定與刪除")
        lib.update_settings("abc123def456", {"octaveOffset": 1, "minLevelDb": -30, "亂塞": 1})
        m = lib.meta("abc123def456")
        check("設定有存下來", m["octaveOffset"] == 1 and m["minLevelDb"] == -30)
        check("不認識的欄位不會被寫入", "亂塞" not in m)
        check("刪除成功", lib.delete("abc123def456"))
        check("刪除後查不到", lib.meta("abc123def456") is None)
        check("剩下的歌還在", len(lib.list()) == 1)

        print(f"\n{'=' * 46}")
        print(f"通過 {len(PASS)}　失敗 {len(FAIL)}")
        for f in FAIL:
            print(f"  失敗：{f}")
        return 1 if FAIL else 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
