"""server.py — 本機服務：靜態網頁 + 歌曲分析 API。

同時在內網開放 HTTP 與 HTTPS：

  http://<本機IP>:8000    方便，但**其他裝置上沒有麥克風**
  https://<本機IP>:8443   自簽憑證，接受警告後麥克風才能用

瀏覽器只在 secure context（https 或 localhost）才給 getUserMedia，
所以內網的其他裝置一定要走 https 那個網址。

所有運算都在這台電腦上：分析請求排成單一佇列依序跑 Demucs，
避免多人同時上傳把記憶體吃光。

  POST /api/analyze         body 為原始音檔位元組，檔名放 X-Filename 標頭
  POST /api/fetch           {url} 從網址下載並分析
  GET  /api/resolve?url=    這個網址的歌是不是已經在曲庫裡
  GET  /api/progress?id=    Server-Sent Events 進度回報
  GET  /api/status?id=      單次查詢進度（SSE 不可用時的備援）
  GET  /api/jobs            進行中與剛結束的工作（重新整理後接回進度用）
  POST /api/jobs/cancel     {id}
  GET  /api/songs[?q=]      曲庫清單（含歌手清單）
  GET  /api/song?id=&kind=meta|chart|instrumental|vocals|lyrics|cover|thumb
  POST /api/song/settings   {id, octaveOffset?, minConfidence?, minLevelDb?, keyShift?, favorite?, chartEdits?}
  POST /api/song/delete     {id}
  POST /api/song/cover?id=  body 為圖片位元組   使用者上傳封面（jpg/png/webp）
  POST /api/song/cover/refetch  {id}            重新自動找封面
  POST /api/lyrics/fetch    {id, title?, artist?} 自動抓（YT Music → LRCLIB → YouTube 字幕）
  POST /api/lyrics/upload   {id, lrc, name}       使用者上傳的 .lrc
  POST /api/lyrics/url      {id, url}             LRCLIB 查詢網址或 .lrc 網址
  POST /api/lyrics/offset   {id, offsetMs}        整首歌詞的時間微調
  POST /api/lyrics/delete   {id}
  GET  /api/scores?id=      這首歌的成績
  POST /api/scores          {id, record}
  POST /api/scores/import   {items: [{songId, ...}]}  舊版存在瀏覽器裡的成績搬過來
  GET  /api/latency         延遲設定檔
  POST /api/latency         {profile}
  POST /api/latency/delete  {id}
  GET  /api/backup[?audio=0]  曲庫備份 zip（只限這台電腦）
  POST /api/restore         body 為備份 zip（只限這台電腦）
  GET  /api/info[?full=1]   版本、網址、運算裝置

安全：
  - 只開放程式本身的網頁檔（白名單），憑證、曲庫、設定檔都拿不到。
  - 所有 POST 都檢查 Origin／Sec-Fetch-Site，別的網站不能代替使用者操作。
  - Host 不是 IP、localhost 或這台電腦的名稱就拒絕（擋 DNS rebinding）。
  - 臨時公開網址要帶存取碼（QR 裡就有），而且不能刪歌、備份、還原。
"""

from __future__ import annotations

import atexit
import gzip
import http.cookies
import ipaddress
import json
import mimetypes
import os
import queue
import re
import secrets
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import library
import tunnel as tunnel_mod

APP_VERSION = "2.2.0"

ROOT = Path(os.environ.get("KARAOKE_APP_ROOT", Path(__file__).resolve().parent))
# 打包成應用程式後，程式目錄是唯讀的，暫存與憑證要寫到使用者資料夾
DATA_DIR = Path(os.environ.get("KARAOKE_DATA_DIR", ROOT))
WORK = DATA_DIR / "work"           # 分析用暫存，做完就清掉
LIBRARY_DIR = DATA_DIR / "library"  # 曲庫本體，長期保存在這台電腦上
CERT_DIR = DATA_DIR / "certs"
HOST = "0.0.0.0"
HTTP_PORT = int(os.environ.get("KARAOKE_HTTP_PORT", 8000))
HTTPS_PORT = int(os.environ.get("KARAOKE_HTTPS_PORT", 8443))
MAX_UPLOAD = 200 * 1024 * 1024  # 200MB
MAX_RESTORE = 20 * 1024 * 1024 * 1024  # 備份檔可能含全部音檔
JOB_ID_RE = re.compile(r"^[0-9a-f]{12}$")
JOB_KEEP_SEC = 3600     # 結束的工作保留多久（給重新整理後的頁面查結果）

# cloudflared 之類的反向代理會加上這些標頭。看到任何一個就代表這個請求
# 是從外面轉進來的，不能當成本機。
PROXY_HEADERS = ("CF-Connecting-IP", "CF-Ray", "CF-Visitor",
                 "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto",
                 "Forwarded", "X-Real-IP")
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", ""}

# 網頁本身只需要這些檔案。其他一律 404——程式目錄裡有原始碼，
# 開發模式下憑證、曲庫、設定檔也在同一層。
STATIC_FILES = {"/": "index.html", "/index.html": "index.html",
                "/manifest.webmanifest": "manifest.webmanifest", "/icon.svg": "icon.svg"}
STATIC_DIRS = {"js": (".js", ".map"), "css": (".css",), "config": (".json",),
               "assets": (".json", ".flac", ".svg", ".png", ".woff2"),
               # 開發用的音高測試頁（README 提到的 /test/pitch-test.html）
               "test": (".html", ".js")}
TEXT_TYPES = (".html", ".js", ".css", ".json", ".svg", ".webmanifest", ".map")
CONTENT_TYPES = {".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
                 ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8",
                 ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json",
                 ".flac": "audio/flac", ".map": "application/json; charset=utf-8", ".png": "image/png", ".woff2": "font/woff2"}

JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
# 佇列裡放的是「要做什麼」：上傳的檔案，或是要先下載的網址
JOB_QUEUE: "queue.Queue[dict]" = queue.Queue()

LIBRARY = library.Library(LIBRARY_DIR)
TUNNEL = tunnel_mod.Tunnel(DATA_DIR / "tools")   # 沒裝 cloudflared 時自動下載到這裡
SETTINGS_PATH = DATA_DIR / "settings.json"
LATENCY_PATH = DATA_DIR / "latency.json"
SETTINGS_LOCK = threading.Lock()

# 公開網址的存取碼：每次建立公開網址就換一組，QR 裡帶著它。
# 拿到網址卻沒有存取碼的人只會看到說明頁。
TUNNEL_TOKEN = {"value": secrets.token_urlsafe(18)}
TOKEN_COOKIE = "karaoke_access"


def load_settings() -> dict:
    try:
        return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def save_settings(patch: dict) -> dict:
    with SETTINGS_LOCK:
        settings = {**load_settings(), **patch}
        library.write_json_atomic(SETTINGS_PATH, settings, indent=2)
        return settings


# ── 延遲設定檔 ─────────────────────────────────────────────
#
# 存在伺服器上而不是瀏覽器裡：瀏覽器的儲存空間是跟著網址走的，
# localhost、內網 https、每次都換的公開網址各算一份，存在瀏覽器裡的話
# 換個網址進來校準就全部歸零。

