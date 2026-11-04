"""test_lyrics.py — 歌詞模組的離線測試（不連網）。

    .venv/bin/python test/test_lyrics.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import lyrics  # noqa: E402

passed = failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ✓ {name}")
    else:
        failed += 1
        print(f"  ✗ {name}  {detail}")


print("LRC 解析")
lines = lyrics.parse_lrc("[ti:x]\n[00:01.00]一\n[00:03.50][00:10.00]副歌\n[00:05.00]二\n[00:05.00](translation)\n")
check("標頭略過、重複時間標籤展開、依時間排序",
      [l["text"] for l in lines] == ["一", "副歌", "二", "副歌"], lines)
check("結束時間取下一行開始", lines[0]["e"] == 3500)
check("同時間夾帶的翻譯行去掉", all("translation" not in l["text"] for l in lines))
enh = lyrics.parse_lrc("[00:10.00]<00:10.00>夜<00:10.40>に<00:11.00>\n")
check("Enhanced LRC 逐字時間", enh[0]["text"] == "夜に" and enh[0]["ct"] == [10000, 10400, 10400, 11000], enh)

print("羅馬拼音版判斷")
check("日文羅馬拼音", lyrics.looks_romaji("kimi no namae wo yonda yoru ni kakeru sora wo miage te nakanai de"))
check("英文歌不算", not lyrics.looks_romaji("I wanna hold your hand and never let it go tonight because you are mine"))

print("歌名歌手")
check("【】裡是歌名", lyrics.guess_title_artist("周杰倫 Jay Chou【七里香】Official MV", "周杰倫 Jay Chou")[0] == "七里香")
check("歌手 - 歌名", lyrics.guess_title_artist("YOASOBI - 夜に駆ける", "Ayase / YOASOBI") == ("夜に駆ける", "YOASOBI"))
check("歌名 - 羅馬拼音", lyrics.guess_title_artist("晩餐歌 - Bansanka", "tuki.")[0] == "晩餐歌")
check("去掉 Topic", lyrics.guess_title_artist("向日葵", "Ado - Topic")[1] == "Ado")

print("振假名")
check("送り仮名不重複標", lyrics.furigana("食べる", "たべる") == [["食", "た"], ["べる", None]])
check("漢字夾假名", lyrics.furigana("取り戻す", "とりもどす") == [["取", "と"], ["り", None], ["戻", "もど"], ["す", None]])
ruby, roma = lyrics.annotate_japanese("君の名前を呼んだ")
check("歌詞讀音修正（君＝きみ）", ruby[0] == ["君", "きみ"], ruby)
check("助詞を＝o", " o " in f" {roma} ", roma)
check("助詞は＝wa", lyrics.annotate_japanese("僕は")[1] == "boku wa")
check("日文判斷：純漢字的中文歌不算", not lyrics.looks_japanese("窗外的麻雀在電線桿上多嘴妳說這一句很有夏天的感覺"))

print("逐字時間對齊")
ours = [{"text": "夜に駆ける", "s": 1000, "e": 3000}, {"text": "沈むように", "s": 3000, "e": 5000}]
src = [{"s": 1000, "chunks": [("夜", 1000, 300), ("に", 1300, 200), ("駆", 1500, 300), ("け", 1800, 200), ("る", 2000, 400)]},
       {"s": 3000, "chunks": [("しずむ", 3000, 600), ("よ", 3600, 200), ("う", 3800, 200), ("に", 4000, 300)]}]
r = lyrics.align_word_timing(ours, src, True)
check("字面對得上的句子有逐字時間", r is not None and r["lines"][0]["ct"][:2] == [1000, 1300], r and r["lines"][0])
check("每字一組 [開始, 結束]", r is not None and len(r["lines"][0]["ct"]) == 2 * len("夜に駆ける"))
ct2 = r["lines"][1].get("ct") if r else None
check("沒對到的字（沈 vs しず）依前後內插", ct2 is not None and ct2[0] < ct2[1] <= ct2[2], ct2)
shifted = [{"s": l["s"] + 2500, "chunks": [(t, s + 2500, d) for t, s, d in l["chunks"]]} for l in src * 3]
check("差距不一致的來源不採用", lyrics.align_word_timing(ours, shifted[:2], True) is None)
check("完全不同的歌詞不採用",
      lyrics.align_word_timing(ours, [{"s": 0, "chunks": [("全然違う歌", 0, 1000)]}], True) is None)

print("純文字套時間軸")
applied = lyrics.apply_timing(["夜に駆ける", "沈むように", "溶けてゆくように"],
                              [{"text": "夜に駆ける", "s": 1000, "e": 2000}, {"text": "沈むように", "s": 2000, "e": 3000},
                               {"text": "溶けてゆくように", "s": 3000, "e": 4000}])
check("行內容相符時套用", applied is not None and [l["s"] for l in applied] == [1000, 2000, 3000])

print("SSRF 防護")
for host in ("127.0.0.1", "localhost", "192.168.1.1"):
    try:
        lyrics._ensure_public_host(host)
        check(f"拒絕 {host}", False)
    except lyrics.LyricsError:
        check(f"拒絕 {host}", True)

print(f"\n==============================================\n通過 {passed}　失敗 {failed}")
sys.exit(1 if failed else 0)
