"""server.py — 本機服務：靜態網頁 + 歌曲分析 API。

同時在內網開放 HTTP 與 HTTPS：

  http://<本機IP>:8000    方便，但**其他裝置上沒有麥克風**
  https://<本機IP>:8443   自簽憑證，接受警告後麥克風才能用

瀏覽器只在 secure context（https 或 localhost）才給 getUserMedia，
所以內網的其他裝置一定要走 https 那個網址。

所有運算都在這台電腦上：分析請求排成單一佇列依序跑 Demucs，
避免多人同時上傳把記憶體吃光。

  POST /api/analyze         body 為原始音檔位元組，檔名放 X-Filename 標頭
  GET  /api/progress?id=    Server-Sent Events 進度回報
  GET  /api/status?id=      單次查詢進度（SSE 不可用時的備援）
  GET  /api/chart?id=       分析結果 JSON
  GET  /api/stem?id=&kind=instrumental|vocals   分離後的音軌（m4a）
"""

from __future__ import annotations

import atexit
import json
import os
import queue
import re
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import library
import tunnel as tunnel_mod

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
JOB_ID_RE = re.compile(r"^[0-9a-f]{12}$")

# cloudflared 之類的反向代理會加上這些標頭。看到任何一個就代表這個請求
# 是從外面轉進來的，不能當成本機。
PROXY_HEADERS = ("CF-Connecting-IP", "CF-Ray", "CF-Visitor",
                 "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto",
                 "Forwarded", "X-Real-IP")
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", ""}

JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
# 佇列裡放的是「要做什麼」：上傳的檔案，或是要先下載的網址
JOB_QUEUE: "queue.Queue[dict]" = queue.Queue()

LIBRARY = library.Library(LIBRARY_DIR)
TUNNEL = tunnel_mod.Tunnel()
SETTINGS_PATH = DATA_DIR / "settings.json"


def load_settings() -> dict:
    try:
        return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def save_settings(patch: dict) -> dict:
    settings = {**load_settings(), **patch}
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_text(json.dumps(settings, ensure_ascii=False, indent=2),
                             encoding="utf-8")
    return settings


# ── 網路位址與憑證 ─────────────────────────────────────────

def local_ips() -> list[str]:
    """這台電腦在內網的 IPv4 位址。"""
    ips: set[str] = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith("127."))


def ensure_cert(ips: list[str]) -> tuple[Path, Path] | None:
    """產生涵蓋 localhost 與目前內網 IP 的自簽憑證。IP 換了就重簽。

    憑證是在 Python 裡直接簽的，不呼叫外部的 openssl 指令——Windows 上
    根本沒有那個指令，打包後的程式不能依賴它，否則內網就沒有 https，
    手機端也就不會有麥克風。
    """
    CERT_DIR.mkdir(parents=True, exist_ok=True)
    cert, key, stamp = CERT_DIR / "cert.pem", CERT_DIR / "key.pem", CERT_DIR / "san.txt"

    hostname = socket.gethostname()
    fingerprint = ",".join(["localhost", hostname, "127.0.0.1", *ips])

    if cert.exists() and key.exists() and stamp.exists() and stamp.read_text() == fingerprint:
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

    key.write_bytes(key_obj.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    ))
    cert.write_bytes(cert_obj.public_bytes(serialization.Encoding.PEM))
    stamp.write_text(fingerprint)
    return cert, key


# ── 分析工作 ───────────────────────────────────────────────

def set_progress(job_id: str, message: str, pct: float, **extra) -> None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            return
        job.update(message=message, pct=pct, **extra)
        job["version"] += 1


