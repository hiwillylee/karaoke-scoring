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
        cover_thumb.jpg    曲庫卡片用的縮圖（由封面產生，可隨時刪掉重建）
        scores.json        演唱成績（存在伺服器上，換裝置、換網址都看得到）

meta.json 會被好幾條執行緒改（加歌後的封面／歌詞背景工作、使用者的設定、
成績），所以「讀出、修改、寫回」一律包在同一把鎖裡，寫檔則先寫暫存檔再
原子替換，避免互相蓋掉或留下寫到一半的檔案。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import unicodedata
from pathlib import Path

STEMS = {"instrumental": "instrumental.m4a", "vocals": "vocals.m4a"}
COVER_TYPES = {"jpg": "image/jpeg", "png": "image/png", "webp": "image/webp"}
# 找封面的邏輯改進時加一，舊版判定「找不到」的歌會在下次啟動時重找
# （2：Bilibili 等非 YouTube 來源也會去問 yt-dlp 要縮圖）
COVER_LOGIC_VERSION = 2
ID_RE = re.compile(r"^[0-9a-z]{6,32}$")
MAX_SCORES = 200          # 每首歌保留的成績筆數
THUMB_SIZE = 360          # 曲庫卡片縮圖的邊長（像素）


def write_json_atomic(path: Path, data, indent: int | None = None) -> None:
    """先寫同目錄的暫存檔再 os.replace：中途當掉也不會留下半份 JSON。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=indent)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


class Library:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        # 所有對 meta.json／scores.json 的讀改寫都經過這把鎖（可重入：
        # update_meta 裡面還會呼叫 meta()）
        self.lock = threading.RLock()
        self._list_cache: list[dict] | None = None

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
        """曲庫清單。只回中繼資料，不含音檔與逐幀資料。

        清單會快取在記憶體裡：經由這個類別寫入時清掉，另外以曲庫目錄的
        修改時間當保險（手動搬進／刪掉資料夾也會反映）。回傳的是複本，
        呼叫端怎麼改都不會污染快取。
        """
        with self.lock:
            stamp = self._root_stamp()
            if self._list_cache is None or self._list_stamp != stamp:
                songs = []
                for folder in self.root.iterdir():
                    if not folder.is_dir() or not ID_RE.match(folder.name):
                        continue
                    meta = self.meta(folder.name)
                    if meta:
                        songs.append(meta)
                songs.sort(key=lambda m: m.get("addedAt", 0), reverse=True)
                self._list_cache = songs
                self._list_stamp = stamp
            return [dict(m) for m in self._list_cache]

    def _root_stamp(self) -> int:
        try:
            return self.root.stat().st_mtime_ns
        except OSError:
            return 0

    def _invalidate(self) -> None:
        self._list_cache = None

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

    def artists(self, songs: list[dict] | None = None) -> list[dict]:
        """曲庫裡有哪些歌手、各幾首，給曲庫畫面的歌手篩選列用。"""
        counts: dict[str, dict] = {}
        for m in (songs if songs is not None else self.list()):
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
                self.update_meta(m["id"], lambda meta, a=artist: meta.__setitem__("artist", a))
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

        write_json_atomic(folder / "chart.json", chart)

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
        with self.lock:
            self._write_meta(song_id, meta)
        return meta

    def update_meta(self, song_id: str, change) -> dict | None:
        """在鎖裡讀出 meta、交給 change(meta) 原地修改、再原子寫回。"""
        with self.lock:
            meta = self.meta(song_id)
            if meta is None:
                return None
            change(meta)
            self._write_meta(song_id, meta)
            return meta

    def update_settings(self, song_id: str, settings: dict) -> dict | None:
        """存下譜面確認與編輯畫面的調整，換一台裝置也會沿用。

        每個欄位都檢查型別與範圍：這些值來自網路請求，又會在每次開曲庫時
        被讀回前端。
        """
        ranges = {"octaveOffset": (-2, 2), "minConfidence": (0, 1),
                  "minLevelDb": (-80, 0), "keyShift": (-6, 6)}

        def change(meta):
            for key, (lo, hi) in ranges.items():
                if key in settings:
                    v = _num(settings[key], lo, hi)
                    if v is not None:
                        meta[key] = int(v) if key in ("octaveOffset", "keyShift") else v
            if "favorite" in settings:
                meta["favorite"] = bool(settings["favorite"])
            if "chartEdits" in settings:
                meta["chartEdits"] = sanitize_edits(settings["chartEdits"])
        return self.update_meta(song_id, change)

    # -- 成績 ---------------------------------------------------------------

    def scores(self, song_id: str) -> list[dict]:
        folder = self.dir_of(song_id)
        if folder is None:
            return []
        try:
            data = json.loads((folder / "scores.json").read_text(encoding="utf-8"))
            return data if isinstance(data, list) else []
        except (OSError, json.JSONDecodeError):
            return []

    def add_scores(self, song_id: str, records: list[dict]) -> dict | None:
        """新增成績（可以一次多筆，舊版瀏覽器裡的成績搬過來時用），並更新
        meta 上的摘要（最佳分、次數、最後演唱時間），曲庫清單不必另外讀成績檔。"""
        clean = [r for r in (sanitize_score(x) for x in records) if r]
        with self.lock:
            folder = self.dir_of(song_id)
            if folder is None:
                return None
            rows = self.scores(song_id)
            # 同一筆（同時間、同分數）不要重複匯入
            seen = {(r.get("date"), r.get("total")) for r in rows}
            rows.extend(r for r in clean if (r["date"], r["total"]) not in seen)
            rows.sort(key=lambda r: r["date"])
            rows = rows[-MAX_SCORES:]
            write_json_atomic(folder / "scores.json", rows)

            def change(meta):
                meta["plays"] = len(rows)
                meta["best"] = max((r["total"] for r in rows), default=None)
                meta["lastSungAt"] = max((r["date"] for r in rows), default=None)
            return self.update_meta(song_id, change)

    def save_lyrics(self, song_id: str, data: dict) -> dict | None:
        """存歌詞，並在 meta 記一筆來源，讓曲庫卡片不必另外抓歌詞就知道有沒有。"""
        meta = self.meta(song_id)
        path = self.lyrics_path(song_id)
        if meta is None or path is None:
            return None
        write_json_atomic(path, data)

        def change(meta):
            meta["lyrics"] = data.get("source") if data.get("lines") else None
            # 抓歌詞時解析出來的歌手名比上傳頻道乾淨，順便記下來給搜尋用
            if (data.get("artist") or "").strip():
                meta["artist"] = data["artist"].strip()
        self.update_meta(song_id, change)
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
        folder = self.dir_of(song_id)
        if folder is None or ext not in COVER_TYPES:
            return None
        with self.lock:
            for old in COVER_TYPES:
                (folder / f"cover.{old}").unlink(missing_ok=True)
            (folder / "cover_thumb.jpg").unlink(missing_ok=True)
            tmp = folder / f".cover.{ext}.tmp"
            tmp.write_bytes(data)
            os.replace(tmp, folder / f"cover.{ext}")

            def change(meta):
                meta["cover"] = int(time.time() * 1000)
                meta["coverSource"] = source
                meta.pop("coverTried", None)
            return self.update_meta(song_id, change)

    def thumb_path(self, song_id: str, ffmpeg: str | None) -> Path | None:
        """曲庫卡片用的小封面。原圖動輒 1280×720，卡片只有兩百多像素寬。

        用程式本來就帶著的 ffmpeg 縮（不另外加圖片套件）；縮不了就回原圖。
        """
        cover = self.cover_path(song_id)
        if cover is None:
            return None
        thumb = cover.parent / "cover_thumb.jpg"
        try:
            if thumb.exists() and thumb.stat().st_mtime >= cover.stat().st_mtime:
                return thumb
        except OSError:
            pass
        if not ffmpeg:
            return cover
        tmp = cover.parent / ".cover_thumb.tmp.jpg"
        try:
            # 置中裁成正方形再縮小：卡片是正方形，16:9 的影片縮圖不裁的話
            # 會被 object-fit 切掉兩側的字
            vf = (f"crop='min(iw,ih)':'min(iw,ih)',"
                  f"scale={THUMB_SIZE}:{THUMB_SIZE}:flags=lanczos")
            kw = {}
            if os.name == "nt":
                kw["creationflags"] = 0x08000000   # CREATE_NO_WINDOW
            subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-i", str(cover),
                            "-vf", vf, "-q:v", "4", str(tmp)],
                           check=True, timeout=20, capture_output=True, **kw)
            os.replace(tmp, thumb)
            return thumb
        except Exception:  # noqa: BLE001
            tmp.unlink(missing_ok=True)
            return cover

    def mark_cover_tried(self, song_id: str) -> None:
        """自動找過但找不到：記下來，避免每次啟動都重找。"""
        self.update_meta(song_id, lambda m: m.__setitem__("coverTried", COVER_LOGIC_VERSION))

    def _write_meta(self, song_id: str, meta: dict) -> None:
        write_json_atomic(self.root / song_id / "meta.json", meta, indent=2)
        self._invalidate()

    def delete_lyrics(self, song_id: str) -> None:
        with self.lock:
            path = self.lyrics_path(song_id)
            if path and path.exists():
                path.unlink()
            self.update_meta(song_id, lambda m: m.__setitem__("lyrics", None))

    def delete(self, song_id: str) -> bool:
        folder = self.dir_of(song_id)
        if folder is None:
            return False
        with self.lock:
            shutil.rmtree(folder, ignore_errors=True)
            self._invalidate()
        return True

    # -- 備份與還原 -----------------------------------------------------------

    BACKUP_FILE_RE = re.compile(
        r"^([0-9a-z]{6,32})/(meta\.json|chart\.json|lyrics\.json|scores\.json|"
        r"cover\.(?:jpg|png|webp)|instrumental\.m4a|vocals\.m4a)$")

    def backup(self, dest, with_audio: bool = True) -> int:
        """把曲庫打包成 zip（寫到 dest，一個可寫的檔案物件），回傳歌曲數。"""
        import zipfile
        count = 0
        with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:
            for meta in self.list():
                folder = self.dir_of(meta["id"])
                if folder is None:
                    continue
                count += 1
                for f in sorted(folder.iterdir()):
                    rel = f"{meta['id']}/{f.name}"
                    if not self.BACKUP_FILE_RE.match(rel):
                        continue
                    if f.suffix == ".m4a" and not with_audio:
                        continue
                    # 音檔本身已經壓縮過，再壓只是浪費時間
                    ztype = zipfile.ZIP_STORED if f.suffix == ".m4a" else zipfile.ZIP_DEFLATED
                    zf.write(f, rel, compress_type=ztype)
        return count

    def restore(self, src) -> dict:
        """從 backup() 產生的 zip 還原。只收已知的檔名，已經存在的歌不覆蓋。"""
        import zipfile
        added, skipped = [], []
        with zipfile.ZipFile(src) as zf:
            groups: dict[str, list] = {}
            for info in zf.infolist():
                m = self.BACKUP_FILE_RE.match(info.filename)
                if m and not info.is_dir() and info.file_size < 1 << 30:
                    groups.setdefault(m.group(1), []).append(info)
            for song_id, infos in groups.items():
                names = {i.filename.split("/", 1)[1] for i in infos}
                if "meta.json" not in names or "chart.json" not in names \
                        or "instrumental.m4a" not in names:
                    skipped.append(song_id)
                    continue
                if (self.root / song_id).exists():
                    skipped.append(song_id)
                    continue
                tmp_dir = self.root / f".restore-{song_id}"
                shutil.rmtree(tmp_dir, ignore_errors=True)
                tmp_dir.mkdir(parents=True)
                try:
                    for info in infos:
                        name = info.filename.split("/", 1)[1]
                        with zf.open(info) as fin, (tmp_dir / name).open("wb") as fout:
                            shutil.copyfileobj(fin, fout, 1 << 20)
                    meta = json.loads((tmp_dir / "meta.json").read_text(encoding="utf-8"))
                    if not isinstance(meta, dict):
                        raise ValueError("meta.json 格式不對")
                    meta["id"] = song_id
                    write_json_atomic(tmp_dir / "meta.json", meta, indent=2)
                    with self.lock:
                        os.replace(tmp_dir, self.root / song_id)
                        self._invalidate()
                    added.append(song_id)
                except Exception:  # noqa: BLE001
                    shutil.rmtree(tmp_dir, ignore_errors=True)
                    skipped.append(song_id)
        return {"added": len(added), "skipped": len(skipped)}


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


def sanitize_score(raw) -> dict | None:
    """一筆成績：只留已知欄位、數值夾在範圍內。"""
    if not isinstance(raw, dict):
        return None
    total = _num(raw.get("total"), 0, 100)
    if total is None:
        return None
    date = _num(raw.get("date"), 1_000_000_000_000, 10_000_000_000_000)
    breakdown = {}
    for k, v in (raw.get("breakdown") or {}).items() if isinstance(raw.get("breakdown"), dict) else []:
        n = _num(v, 0, 100)
        if n is not None and isinstance(k, str) and len(k) <= 32:
            breakdown[k] = round(n, 2)
    techniques = {}
    tc = raw.get("techniqueCounts")
    for k, v in (tc.items() if isinstance(tc, dict) else []):
        n = _num(v, 0, 10000)
        if n is not None and isinstance(k, str) and len(k) <= 32:
            techniques[k] = int(n)
    key = _num(raw.get("keyShift"), -12, 12)
    sung = _num(raw.get("sungMs"), 0, MAX_SONG_MS)
    return {
        "date": int(date) if date is not None else int(time.time() * 1000),
        "total": round(total, 2),
        "breakdown": breakdown,
        "techniqueCounts": techniques,
        "keyShift": int(key) if key is not None else 0,
        "sungMs": int(sung) if sung is not None else None,
    }


ARTIST_NOISE = re.compile(r"[(（\[【].*?[)）\]】]|\s*-\s*topic$|\bofficial\b|\bchannel\b|vevo$", re.I)


def normalize(text: str) -> str:
    """搜尋用的正規化：全形轉半形、去掉大小寫與空白差異。"""
    return unicodedata.normalize("NFKC", text or "").casefold().replace(" ", "")
