"""lyrics.py — 同步歌詞：自動抓取、逐字時間（KTV 上色）、日文振假名與羅馬拼音。

移植自「歌詞讀音」App 個人版（../yt music歌詞app 個人版，Kotlin）的歌詞流程：

  1. 句時間：YT Music（InnerTube，ANDROID_MUSIC 的 timedLyricsData）
             → LRCLIB（get／search）
             → YouTube 影片上傳者提供的原文 CC 字幕（IOS client 的 player）
             → YT Music 純文字（沒有時間軸，只能看不能捲）
     使用者也可以自己上傳 .lrc 或貼 LRCLIB 網址。
  2. 逐字時間：Enhanced LRC 的 <mm:ss.xx> 標籤；沒有的話抓酷狗 KRC → 網易雲 YRC，
     逐字 diff 對到我們的歌詞上才採用（避免套到別的版本或翻唱）。
     都沒有時由前端依參考譜的音符估算（這個程式獨有的優勢：每個音的位置都知道）。
  3. 日文：pykakasi 斷詞取讀音，讀音只標在漢字上（送り仮名不重複標），另附羅馬拼音。

全部都是免登入、免金鑰的公開端點，在伺服器這台電腦上呼叫（瀏覽器有 CORS 限制）。
結果存成 library/<歌曲ID>/lyrics.json。

lyrics.json：
    {
      "v": 1, "source": "YT Music（同步）", "note": "...", "synced": true,
      "title": "...", "artist": "...", "wordTiming": "酷狗" | "LRC" | null,
      "japanese": true, "offsetMs": 0, "fetchedAt": 1700000000000, "log": [...],
      "lines": [{"text": "...", "s": 12340, "e": 15600,
                 "ct": [s0, e0, s1, e1, ...],          # 每個字元的 [開始, 結束]，可省略
                 "ruby": [["夜", "よる"], ["に", null]], # 日文才有
                 "romaji": "yoru ni kakeru"}]
    }
"""

from __future__ import annotations

import base64
import difflib
import json
import re
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import zlib

TIMEOUT = 30   # LRCLIB 偶爾要十幾秒才回
USER_AGENT = "KaraokeScoring/1.0 (personal use)"
DURATION_TOLERANCE_MS = 2000


class LyricsError(Exception):
    """抓取／解析失敗；訊息直接顯示給使用者。"""


# ── HTTP ─────────────────────────────────────────────────────────

def _request(url: str, *, data: bytes | None = None, headers: dict | None = None,
             params: dict | None = None) -> bytes:
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
        return res.read()


def _json(url: str, **kw):
    return json.loads(_request(url, **kw).decode("utf-8"))


def find_all(obj, key: str):
    """遞迴找出所有名為 key 的欄位值（InnerTube 回應很深，路徑常變，用找的比寫死路徑穩）。"""
    stack = [obj]
    while stack:
        cur = stack.pop()
        if isinstance(cur, dict):
            for k, v in cur.items():
                if k == key:
                    yield v
                if isinstance(v, (dict, list)):
                    stack.append(v)
        elif isinstance(cur, list):
            stack.extend(reversed(cur))


def runs_text(obj) -> str:
    if not isinstance(obj, dict):
        return ""
    if "simpleText" in obj:
        return obj["simpleText"]
    return "".join(r.get("text", "") for r in obj.get("runs", []))


def _path(obj, *keys):
    for k in keys:
        if not isinstance(obj, dict):
            return None
        obj = obj.get(k)
    return obj


# ── 文字工具 ─────────────────────────────────────────────────────

def is_hiragana(c): return "ぁ" <= c <= "ゟ"
def is_katakana(c): return "ァ" <= c <= "ヿ" or "ㇰ" <= c <= "ㇿ" or "ｦ" <= c <= "ﾟ"
def is_kana(c): return is_hiragana(c) or is_katakana(c)


def is_kanji(c):
    return ("一" <= c <= "鿿" or "㐀" <= c <= "䶿" or "豈" <= c <= "﫿"
            or c in "々〆ヶ〇")


def has_kanji(s): return any(is_kanji(c) for c in s)


def to_hiragana(s: str) -> str:
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in s)


def looks_japanese(text: str) -> bool:
    """整首歌是否為日文：以假名數量判斷（純漢字的歌多半是中文）。"""
    kana = sum(1 for c in text if is_kana(c) and c not in "ー・")
    letters = sum(1 for c in text if c.isalpha())
    return kana >= 10 and kana * 10 >= letters


def normalize(s: str, drop_brackets: bool = False) -> str:
    t = unicodedata.normalize("NFKC", s or "").lower()
    if drop_brackets:
        t = re.sub(r"[(（\[【「『].*?[)）\]】」』]", "", t)
    return "".join(c for c in t if c.isalnum())


def similarity(a: str, b: str) -> float:
    """字元 bigram 的 Dice 係數，0..1。"""
    x, y = normalize(a), normalize(b)
    if not x or not y:
        return 1.0 if x == y else 0.0
    if x == y:
        return 1.0
    if len(x) < 2 or len(y) < 2:
        return 0.5 if (x in y or y in x) else 0.0
    bx: dict[str, int] = {}
    for i in range(len(x) - 1):
        bx[x[i:i + 2]] = bx.get(x[i:i + 2], 0) + 1
    hit = 0
    for i in range(len(y) - 1):
        g = y[i:i + 2]
        if bx.get(g, 0) > 0:
            hit += 1
            bx[g] -= 1
    return 2.0 * hit / (len(x) - 1 + len(y) - 1)


def title_similarity(a: str, b: str) -> float:
    plain = similarity(a, b)
    na, nb = normalize(a, True), normalize(b, True)
    stripped = similarity(na, nb) if na and nb else 0.0
    contains = 0.8 if len(na) >= 2 and len(nb) >= 2 and (na in nb or nb in na) else 0.0
    return max(plain, stripped, contains)


def duration_close(a, b, tol=3000) -> bool:
    return bool(a and b and a > 0 and b > 0 and abs(a - b) <= tol)


NOISE_WORDS = re.compile(
    r"(official\s*(music\s*)?(video|mv|audio|lyric\s*video)|music\s*video|lyric\s*video|"
    r"lyrics?|歌詞|中字|字幕|完整版|高音質|官方|動態歌詞|\bmv\b|\bpv\b|\bhd\b|\b4k\b|"
    r"audio|full\s*ver(sion)?\.?|topic)", re.I)