def load_latency() -> dict:
    try:
        data = json.loads(LATENCY_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_latency_profile(raw: dict) -> dict | None:
    if not isinstance(raw, dict):
        return None
    mic = str(raw.get("micLabel") or "未知麥克風")[:200]
    out = str(raw.get("outputLabel") or "預設輸出")[:200]
    offset = library._num(raw.get("offsetMs"), -2000, 5000)
    if offset is None:
        return None
    profile = {"id": f"{mic}｜{out}", "micLabel": mic, "outputLabel": out,
               "offsetMs": round(offset), "measuredAt": int(time.time() * 1000)}
    for key, lo, hi in (("inputMs", -2000, 5000), ("outputLatencyMs", 0, 2000),
                        ("accepted", 0, 100), ("total", 0, 100), ("spreadMs", 0, 5000)):
        v = library._num(raw.get(key), lo, hi)
        if v is not None:
            profile[key] = round(v)
    with SETTINGS_LOCK:
        data = load_latency()
        data[profile["id"]] = profile
        # 數量設上限，避免被灌爆
        if len(data) > 100:
            for k in sorted(data, key=lambda k: data[k].get("measuredAt", 0))[:len(data) - 100]:
                data.pop(k, None)
        library.write_json_atomic(LATENCY_PATH, data, indent=2)
    return profile


def delete_latency_profile(pid: str) -> None:
    with SETTINGS_LOCK:
        data = load_latency()
        data.pop(pid, None)
        library.write_json_atomic(LATENCY_PATH, data, indent=2)


# ── 網路位址與憑證 ─────────────────────────────────────────

def local_ips() -> list[str]:
    """這台電腦在內網的 IPv4 位址。對外連線用的那張網卡排第一個。

    電腦裝了 VPN、虛擬機或 Docker 時會有好幾個位址，按字母排序的話，
    QR 常常會指到手機根本連不到的那一個。
    """
    primary = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        primary = s.getsockname()[0]
        s.close()
    except OSError:
        pass
    ips: set[str] = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    others = sorted(ip for ip in ips if not ip.startswith("127.") and ip != primary)
    return ([primary] if primary and not primary.startswith("127.") else []) + others


def cert_pair_ok(cert: Path, key: Path) -> bool:
    """憑證與私鑰是不是同一對（讀得進 SSLContext 就是）。"""
    try:
        ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER).load_cert_chain(certfile=str(cert), keyfile=str(key))
        return True
    except (ssl.SSLError, OSError, ValueError):
        return False


def ensure_cert(ips: list[str], force: bool = False) -> tuple[Path, Path] | None:
    """產生涵蓋 localhost 與目前內網 IP 的自簽憑證。IP 換了、或檔案壞了就重簽。

    憑證是在 Python 裡直接簽的，不呼叫外部的 openssl 指令——Windows 上
    根本沒有那個指令，打包後的程式不能依賴它，否則內網就沒有 https，
    手機端也就不會有麥克風。

    只比對 IP 不夠：兩份程式幾乎同時啟動（連點兩下圖示，第一份還在載入）時，
    會各自重簽，一份寫的私鑰配上另一份寫的憑證，之後每次啟動都在
    load_cert_chain 炸掉、整個程式開不起來。所以沿用前一定要確認是同一對。
    """
    CERT_DIR.mkdir(parents=True, exist_ok=True)
    cert, key, stamp = CERT_DIR / "cert.pem", CERT_DIR / "key.pem", CERT_DIR / "san.txt"

    hostname = socket.gethostname()
    fingerprint = ",".join(["localhost", hostname, "127.0.0.1", *ips])

    if (not force and cert.exists() and key.exists() and stamp.exists()
            and stamp.read_text() == fingerprint and cert_pair_ok(cert, key)):
        return cert, key

    try:
        import ipaddress
        from datetime import datetime, timedelta, timezone

        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
    except ImportError:
        print("！缺少 cryptography 套件，無法產生憑證，只會開 HTTP"
              "（其他裝置不會有麥克風）")
        return None

    print("==> 產生自簽憑證（涵蓋 " + ", ".join([*ips, "localhost"]) + "）")

    names: list[x509.GeneralName] = [
        x509.DNSName("localhost"),
        x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
    ]
    if hostname:
        names.append(x509.DNSName(hostname))
    for ip in ips:
        try:
            names.append(x509.IPAddress(ipaddress.ip_address(ip)))
        except ValueError:
            continue

    key_obj = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "karaoke-scoring")])
    now = datetime.now(timezone.utc)
    cert_obj = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key_obj.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=825))
        .add_extension(x509.SubjectAlternativeName(names), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .sign(key_obj, hashes.SHA256())
    )

    # 先寫到暫存檔再換上去，寫到一半被中斷也不會留下半個檔案
    tag = f".{os.getpid()}.tmp"
    for path, data in ((key, key_obj.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption())),
            (cert, cert_obj.public_bytes(serialization.Encoding.PEM))):
        tmp = path.with_name(path.name + tag)
        tmp.write_bytes(data)
        os.replace(tmp, path)
    stamp.write_text(fingerprint)
    return cert, key


# ── 分析工作 ───────────────────────────────────────────────

class JobCancelled(Exception):
    """使用者按了取消。分析在下一次回報進度時停下來。"""


def stage_of(analysis_pct: float) -> str:
    """分析內部進度對應到畫面上的階段（analyze.py 的回報點：0.57 轉檔、0.92 標技巧）。"""
    if analysis_pct < 0.57:
        return "separate"
    if analysis_pct < 0.92:
        return "pitch"
    return "technique"


def set_progress(job_id: str, message: str, pct: float, **extra) -> None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            return
        job.update(message=message, pct=pct, **extra)
        if extra.get("state") in ("done", "error", "cancelled"):
            job["finishedAt"] = time.time()
        job["version"] += 1


def check_cancel(job_id: str) -> None:
    with JOBS_LOCK:
        cancelled = (JOBS.get(job_id) or {}).get("cancel")
    if cancelled:
        raise JobCancelled()


def purge_jobs() -> None:
    """結束超過一小時的工作就丟掉，不讓 JOBS 無限長大。"""
    now = time.time()
    with JOBS_LOCK:
        for jid in [j for j, job in JOBS.items()
                    if job.get("finishedAt") and now - job["finishedAt"] > JOB_KEEP_SEC]:
            JOBS.pop(jid, None)


def new_job(name: str, source: str, job_id: str | None = None, **fields) -> str:
    """登記一件工作並排進佇列。fields 是工作本身需要的東西（url 或 src）。"""
    purge_jobs()
    job_id = job_id or uuid.uuid4().hex[:12]
    ahead = JOB_QUEUE.qsize()
    with JOBS_LOCK:
        JOBS[job_id] = {
            "jobId": job_id, "state": "queued", "pct": 0.0, "name": name, "version": 0,
            "source": source, "stage": "download" if source == "url" else "separate",
            "createdAt": time.time(), "url": fields.get("url"),
            "message": "排隊中…" if ahead == 0 else f"排隊中（前面還有 {ahead} 首）",
        }
    JOB_QUEUE.put({"jobId": job_id, "name": name, **fields})
    return job_id


# yt-dlp 與分析程式丟出來的例外訊息是給工程師看的，轉成看得懂的說法
_FRIENDLY_ERRORS = (
    (re.compile(r"private video|私人影片", re.I), "這是私人影片，無法下載"),
    (re.compile(r"sign in to confirm your age|age-restricted", re.I), "這部影片有年齡限制，無法下載"),
    (re.compile(r"sign in to confirm you.?re not a bot", re.I),
     "YouTube 暫時擋下了下載（判定為機器人），請過一陣子再試"),
    (re.compile(r"video unavailable|not available|has been removed|此影片無法播放", re.I),
     "這部影片已下架或在你的地區無法觀看"),
    (re.compile(r"members[- ]only|join this channel", re.I), "這是頻道會員限定的影片"),
    (re.compile(r"live event|premieres in|is_live", re.I), "直播或尚未首播的影片無法下載"),
    (re.compile(r"HTTP Error 429|too many requests", re.I), "請求太頻繁，請過幾分鐘再試"),
    (re.compile(r"unable to download|timed? ?out|connection|getaddrinfo|network", re.I),
     "網路連線失敗，請確認這台電腦連得上網路"),
    (re.compile(r"ffmpeg|ffprobe", re.I), "轉檔失敗，這個檔案可能不是有效的音訊"),
    (re.compile(r"out of memory|CUDA error|MPS backend out of memory", re.I),
     "記憶體不足，請關閉其他程式後再試"),
    (re.compile(r"invalid data found|could not open|decode", re.I), "無法讀取這個音檔，格式可能不支援"),
    (re.compile(r"No module named", re.I), "程式缺少分析元件，請重新安裝唱歌評分"),
)


