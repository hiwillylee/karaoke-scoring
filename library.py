"""library.py — 伺服器端的曲庫。

歌曲（伴奏、人聲軌、參考譜、設定）全部存在跑伺服器的這台電腦上，
手機只有在按下「演唱」或「譜面」時才會把音檔抓下來。這樣同一個內網裡
每台裝置看到的是同一份曲庫，手機也不必存下幾百 MB 的音檔。

目錄結構：
    <資料目錄>/library/<歌曲ID>/
        meta.json          曲名、來源、時長、使用者調整過的參數
        chart.json         參考譜（逐幀音高 + note + 技巧標記）
        instrumental.m4a   純伴奏
        vocals.m4a         原唱人聲（導唱與譜面試聽用）
        lyrics.json        同步歌詞（lyrics.py 產生；沒有就是還沒抓或抓不到）
        cover.jpg|png|webp 封面（covers.py 產生，或使用者上傳）
"""

from __future__ import annotations

import json
import re
import shutil
import time
import unicodedata
from pathlib import Path

STEMS = {"instrumental": "instrumental.m4a", "vocals": "vocals.m4a"}
COVER_TYPES = {"jpg": "image/jpeg", "png": "image/png", "webp": "image/webp"}
ID_RE = re.compile(r"^[0-9a-z]{6,32}$")