def guess_title_artist(name: str, uploader: str) -> tuple[str, str]:
    """從影片標題與上傳者猜出歌名／歌手（YouTube 標題五花八門，只求搜得到）。"""
    name = (name or "").strip()
    artist = re.sub(r"\s*-\s*Topic$|VEVO$|\s*(official|channel|官方頻道)\s*$", "",
                    uploader or "", flags=re.I).strip()
    title = name
    m = re.search(r"[【「『《](.+?)[】」』》]", name)
    if m and not NOISE_WORDS.fullmatch(m.group(1).strip()):
        title = m.group(1)
    elif " - " in name or " – " in name:
        left, right = re.split(r"\s+[-–]\s+", name, maxsplit=1)
        cjk = lambda s: any(is_kana(c) or is_kanji(c) or "가" <= c <= "힣" for c in s)  # noqa: E731
        if artist and similarity(right, artist) >= 0.5:
            title = left                       # 「歌名 - 歌手」
        elif artist and similarity(left, artist) >= 0.5:
            title, artist = right, left        # 「歌手 - 歌名」
        elif cjk(left) and not cjk(right) and artist:
            title = left                       # 「晩餐歌 - Bansanka」：右邊是羅馬拼音
        else:
            title, artist = right, left        # 「歌手 - 歌名」最常見
    title = re.sub(r"[(（\[【].*?[)）\]】]", "", title)
    title = NOISE_WORDS.sub("", title)
    title = re.sub(r"\s*(feat\.?|ft\.).*$", "", title, flags=re.I)
    title = title.strip(" -–|/｜・")
    return (title or name), artist


# ── LRC ─────────────────────────────────────────────────────────

TAG = re.compile(r"\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]")
WORD_TAG = re.compile(r"<(\d+):(\d{1,2})(?:[.:](\d{1,3}))?>")


def _tag_ms(m) -> int:
    frac = m.group(3) or ""
    ms = {0: 0, 1: int(frac or 0) * 100, 2: int(frac or 0) * 10}.get(len(frac), int(frac[:3] or 0))
    return int(m.group(1)) * 60000 + int(m.group(2)) * 1000 + ms


def _word_times(body: str, line_start: int):
    """去掉 Enhanced LRC 的 <mm:ss.xx>，回傳 (文字, 逐字時間 [s0,e0,s1,e1…] 或 None)。"""
    tags = list(WORD_TAG.finditer(body))
    if not tags:
        return body.strip(), None
    segs = []
    if tags[0].start() > 0:
        segs.append((line_start, body[:tags[0].start()]))
    for i, m in enumerate(tags):
        end = tags[i + 1].start() if i + 1 < len(tags) else len(body)
        segs.append((_tag_ms(m), body[m.end():end]))
    full = "".join(s for _, s in segs)
    lead = len(full) - len(full.lstrip())
    text = full.strip()
    if not text:
        return "", None
    start = [0] * len(full)
    end = [0] * len(full)
    p = 0
    for i, (t, s) in enumerate(segs):
        letters = max(1, sum(1 for c in s if not c.isspace()))
        nxt = segs[i + 1][0] if i + 1 < len(segs) else t + 250 * letters
        k = 0
        for c in s:
            start[p] = t + (nxt - t) * k // letters
            if c.isspace():
                end[p] = start[p]
            else:
                end[p] = t + (nxt - t) * (k + 1) // letters
                k += 1
            p += 1
    flat = []
    for i in range(lead, lead + len(text)):
        flat += [start[i], end[i]]
    return text, flat


def parse_lrc(lrc: str) -> list[dict]:
    """解析 LRC；同一行多個時間標籤展開成多行，結束時間取下一行的開始。"""
    entries = []
    for raw in lrc.lstrip("﻿").splitlines():
        tags = list(TAG.finditer(raw))
        if not tags or tags[0].start() != 0:
            continue
        text, ct = _word_times(raw[tags[-1].end():], _tag_ms(tags[0]))
        for t in tags:
            entries.append((_tag_ms(t), text, ct if len(tags) == 1 else None))
    entries.sort(key=lambda e: e[0])
    # 同一時間夾帶的翻譯／羅馬拼音行：只留第一行有字的
    kept = []
    for e in entries:
        if kept and kept[-1][0] == e[0]:
            if kept[-1][1].strip():
                continue
            kept[-1] = e
        else:
            kept.append(e)
    out = []
    for i, (s, text, ct) in enumerate(kept):
        line = {"text": text, "s": s, "e": kept[i + 1][0] if i + 1 < len(kept) else None}
        if ct:
            line["ct"] = ct
        out.append(line)
    return out


ROMAJI_WORD = re.compile(r"^(?:(?:[bcdfghjkmnprstvwyz]|sh|ch|ts)?y?[aeiou]+|n|[kstpgdbcm](?=[kstpgdbcm]))+$")


def looks_romaji(text: str) -> bool:
    """日文歌的羅馬拼音版歌詞（LRCLIB 上很常見，不能拿來唱日文）。"""
    if any(is_kana(c) or is_kanji(c) for c in text):
        return False
    words = [w.replace("'", "") for w in re.split(r"[^a-z']+", text.lower())]
    words = [w for w in words if len(w) >= 2]
    if len(words) < 10:
        return False
    return sum(1 for w in words if ROMAJI_WORD.match(w)) >= len(words) * 0.8


# ── YT Music（InnerTube） ─────────────────────────────────────────

INNERTUBE = "https://music.youtube.com/youtubei/v1/"
WEB_REMIX = {
    "clientName": "WEB_REMIX", "clientVersion": "1.20250310.01.00", "id": "67",
    "ua": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "web": True,
}
ANDROID_MUSIC = {
    "clientName": "ANDROID_MUSIC", "clientVersion": "7.27.52", "id": "21",
    "ua": "com.google.android.apps.youtube.music/7.27.52 (Linux; U; Android 11) gzip",
    "extra": {"androidSdkVersion": 30, "osName": "Android", "osVersion": "11"},
}
IOS = {
    "clientName": "IOS", "clientVersion": "20.10.4", "id": "5",
    "ua": "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
    "extra": {"deviceMake": "Apple", "deviceModel": "iPhone16,2", "osName": "iPhone",
              "osVersion": "18.3.2.22D82"},
}
FILTER_SONGS = "EgWKAQIIAWoKEAkQBRAKEAMQBA=="


def innertube(endpoint: str, client: dict, body: dict, base: str = INNERTUBE):
    payload = {"context": {"client": {
        "clientName": client["clientName"], "clientVersion": client["clientVersion"],
        "hl": "ja", "gl": "JP", **client.get("extra", {})}}, **body}
    headers = {
        "Content-Type": "application/json", "User-Agent": client["ua"],
        "X-YouTube-Client-Name": client["id"], "X-YouTube-Client-Version": client["clientVersion"],
    }
    if client.get("web"):
        headers.update(Origin="https://music.youtube.com", Referer="https://music.youtube.com/")
    return _json(base + endpoint + "?prettyPrint=false",
                 data=json.dumps(payload).encode("utf-8"), headers=headers)


def parse_duration(s: str) -> int | None:
    m = re.fullmatch(r"(?:(\d+):)?(\d{1,2}):(\d{2})", (s or "").strip())
    if not m:
        return None
    return ((int(m.group(1) or 0) * 60 + int(m.group(2))) * 60 + int(m.group(3))) * 1000