def friendly_error(exc: BaseException) -> str:
    text = str(exc) or type(exc).__name__
    for pattern, message in _FRIENDLY_ERRORS:
        if pattern.search(text):
            return message
    # 認不得的錯誤：去掉 yt-dlp 的「ERROR: [youtube] xxx:」前綴，只留第一行
    line = text.strip().splitlines()[0] if text.strip() else text
    line = re.sub(r"^(ERROR:\s*)?(\[[^\]]+\]\s*)?([\w-]{6,}:\s*)?", "", line)
    return (line[:160] + "…") if len(line) > 160 else line


# 貼網址時前端先 resolve、再 fetch，兩次都要問 yt-dlp。結果記幾分鐘就不必再問一次。
_PROBE_CACHE: dict[str, tuple[float, dict]] = {}
_PROBE_LOCK = threading.Lock()


def probe_cached(url: str) -> dict:
    import fetcher
    now = time.time()
    with _PROBE_LOCK:
        hit = _PROBE_CACHE.get(url)
        if hit and now - hit[0] < 600:
            return hit[1]
    meta = fetcher.probe(url)
    with _PROBE_LOCK:
        if len(_PROBE_CACHE) > 200:
            _PROBE_CACHE.clear()
        _PROBE_CACHE[url] = (now, meta)
    return meta


def run_job(job: dict) -> None:
    """一件工作 = （可選的下載）+ 分析 + 存進曲庫。"""
    job_id = job["jobId"]
    work_dir = WORK / job_id
    src = job.get("src")
    name = job.get("name") or "未命名"
    extra_meta = {}
    thumbnail = None

    def report(message, pct, **extra):
        check_cancel(job_id)
        set_progress(job_id, message, pct, **extra)

    try:
        # 1) 網址來源：先下載
        if job.get("url"):
            import fetcher
            report("取得音訊中…", 0.01, stage="download")
            got = fetcher.download(job["url"], work_dir / "download",
                                   lambda m, p: report(m, p * 0.25, stage="download"))
            src = got["path"]
            name = got["title"]
            extra_meta = {
                "source": got["platformLabel"],
                "sourceId": got["sourceId"],
                "sourceUrl": got["webpageUrl"],
                "uploader": got["uploader"],
            }
            thumbnail = got.get("thumbnail")
            report("下載完成，開始分析…", 0.26, name=name, stage="separate")

        # 2) 分離 + 抽音高 + 標技巧。延後載入讓伺服器能秒開；放在 try 裡面，
        # 載入失敗（套件壞掉）時這首標成失敗，而不是把工作執行緒整條弄死
        import analyze as analyzer
        report("載入分離模型…", 0.28, stage="separate")
        base = 0.28
        result = analyzer.analyze(
            src, work_dir,
            lambda m, p: report(m, base + p * (0.97 - base), stage=stage_of(p)))
        chart = result["chart"]
        check_cancel(job_id)

        # 3) 收進曲庫（音檔留在這台電腦上，手機要唱時才抓）
        set_progress(job_id, "收進曲庫…", 0.98, stage="technique")
        song_id = uuid.uuid4().hex[:12]
        meta = LIBRARY.add(song_id, name, chart,
                           instrumental=result["instrumental"],
                           vocals=result.get("vocals"),
                           **extra_meta)
        # 本機音檔的內嵌封面要趁原始檔還在時抽出來（finally 會清掉工作目錄）
        if not job.get("url"):
            import covers
            data = covers.embedded_cover(Path(src), work_dir)
            if data:
                LIBRARY.save_cover(song_id, data, covers.image_kind(data), "音檔內嵌")
        # 歌詞與網路封面在背景抓，不佔分析佇列（抓不到也不影響唱歌）。
        # 兩條執行緒都會改 meta.json，Library 內部用鎖串起來，不會互相蓋掉。
        threading.Thread(target=auto_lyrics, args=(song_id,), daemon=True).start()
        if job.get("url"):
            threading.Thread(target=auto_cover, args=(song_id, thumbnail), daemon=True).start()
        set_progress(job_id, "完成", 1.0, state="done",
                     songId=song_id, name=name,
                     notes=meta["notes"], techniques=meta["techniques"])
    except JobCancelled:
        set_progress(job_id, "已取消", 1.0, state="cancelled")
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        set_progress(job_id, friendly_error(exc), 1.0, state="error")
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
        print(f"[server] job {job_id} ({name}) 結束", flush=True)


LYRICS_LOCK = threading.Lock()


def auto_cover(song_id: str, thumbnail: str | None = None) -> dict | None:
    """自動找封面並存檔；找不到就記下來，下次啟動不再重找。"""
    import covers
    meta = LIBRARY.meta(song_id)
    if meta is None:
        return None
    try:
        data = covers.fetch_for(meta, thumbnail)
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        data = None
    if not data:
        LIBRARY.mark_cover_tried(song_id)
        return None
    return LIBRARY.save_cover(song_id, data, covers.image_kind(data), "自動")


def backfill_covers() -> None:
    """舊版曲庫的歌沒有封面：啟動後在背景補，一首一首慢慢來。"""
    for meta in LIBRARY.list():
        tried = meta.get("coverTried")
        if (LIBRARY.cover_path(meta["id"]) or not meta.get("sourceId")
                or (tried and int(tried) >= library.COVER_LOGIC_VERSION)):   # 舊版存的是 True（=1）
            continue
        got = auto_cover(meta["id"])
        print(f"[cover] {meta.get('name')}：{'已補上' if got else '找不到'}", flush=True)


def auto_lyrics(song_id: str, title: str | None = None, artist: str | None = None) -> dict | None:
    """自動抓歌詞並存檔。抓不到時不蓋掉已經有的歌詞（例如使用者上傳過的）。"""
    import lyrics as lyrics_mod
    meta = LIBRARY.meta(song_id)
    if meta is None:
        return None
    try:
        data = lyrics_mod.fetch_for_song(meta, title, artist)
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        return None
    with LYRICS_LOCK:
        old = LIBRARY.lyrics(song_id)
        if not data.get("lines") and old and old.get("lines"):
            return {**old, "log": data.get("log"), "fetchError": data.get("note")}
        if old:
            data["offsetMs"] = old.get("offsetMs", 0)
        LIBRARY.save_lyrics(song_id, data)
    print(f"[lyrics] {meta.get('name')}：{data.get('source') or '找不到'}", flush=True)
    return data


def worker_loop() -> None:
    """單一工作執行緒：Demucs 很吃資源，多人同時上傳就排隊依序處理。"""
    while True:
        job = JOB_QUEUE.get()
        try:
            with JOBS_LOCK:
                state = JOBS.get(job["jobId"], {})
                skip = state.get("cancel") or state.get("state") == "cancelled"
                waiting = JOB_QUEUE.qsize()
                for other in JOBS.values():
                    if other.get("state") == "queued" and other is not state:
                        other["message"] = f"排隊中（前面還有 {waiting} 首）"
                        other["version"] += 1
            if skip:
                set_progress(job["jobId"], "已取消", 1.0, state="cancelled")
                if job.get("src"):
                    shutil.rmtree(WORK / job["jobId"], ignore_errors=True)
                continue
            set_progress(job["jobId"], "開始處理…", 0.01, state="running")
            run_job(job)
        except Exception as exc:  # noqa: BLE001
            # 這是唯一的工作執行緒：不管發生什麼都不能讓它結束，
            # 否則之後加的每一首歌都會永遠停在「開始處理…」
            traceback.print_exc()
            set_progress(job["jobId"], friendly_error(exc), 1.0, state="error")
        finally:
            JOB_QUEUE.task_done()
            purge_jobs()


def public_job(job: dict) -> dict:
    return {k: job.get(k) for k in ("jobId", "name", "state", "pct", "message", "stage",
                                     "songId", "source", "createdAt")}


# ── HTTP 處理 ──────────────────────────────────────────────