class Library:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    # -- 路徑 ---------------------------------------------------------------

    def dir_of(self, song_id: str) -> Path | None:
        """只接受本程式產生的 ID 格式，避免被拿來讀取任意路徑。"""
        if not ID_RE.match(song_id or ""):
            return None
        path = self.root / song_id
        return path if path.is_dir() else None

    def stem_path(self, song_id: str, kind: str) -> Path | None:
        folder = self.dir_of(song_id)
        if folder is None or kind not in STEMS:
            return None
        path = folder / STEMS[kind]
        return path if path.exists() else None

    def chart_path(self, song_id: str) -> Path | None:
        folder = self.dir_of(song_id)
        if folder is None:
            return None
        path = folder / "chart.json"
        return path if path.exists() else None

    def lyrics_path(self, song_id: str) -> Path | None:
        folder = self.dir_of(song_id)
        return folder / "lyrics.json" if folder else None

    # -- 讀取 ---------------------------------------------------------------

    def lyrics(self, song_id: str) -> dict | None:
        path = self.lyrics_path(song_id)
        if path is None or not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

    def meta(self, song_id: str) -> dict | None:
        folder = self.dir_of(song_id)
        if folder is None:
            return None
        try:
            return json.loads((folder / "meta.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

    def list(self) -> list[dict]:
        """曲庫清單。只回中繼資料，不含音檔與逐幀資料。"""
        songs = []
        for folder in self.root.iterdir():
            if not folder.is_dir():
                continue
            meta = self.meta(folder.name)
            if meta:
                songs.append(meta)
        songs.sort(key=lambda m: m.get("addedAt", 0), reverse=True)
        return songs

    def find_by_source(self, source_id: str) -> dict | None:
        """依來源（例如 Youtube:rpVvPAFaoqM）找出已經下載過的歌。"""
        if not source_id:
            return None
        for meta in self.list():
            if meta.get("sourceId") == source_id:
                return meta
        return None

    def search(self, query: str) -> list[dict]:
        """用歌名或歌手（團體）在已下載的歌裡面找。大小寫與全形半形都不計較。

        歌手比對三個欄位：artist（抓歌詞時從 YT Music 解析出來的乾淨歌手名）、
        uploader（上傳頻道，常是「周杰倫 Jay Chou」這種中英並列，兩種寫法都搜得到）、
        以及歌名本身（「【Ado】向日葵」這種把歌手寫在標題裡的）。
        空白分隔的多個關鍵字要全部符合，例如「ado 向日葵」。
        """
        words = [normalize(w) for w in (query or "").split()]
        words = [w for w in words if w]
        if not words:
            return self.list()

        def haystack(m: dict) -> str:
            return " ".join(normalize(m.get(k) or "") for k in ("name", "artist", "uploader"))
        return [m for m in self.list() if all(w in haystack(m) for w in words)]

    def artists(self) -> list[dict]:
        """曲庫裡有哪些歌手、各幾首，給曲庫畫面的歌手篩選列用。"""
        counts: dict[str, dict] = {}
        for m in self.list():
            name = (m.get("artist") or m.get("uploader") or "").strip()
            if not name:
                continue
            # 「tuki.(17)」「Ado - Topic」「周杰倫 Jay Chou」這類頻道名去掉註記後再合併
            key = normalize(ARTIST_NOISE.sub("", name)) or normalize(name)
            entry = counts.setdefault(key, {"name": name, "count": 0})
            if m.get("artist") and len(m["artist"]) < len(entry["name"]):
                entry["name"] = m["artist"]   # 顯示比較乾淨的寫法
            entry["count"] += 1
        return sorted(counts.values(), key=lambda e: (-e["count"], e["name"]))

    def backfill_artists(self) -> int:
        """舊版曲庫沒有 artist 欄位：從已經抓好的歌詞資料補上。"""
        fixed = 0
        for m in self.list():
            if m.get("artist"):
                continue
            artist = ((self.lyrics(m["id"]) or {}).get("artist") or "").strip()
            if artist:
                m["artist"] = artist
                self._write_meta(m["id"], m)
                fixed += 1
        return fixed

    # -- 寫入 ---------------------------------------------------------------

    def add(self, song_id: str, name: str, chart: dict,
            instrumental: Path, vocals: Path | None, **extra) -> dict:
        folder = self.root / song_id
        folder.mkdir(parents=True, exist_ok=True)

        shutil.copy2(instrumental, folder / STEMS["instrumental"])
        if vocals is not None:
            shutil.copy2(vocals, folder / STEMS["vocals"])

        (folder / "chart.json").write_text(
            json.dumps(chart, ensure_ascii=False), encoding="utf-8")

        meta = {
            "id": song_id,
            "name": name,
            "addedAt": int(time.time() * 1000),
            "durationMs": chart.get("durationMs", 0),
            "notes": len(chart.get("notes", [])),
            "techniques": len(chart.get("techniques", [])),
            "hasGuide": vocals is not None,
            **extra,
        }
        (folder / "meta.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        return meta

    def update_settings(self, song_id: str, settings: dict) -> dict | None:
        """存下譜面確認與編輯畫面的調整，換一台裝置也會沿用。"""
        meta = self.meta(song_id)
        if meta is None:
            return None
        for key in ("octaveOffset", "minConfidence", "minLevelDb"):
            if key in settings:
                meta[key] = settings[key]
        if "chartEdits" in settings:
            meta["chartEdits"] = sanitize_edits(settings["chartEdits"])
        (self.root / song_id / "meta.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        return meta

    def save_lyrics(self, song_id: str, data: dict) -> dict | None:
        """存歌詞，並在 meta 記一筆來源，讓曲庫卡片不必另外抓歌詞就知道有沒有。"""
        meta = self.meta(song_id)
        path = self.lyrics_path(song_id)
        if meta is None or path is None:
            return None
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        meta["lyrics"] = data.get("source") if data.get("lines") else None
        # 抓歌詞時解析出來的歌手名比上傳頻道乾淨，順便記下來給搜尋用
        if (data.get("artist") or "").strip():
            meta["artist"] = data["artist"].strip()
        (self.root / song_id / "meta.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        return data

    # -- 封面 ---------------------------------------------------------------

    def cover_path(self, song_id: str) -> Path | None:
        folder = self.dir_of(song_id)
        if folder is None:
            return None
        for ext in COVER_TYPES:
            path = folder / f"cover.{ext}"
            if path.exists():
                return path
        return None

    def save_cover(self, song_id: str, data: bytes, ext: str, source: str) -> dict | None:
        """存封面並在 meta 記下版本（前端拿來當快取鍵，換了封面才會重抓）。"""
        meta = self.meta(song_id)
        folder = self.dir_of(song_id)
        if meta is None or folder is None or ext not in COVER_TYPES:
            return None
        for old in COVER_TYPES:
            (folder / f"cover.{old}").unlink(missing_ok=True)
        (folder / f"cover.{ext}").write_bytes(data)
        meta["cover"] = int(time.time() * 1000)
        meta["coverSource"] = source
        meta.pop("coverTried", None)
        self._write_meta(song_id, meta)
        return meta

    def mark_cover_tried(self, song_id: str) -> None:
        """自動找過但找不到：記下來，避免每次啟動都重找。"""
        meta = self.meta(song_id)
        if meta is not None:
            meta["coverTried"] = True
            self._write_meta(song_id, meta)

    def _write_meta(self, song_id: str, meta: dict) -> None:
        (self.root / song_id / "meta.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    def delete_lyrics(self, song_id: str) -> None:
        path = self.lyrics_path(song_id)
        if path and path.exists():
            path.unlink()
        meta = self.meta(song_id)
        if meta is not None:
            meta["lyrics"] = None
            (self.root / song_id / "meta.json").write_text(
                json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    def delete(self, song_id: str) -> bool:
        folder = self.dir_of(song_id)
        if folder is None:
            return False
        shutil.rmtree(folder, ignore_errors=True)
        return True


# 譜面編輯的資料是從網路請求寫進 meta.json 的，而 meta.json 每次開曲庫都會被
# 讀回來。所以進來的東西一律重建成已知形狀、數值夾在合理範圍、筆數設上限，
# 不直接把使用者送來的 JSON 原樣落地。
MAX_EDIT_NOTES = 5000
MAX_PITCH_SHIFTS = 2000
MAX_SONG_MS = 3 * 60 * 60 * 1000   # 三小時，比任何一首歌都長
MIDI_LO, MIDI_HI = 0, 127


def _num(value, lo: float, hi: float) -> float | None:
    """解析成範圍內的數字，不合格就回 None——由呼叫端整筆丟掉。

    刻意不給預設值：把 "abc" 當成 0、把 999 夾成 127，都會安靜地生出一個
    使用者沒有要的音符，比直接忽略這筆更難察覺。
    """
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    if v != v or v < lo or v > hi:     # NaN 或超出範圍
        return None
    return v


def sanitize_edits(edits) -> dict:
    """把外來的譜面編輯資料整理成乾淨、有界的形狀。"""
    if not isinstance(edits, dict):
        return {"pitchShifts": [], "notes": None}

    shifts = []
    for item in (edits.get("pitchShifts") or [])[:MAX_PITCH_SHIFTS]:
        if not isinstance(item, dict):
            continue
        start = _num(item.get("startMs"), 0, MAX_SONG_MS)
        end = _num(item.get("endMs"), 0, MAX_SONG_MS)
        semitones = _num(item.get("semitones"), -48, 48)
        if start is None or end is None or semitones is None or end <= start:
            continue
        shifts.append({
            "startMs": round(start, 1),
            "endMs": round(end, 1),
            "semitones": round(semitones, 3),
        })

    raw_notes = edits.get("notes")
    notes = None
    if isinstance(raw_notes, list):
        notes = []
        for item in raw_notes[:MAX_EDIT_NOTES]:
            if not isinstance(item, dict):
                continue
            start = _num(item.get("startMs"), 0, MAX_SONG_MS)
            end = _num(item.get("endMs"), 0, MAX_SONG_MS)
            midi = _num(item.get("midi"), MIDI_LO, MIDI_HI)
            if start is None or end is None or midi is None or end <= start:
                continue
            notes.append({
                "startMs": round(start, 1),
                "endMs": round(end, 1),
                "midi": round(midi, 3),
            })
        notes.sort(key=lambda n: n["startMs"])

    return {"pitchShifts": shifts, "notes": notes}


ARTIST_NOISE = re.compile(r"[(（\[【].*?[)）\]】]|\s*-\s*topic$|\bofficial\b|\bchannel\b|vevo$", re.I)


def normalize(text: str) -> str:
    """搜尋用的正規化：全形轉半形、去掉大小寫與空白差異。"""
    return unicodedata.normalize("NFKC", text or "").casefold().replace(" ", "")