def yt_track_info(nxt, video_id: str) -> dict:
    """next 回應裡這支影片的歌名、歌手、時長（YT Music 的資料比影片標題乾淨）。"""
    for r in find_all(nxt, "playlistPanelVideoRenderer"):
        if r.get("videoId") != video_id:
            continue
        byline = [x.get("text", "") for x in (r.get("longBylineText") or {}).get("runs", [])]
        artist = byline[0] if byline else ""
        return {"title": runs_text(r.get("title")), "artist": artist,
                "durationMs": parse_duration(runs_text(r.get("lengthText")))}
    return {}


def yt_counterparts(nxt, video_id: str) -> list[str]:
    """MV 對應的「歌曲」版本（或反過來）；MV 通常沒有歌詞 tab，歌曲版本才有。"""
    out = []
    for w in find_all(nxt, "playlistPanelVideoWrapperRenderer"):
        if _path(w, "primaryRenderer", "playlistPanelVideoRenderer", "videoId") != video_id:
            continue
        for c in w.get("counterpart", []):
            vid = _path(c, "counterpartRenderer", "playlistPanelVideoRenderer", "videoId")
            if vid and vid not in out:
                out.append(vid)
    return out


def yt_timed(browse) -> list[dict] | None:
    for data in find_all(browse, "timedLyricsData"):
        lines = []
        for e in data or []:
            text = e.get("lyricLine")
            if text is None:
                continue
            cue = e.get("cueRange") or {}
            s = cue.get("startTimeMilliseconds")
            en = cue.get("endTimeMilliseconds")
            lines.append({"text": text, "s": int(s) if s is not None else None,
                          "e": int(en) if en is not None else None})
        if lines and any(l["s"] is not None for l in lines):
            return lines
    return None


def yt_plain(browse) -> tuple[str, str] | None:
    for shelf in find_all(browse, "musicDescriptionShelfRenderer"):
        text = runs_text(shelf.get("description"))
        if text.strip():
            return text, runs_text(shelf.get("footer"))
    return None


def yt_search_songs(query: str) -> list[dict]:
    res = innertube("search", WEB_REMIX, {"query": query, "params": FILTER_SONGS})
    hits = []
    for r in find_all(res, "musicResponsiveListItemRenderer"):
        vid = _path(r, "playlistItemData", "videoId")
        if not vid:
            continue
        cols = [_path(c, "musicResponsiveListItemFlexColumnRenderer", "text") for c in r.get("flexColumns", [])]
        title = runs_text(cols[0]) if cols else ""
        runs = [x for c in cols[1:] for x in (c or {}).get("runs", [])]
        artist = runs[0].get("text", "") if runs else ""
        dur = next((parse_duration(x.get("text", "")) for x in runs if parse_duration(x.get("text", ""))), None)
        hits.append({"videoId": vid, "title": title, "artist": artist, "durationMs": dur})
    return hits


# ── LRCLIB ───────────────────────────────────────────────────────

LRCLIB = "https://lrclib.net/api/"


def _lrclib_track(e) -> dict | None:
    if not isinstance(e, dict):
        return None
    raw = e.get("syncedLyrics")
    synced = parse_lrc(raw) if raw else None
    if synced is not None and not any(l["text"].strip() for l in synced):
        synced = None
    dur = e.get("duration")
    return {"title": e.get("trackName") or "", "artist": e.get("artistName") or "",
            "durationMs": int(dur * 1000) if isinstance(dur, (int, float)) else None,
            "synced": synced, "plain": e.get("plainLyrics"),
            "extras": (len(TAG.findall(raw)) - len(set(m.group(0) for m in TAG.finditer(raw)))) if raw else 0}


def _track_text(t) -> str:
    return "\n".join(l["text"] for l in t["synced"]) if t["synced"] else (t["plain"] or "")


def pick_track(tracks: list[dict], duration_ms: int) -> dict | None:
    """同步歌詞優先 → 同版本時長 → 有日文版就不用羅馬拼音版 → 時長最接近 → 沒夾帶翻譯。"""
    usable = [t for t in tracks if t["synced"] or (t["plain"] or "").strip()]
    has_ja = any(looks_japanese(_track_text(t)) for t in usable)

    def diff(t):
        return abs(t["durationMs"] - duration_ms) if t["durationMs"] and duration_ms else None

    def key(t):
        d = diff(t)
        return (t["synced"] is None,
                (d or 0) > DURATION_TOLERANCE_MS,
                has_ja and looks_romaji(_track_text(t)),
                (d if d is not None else 10 ** 9) // 1000,
                t["extras"] > 0,
                d if d is not None else 10 ** 9)
    return min(usable, key=key) if usable else None


def lrclib_find(title: str, artist: str, duration_ms: int, log) -> dict | None:
    try:
        params = {"track_name": title, "artist_name": artist}
        if duration_ms > 0:
            params["duration"] = str(round(duration_ms / 1000))
        try:
            direct = _lrclib_track(_json(LRCLIB + "get", params=params))
        except urllib.error.HTTPError as exc:
            if exc.code != 404:
                raise
            direct = None
        if direct and direct["synced"]:
            log("LRCLIB get：找到同步歌詞")
            return direct
        found = [_lrclib_track(e) for e in _json(LRCLIB + "search", params={"track_name": title, "artist_name": artist})]
        if not found and artist:
            found = [_lrclib_track(e) for e in _json(LRCLIB + "search", params={"q": title})]
        found = [t for t in found if t]
        log(f"LRCLIB search：{len(found)} 筆")
        cands = [t for t in found
                 if (duration_ms <= 0 or t["durationMs"] is None or duration_close(t["durationMs"], duration_ms))
                 and title_similarity(t["title"], title) >= 0.5]
        return pick_track(cands, duration_ms) or direct
    except Exception as exc:  # noqa: BLE001
        log(f"LRCLIB 失敗：{exc}")
        return None


def lrclib_search_url(title: str, artist: str) -> str:
    params = {"track_name": title.strip()}
    if artist.strip():
        params["artist_name"] = artist.strip()
    return LRCLIB + "search?" + urllib.parse.urlencode(params)


def _ensure_public_host(host: str) -> None:
    """這個網址是連進來的人貼的、由伺服器去抓，不能讓它被拿來探內網或本機的服務。"""
    import ipaddress
    import socket
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError as exc:
        raise LyricsError(f"找不到主機 {host}") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if not ip.is_global:
            raise LyricsError("只能抓公開網站上的歌詞（不接受內網或本機位址）")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # noqa: D401
        return None