class _Cache:
    """靜態檔（含 gzip 版本）快取在記憶體：檔案改了（修改時間或大小變了）才重讀。"""

    def __init__(self):
        self.lock = threading.Lock()
        self.items: dict[str, tuple] = {}

    def get(self, path: Path):
        st = path.stat()
        key = str(path)
        stamp = (st.st_mtime_ns, st.st_size)
        with self.lock:
            hit = self.items.get(key)
            if hit and hit[0] == stamp:
                return hit[1], hit[2], hit[3]
        data = path.read_bytes()
        etag = f'"{st.st_mtime_ns:x}-{st.st_size:x}"'
        gz = (gzip.compress(data, 6)
              if path.suffix in TEXT_TYPES and len(data) > 1024 else None)
        with self.lock:
            self.items[key] = (stamp, data, gz, etag)
        return data, gz, etag


STATIC_CACHE = _Cache()


# ── 前端打包檔 ─────────────────────────────────────────────
#
# `npm run build`（scripts/build.mjs）會把所有 ES 模組打包成 js/app.bundle.js，
# 並把原始碼的雜湊寫進 js/app.bundle.meta.json。打包檔只在「雜湊與目前的
# 原始碼一致」時才送：開發時改了任何一支 js 而沒重新打包，就自動退回逐支
# 載入，不會跑到舊程式。沒有打包檔（直接從原始碼執行）也完全能用。

BUNDLE_JS = ROOT / "js" / "app.bundle.js"
BUNDLE_META = ROOT / "js" / "app.bundle.meta.json"
_BUNDLE = {"stamp": None, "hash": None}
_BUNDLE_LOCK = threading.Lock()
MODULES_BLOCK = re.compile(rb"<!-- modules:start -->.*?<!-- modules:end -->", re.S)


def _bundle_sources() -> list[Path]:
    out = []
    for path in (ROOT / "js").rglob("*.js"):
        if not path.name.startswith("app.bundle"):
            out.append(path)
    return out


def bundle_source_hash() -> str:
    """與 scripts/build.mjs 的 sourceHash() 相同：依相對路徑排序，逐一雜湊路徑與內容。"""
    import hashlib
    h = hashlib.sha256()
    files = sorted(p.relative_to(ROOT).as_posix() for p in _bundle_sources())
    for rel in files:
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        h.update((ROOT / rel).read_bytes())
        h.update(b"\0")
    return h.hexdigest()


def current_bundle() -> str | None:
    """打包檔可用就回傳它的版本（原始碼雜湊），否則 None。結果依檔案修改時間快取。"""
    try:
        if not BUNDLE_JS.is_file() or not BUNDLE_META.is_file():
            return None
        stamp = tuple(sorted((str(p), p.stat().st_mtime_ns, p.stat().st_size)
                             for p in [*_bundle_sources(), BUNDLE_JS, BUNDLE_META]))
        with _BUNDLE_LOCK:
            if _BUNDLE["stamp"] == stamp:
                return _BUNDLE["hash"]
        expected = json.loads(BUNDLE_META.read_text(encoding="utf-8")).get("sourceHash")
        actual = bundle_source_hash()
        ok = actual if expected == actual else None
        if not ok:
            print("[server] js/app.bundle.js 跟原始碼對不上（改過程式但沒重新打包），改送原始模組", flush=True)
        with _BUNDLE_LOCK:
            _BUNDLE.update(stamp=stamp, hash=ok)
        return ok
    except (OSError, ValueError):
        return None


def index_html() -> tuple[bytes, bytes | None, str]:
    """首頁。有可用的打包檔時，把逐支載入的那一段換成單一的打包檔。"""
    data, gz, etag = STATIC_CACHE.get(ROOT / "index.html")
    version = current_bundle()
    if not version:
        return data, gz, etag
    tag = f'<script type="module" src="js/app.bundle.js?v={version[:12]}"></script>'.encode()
    html = MODULES_BLOCK.sub(lambda _m: tag, data, count=1)
    return html, gzip.compress(html, 6), f'{etag[:-1]}-b{version[:12]}"'


