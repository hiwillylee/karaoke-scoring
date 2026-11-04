"""fetcher.py — 用 yt-dlp 從 YouTube / YouTube Music / Bilibili 取得音訊。

為什麼是呼叫 yt-dlp 而不是自己重寫下載邏輯：這三個平台的取流方式（YouTube 的
player client 與 PO Token、Bilibili 的 DASH 音軌）幾乎每個月都在變，yt-dlp 光是
extractor 就上千個站、靠社群持續跟進。自己重寫等於每隔幾週就壞一次。所以這裡
只做三件事：判斷網址屬於哪個平台、給 yt-dlp 正確的參數、把結果正規化成曲庫要
的格式。

音訊格式的選擇：三個平台的音訊都以「只有音軌」的形式提供
（YouTube 的 opus/m4a、Bilibili 的 DASH audio，vcodec 都是 none），
所以 bestaudio 就能直接拿到不含影像的串流，不必下載整支影片再抽音軌。
"""

from __future__ import annotations

import os
import re
from pathlib import Path

# 支援的平台。判斷只看網域，實際解析交給 yt-dlp。
PLATFORMS = [
    ("youtube_music", "YouTube Music", re.compile(r"(^|\.)music\.youtube\.com$", re.I)),
    ("youtube", "YouTube", re.compile(r"(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$", re.I)),
    ("bilibili", "Bilibili", re.compile(r"(^|\.)(bilibili\.com|b23\.tv)$", re.I)),
]

URL_RE = re.compile(r"^https?://", re.I)


def looks_like_url(text: str) -> bool:
    return bool(URL_RE.match((text or "").strip()))


def platform_of(url: str) -> tuple[str, str] | None:
    """回傳 (代號, 顯示名稱)，不支援的網址回 None。"""
    from urllib.parse import urlparse

    host = (urlparse(url.strip()).hostname or "").lower()
    for key, label, pattern in PLATFORMS:
        if pattern.search(host):
            return key, label
    return None


def _base_options() -> dict:
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        # 一次只處理一首。貼播放清單或 radio 網址時只取當下那首，
        # 否則使用者按一下會意外下載幾十首歌。
        "noplaylist": True,
        "format": "bestaudio/best",
        "retries": 3,
        "socket_timeout": 30,
    }
    ffmpeg = os.environ.get("KARAOKE_FFMPEG")
    if ffmpeg and Path(ffmpeg).exists():
        # 打包後系統上沒有 ffmpeg，要指向內附的那份
        opts["ffmpeg_location"] = str(Path(ffmpeg).parent)
    return opts


# Bilibili 的合集影片，yt-dlp 會把分 P 標題接在主標題後面，
# 例如「《阳光彩虹小白马》 p01 阳光彩虹小白马」。單 P 或分 P 標題與主標題
# 重複時純粹是雜訊，當歌名很礙眼，這裡把它收掉。
PART_SUFFIX_RE = re.compile(r"^(?P<main>.+?)\s+p\d{1,3}\s+(?P<part>.+)$", re.I)


def clean_title(title: str) -> str:
    m = PART_SUFFIX_RE.match(title or "")
    if not m:
        return title
    main, part = m.group("main").strip(), m.group("part").strip()
    # 分 P 標題本來就是主標題的一部分（單曲上傳成合集）→ 只留主標題
    if part in main or main in part:
        return main
    # 真的是不同段落 → 保留但用比較好讀的分隔
    return f"{main} - {part}"


def source_id_of(info: dict) -> str:
    """跨網址的唯一識別。

    同一首歌的 youtube.com、youtu.be、music.youtube.com 三種網址，
    yt-dlp 都會正規化成同一個 extractor + id，所以用這個當鍵，
    使用者貼哪一種網址都認得出「這首已經下載過了」。
    """
    return f"{info.get('extractor_key') or info.get('extractor')}:{info.get('id')}"


def probe(url: str) -> dict:
    """只取中繼資料，不下載。用來判斷這首是不是已經在曲庫裡。"""
    from yt_dlp import YoutubeDL

    platform = platform_of(url)
    if platform is None:
        raise ValueError("只支援 YouTube、YouTube Music 與 Bilibili 的網址")

    opts = {**_base_options(), "skip_download": True}
    with YoutubeDL(opts) as ydl:
        info = ydl.sanitize_info(ydl.extract_info(url, download=False))

    # 播放清單網址即使加了 noplaylist 仍可能回傳 entries，取第一首
    if info.get("entries"):
        info = info["entries"][0]

    return {
        "sourceId": source_id_of(info),
        "platform": platform[0],
        "platformLabel": platform[1],
        "title": clean_title(info.get("title") or "") or "未命名",
        "uploader": info.get("uploader") or info.get("channel") or "",
        "durationMs": int((info.get("duration") or 0) * 1000),
        "webpageUrl": info.get("webpage_url") or url,
        "thumbnail": info.get("thumbnail") or "",
    }


def download(url: str, dest_dir: Path, progress=None) -> dict:
    """把音訊下載到 dest_dir，回傳中繼資料（含 path）。"""
    from yt_dlp import YoutubeDL

    platform = platform_of(url)
    if platform is None:
        raise ValueError("只支援 YouTube、YouTube Music 與 Bilibili 的網址")

    dest_dir.mkdir(parents=True, exist_ok=True)

    def hook(d):
        if progress is None:
            return
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            done = d.get("downloaded_bytes") or 0
            pct = done / total if total else 0
            progress(f"下載中… {pct * 100:.0f}%", pct)
        elif d.get("status") == "finished":
            progress("下載完成，準備分析…", 1.0)

    opts = {
        **_base_options(),
        "outtmpl": str(dest_dir / "source.%(ext)s"),
        "progress_hooks": [hook],
    }

    with YoutubeDL(opts) as ydl:
        info = ydl.sanitize_info(ydl.extract_info(url, download=True))

    if info.get("entries"):
        info = info["entries"][0]

    downloaded = sorted(dest_dir.glob("source.*"))
    if not downloaded:
        raise RuntimeError("yt-dlp 沒有產生檔案")

    return {
        "path": downloaded[0],
        "sourceId": source_id_of(info),
        "platform": platform[0],
        "platformLabel": platform[1],
        "title": clean_title(info.get("title") or "") or "未命名",
        "uploader": info.get("uploader") or info.get("channel") or "",
        "durationMs": int((info.get("duration") or 0) * 1000),
        "webpageUrl": info.get("webpage_url") or url,
        "thumbnail": info.get("thumbnail") or "",
    }


def version() -> str:
    try:
        from yt_dlp import version as v
        return f"{v.__version__} ({getattr(v, 'CHANNEL', 'stable')})"
    except ImportError:
        return "未安裝"