def run_job(job: dict) -> None:
    """一件工作 = （可選的下載）+ 分析 + 存進曲庫。"""
    import analyze as analyzer  # 延後載入，讓伺服器能秒開

    job_id = job["jobId"]
    work_dir = WORK / job_id
    src = job.get("src")
    name = job.get("name") or "未命名"
    extra_meta = {}

    try:
        # 1) 網址來源：先下載
        if job.get("url"):
            import fetcher
            set_progress(job_id, "取得音訊中…", 0.01)
            got = fetcher.download(job["url"], work_dir / "download",
                                   lambda m, p: set_progress(job_id, m, p * 0.25))
            src = got["path"]
            name = got["title"]
            extra_meta = {
                "source": got["platformLabel"],
                "sourceId": got["sourceId"],
                "sourceUrl": got["webpageUrl"],
                "uploader": got["uploader"],
            }
            set_progress(job_id, "下載完成，開始分析…", 0.26, name=name)

        # 2) 分離 + 抽音高 + 標技巧
        set_progress(job_id, "載入分離模型…", 0.28)
        base = 0.28
        result = analyzer.analyze(
            src, work_dir,
            lambda m, p: set_progress(job_id, m, base + p * (0.97 - base)))
        chart = result["chart"]

        # 3) 收進曲庫（音檔留在這台電腦上，手機要唱時才抓）
        set_progress(job_id, "收進曲庫…", 0.98)
        song_id = uuid.uuid4().hex[:12]
        meta = LIBRARY.add(song_id, name, chart,
                           instrumental=result["instrumental"],
                           vocals=result.get("vocals"),
                           **extra_meta)
        set_progress(job_id, "完成", 1.0, state="done",
                     songId=song_id, name=name,
                     notes=meta["notes"], techniques=meta["techniques"])
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        set_progress(job_id, f"失敗：{exc}", 1.0, state="error")
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
        print(f"[server] job {job_id} ({name}) 結束", flush=True)


def worker_loop() -> None:
    """單一工作執行緒：Demucs 很吃資源，多人同時上傳就排隊依序處理。"""
    while True:
        job = JOB_QUEUE.get()
        waiting = JOB_QUEUE.qsize()
        for other_id in list(JOBS):
            with JOBS_LOCK:
                other = JOBS.get(other_id)
                if other and other.get("state") == "queued":
                    other["message"] = f"排隊中（前面還有 {waiting} 首）"
                    other["version"] += 1
        set_progress(job["jobId"], "開始處理…", 0.01, state="running")
        run_job(job)
        JOB_QUEUE.task_done()