def from_url(url: str, duration_ms: int, log) -> dict:
    """使用者貼的網址：LRCLIB 的 JSON（search 陣列或 get 單筆）或 LRC 純文字。"""
    parsed = urllib.parse.urlparse(url.strip())
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise LyricsError("網址格式不正確")
    _ensure_public_host(parsed.hostname)
    try:
        opener = urllib.request.build_opener(_NoRedirect)
        req = urllib.request.Request(url.strip(), headers={"User-Agent": USER_AGENT})
        with opener.open(req, timeout=TIMEOUT) as res:
            body = res.read(2 << 20).decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001
        raise LyricsError(f"讀取網址失敗：{exc}") from exc
    try:
        data = json.loads(body)
    except ValueError:
        lines = parse_lrc(body)
        if not any(l["text"].strip() for l in lines):
            raise LyricsError("網址內容不是 LRC 歌詞，也不是 LRCLIB 的 JSON")
        return {"lines": lines, "synced": True, "source": f"LRC（{parsed.hostname}）"}
    tracks = [_lrclib_track(e) for e in (data if isinstance(data, list) else [data])]
    tracks = [t for t in tracks if t]
    log(f"LRCLIB：{len(tracks)} 筆，其中 {sum(1 for t in tracks if t['synced'])} 筆有同步歌詞")
    best = pick_track(tracks, duration_ms)
    if best is None:
        raise LyricsError("LRCLIB 查不到這首歌" if not tracks else "LRCLIB 的結果都沒有歌詞")
    if best["synced"]:
        return {"lines": best["synced"], "synced": True, "source": "LRCLIB"}
    return {"lines": [{"text": l, "s": None, "e": None} for l in best["plain"].splitlines()],
            "synced": False, "source": "LRCLIB 純文字", "note": "LRCLIB 只有純文字歌詞"}


def from_lrc_text(text: str, name: str) -> dict:
    lines = parse_lrc(text)
    if not any(l["text"].strip() for l in lines):
        raise LyricsError(f"「{name}」裡沒有 LRC 時間標籤（[mm:ss.xx]）")
    return {"lines": lines, "synced": True, "source": f"上傳的 LRC（{name}）"}


# ── YouTube CC 字幕 ───────────────────────────────────────────────

CAPTION_NOISE = re.compile(r"^[\s♪♫♬～~・\-]*$|^[\[（(【]\s*(音楽|music|拍手|歓声|笑)\s*[\]）)】]$", re.I)


def caption_tracks(video_id: str) -> dict:
    res = innertube("player", IOS, {"videoId": video_id}, base="https://www.youtube.com/youtubei/v1/")
    tracks = []
    for t in _path(res, "captions", "playerCaptionsTracklistRenderer", "captionTracks") or []:
        if not t.get("baseUrl") or not t.get("languageCode"):
            continue
        tracks.append({"url": t["baseUrl"], "lang": t["languageCode"],
                       "name": runs_text(t.get("name")) or t["languageCode"],
                       "auto": t.get("kind") == "asr" or (t.get("vssId") or "").startswith("a.")})
    secs = _path(res, "videoDetails", "lengthSeconds")
    return {"title": _path(res, "videoDetails", "title") or "",
            "durationMs": int(secs) * 1000 if secs else None, "tracks": tracks}


def pick_original_caption(tracks: list[dict], title: str, artist: str) -> dict | None:
    """挑出歌曲原文的人工字幕；判斷不出來就不用（寧可沒有，也不要把翻譯當歌詞）。"""
    manual = [t for t in tracks if not t["auto"]]
    if not manual:
        return None

    def base(l): return l.split("-")[0].lower()

    def find(lang): return next((t for t in manual if base(t["lang"]) == lang), None)
    meta = f"{title} {artist}"
    if any(is_kana(c) for c in meta):
        return find("ja")
    if any("가" <= c <= "힣" for c in meta):
        return find("ko")
    if has_kanji(meta):
        zh = find("zh")
        return find("ja") or (zh if all(base(t["lang"]) == "zh" for t in manual) else None)
    asr = next((t for t in tracks if t["auto"]), None)
    if asr and find(base(asr["lang"])):
        return find(base(asr["lang"]))
    return manual[0] if len({base(t["lang"]) for t in manual}) == 1 else None


def download_caption(track: dict) -> list[dict]:
    url = re.sub(r"&fmt=[^&]*", "", track["url"]) + "&fmt=json3"
    data = _json(url, headers={"User-Agent": IOS["ua"]})
    out = []
    for e in data.get("events", []):
        start = e.get("tStartMs")
        if start is None:
            continue
        raw = "".join(s.get("utf8", "") for s in e.get("segs", []) or [])
        parts = [re.sub(r"^[\s♪♫♬]+|[\s♪♫♬]+$", "", p) for p in raw.splitlines()]
        parts = [p for p in parts if p.strip()]
        joiner = "　" if any(is_kana(c) or is_kanji(c) for c in raw) else " "
        text = joiner.join(parts).strip()
        if not text or CAPTION_NOISE.match(text):
            continue
        dur = e.get("dDurationMs")
        out.append({"text": text, "s": int(start), "e": int(start) + int(dur) if dur else None})
    for i, l in enumerate(out):
        nxt = out[i + 1]["s"] if i + 1 < len(out) else None
        if nxt is not None and (l["e"] is None or l["e"] > nxt):
            l["e"] = nxt
    return out


def caption_lyrics(video_ids: list[str], title: str, artist: str, duration_ms: int, log) -> dict | None:
    log("改找 YouTube 影片的 CC 字幕（不用自動生成的）")
    for vid in video_ids[:6]:
        try:
            info = caption_tracks(vid)
        except Exception as exc:  # noqa: BLE001
            log(f"  {vid} 取字幕清單失敗：{exc}")
            continue
        desc = ", ".join(t["lang"] + ("(自動)" if t["auto"] else "") for t in info["tracks"]) or "無"
        log(f"  {vid}「{info['title']}」字幕：{desc}")
        track = pick_original_caption(info["tracks"], title, artist)
        if track is None:
            continue
        try:
            lines = download_caption(track)
        except Exception as exc:  # noqa: BLE001
            log(f"    下載字幕失敗：{exc}")
            continue
        if len(lines) < 4:
            continue
        log(f"    使用字幕「{track['name']}」{len(lines)} 行 ✔")
        note = f"歌詞取自 YouTube 影片「{info['title']}」上傳者提供的字幕"
        if info["durationMs"] and duration_ms and abs(info["durationMs"] - duration_ms) > 3000:
            note += "，影片與歌曲時長不同，時間可能整體偏移（可用「歌詞時間」微調）"
        return {"lines": lines, "synced": True, "source": f"YouTube 字幕（{track['name']}）", "note": note}
    return None


# ── 自動抓取 ─────────────────────────────────────────────────────

def youtube_id(meta: dict) -> str | None:
    sid = meta.get("sourceId") or ""
    if sid.lower().startswith("youtube:"):
        return sid.split(":", 1)[1]
    return None


def apply_timing(plain: list[str], timed: list[dict]) -> list[dict] | None:
    """把同步歌詞的時間套到純文字歌詞上；≥70% 的行對得上才套用。"""
    p = [x.strip() for x in plain if x.strip()]
    t = [x for x in timed if x["text"].strip() and x["s"] is not None]
    if not p or not t:
        return None
    starts: list[int | None] = [None] * len(p)
    j = matched = 0
    for i, line in enumerate(p):
        best, best_sim = -1, 0.0
        for k in range(j, min(j + 5, len(t))):
            s = similarity(line, t[k]["text"])
            if s >= 0.5 and s > best_sim:
                best, best_sim = k, s
                if s >= 0.95:
                    break
        if best >= 0:
            starts[i] = t[best]["s"]
            j = best + 1
            matched += 1
    if matched < len(p) * 0.7:
        return None
    last_end = t[-1]["e"] or t[-1]["s"] + 5000
    _interpolate(starts, last_end)
    return [{"text": x, "s": starts[i], "e": starts[i + 1] if i + 1 < len(p) else last_end}
            for i, x in enumerate(p)]