class Handler(BaseHTTPRequestHandler):
    # HTTP/1.1 才能保持連線：內網 https 下每個請求都重新握手很慢
    protocol_version = "HTTP/1.1"
    server_version = "KaraokeScoring"
    sys_version = ""
    timeout = 120   # 閒置的保持連線最多佔一條執行緒兩分鐘

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or ""):
            super().log_message(fmt, *args)

    # -- 回應工具 ------------------------------------------------------------

    def _accepts_gzip(self) -> bool:
        return "gzip" in (self.headers.get("Accept-Encoding") or "").lower()

    def _send_bytes(self, data: bytes, content_type: str, status: int = 200,
                    etag: str | None = None, cache: str = "no-store",
                    gz: bytes | None = None, extra: dict | None = None):
        if etag and self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", cache)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        body = data
        encoded = False
        if self._accepts_gzip() and len(data) > 1024 and (
                gz is not None or content_type.startswith(("application/json", "text/", "image/svg"))):
            body = gz if gz is not None else gzip.compress(data, 6)
            encoded = True
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("Vary", "Accept-Encoding")
        if encoded:
            self.send_header("Content-Encoding", "gzip")
        if etag:
            self.send_header("ETag", etag)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self._send_bytes(body, "application/json; charset=utf-8", status)

    def _html(self, html: str, status: int):
        self._send_bytes(html.encode("utf-8"), "text/html; charset=utf-8", status)

    def _not_found(self):
        self._json({"error": "找不到"}, 404)

    def _query(self):
        parsed = urllib.parse.urlparse(self.path)
        return parsed.path, urllib.parse.parse_qs(parsed.query)

    def _job_id(self, query) -> str | None:
        """只接受伺服器自己發出的 id 格式，避免被拿來讀取任意路徑。"""
        job_id = (query.get("id") or [""])[0]
        return job_id if JOB_ID_RE.match(job_id) else None

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("X-Content-Type-Options", "nosniff")
        # 公開網址帶著存取碼，不能經由 Referer 外流
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    # -- 身分判斷 -------------------------------------------------------------

    def is_proxied(self) -> bool:
        """從臨時公開網址（cloudflared）轉進來的請求。"""
        return any(self.headers.get(h) for h in PROXY_HEADERS)

    def _host(self) -> str:
        host = (self.headers.get("Host") or "").strip().lower()
        if host.startswith("["):
            return host[1:host.find("]")] if "]" in host else host
        return host.rsplit(":", 1)[0] if host.count(":") == 1 else host

    def is_local(self) -> bool:
        """請求是不是真的從這台電腦本身來的。

        QR code 與「建立公開網址」只對本機開放：手機是掃 QR 進來的，
        自己不需要再看到一次；而把整台機器公開到網際網路這種事，
        也不該讓內網或外面的人代為決定。

        只看連線來源 IP 是不夠的——cloudflared 是在本機轉發，所以從公開
        網址進來的請求，socket 來源同樣是 127.0.0.1。必須再排除帶有
        代理標頭、或 Host 不是本機的請求，否則拿到公開網址的人就能
        操控這台電腦的 tunnel。
        """
        if self.client_address[0] not in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
            return False
        if self.is_proxied():
            return False
        return self._host() in LOCAL_HOSTS

    def host_allowed(self) -> bool:
        """擋 DNS rebinding：惡意網域解析到 127.0.0.1 時，Host 會是那個網域。

        IP 位址、localhost、這台電腦的名稱（含 .local）才放行；公開網址另有
        存取碼把關。
        """
        if self.is_proxied():
            return True
        host = self._host()
        if host in LOCAL_HOSTS:
            return True
        try:
            ipaddress.ip_address(host)
            return True
        except ValueError:
            pass
        name = socket.gethostname().lower()
        return host in (name, f"{name}.local") or host.endswith(".local")

    def cross_site(self) -> bool:
        """別的網站透過使用者的瀏覽器送來的請求（CSRF）。

        瀏覽器一定會帶 Origin 或 Sec-Fetch-Site；兩個都沒有的是 curl 之類
        的工具，那本來就不是 CSRF 的管道。
        """
        site = (self.headers.get("Sec-Fetch-Site") or "").lower()
        if site == "cross-site":
            return True
        origin = self.headers.get("Origin")
        if origin is None:
            return False
        if origin == "null":
            return True
        netloc = urllib.parse.urlparse(origin).netloc.lower()
        return netloc != (self.headers.get("Host") or "").strip().lower()

    def token_gate(self) -> bool:
        """公開網址的存取碼。回傳 True 表示這個請求已經處理掉（被擋或被轉址）。"""
        if not self.is_proxied():
            return False
        token = TUNNEL_TOKEN["value"]
        cookie = http.cookies.SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie") or "")
        except http.cookies.CookieError:
            pass
        got = cookie.get(TOKEN_COOKIE)
        if got and secrets.compare_digest(got.value, token):
            return False
        path, query = self._query()
        given = (query.get("k") or [""])[0]
        if given and secrets.compare_digest(given, token):
            rest = {k: v for k, v in query.items() if k != "k"}
            target = path + ("?" + urllib.parse.urlencode(rest, doseq=True) if rest else "")
            self.send_response(302)
            self.send_header("Location", target or "/")
            self.send_header("Set-Cookie", f"{TOKEN_COOKIE}={token}; Path=/; Max-Age=604800; "
                                           "HttpOnly; Secure; SameSite=Lax")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return True
        if path.startswith("/api/"):
            self._json({"error": "這個公開網址需要存取碼，請重新掃描電腦上的 QR 碼"}, 403)
        else:
            self._html(
                "<!doctype html><meta charset='utf-8'><meta name='viewport' "
                "content='width=device-width,initial-scale=1'><title>唱歌評分</title>"
                "<body style='font-family:system-ui,sans-serif;padding:32px;line-height:1.7'>"
                "<h2>需要存取碼</h2><p>這個公開網址只接受從電腦上「手機連線」頁面的 QR 碼"
                "（或完整網址）進入。請重新掃描 QR 碼。</p></body>", 403)
        return True

    def guard(self) -> bool:
        """所有請求共用的檢查。回傳 True 表示已經回應（擋掉了）。"""
        if not self.host_allowed():
            self._json({"error": "不接受這個主機名稱"}, 403)
            return True
        return self.token_gate()

    # -- 路由 --------------------------------------------------------------

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 4 << 20:
            return {}
        self._body_read = True
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            return data if isinstance(data, dict) else {}
        except (ValueError, UnicodeDecodeError):
            return {}

    def do_POST(self):
        self._body_read = False
        try:
            if self.guard():
                return
            if self.cross_site():
                self._json({"error": "拒絕來自其他網站的請求"}, 403)
                return
            self._do_post()
        finally:
            # 保持連線時，沒讀完的請求內容會被當成下一個請求的開頭。
            # 提早回錯誤而沒讀內容的話，這條連線就不要再用了。
            if not self._body_read and int(self.headers.get("Content-Length") or 0) > 0:
                self.close_connection = True

    def _local_only(self) -> bool:
        if not self.is_local():
            self._json({"error": "只能從這台電腦操作"}, 403)
            return False
        return True

    def _not_public(self, what: str) -> bool:
        """公開網址上不開放的破壞性操作。"""
        if self.is_proxied():
            self._json({"error": f"公開網址不能{what}，請在同一個 Wi-Fi 或這台電腦上操作"}, 403)
            return False
        return True

    def _do_post(self):
        path, _ = self._query()

        if path in ("/api/quit", "/api/restart"):
            # 手機連進來的人不該能關掉別人的電腦
            if not self._local_only():
                return
            restart = path == "/api/restart"
            if restart and not can_restart():
                self._json({"error": "開發模式不支援自動重新啟動，請手動重開"}, 400)
                return
            self.close_connection = True
            self._json({"ok": True})
            threading.Thread(target=quit_app, args=(restart,), daemon=True).start()
            return

        if path.startswith("/api/gpu/"):
            # 下載 2.5GB、改動這台電腦的安裝內容，只給本機操作
            if not self._local_only():
                return
            import gpu_pack
            action = {"/api/gpu/start": gpu_pack.PACK.start,
                      "/api/gpu/cancel": gpu_pack.PACK.cancel,
                      "/api/gpu/remove": gpu_pack.PACK.remove}.get(path)
            if action is None:
                self._not_found()
                return
            result = action()
            self._json(result, 400 if "error" in result else 200)
            return

        if path.startswith("/api/tunnel/"):
            if not self._local_only():
                return
            if path == "/api/tunnel/start":
                if not TUNNEL.running:   # 每次新網址都換存取碼；已經開著就沿用
                    TUNNEL_TOKEN["value"] = secrets.token_urlsafe(18)
                self._json(tunnel_status(TUNNEL.start(INFO.get("httpPort", HTTP_PORT))))
            elif path == "/api/tunnel/stop":
                self._json(tunnel_status(TUNNEL.stop()))
            else:
                self._not_found()
            return

        if path == "/api/settings":
            if not self._local_only():
                return
            body = self._read_json_body()
            patch = {k: bool(v) for k, v in body.items()
                     if k in ("tunnelOnStart", "gpuPromptAnswered")}
            self._json(save_settings(patch))
            return

        if path == "/api/restore":
            if self._local_only() and self._not_public("還原"):
                self.handle_restore()
            return

        if path == "/api/fetch":
            self.handle_fetch()
            return
        if path == "/api/jobs/cancel":
            job_id = str(self._read_json_body().get("id", ""))
            with JOBS_LOCK:
                job = JOBS.get(job_id)
                if job and job.get("state") in ("queued", "running"):
                    job["cancel"] = True
                    job["message"] = "取消中…（會在目前這個步驟結束後停下）" \
                        if job["state"] == "running" else "已取消"
                    if job["state"] == "queued":
                        job["state"] = "cancelled"
                        job["finishedAt"] = time.time()
                    job["version"] += 1
            self._json({"ok": bool(job)}, 200 if job else 404)
            return
        if path == "/api/song/settings":
            body = self._read_json_body()
            meta = LIBRARY.update_settings(str(body.get("id", "")), body)
            self._json(meta or {"error": "找不到歌曲"}, 200 if meta else 404)
            return
        if path.startswith("/api/lyrics/"):
            self.handle_lyrics(path)
            return
        if path == "/api/song/cover":
            self.handle_cover_upload()
            return
        if path == "/api/song/cover/refetch":
            song_id = str(self._read_json_body().get("id", ""))
            if LIBRARY.meta(song_id) is None:
                self._json({"error": "找不到歌曲"}, 404)
                return
            meta = auto_cover(song_id)
            self._json(meta or {"error": "找不到這首歌的封面"}, 200 if meta else 404)
            return
        if path == "/api/song/delete":
            if not self._not_public("刪歌"):
                return
            body = self._read_json_body()
            ok = LIBRARY.delete(str(body.get("id", "")))
            self._json({"ok": ok}, 200 if ok else 404)
            return

        if path == "/api/scores":
            body = self._read_json_body()
            meta = LIBRARY.add_scores(str(body.get("id", "")), [body.get("record")])
            self._json(meta or {"error": "找不到歌曲"}, 200 if meta else 404)
            return
        if path == "/api/scores/import":
            body = self._read_json_body()
            groups: dict[str, list] = {}
            for item in (body.get("items") or [])[:5000]:
                if isinstance(item, dict):
                    groups.setdefault(str(item.get("songId", "")), []).append(item)
            imported = sum(1 for sid, rows in groups.items() if LIBRARY.add_scores(sid, rows))
            self._json({"ok": True, "songs": imported})
            return
        if path == "/api/latency":
            profile = save_latency_profile(self._read_json_body().get("profile"))
            self._json(profile or {"error": "設定檔格式不對"}, 200 if profile else 400)
            return
        if path == "/api/latency/delete":
            delete_latency_profile(str(self._read_json_body().get("id", "")))
            self._json({"ok": True})
            return

        if path != "/api/analyze":
            self._not_found()
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            self._json({"error": "沒有收到檔案"}, 400)
            return
        if length > MAX_UPLOAD:
            self._json({"error": "檔案超過 200MB"}, 413)
            return

        name = urllib.parse.unquote(self.headers.get("X-Filename", "song"))[:200]
        suffix = Path(name).suffix.lower()
        if not re.fullmatch(r"\.[a-z0-9]{1,5}", suffix):
            suffix = ".mp3"

        # 先決定工作編號、把檔案收進它的工作目錄，收完才排進佇列——
        # 否則工作執行緒可能在檔案還沒到齊時就開始處理
        job_id = uuid.uuid4().hex[:12]
        work_dir = WORK / job_id
        work_dir.mkdir(parents=True, exist_ok=True)
        src = work_dir / f"input{suffix}"
        if not self._receive(src, length):
            shutil.rmtree(work_dir, ignore_errors=True)
            return
        title = Path(name).stem or name
        new_job(title, "upload", job_id=job_id, src=src)
        self._json({"jobId": job_id, "name": title})

    def _receive(self, dest: Path, length: int) -> bool:
        """把請求內容串流寫進檔案。連線中斷就回 False。"""
        self._body_read = True
        remaining = length
        with dest.open("wb") as fh:
            while remaining > 0:
                chunk = self.rfile.read(min(1 << 20, remaining))
                if not chunk:
                    break
                fh.write(chunk)
                remaining -= len(chunk)
        if remaining > 0:
            self.close_connection = True
            return False
        return True

    def handle_restore(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_RESTORE:
            self._json({"error": "備份檔大小不對"}, 400)
            return
        WORK.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix="restore-", suffix=".zip", dir=str(WORK))
        os.close(fd)
        tmp_path = Path(tmp)
        try:
            if not self._receive(tmp_path, length):
                return
            try:
                result = LIBRARY.restore(tmp_path)
            except Exception as exc:  # noqa: BLE001
                self._json({"error": f"這不是有效的備份檔：{exc}"}, 400)
                return
            self._json(result)
        finally:
            tmp_path.unlink(missing_ok=True)

    def handle_cover_upload(self):
        """使用者上傳封面。只收 jpg/png/webp（看檔頭），8MB 以內。"""
        import covers
        _, query = self._query()
        song_id = (query.get("id") or [""])[0]
        if LIBRARY.meta(song_id) is None:
            self._json({"error": "找不到歌曲"}, 404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > covers.MAX_BYTES:
            self._json({"error": "圖片要在 8MB 以內"}, 413 if length else 400)
            return
        self._body_read = True
        data = self.rfile.read(length)
        kind = covers.image_kind(data)
        if kind is None:
            self._json({"error": "只支援 JPG、PNG、WebP 圖片"}, 400)
            return
        self._json(LIBRARY.save_cover(song_id, data, kind, "使用者上傳"))

    def handle_lyrics(self, path: str):
        import lyrics as lyrics_mod
        body = self._read_json_body()
        song_id = str(body.get("id", ""))
        meta = LIBRARY.meta(song_id)
        if meta is None:
            self._json({"error": "找不到歌曲"}, 404)
            return

        if path == "/api/lyrics/fetch":
            title = str(body.get("title") or "").strip()[:200] or None
            artist = str(body.get("artist") or "").strip()[:200] or None
            data = auto_lyrics(song_id, title, artist)
            self._json(data or {"error": "抓取失敗"}, 200 if data else 502)
            return

        if path in ("/api/lyrics/upload", "/api/lyrics/url"):
            old = LIBRARY.lyrics(song_id) or {}
            try:
                if path == "/api/lyrics/upload":
                    data = lyrics_mod.from_user(
                        meta, lrc_text=str(body.get("lrc", "")), name=str(body.get("name", ""))[:200],
                        title=old.get("title", ""), artist=old.get("artist", ""))
                else:
                    data = lyrics_mod.from_user(
                        meta, url=str(body.get("url", ""))[:2000],
                        title=old.get("title", ""), artist=old.get("artist", ""))
            except lyrics_mod.LyricsError as exc:
                self._json({"error": str(exc)}, 400)
                return
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                self._json({"error": f"處理歌詞失敗：{friendly_error(exc)}"}, 500)
                return
            with LYRICS_LOCK:
                LIBRARY.save_lyrics(song_id, data)
            self._json(data)
            return

        if path == "/api/lyrics/offset":
            try:
                offset = max(-15000, min(15000, int(float(body.get("offsetMs", 0)))))
            except (TypeError, ValueError):
                self._json({"error": "offsetMs 不是數字"}, 400)
                return
            with LYRICS_LOCK:
                data = LIBRARY.lyrics(song_id)
                if data is None:
                    self._json({"error": "這首歌還沒有歌詞"}, 404)
                    return
                data["offsetMs"] = offset
                LIBRARY.save_lyrics(song_id, data)
            self._json({"ok": True, "offsetMs": offset})
            return

        if path == "/api/lyrics/delete":
            with LYRICS_LOCK:
                LIBRARY.delete_lyrics(song_id)
            self._json({"ok": True})
            return

        self._not_found()

    def handle_fetch(self):
        """從網址下載並分析。已經下載過的直接回傳既有那首，不重跑。"""
        body = self._read_json_body()
        url = str(body.get("url", "")).strip()
        if not url:
            self._json({"error": "沒有收到網址"}, 400)
            return

        import fetcher
        if fetcher.platform_of(url) is None:
            self._json({"error": "只支援 YouTube、YouTube Music 與 Bilibili 的網址"}, 400)
            return

        try:
            meta = probe_cached(url)
        except Exception as exc:  # noqa: BLE001
            self._json({"error": f"讀取這個網址失敗：{friendly_error(exc)}"}, 502)
            return

        existing = LIBRARY.find_by_source(meta["sourceId"])
        if existing:
            # 已經下載過了——直接把那首歌回給前端顯示成卡片
            self._json({"existing": existing, "meta": meta})
            return

        # 同一個網址已經在排隊或處理中，不要再排一次
        with JOBS_LOCK:
            for job in JOBS.values():
                if job.get("url") == url and job.get("state") in ("queued", "running"):
                    self._json({"jobId": job["jobId"], "name": job["name"], "meta": meta})
                    return

        job_id = new_job(meta["title"], "url", url=url)
        self._json({"jobId": job_id, "name": meta["title"], "meta": meta})

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if self.guard():
            return
        path, query = self._query()

        if not path.startswith("/api/"):
            self.serve_static(path)
            return

        job_id = self._job_id(query)
        with JOBS_LOCK:
            job = dict(JOBS.get(job_id, {})) if job_id else {}

        if path == "/api/status":
            self._json(public_job(job)) if job else self._json({"error": "找不到工作"}, 404)
            return

        if path == "/api/progress":
            if not job:
                self._json({"error": "找不到工作"}, 404)
                return
            self.stream_progress(job_id)
            return

        if path == "/api/jobs":
            purge_jobs()
            with JOBS_LOCK:
                jobs = [public_job(j) for j in JOBS.values()]
            jobs.sort(key=lambda j: j.get("createdAt") or 0)
            self._json({"jobs": jobs})
            return

        if path == "/api/songs":
            # 曲庫清單。只回中繼資料，音檔要另外抓——手機開曲庫時
            # 不該把幾百 MB 的音軌一起拉下來。歌手清單用同一份資料算，
            # 不必再讀一次磁碟。
            songs = LIBRARY.list()
            q = (query.get("q") or [""])[0]
            for m in songs:
                m.pop("chartEdits", None)   # 清單用不到，又可能很大
            self._json({"songs": LIBRARY.search(q) if q else songs,
                        "artists": LIBRARY.artists(songs)})
            return

        if path == "/api/song":
            song_id = (query.get("id") or [""])[0]
            kind = (query.get("kind") or ["meta"])[0]

            if kind == "meta":
                meta = LIBRARY.meta(song_id)
                self._json(meta or {"error": "找不到歌曲"}, 200 if meta else 404)
                return

            if kind in ("cover", "thumb"):
                cover = (LIBRARY.thumb_path(song_id, ffmpeg_path()) if kind == "thumb"
                         else LIBRARY.cover_path(song_id))
                if cover is None:
                    self._json({"error": "沒有封面"}, 404)
                    return
                ctype = library.COVER_TYPES.get(cover.suffix[1:], "image/jpeg")
                self._send_file(cover, ctype)
                return

            if kind == "lyrics":
                data = LIBRARY.lyrics(song_id)
                self._json(data or {"error": "還沒有歌詞"}, 200 if data else 404)
                return

            if kind == "chart":
                chart = LIBRARY.chart_path(song_id)
                if chart is None:
                    self._json({"error": "找不到譜面"}, 404)
                    return
                data, gz, etag = STATIC_CACHE.get(chart)
                self._send_bytes(data, "application/json; charset=utf-8",
                                 etag=etag, cache="no-cache", gz=gz)
                return

            stem = LIBRARY.stem_path(song_id, kind)
            if stem is None:
                self._json({"error": "找不到音軌"}, 404)
                return
            self._send_file(stem, "audio/mp4")
            return

        if path == "/api/scores":
            song_id = (query.get("id") or [""])[0]
            self._json({"scores": LIBRARY.scores(song_id)})
            return

        if path == "/api/latency":
            self._json({"profiles": sorted(load_latency().values(),
                                           key=lambda p: -p.get("measuredAt", 0))})
            return

        if path == "/api/backup":
            if self._local_only() and self._not_public("備份"):
                self.send_backup((query.get("audio") or ["1"])[0] != "0")
            return

        if path == "/api/resolve":
            # 貼上網址時先問一次：這首已經在曲庫裡了嗎？
            url = (query.get("url") or [""])[0].strip()
            import fetcher
            if fetcher.platform_of(url) is None:
                self._json({"error": "只支援 YouTube、YouTube Music 與 Bilibili 的網址"}, 400)
                return
            try:
                meta = probe_cached(url)
            except Exception as exc:  # noqa: BLE001
                self._json({"error": f"讀取這個網址失敗：{friendly_error(exc)}"}, 502)
                return
            self._json({"meta": meta, "existing": LIBRARY.find_by_source(meta["sourceId"])})
            return

        if path == "/api/tunnel":
            self._json(tunnel_status(TUNNEL.status()) if self.is_local()
                       else {"available": False, "running": False})
            return

        if path == "/api/qr":
            # 只產生伺服器自己知道的網址，不接受任意輸入
            target = (query.get("target") or ["lan"])[0]
            if not self.is_local():
                self._json({"error": "只能從這台電腦操作"}, 403)
                return
            try:
                idx = int((query.get("i") or ["0"])[0])
            except ValueError:
                idx = 0
            lan = INFO.get("lanUrls") or []
            url = {"lan": lan[idx] if 0 <= idx < len(lan) else None,
                   "tunnel": tunnel_share_url()}.get(target)
            if not url:
                self._json({"error": "目前沒有可用的網址"}, 404)
                return
            self._send_bytes(make_qr_svg(url), "image/svg+xml; charset=utf-8")
            return

        if path == "/api/gpu":
            import gpu_pack
            st = gpu_pack.PACK.status()
            st["isLocal"] = self.is_local()
            st["canRestart"] = can_restart()
            st["promptAnswered"] = bool(load_settings().get("gpuPromptAnswered"))
            self._json(st)
            return

        if path == "/api/info":
            local = self.is_local()
            full = (query.get("full") or ["0"])[0] == "1"
            info = server_info(local, full and local)
            info["public"] = self.is_proxied()
            self._json(info)
            return

        self._not_found()

    # -- 靜態檔 -------------------------------------------------------------

    def serve_static(self, path: str):
        rel = STATIC_FILES.get(path)
        if rel is None:
            rel = urllib.parse.unquote(path).lstrip("/")
            parts = rel.split("/")
            allowed = STATIC_DIRS.get(parts[0]) if len(parts) > 1 else None
            if (not allowed or "\\" in rel or "\0" in rel
                    or any(p in ("", ".", "..") or p.startswith(".") for p in parts)
                    or not rel.endswith(allowed)):
                self._not_found()
                return
        full = ROOT / rel
        try:
            if ROOT.resolve() not in full.resolve().parents or not full.is_file():
                self._not_found()
                return
            if rel == "index.html":
                data, gz, etag = index_html()
            else:
                data, gz, etag = STATIC_CACHE.get(full)
        except OSError:
            self._not_found()
            return
        suffix = full.suffix
        ctype = CONTENT_TYPES.get(suffix) or mimetypes.guess_type(full.name)[0] \
            or "application/octet-stream"
        # 改了 js/css 之後瀏覽器卻還在跑快取的舊檔，看到的行為與程式碼對不起來——
        # 原始檔一律要求重新驗證（沒改動就回 304，成本很低）；鋼琴取樣這種
        # 不會變的大檔才給長快取。
        cache = "no-cache" if suffix in TEXT_TYPES else "public, max-age=604800"
        self._send_bytes(data, ctype, etag=etag, cache=cache, gz=gz)

    def _send_file(self, path: Path, content_type: str):
        """串流送出檔案，附上 ETag 讓手機第二次進來可以直接用快取，並支援 Range。"""
        stat = path.stat()
        etag = f'"{int(stat.st_mtime)}-{stat.st_size}"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        size = stat.st_size
        start, end = 0, size - 1
        status = 200
        rng = self.headers.get("Range")
        if rng and (self.headers.get("If-Range") in (None, etag)):
            m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng.strip())
            if m and (m.group(1) or m.group(2)):
                if m.group(1):
                    start = int(m.group(1))
                    end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
                else:   # bytes=-N：最後 N 個位元組
                    start = max(0, size - int(m.group(2)))
                if start > end or start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                status = 206
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "private, max-age=31536000")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command == "HEAD":
            return
        with path.open("rb") as fh:
            fh.seek(start)
            remaining = length
            while remaining > 0:
                chunk = fh.read(min(1 << 20, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def send_backup(self, with_audio: bool):
        WORK.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix="backup-", suffix=".zip", dir=str(WORK))
        try:
            with os.fdopen(fd, "wb") as fh:
                LIBRARY.backup(fh, with_audio)
            stamp = time.strftime("%Y%m%d-%H%M")
            size = os.path.getsize(tmp)
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Disposition",
                             f'attachment; filename="karaoke-library-{stamp}.zip"')
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            with open(tmp, "rb") as fh:
                shutil.copyfileobj(fh, self.wfile, 1 << 20)
        finally:
            Path(tmp).unlink(missing_ok=True)

    def stream_progress(self, job_id: str):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        # 長連線串流沒有 Content-Length，結束後這條連線就不能再重用
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()
        last_version = -1
        last_send = time.time()
        try:
            while True:
                with JOBS_LOCK:
                    job = dict(JOBS.get(job_id, {}))
                if not job:
                    break
                if job["version"] != last_version:
                    last_version = job["version"]
                    payload = json.dumps(public_job(job), ensure_ascii=False)
                    self.wfile.write(f"data: {payload}\n\n".encode("utf-8"))
                    self.wfile.flush()
                    last_send = time.time()
                    if job.get("state") in ("done", "error", "cancelled"):
                        break
                elif time.time() - last_send > 15:
                    # 心跳：代理（cloudflared）會切掉太久沒有資料的連線
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    last_send = time.time()
                threading.Event().wait(0.25)
        except (BrokenPipeError, ConnectionResetError, ssl.SSLError, OSError):
            pass