# ── HTTP 處理 ──────────────────────────────────────────────

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or ""):
            super().log_message(fmt, *args)

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _query(self):
        parsed = urllib.parse.urlparse(self.path)
        return parsed.path, urllib.parse.parse_qs(parsed.query)

    def _job_id(self, query) -> str | None:
        """只接受伺服器自己發出的 id 格式，避免被拿來讀取任意路徑。"""
        job_id = (query.get("id") or [""])[0]
        return job_id if JOB_ID_RE.match(job_id) else None

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
        if any(self.headers.get(h) for h in PROXY_HEADERS):
            return False
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
        return host in LOCAL_HOSTS

    # 改了 js/css 之後瀏覽器卻還在跑快取的舊檔，看到的行為與程式碼對不起來——
    # 這種問題極難察覺，因為畫面「有東西」只是不對。原始檔一律要求重新驗證
    # （沒改動就回 304，成本很低）；音檔那種大檔仍由 _send_file 自己設長快取。
    NO_CACHE_SUFFIXES = (".html", ".js", ".mjs", ".css", ".json")

    def _header_sent(self, name: str) -> bool:
        prefix = f"{name}:".lower().encode()
        return any(h.lower().startswith(prefix)
                   for h in getattr(self, "_headers_buffer", []))

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        if not self._header_sent("Cache-Control"):
            path = urllib.parse.urlparse(self.path).path.lower()
            if path.endswith("/") or path.endswith(self.NO_CACHE_SUFFIXES):
                self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    # -- 路由 --------------------------------------------------------------
    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 1 << 20:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return {}

    def do_POST(self):
        path, _ = self._query()

        if path in ("/api/quit", "/api/restart"):
            # 手機連進來的人不該能關掉別人的電腦
            if not self.is_local():
                self._json({"error": "只能從這台電腦操作"}, 403)
                return
            restart = path == "/api/restart"
            if restart and not can_restart():
                self._json({"error": "開發模式不支援自動重新啟動，請手動重開"}, 400)
                return
            self._json({"ok": True})
            threading.Thread(target=quit_app, args=(restart,), daemon=True).start()
            return

        if path.startswith("/api/gpu/"):
            # 下載 2.5GB、改動這台電腦的安裝內容，只給本機操作
            if not self.is_local():
                self._json({"error": "只能從這台電腦操作"}, 403)
                return
            import gpu_pack
            action = {"/api/gpu/start": gpu_pack.PACK.start,
                      "/api/gpu/cancel": gpu_pack.PACK.cancel,
                      "/api/gpu/remove": gpu_pack.PACK.remove}.get(path)
            if action is None:
                self.send_error(404)
                return
            result = action()
            self._json(result, 400 if "error" in result else 200)
            return

        if path.startswith("/api/tunnel/"):
            if not self.is_local():
                self._json({"error": "只能從這台電腦操作"}, 403)
                return
            if path == "/api/tunnel/start":
                self._json(TUNNEL.start(INFO.get("httpPort", HTTP_PORT)))
            elif path == "/api/tunnel/stop":
                self._json(TUNNEL.stop())
            else:
                self.send_error(404)
            return

        if path == "/api/settings":
            if not self.is_local():
                self._json({"error": "只能從這台電腦操作"}, 403)
                return
            body = self._read_json_body()
            patch = {k: bool(v) for k, v in body.items()
                     if k in ("tunnelOnStart", "gpuPromptAnswered")}
            self._json(save_settings(patch))
            return

        if path == "/api/fetch":
            self.handle_fetch()
            return
        if path == "/api/song/settings":
            body = self._read_json_body()
            meta = LIBRARY.update_settings(str(body.get("id", "")), body)
            self._json(meta or {"error": "找不到歌曲"}, 200 if meta else 404)
            return
        if path == "/api/song/delete":
            body = self._read_json_body()
            ok = LIBRARY.delete(str(body.get("id", "")))
            self._json({"ok": ok}, 200 if ok else 404)
            return

        if path != "/api/analyze":
            self.send_error(404)
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            self._json({"error": "沒有收到檔案"}, 400)
            return
        if length > MAX_UPLOAD:
            self._json({"error": "檔案超過 200MB"}, 413)
            return

        name = urllib.parse.unquote(self.headers.get("X-Filename", "song"))
        suffix = Path(name).suffix or ".mp3"

        job_id = uuid.uuid4().hex[:12]
        work_dir = WORK / job_id
        work_dir.mkdir(parents=True, exist_ok=True)
        src = work_dir / f"input{suffix}"

        remaining = length
        with src.open("wb") as fh:
            while remaining > 0:
                chunk = self.rfile.read(min(1 << 20, remaining))
                if not chunk:
                    break
                fh.write(chunk)
                remaining -= len(chunk)

        ahead = JOB_QUEUE.qsize()
        with JOBS_LOCK:
            JOBS[job_id] = {
                "state": "queued", "pct": 0.0, "name": name, "version": 0,
                "message": "排隊中…" if ahead == 0 else f"排隊中（前面還有 {ahead} 首）",
            }
        JOB_QUEUE.put({"jobId": job_id, "src": src, "name": name})
        self._json({"jobId": job_id, "name": name, "queued": ahead})

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
            meta = fetcher.probe(url)
        except Exception as exc:  # noqa: BLE001
            self._json({"error": f"讀取這個網址失敗：{exc}"}, 502)
            return

        existing = LIBRARY.find_by_source(meta["sourceId"])
        if existing:
            # 已經下載過了——直接把那首歌回給前端顯示成卡片
            self._json({"existing": existing, "meta": meta})
            return

        job_id = uuid.uuid4().hex[:12]
        ahead = JOB_QUEUE.qsize()
        with JOBS_LOCK:
            JOBS[job_id] = {
                "state": "queued", "pct": 0.0, "name": meta["title"], "version": 0,
                "message": "排隊中…" if ahead == 0 else f"排隊中（前面還有 {ahead} 首）",
            }
        JOB_QUEUE.put({"jobId": job_id, "url": url, "name": meta["title"]})
        self._json({"jobId": job_id, "name": meta["title"], "queued": ahead, "meta": meta})

    def do_GET(self):
        path, query = self._query()

        if not path.startswith("/api/"):
            # work/ 是分析用的暫存區，內網開放時不該讓別人翻到
            if path.startswith(("/work/", "/certs/", "/library/")):
                self.send_error(404)
                return
            super().do_GET()
            return

        job_id = self._job_id(query)
        with JOBS_LOCK:
            job = dict(JOBS.get(job_id, {})) if job_id else {}

        if path == "/api/status":
            self._json(job) if job else self._json({"error": "找不到工作"}, 404)
            return

        if path == "/api/progress":
            if not job:
                self._json({"error": "找不到工作"}, 404)
                return
            self.stream_progress(job_id)
            return

        if path == "/api/songs":
            # 曲庫清單。只回中繼資料，音檔要另外抓——手機開曲庫時
            # 不該把幾百 MB 的音軌一起拉下來。
            q = (query.get("q") or [""])[0]
            self._json({"songs": LIBRARY.search(q) if q else LIBRARY.list()})
            return

        if path == "/api/song":
            song_id = (query.get("id") or [""])[0]
            kind = (query.get("kind") or ["meta"])[0]

            if kind == "meta":
                meta = LIBRARY.meta(song_id)
                self._json(meta or {"error": "找不到歌曲"}, 200 if meta else 404)
                return

            if kind == "chart":
                chart = LIBRARY.chart_path(song_id)
                if chart is None:
                    self._json({"error": "找不到譜面"}, 404)
                    return
                self._send_bytes(chart.read_bytes(), "application/json; charset=utf-8")
                return

            stem = LIBRARY.stem_path(song_id, kind)
            if stem is None:
                self._json({"error": "找不到音軌"}, 404)
                return
            self._send_file(stem, "audio/mp4")
            return

        if path == "/api/resolve":
            # 貼上網址時先問一次：這首已經在曲庫裡了嗎？
            url = (query.get("url") or [""])[0].strip()
            import fetcher
            if fetcher.platform_of(url) is None:
                self._json({"error": "只支援 YouTube、YouTube Music 與 Bilibili 的網址"}, 400)
                return
            try:
                meta = fetcher.probe(url)
            except Exception as exc:  # noqa: BLE001
                self._json({"error": f"讀取這個網址失敗：{exc}"}, 502)
                return
            self._json({"meta": meta, "existing": LIBRARY.find_by_source(meta["sourceId"])})
            return

        if path == "/api/tunnel":
            self._json(TUNNEL.status() if self.is_local()
                       else {"available": False, "running": False})
            return

        if path == "/api/qr":
            # 只產生伺服器自己知道的網址，不接受任意輸入
            target = (query.get("target") or ["lan"])[0]
            if not self.is_local():
                self.send_error(403)
                return
            url = {"lan": (INFO.get("lanUrls") or [None])[0],
                   "tunnel": TUNNEL.url}.get(target)
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
            info = server_info()
            info["isLocal"] = self.is_local()
            info["settings"] = load_settings()
            self._json(info)
            return

        self.send_error(404)

    def _send_file(self, path: Path, content_type: str):
        """串流送出檔案，並附上 ETag 讓手機第二次進來可以直接用快取。"""
        stat = path.stat()
        etag = f'"{int(stat.st_mtime)}-{stat.st_size}"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(stat.st_size))
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "private, max-age=31536000")
        self.end_headers()
        with path.open("rb") as fh:
            shutil.copyfileobj(fh, self.wfile, 1 << 20)

    def _send_bytes(self, data: bytes, content_type: str):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def stream_progress(self, job_id: str):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        last_version = -1
        try:
            while True:
                with JOBS_LOCK:
                    job = dict(JOBS.get(job_id, {}))
                if not job:
                    break
                if job["version"] != last_version:
                    last_version = job["version"]
                    payload = json.dumps(job, ensure_ascii=False)
                    self.wfile.write(f"data: {payload}\n\n".encode("utf-8"))
                    self.wfile.flush()
                    if job.get("state") in ("done", "error"):
                        break
                threading.Event().wait(0.25)
        except (BrokenPipeError, ConnectionResetError):
            pass


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


def server_info() -> dict:
    """給介面顯示：內網網址與目前使用的運算裝置。"""
    info = dict(INFO)
    info["pid"] = os.getpid()  # 重新啟動時，網頁靠這個分辨新舊行程
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
    info["songs"] = len(LIBRARY.list())
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
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile=str(tls[0]), keyfile=str(tls[1]))
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def start() -> dict:
    """啟動服務並回傳連線資訊。給 launcher 與命令列共用。"""
    WORK.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=worker_loop, daemon=True).start()

    ips = local_ips()
    tls = ensure_cert(ips)

    http_port = find_free_port(HTTP_PORT)
    serve(http_port, None)
    https_port = None
    if tls:
        https_port = find_free_port(HTTPS_PORT)
        serve(https_port, tls)

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