def _interpolate(starts: list, last_end: int) -> None:
    n = len(starts)
    for i in range(n):
        if starts[i] is not None:
            continue
        prev = next((k for k in range(i - 1, -1, -1) if starts[k] is not None), None)
        nxt = next((k for k in range(i + 1, n) if starts[k] is not None), None)
        a = starts[prev] if prev is not None else 0
        b = starts[nxt] if nxt is not None else last_end
        lo = prev if prev is not None else -1
        hi = nxt if nxt is not None else n
        starts[i] = int(a + (b - a) * (i - lo) / (hi - lo))


def auto_fetch(meta: dict, title: str, artist: str, log) -> dict | None:
    """自動抓句時間。回傳 {lines, synced, source, note?} 或 None（都沒有）。"""
    duration = int(meta.get("durationMs") or 0)
    vid = youtube_id(meta)
    queue: list[tuple[str, bool]] = []
    seen: set[str] = set()

    def enqueue(v, exact, front=False):
        if v and v not in seen:
            seen.add(v)
            queue.insert(0, (v, exact)) if front else queue.append((v, exact))

    if vid:
        enqueue(vid, True)
    searched = False
    tried = 0
    plain_fallback = None
    lrc_cache: list = []

    def lrc():
        if not lrc_cache:
            lrc_cache.append(lrclib_find(title, artist, duration, log))
        return lrc_cache[0]

    while True:
        if not queue and not searched:
            searched = True
            try:
                hits = yt_search_songs(f"{title} {artist}".strip())
                hits = [h for h in hits if title_similarity(h["title"], title) >= 0.5
                        and (not duration or not h["durationMs"] or duration_close(h["durationMs"], duration))]
                log(f"YT Music 搜尋「{title} {artist}」：相符 {len(hits)} 筆")
                for h in hits[:3]:
                    enqueue(h["videoId"], duration_close(h["durationMs"], duration, 1500))
            except Exception as exc:  # noqa: BLE001
                log(f"YT Music 搜尋失敗：{exc}")
        if not queue or tried >= 6:
            break
        v, exact = queue.pop(0)
        tried += 1
        log(f"候選 {v}{'' if exact else '（其他版本）'}")
        try:
            nxt = innertube("next", WEB_REMIX, {"videoId": v, "isAudioOnly": True})
        except Exception as exc:  # noqa: BLE001
            log(f"  next 失敗：{exc}")
            continue
        for c in yt_counterparts(nxt, v):
            log(f"  counterpart：{c}")
            enqueue(c, exact, front=True)   # MV ↔ 歌曲版本，長度幾乎一樣
        browse_id = next((b for b in find_all(nxt, "browseId") if isinstance(b, str) and b.startswith("MPLYt")), None)
        if not browse_id:
            log("  沒有歌詞 tab")
            continue
        try:
            timed = yt_timed(innertube("browse", ANDROID_MUSIC, {"browseId": browse_id}))
        except Exception as exc:  # noqa: BLE001
            log(f"  ANDROID_MUSIC 失敗：{exc}")
            timed = None
        if timed:
            log(f"  同步歌詞 {len(timed)} 行 ✔")
            if exact:
                return {"lines": timed, "synced": True, "source": "YT Music（同步）"}
            note = "時間軸取自時長不同的版本，可能整體偏移；可用「歌詞時間」微調"
            return {"lines": timed, "synced": True, "source": "YT Music（同步，其他版本）", "note": note}
        try:
            plain = yt_plain(innertube("browse", WEB_REMIX, {"browseId": browse_id}))
        except Exception as exc:  # noqa: BLE001
            log(f"  WEB_REMIX 失敗：{exc}")
            plain = None
        if not plain:
            log("  沒有歌詞內容")
            continue
        text, credit = plain
        log(f"  純文字歌詞 {len(text.splitlines())} 行（{credit or '無出處'}）")
        track = lrc()
        if track and track["synced"]:
            applied = apply_timing(text.splitlines(), track["synced"])
            if applied:
                log("  LRCLIB 時間軸與 YT 歌詞相符，套用")
                return {"lines": applied, "synced": True, "source": "YT Music ＋ LRCLIB 時間軸", "note": credit}
            log("  LRCLIB 歌詞內容與 YT 不符，不套用時間")
        if plain_fallback is None:
            plain_fallback = {"lines": [{"text": l, "s": None, "e": None} for l in text.splitlines()],
                              "synced": False, "source": "YT Music（純文字）", "note": credit}

    track = lrc()
    romaji_note = ("LRCLIB 只有羅馬拼音版本；可上傳日文 .lrc"
                   if track and looks_romaji(_track_text(track)) else None)
    if plain_fallback and vid:
        got = caption_lyrics([vid, *[v for v in seen if v != vid]], title, artist, duration, log)
        if got:
            return got
    if track and track["synced"]:
        return {"lines": track["synced"], "synced": True, "source": "LRCLIB", "note": romaji_note}
    if not plain_fallback and vid:
        got = caption_lyrics([vid, *[v for v in seen if v != vid]], title, artist, duration, log)
        if got:
            return got
    if plain_fallback:
        return plain_fallback
    if track and (track["plain"] or "").strip():
        return {"lines": [{"text": l, "s": None, "e": None} for l in track["plain"].splitlines()],
                "synced": False, "source": "LRCLIB 純文字", "note": romaji_note}
    log("所有來源都沒有歌詞")
    return None


# ── 逐字時間：酷狗 KRC／網易雲 YRC ─────────────────────────────────

KRC_KEY = bytes([64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105])
CREDIT = re.compile(
    r"^\s*(作?词|作?詞|作?曲|编曲|編曲|制作人?|製作人?|监制|監製|混音|母带|和声|吉他|贝斯|鼓|演唱|原唱|翻唱|出品|发行|發行|OP|SP|"
    r"Lyrics?|Lyricist|Composed?r?|Composer|Written|Writer|Produced?r?|Producer|Arranged?r?|Arranger|Music|Words?|Vocals?)"
    r"\s*(by)?\s*[：:]", re.I)


def decode_krc(content_b64: str) -> str:
    raw = base64.b64decode(content_b64)[4:]
    body = bytes(b ^ KRC_KEY[i % 16] for i, b in enumerate(raw))
    return zlib.decompress(body).decode("utf-8", "replace")