def ffmpeg_path() -> str | None:
    """與 analyze.ffmpeg_bin() 相同的規則，但不載入 analyze（它會拉進 librosa，很慢）。"""
    bundled = os.environ.get("KARAOKE_FFMPEG")
    if bundled and Path(bundled).exists():
        return bundled
    return shutil.which("ffmpeg")


def tunnel_share_url() -> str | None:
    url = TUNNEL.url
    return f"{url.rstrip('/')}/?k={TUNNEL_TOKEN['value']}" if url else None


def tunnel_status(st: dict) -> dict:
    st = dict(st or {})
    if st.get("url"):
        st["shareUrl"] = tunnel_share_url()
    return st


INFO: dict = {"lanUrls": [], "httpPort": HTTP_PORT, "httpsPort": HTTPS_PORT}


def make_qr_svg(url: str) -> bytes:
    """把網址畫成 QR。用 segno（純 Python、零相依），不連外。"""
    import io

    import segno

    qr = segno.make(url, error="m")
    buf = io.BytesIO()
    qr.save(buf, kind="svg", scale=1, border=2,
            dark="#07070d", light="#ffffff", xmldecl=False, svgns=True)
    svg = buf.getvalue().decode("utf-8")

    # segno 會寫死 width/height，塞進版面時會維持 29px 這種原始尺寸。
    # 換成 viewBox，讓 CSS 能自由放大而不失真。
    side = qr.symbol_size(scale=1, border=2)[0]
    svg = re.sub(r'width="\d+" height="\d+"',
                 f'viewBox="0 0 {side} {side}" preserveAspectRatio="xMidYMid meet"',
                 svg, count=1)
    return svg.encode("utf-8")


