"""covers.py — 歌曲封面。

來源（依序）：
  1. YouTube 來源：YT Music 的正方形專輯封面（MV 會先找對應的「歌曲」版本，
     那個版本的縮圖才是專輯封面），沒有的話用影片縮圖（maxres → hq）。
  2. 其他網址（Bilibili 等）：yt-dlp 給的縮圖網址。
  3. 本機上傳的音檔：音檔裡內嵌的封面（ffmpeg 抽 attached picture）。
  4. 使用者自己上傳的圖片。
都沒有時前端畫一張依歌名配色的預設封面。

封面存成 library/<歌曲ID>/cover.<jpg|png|webp>。只接受這三種格式，並以檔頭判斷，
不相信副檔名或 Content-Type（SVG 之類可以夾帶腳本的格式一律不收）。
"""

from __future__ import annotations

import os
import re
import subprocess
import urllib.request
from pathlib import Path

TIMEOUT = 20
MAX_BYTES = 8 * 1024 * 1024
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"


def image_kind(data: bytes) -> str | None:
    """由檔頭判斷格式，回傳副檔名；不是 jpg/png/webp 就回 None。"""
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def _download(url: str) -> bytes | None:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            data = res.read(MAX_BYTES + 1)
    except Exception:  # noqa: BLE001
        return None
    if len(data) > MAX_BYTES or image_kind(data) is None:
        return None
    return data


def _square_art(url: str) -> str:
    """YT Music 的 googleusercontent 縮圖網址尾巴帶尺寸（=w60-h60-…），換成大圖。"""
    return re.sub(r"=w\d+-h\d+.*$", "=w720-h720-l90-rj", url)


def yt_music_art(video_id: str) -> str | None:
    """YT Music 上這首（或它對應的歌曲版本）的正方形專輯封面網址。"""
    import lyrics  # 共用 InnerTube 的呼叫與解析
    try:
        nxt = lyrics.innertube("next", lyrics.WEB_REMIX, {"videoId": video_id, "isAudioOnly": True})
    except Exception:  # noqa: BLE001
        return None
    # MV 的縮圖是 16:9 的影片截圖；它對應的「歌曲」版本才有專輯封面，優先用那個
    candidates = [*lyrics.yt_counterparts(nxt, video_id), video_id]
    for vid in candidates:
        for r in lyrics.find_all(nxt, "playlistPanelVideoRenderer"):
            if r.get("videoId") != vid:
                continue
            thumbs = (r.get("thumbnail") or {}).get("thumbnails") or []
            for t in reversed(thumbs):
                url = t.get("url") or ""
                if "googleusercontent.com" in url or "ggpht.com" in url:
                    return _square_art(url)
    return None


def youtube_cover(video_id: str) -> bytes | None:
    art = yt_music_art(video_id)
    if art:
        data = _download(art)
        if data:
            return data
    for name in ("maxresdefault", "hqdefault"):
        data = _download(f"https://i.ytimg.com/vi/{video_id}/{name}.jpg")
        # maxres 不存在時 YouTube 回一張 120x90 的灰色占位圖（約 1KB），不能當封面
        if data and len(data) > 5000:
            return data
    return None


def embedded_cover(audio: Path, work_dir: Path) -> bytes | None:
    """音檔內嵌的封面（mp3 的 APIC、m4a 的 covr…），用 ffmpeg 抽出來。"""
    ffmpeg = os.environ.get("KARAOKE_FFMPEG") or "ffmpeg"
    out = work_dir / "embedded_cover.jpg"
    kw = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    try:
        subprocess.run([ffmpeg, "-y", "-v", "error", "-i", str(audio), "-map", "0:v:0",
                        "-frames:v", "1", str(out)],
                       capture_output=True, timeout=30, check=True, **kw)
        data = out.read_bytes()
    except Exception:  # noqa: BLE001
        return None
    return data if image_kind(data) else None


def fetch_for(meta: dict, thumbnail: str | None = None) -> bytes | None:
    """依中繼資料找封面（不含本機音檔內嵌那條，那個要在分析完、檔案還在時做）。"""
    sid = meta.get("sourceId") or ""
    if sid.lower().startswith("youtube:"):
        data = youtube_cover(sid.split(":", 1)[1])
        if data:
            return data
    if thumbnail:
        return _download(thumbnail)
    return None