def _clean_timed(lines: list[dict]) -> list[dict]:
    kept = [l for l in lines if any(any(ch.isalnum() for ch in c[0]) for c in l["chunks"])
            and not CREDIT.search("".join(c[0] for c in l["chunks"]))]
    if kept and kept[0]["s"] < 2000 and " - " in "".join(c[0] for c in kept[0]["chunks"]):
        kept = kept[1:]
    return sorted(kept, key=lambda l: l["s"])


def parse_krc(krc: str) -> list[dict]:
    """KRC：[句首,句長]<相對句首的時間,長度,0>字…；chunk = (文字, 開始, 長度)。"""
    out = []
    for raw in krc.lstrip("﻿").splitlines():
        m = re.fullmatch(r"\[(\d+),(\d+)\](.*)", raw.rstrip())
        if not m:
            continue
        s = int(m.group(1))
        chunks = [(c.group(3), s + int(c.group(1)), int(c.group(2)))
                  for c in re.finditer(r"<(\d+),(\d+),-?\d+>([^<]*)", m.group(3)) if c.group(3)]
        out.append({"s": s, "chunks": chunks})
    return _clean_timed(out)


def parse_yrc(yrc: str) -> list[dict]:
    """網易雲 YRC：[句首,句長](絕對時間,長度,0)字…"""
    out = []
    for raw in yrc.splitlines():
        m = re.fullmatch(r"\[(\d+),(\d+)\](.*)", raw.rstrip())
        if not m:
            continue
        chunks = [(c.group(3), int(c.group(1)), int(c.group(2)))
                  for c in re.finditer(r"\((\d+),(\d+),-?\d+\)([^(]*)", m.group(3)) if c.group(3)]
        out.append({"s": int(m.group(1)), "chunks": chunks})
    return _clean_timed(out)


def _rank(hits, title, artist, duration):
    scored = []
    for h in hits:
        if not duration_close(h["durationMs"], duration, 5000) or title_similarity(h["title"], title) < 0.5:
            continue
        a = 0.5 if not artist else max(similarity(h["artist"], artist), title_similarity(h["artist"], artist))
        bonus = 3.5 if duration_close(h["durationMs"], duration, 1000) else 2.5
        scored.append((title_similarity(h["title"], title) * 2 + a + bonus, h))
    scored.sort(key=lambda x: -x[0])
    return [h for _, h in scored]


def kugou_candidates(title: str, artist: str, duration: int, log) -> list[tuple[str, list]]:
    ua = {"User-Agent": "Mozilla/5.0"}   # 完整的瀏覽器 UA 會讓酷狗的搜尋回傳空結果

    def song_search(kw):
        data = _json("https://mobileservice.kugou.com/api/v3/search/song", headers=ua,
                     params={"format": "json", "keyword": kw, "page": 1, "pagesize": 10, "showtype": 1})
        return [{"videoId": s.get("hash"), "title": s.get("songname") or "", "artist": s.get("singername") or "",
                 "durationMs": (s.get("duration") or 0) * 1000}
                for s in (_path(data, "data", "info") or []) if s.get("hash")]

    def lyric_search(params):
        data = _json("https://lyrics.kugou.com/search", headers=ua,
                     params={"ver": 1, "man": "yes", "client": "pc", **params})
        out = []
        for c in data.get("candidates") or []:
            d = int(c.get("duration") or 0)
            out.append({"id": c.get("id"), "key": c.get("accesskey"), "song": c.get("song") or "",
                        "singer": c.get("singer") or "", "durationMs": d * 1000 if 0 < d < 10000 else d})
        return [c for c in out if c["id"] and c["key"]]

    out, seen = [], set()

    def take(cands):
        for c in [c for c in cands if duration_close(c["durationMs"], duration, 5000)][:2]:
            if c["id"] in seen:
                continue
            seen.add(c["id"])
            data = _json("https://lyrics.kugou.com/download", headers=ua,
                         params={"ver": 1, "client": "pc", "id": c["id"], "accesskey": c["key"],
                                 "fmt": "krc", "charset": "utf8"})
            if not data.get("content"):
                continue
            try:
                lines = parse_krc(decode_krc(data["content"]))
            except Exception:  # noqa: BLE001
                continue
            if len(lines) >= 5:
                out.append((f"「{c['song']}／{c['singer']}」", lines))
            if len(out) >= 2:
                return

    hits = song_search(f"{artist} {title}".strip()) or song_search(title)
    ranked = _rank(hits, title, artist, duration)
    log(f"酷狗：搜尋 {len(hits)} 首，時長相符 {len(ranked)} 首")
    for h in ranked[:3]:
        take(lyric_search({"hash": h["videoId"]}))
        if out:
            return out
    take([c for c in lyric_search({"keyword": f"{artist} {title}".strip()})
          if title_similarity(c["song"], title) >= 0.5])
    return out


def netease_candidates(title: str, artist: str, duration: int, log) -> list[tuple[str, list]]:
    ref = {"Referer": "https://music.163.com/", "User-Agent": "Mozilla/5.0"}
    data = _json("https://music.163.com/api/search/get", headers=ref,
                 params={"s": f"{artist} {title}".strip(), "type": 1, "limit": 10})
    hits = [{"videoId": str(s.get("id")), "title": s.get("name") or "",
             "artist": " ".join(a.get("name") or "" for a in s.get("artists") or []),
             "durationMs": s.get("duration")}
            for s in (_path(data, "result", "songs") or []) if s.get("id")]
    ranked = _rank(hits, title, artist, duration)
    log(f"網易雲：搜尋 {len(hits)} 首，時長相符 {len(ranked)} 首")
    out = []
    for h in ranked[:3]:
        lyr = _json("https://music.163.com/api/song/lyric/v1", headers=ref,
                    params={"id": h["videoId"], "lv": 0, "yv": 0, "tv": 0})
        yrc = _path(lyr, "yrc", "lyric")
        if not yrc:
            continue
        lines = parse_yrc(yrc)
        if len(lines) >= 5:
            out.append((f"「{h['title']}／{h['artist']}」", lines))
        if len(out) >= 2:
            break
    return out


def _code(c: str) -> str:
    n = to_hiragana(unicodedata.normalize("NFKC", c).lower())
    return "".join(ch for ch in n if ch.isalnum())