def server_info(local: bool, full: bool = False) -> dict:
    """給介面顯示的資訊。

    一般的請求只回便宜的欄位，開頁時不必等 torch 載入或裝置探測；
    運算裝置與套件版本要 full=1 才算，而且只給這台電腦看——手機或公開網址
    上的人不需要知道這台電腦的內網位址與硬體。
    """
    info = {"pid": os.getpid(),   # 重新啟動時，網頁靠這個分辨新舊行程
            "version": APP_VERSION, "isLocal": local,
            "songs": len(LIBRARY.list())}
    if not local:
        return info
    info.update(INFO)
    info["settings"] = load_settings()
    if full:
        try:
            import analyze as analyzer
            info["devices"] = analyzer.describe_devices()
            info["device"] = analyzer.pick_device()
        except Exception as exc:  # noqa: BLE001
            info["devices"] = []
            info["device"] = f"（尚未初始化：{exc}）"
        try:
            import fetcher
            info["downloader"] = fetcher.version()
        except Exception:  # noqa: BLE001
            info["downloader"] = "未安裝"
    return info


def find_free_port(preferred: int) -> int:
    """連接埠被占用就往後找，避免使用者已經開了另一份。"""
    for port in range(preferred, preferred + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((HOST, port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"{preferred} 之後 20 個連接埠都被占用")


def serve(port: int, tls: tuple[Path, Path] | None) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((HOST, port), Handler)
    if tls:
        try:
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(certfile=str(tls[0]), keyfile=str(tls[1]))
            server.socket = ctx.wrap_socket(server.socket, server_side=True)
        except Exception:
            server.server_close()   # 放掉連接埠，呼叫端才能用新憑證重試
            raise
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def start() -> dict:
    """啟動服務並回傳連線資訊。給 launcher 與命令列共用。"""
    WORK.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=worker_loop, daemon=True).start()
    threading.Thread(target=backfill_covers, daemon=True).start()
    LIBRARY.backfill_artists()

    ips = local_ips()
    tls = ensure_cert(ips)

    http_port = find_free_port(HTTP_PORT)
    serve(http_port, None)
    https_port = None
    if tls:
        https_port = find_free_port(HTTPS_PORT)
        try:
            serve(https_port, tls)
        except (ssl.SSLError, OSError) as exc:
            # 憑證剛好被另一份同時啟動的程式換掉之類的情況：重簽一次再試，
            # 還是不行就只開 HTTP——這台電腦照樣能用，不該整個程式開不起來
            print(f"！HTTPS 啟動失敗（{exc}），重新產生憑證再試一次")
            tls = ensure_cert(ips, force=True)
            try:
                if tls:
                    serve(https_port, tls)
                else:
                    https_port = None
            except (ssl.SSLError, OSError) as exc2:
                print(f"！HTTPS 仍無法啟動（{exc2}），這次只開 HTTP（其他裝置不會有麥克風）")
                https_port = None

    INFO.update({
        "httpPort": http_port,
        "httpsPort": https_port,
        "localUrl": f"http://localhost:{http_port}",
        "lanUrls": [f"https://{ip}:{https_port}" for ip in ips] if https_port else [],
        "lanHttpUrls": [f"http://{ip}:{http_port}" for ip in ips],
    })

    # 使用者可以選擇「啟動時就申請公開網址」，預設是關的
    if load_settings().get("tunnelOnStart"):
        threading.Thread(target=lambda: TUNNEL.start(http_port), daemon=True).start()

    return INFO


def can_restart() -> bool:
    """只有從 launcher.py 啟動（打包後）才知道怎麼把自己重新開起來。"""
    return "launcher" in sys.modules or Path(sys.argv[0]).name == "launcher.py"


def spawn_replacement() -> None:
    """開一份新的程式接手。新的那份會先等這份把連接埠放掉才開始服務。"""
    env = dict(os.environ)
    env["KARAOKE_RESTARTING"] = "1"
    env.pop("KARAOKE_GPU_PACK", None)  # 讓新的那份自己重新判斷要不要載入加速包
    kw = {}
    if os.name == "nt":
        kw["creationflags"] = (subprocess.DETACHED_PROCESS
                               | subprocess.CREATE_NEW_PROCESS_GROUP
                               | subprocess.CREATE_NO_WINDOW)
    else:
        kw["start_new_session"] = True
    subprocess.Popen([sys.executable, "-s", "-E", "-B", str(ROOT / "launcher.py")],
                     env=env, close_fds=True, stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kw)


def quit_app(restart: bool = False) -> None:
    """網頁按「關閉程式」或「重新啟動」時走這裡。

    要先把 HTTP 回應送完才能真的關，否則瀏覽器只會看到連線被切斷。
    子行程（cloudflared、常駐的人聲分離工作行程）一定要主動收掉，
    不然會變成孤兒繼續佔著資源——公開網址甚至會一直開著。

    用 os._exit 而不是 sys.exit：這裡是背景執行緒，sys.exit 只會結束
    這條執行緒，主行程照樣跑。
    """
    time.sleep(0.3)
    TUNNEL.stop()
    analyzer = sys.modules.get("analyze")
    stop_worker = getattr(analyzer, "_stop_worker", None)
    if callable(stop_worker):
        try:
            stop_worker()
        except Exception:
            traceback.print_exc()
    if restart:
        try:
            spawn_replacement()
            print("重新啟動中…", flush=True)
        except Exception:  # noqa: BLE001
            traceback.print_exc()
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)