def align_word_timing(lines: list[dict], source: list[dict], synced: bool) -> dict | None:
    """把逐字歌詞的時間 diff 到我們的歌詞上。

    兩邊的換行、標點、大小寫、全半形、平假名片假名都可能不同，所以整首攤成字元序列比對，
    對到的字用來源的時間，沒對到的字用前後內插。整首 ≥50%、每句 ≥60% 的字對到才算數。
    回傳 {lines, matched, timedLines, shifted} 或 None。
    """
    ours = []   # (code, line, index)
    for li, l in enumerate(lines):
        for ci, c in enumerate(l["text"]):
            for k in _code(c):
                ours.append((k, li, ci))
    src = []    # (code, start, end)
    for line in source:
        for text, start, dur in line["chunks"]:
            ks = [k for c in text for k in _code(c)]
            for i, k in enumerate(ks):
                src.append((k, start + dur * i // len(ks), start + dur * (i + 1) // len(ks)))
    if not ours or not src:
        return None
    sm = difflib.SequenceMatcher(None, [k for k, _, _ in ours], [k for k, _, _ in src], autojunk=False)
    pairs = [(b.a + i, b.b + i) for b in sm.get_matching_blocks() for i in range(b.size)]
    matched = len(pairs) / len(ours)
    if matched < 0.5:
        return None

    hit = [[None] * len(l["text"]) for l in lines]
    for a, b in pairs:
        _, li, ci = ours[a]
        h = hit[li][ci]
        hit[li][ci] = [src[b][1], src[b][2]] if h is None else [min(h[0], src[b][1]), max(h[1], src[b][2])]
    letters = [[] for _ in lines]
    for _, li, ci in ours:
        if not letters[li] or letters[li][-1] != ci:
            letters[li].append(ci)

    # 句時間與來源一致嗎：句首 − 第一個對到的字（中位數）
    diffs = []
    for li, l in enumerate(lines):
        if l.get("s") is None or not letters[li]:
            continue
        got = [hit[li][i] for i in letters[li] if hit[li][i]]
        if got and len(got) >= len(letters[li]) * 0.6:
            diffs.append(l["s"] - got[0][0])
    diffs.sort()
    offset = diffs[len(diffs) // 2] if diffs else 0
    shift = 0
    if synced and abs(offset) > 1000:
        # 來源大概是前奏長度不同的版本：各句的差要一致才整首平移，否則當成對錯
        if len(diffs) < 5 or diffs[len(diffs) * 3 // 4] - diffs[len(diffs) // 4] > 1000:
            return None
        shift = offset

    out, timed = [], 0
    for li, l in enumerate(lines):
        lt = letters[li]
        got = sum(1 for i in lt if hit[li][i])
        nl = {k: v for k, v in l.items() if k != "ct"}
        if lt and got >= len(lt) * 0.6:
            timed += 1
            nl["ct"] = _fill(len(l["text"]), lt, [[h[0] + shift, h[1] + shift] if h else None for h in hit[li]])
            if not synced:
                nl["s"] = nl["ct"][0]
        out.append(nl)
    if not synced:
        starts = [l.get("s") if "ct" in l else None for l in out]
        last = max((l["ct"][-1] for l in out if "ct" in l), default=0)
        _interpolate(starts, last + 4000)
        for i, l in enumerate(out):
            l["s"] = starts[i]
            l["e"] = starts[i + 1] if i + 1 < len(out) else (l["ct"][-1] if "ct" in l else starts[i] + 4000)
    return {"lines": out, "matched": matched, "timedLines": timed, "shifted": shift != 0}


def _fill(length: int, letters: list[int], hit: list) -> list[int]:
    """補齊一句的逐字時間：沒對到的字依前後內插，空白標點長度 0，時間不倒退。"""
    start = [0] * length
    end = [0] * length
    known = [i for i in letters if hit[i]]
    p = 0
    while p < len(letters):
        i = letters[p]
        if hit[i]:
            start[i], end[i] = hit[i]
            p += 1
            continue
        q = p
        while q < len(letters) and not hit[letters[q]]:
            q += 1
        count = q - p
        prev_end = end[letters[p - 1]] if p > 0 else None
        next_start = hit[letters[q]][0] if q < len(letters) else None
        frm = prev_end if prev_end is not None else ((next_start if next_start is not None else hit[known[0]][0]) - 180 * count)
        to = next_start if next_start is not None else frm + 180 * count
        span = max(0, to - frm)
        for k in range(count):
            j = letters[p + k]
            start[j] = frm + span * k // count
            end[j] = frm + span * (k + 1) // count
        p = q
    is_letter = [False] * length
    for i in letters:
        is_letter[i] = True
    last = start[letters[0]] if letters else 0
    flat = []
    for i in range(length):
        if is_letter[i]:
            start[i] = max(start[i], last)
            end[i] = max(end[i], start[i])
            last = end[i]
        else:
            start[i] = end[i] = last
        flat += [start[i], end[i]]
    return flat


def word_timing(lines: list[dict], synced: bool, title: str, artist: str, duration: int, log):
    """酷狗 → 網易雲，第一個對得上的就用。回傳 (標籤, 新的 lines) 或 None。"""
    for label, source in (("酷狗", kugou_candidates), ("網易雲", netease_candidates)):
        try:
            cands = source(title, artist, duration, log)
        except Exception as exc:  # noqa: BLE001
            log(f"{label} 逐字歌詞失敗：{exc}")
            continue
        for desc, timed in cands:
            r = align_word_timing(lines, timed, synced)
            if r is None:
                log(f"  {label} {desc}：歌詞對不上，略過")
                continue
            log(f"  {label} {desc}：對到 {r['matched'] * 100:.0f}% 的字，{r['timedLines']} 句有逐字時間"
                + ("（整首平移對齊）" if r["shifted"] else ""))
            return label, r["lines"]
    return None


# ── 日文：振假名與羅馬拼音 ─────────────────────────────────────────

# pykakasi 是一般辭典的讀法，歌詞有幾個字幾乎都唸另一種（君＝きみ 而不是くん）
READING_FIX = {
    "君": "きみ", "僕": "ぼく", "私": "わたし", "貴方": "あなた", "貴女": "あなた", "明日": "あした",
    "今日": "きょう", "昨日": "きのう", "一人": "ひとり", "二人": "ふたり", "何": "なに", "何処": "どこ",
    "此処": "ここ", "其処": "そこ", "未来": "みらい", "宇宙": "うちゅう", "運命": "うんめい", "永遠": "えいえん",
    "瞬間": "しゅんかん", "世界": "せかい", "心": "こころ", "夢": "ゆめ", "涙": "なみだ", "声": "こえ",
    "空": "そら", "風": "かぜ", "星": "ほし", "花": "はな", "雨": "あめ", "夜": "よる", "朝": "あさ",
    "日": "ひ", "愛": "あい", "恋": "こい", "人": "ひと", "日々": "ひび", "今": "いま", "全部": "ぜんぶ", "一緒": "いっしょ",
}

_kakasi = None


def _tokens(text: str) -> list[tuple[str, str, str]]:
    """(詞面, 平假名讀音, 羅馬拼音)。"""
    global _kakasi
    if _kakasi is None:
        import pykakasi
        _kakasi = pykakasi.kakasi()
    out = []
    for t in _kakasi.convert(text):
        orig, hira, rom = t["orig"], t["hira"], t["hepburn"]
        for word, reading in READING_FIX.items():
            if orig == word or (orig.startswith(word) and not has_kanji(orig[len(word):])):
                rest = orig[len(word):]
                hira = reading + to_hiragana(rest)
                rom = None
                break
        out.append((orig, hira, rom))
    return out


def furigana(surface: str, reading: str) -> list[list]:
    """讀音只標在漢字上，送り仮名不重複標。例：食べる＋たべる → [[食,た],[べる,None]]。"""
    if not surface or not has_kanji(surface) or not reading:
        return [[surface, None]]
    hira = to_hiragana(reading)
    runs: list[list] = []
    for c in surface:
        k = is_kanji(c)
        if runs and runs[-1][1] == k:
            runs[-1][0] += c
        else:
            runs.append([c, k])
    pattern = "^" + "".join("(.+?)" if k else re.escape(to_hiragana(t)) for t, k in runs) + "$"
    m = re.match(pattern, hira)
    if not m:
        return [[surface, hira]]
    g = 1
    out = []
    for t, k in runs:
        if k:
            out.append([t, m.group(g)])
            g += 1
        else:
            out.append([t, None])
    return out


HEPBURN = None


def _romaji_of(hira: str) -> str:
    global HEPBURN
    if HEPBURN is None:
        import pykakasi
        HEPBURN = pykakasi.kakasi()
    return "".join(t["hepburn"] for t in HEPBURN.convert(hira))


def annotate_japanese(text: str) -> tuple[list[list], str]:
    """一行日文 → (振假名段落, 羅馬拼音)。"""
    ruby: list[list] = []
    roma: list[str] = []
    for orig, hira, rom in _tokens(text):
        for seg in furigana(orig, hira):
            if ruby and seg[1] is None and ruby[-1][1] is None:
                ruby[-1][0] += seg[0]     # 相鄰沒讀音的併成一段，前端少一點節點
            else:
                ruby.append(seg)
        if any(is_kana(c) or is_kanji(c) for c in orig):
            r = rom if rom is not None else _romaji_of(hira)
            # 助詞：を→o、は→wa、へ→e（pykakasi 會把「には」「僕は」連成一塊，尾巴的は也要改）
            if orig in ("を", "へ"):
                r = {"を": "o", "へ": "e"}[orig]
            elif orig.endswith("は") and r.endswith("ha"):
                r = (r[:-2] + " wa").strip()
            roma.append(r)
        elif orig.strip():
            roma.append(orig.strip())
    joined = re.sub(r"\s+", " ", " ".join(roma)).strip()
    return ruby, joined


# ── 整合 ─────────────────────────────────────────────────────────

def finish(result: dict, meta: dict, title: str, artist: str, log, *, want_word_timing: bool = True) -> dict:
    """句時間到手後：逐字時間 + 日文讀音，整理成要存檔的形狀。"""
    lines = [l for l in result["lines"] if l.get("text", "").strip() or l.get("s") is not None]
    # 頭尾的空白行沒有用
    while lines and not lines[0]["text"].strip():
        lines.pop(0)
    while lines and not lines[-1]["text"].strip():
        lines.pop()
    synced = bool(result.get("synced"))
    duration = int(meta.get("durationMs") or 0)
    label = None
    if any("ct" in l for l in lines):
        label = "LRC 逐字"
    elif want_word_timing and lines:
        got = word_timing(lines, synced, title, artist, duration, log)
        if got:
            label, lines = got
            synced = True
        else:
            log("找不到逐字時間，演唱時依參考譜的音符估算")

    full = "\n".join(l["text"] for l in lines)
    japanese = looks_japanese(full)
    if japanese:
        for l in lines:
            if any(is_kanji(c) or is_kana(c) for c in l["text"]):
                try:
                    l["ruby"], l["romaji"] = annotate_japanese(l["text"])
                except Exception as exc:  # noqa: BLE001
                    log(f"讀音失敗：{exc}")
                    break
    # 結束時間補齊（最後一行到歌曲結束前，最多 8 秒）
    for i, l in enumerate(lines):
        if l.get("s") is not None and l.get("e") is None:
            nxt = next((x["s"] for x in lines[i + 1:] if x.get("s") is not None), None)
            l["e"] = nxt if nxt is not None else min(l["s"] + 8000, duration or l["s"] + 8000)
    return {
        "v": 1,
        "source": result.get("source"),
        "note": result.get("note"),
        "synced": synced,
        "title": title,
        "artist": artist,
        "wordTiming": label,
        "japanese": japanese,
        "offsetMs": 0,
        "fetchedAt": int(time.time() * 1000),
        "lines": lines,
    }


def resolve_title_artist(meta: dict, log) -> tuple[str, str]:
    """搜尋用的歌名／歌手：YouTube 來源先問 YT Music（資料比影片標題乾淨），否則從標題猜。"""
    vid = youtube_id(meta)
    if vid:
        try:
            info = yt_track_info(innertube("next", WEB_REMIX, {"videoId": vid, "isAudioOnly": True}), vid)
            if info.get("title"):
                title, artist = guess_title_artist(info["title"], info.get("artist", ""))
                log(f"YT Music：「{info['title']}」／{info.get('artist', '')}")
                return title, artist
        except Exception as exc:  # noqa: BLE001
            log(f"YT Music 讀取歌曲資訊失敗：{exc}")
    return guess_title_artist(meta.get("name", ""), meta.get("uploader", ""))


def fetch_for_song(meta: dict, title: str | None = None, artist: str | None = None) -> dict:
    """自動抓。找不到時仍回傳一份只有 log 的結果（lines 為空），前端據此提示手動提供。"""
    logs: list[str] = []
    log = logs.append
    if not title:
        title, artist = resolve_title_artist(meta, log)
    artist = artist or ""
    log(f"搜尋用歌名「{title}」歌手「{artist}」")
    try:
        got = auto_fetch(meta, title, artist, log)
    except Exception as exc:  # noqa: BLE001
        log(f"自動抓取失敗：{exc}")
        got = None
    if not got:
        return {"v": 1, "lines": [], "title": title, "artist": artist, "source": None,
                "note": "找不到歌詞，可上傳 .lrc 或貼 LRCLIB 網址",
                "searchUrl": lrclib_search_url(title, artist),
                "fetchedAt": int(time.time() * 1000), "log": logs}
    data = finish(got, meta, title, artist, log)
    data["log"] = logs
    return data


def from_user(meta: dict, *, lrc_text: str | None = None, name: str = "", url: str | None = None,
              title: str = "", artist: str = "") -> dict:
    logs: list[str] = []
    log = logs.append
    if not title:
        title, artist = guess_title_artist(meta.get("name", ""), meta.get("uploader", ""))
    if lrc_text is not None:
        got = from_lrc_text(lrc_text, name or "lyrics.lrc")
    else:
        got = from_url(url or "", int(meta.get("durationMs") or 0), log)
    data = finish(got, meta, title, artist, log)
    data["log"] = logs
    return data


if __name__ == "__main__":
    # 手動測試：python lyrics.py <library/歌曲ID>
    import sys
    from pathlib import Path
    folder = Path(sys.argv[1])
    m = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
    res = fetch_for_song(m)
    print("\n".join(res.get("log", [])))
    print("來源：", res.get("source"), "逐字：", res.get("wordTiming"), "行數：", len(res["lines"]))
    for line in res["lines"][:8]:
        print(line.get("s"), line["text"], "|", line.get("romaji", ""), "| ct" if "ct" in line else "")