def shutdown(*_args):
    """收掉 cloudflared 再離開。

    公開網址是另一個行程在撐著，程式被關掉時若不主動收，它會變成孤兒
    繼續跑——使用者以為關了 App，實際上機器還公開在網路上。
    """
    TUNNEL.stop()
    sys.exit(0)


def main():
    # 導向檔案時 stdout 預設是區塊緩衝，啟動訊息會看不到
    sys.stdout.reconfigure(line_buffering=True)

    atexit.register(TUNNEL.stop)
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, shutdown)
        except ValueError:
            pass  # 不在主執行緒時無法註冊，交給 atexit
    info = start()
    ips = local_ips()
    tls = info["httpsPort"] is not None
    HTTP_PORT_ACTUAL = info["httpPort"]
    HTTPS_PORT_ACTUAL = info["httpsPort"]

    print("\n唱歌評分系統已啟動（運算全部在這台電腦上）\n")
    print(f"  這台電腦：   http://localhost:{HTTP_PORT_ACTUAL}")
    if ips and tls:
        print("  內網其他裝置（麥克風要用這個）：")
        for ip in ips:
            print(f"               https://{ip}:{HTTPS_PORT_ACTUAL}")
        print("\n  第一次連會出現「憑證不受信任」的警告，選「進階 → 繼續前往」即可。")
        print("  瀏覽器只在 https 或 localhost 才開放麥克風，所以別用 http 的網址唱歌。")
    elif ips:
        print("  內網（沒有憑證，其他裝置不會有麥克風）：")
        for ip in ips:
            print(f"               http://{ip}:{HTTP_PORT_ACTUAL}")
    print("\n（Ctrl+C 結束）")

    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        TUNNEL.stop()
        print("\n已停止")


if __name__ == "__main__":
    main()
