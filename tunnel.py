"""tunnel.py — 用 Cloudflare Quick Tunnel 取得一組臨時的公開網址。

`cloudflared tunnel --url http://127.0.0.1:PORT` 會配發一個隨機的
`*.trycloudflare.com` 網址，不需要帳號、不需要設定 DNS，關掉就失效。
用來臨時把這台電腦上的唱歌評分分享給不在同一個 Wi-Fi 的人。

附帶好處：這個網址是真正的 HTTPS 且憑證有效，所以對方的瀏覽器不會跳
憑證警告，麥克風也能直接使用（內網的自簽憑證要手動信任才行）。

安全性：Quick Tunnel 沒有任何驗證，**拿到網址的人就能用**——瀏覽曲庫、
上傳、下載、刪歌都可以。所以預設不開，要使用者自己按下去。

cloudflared 沒有內附（多數人用不到，各平台又要 20～55MB）。第一次按「建立公開網址」
時，這台電腦上找不到的話，就從 Cloudflare 官方的 GitHub Releases 下載對應平台的
執行檔，比對官方公布的 SHA-256 後放進使用者資料夾（<資料目錄>/tools/），
之後就直接用那份。系統上已經裝了（brew／winget）的話優先用系統那份。
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import platform
import re
import shutil
import subprocess
import tarfile
import threading
import time
import urllib.request
from pathlib import Path

URL_RE = re.compile(r"https://[-a-z0-9]+\.trycloudflare\.com", re.I)
INSTALL_HINT = {
    "Darwin": "brew install cloudflared",
    "Windows": "winget install Cloudflare.cloudflared",
    "Linux": "參考 https://pkg.cloudflare.com 安裝 cloudflared",
}


RELEASE_API = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest"


def release_asset_name() -> str | None:
    """這台電腦該下載哪一個檔。Windows ARM 沒有原生版，amd64 版可透過模擬執行。"""
    system = platform.system()
    arm = platform.machine().lower() in ("arm64", "aarch64")
    if system == "Darwin":
        return f"cloudflared-darwin-{'arm64' if arm else 'amd64'}.tgz"
    if system == "Windows":
        return "cloudflared-windows-amd64.exe"
    if system == "Linux":
        return f"cloudflared-linux-{'arm64' if arm else 'amd64'}"
    return None


def _expected_sha256(release: dict, asset: dict) -> str | None:
    """官方公布的 SHA-256：GitHub 資產的 digest 欄位，沒有就從發布說明的校驗表找。"""
    digest = asset.get("digest") or ""
    if digest.startswith("sha256:"):
        return digest.split(":", 1)[1].lower()
    m = re.search(re.escape(asset["name"]) + r":\s*([0-9a-f]{64})", release.get("body") or "", re.I)
    return m.group(1).lower() if m else None


class Tunnel:
    """管理一個 cloudflared 子行程。同一時間只會有一條。"""

    def __init__(self, tools_dir: Path | None = None):
        self.proc: subprocess.Popen | None = None
        self.url: str | None = None
        self.error: str | None = None
        self.starting = False
        # 自動下載 cloudflared 的狀態，給畫面顯示進度
        self.installing = False
        self.install_progress = 0.0
        self.tools_dir = tools_dir
        self._lock = threading.Lock()

    # -- 狀態 ---------------------------------------------------------------

    def local_binary(self) -> Path | None:
        if self.tools_dir is None:
            return None
        return self.tools_dir / ("cloudflared.exe" if os.name == "nt" else "cloudflared")

    def binary(self) -> str | None:
        found = shutil.which("cloudflared")
        if found:
            return found
        local = self.local_binary()
        return str(local) if local and local.is_file() else None

    def can_install(self) -> bool:
        return self.tools_dir is not None and release_asset_name() is not None

    @staticmethod
    def install_hint() -> str:
        return INSTALL_HINT.get(platform.system(), INSTALL_HINT["Linux"])

    @property
    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def status(self) -> dict:
        return {
            "available": self.binary() is not None,
            "canInstall": self.can_install(),
            "installing": self.installing,
            "installProgress": round(self.install_progress, 3),
            "installHint": self.install_hint(),
            "running": self.running,
            "starting": self.starting,
            "url": self.url if self.running else None,
            "error": self.error,
        }

    # -- 自動安裝 -----------------------------------------------------------

    def install(self) -> str:
        """下載官方的 cloudflared 執行檔、驗證 SHA-256，回傳路徑。失敗就丟例外。"""
        name = release_asset_name()
        target = self.local_binary()
        if name is None or target is None:
            raise RuntimeError("這個平台沒有可自動下載的 cloudflared")
        self.installing = True
        self.install_progress = 0.0
        try:
            headers = {"User-Agent": "karaoke-scoring", "Accept": "application/vnd.github+json"}
            with urllib.request.urlopen(urllib.request.Request(RELEASE_API, headers=headers),
                                        timeout=30) as resp:
                release = json.load(resp)
            asset = next((a for a in release.get("assets", []) if a.get("name") == name), None)
            if asset is None:
                raise RuntimeError(f"Cloudflare 的最新版本裡沒有 {name}")
            expected = _expected_sha256(release, asset)
            if not expected:
                # 沒有官方校驗值就不裝：這個檔會被拿來執行，不能憑空相信
                raise RuntimeError("找不到官方公布的校驗值，為了安全不自動安裝")

            req = urllib.request.Request(asset["browser_download_url"],
                                         headers={"User-Agent": "karaoke-scoring"})
            total = int(asset.get("size") or 0)
            buf = io.BytesIO()
            with urllib.request.urlopen(req, timeout=60) as resp:
                while True:
                    chunk = resp.read(1 << 16)
                    if not chunk:
                        break
                    buf.write(chunk)
                    if total:
                        self.install_progress = min(0.99, buf.tell() / total)
            data = buf.getvalue()
            if hashlib.sha256(data).hexdigest() != expected:
                raise RuntimeError("下載的 cloudflared 校驗值不符，已捨棄")

            if name.endswith(".tgz"):
                with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
                    member = next((m for m in tar.getmembers()
                                   if m.isfile() and Path(m.name).name == "cloudflared"), None)
                    if member is None:
                        raise RuntimeError("壓縮檔裡沒有 cloudflared")
                    data = tar.extractfile(member).read()  # type: ignore[union-attr]

            target.parent.mkdir(parents=True, exist_ok=True)
            tmp = target.with_suffix(target.suffix + ".part")
            tmp.write_bytes(data)
            tmp.chmod(0o755)
            os.replace(tmp, target)
            self.install_progress = 1.0
            print(f"[tunnel] 已安裝 cloudflared {release.get('tag_name', '')} → {target}", flush=True)
            return str(target)
        finally:
            self.installing = False

    # -- 控制 ---------------------------------------------------------------

    def start(self, port: int, timeout: float = 25.0) -> dict:
        with self._lock:
            if self.running:
                return self.status()

            binary = self.binary()
            if binary is None and self.can_install():
                self.error = None
                try:
                    binary = self.install()
                except Exception as exc:  # noqa: BLE001
                    self.error = f"自動下載 cloudflared 失敗：{exc}（也可以手動安裝：{self.install_hint()}）"
                    return self.status()
            if binary is None:
                self.error = f"找不到 cloudflared，請先安裝：{self.install_hint()}"
                return self.status()

            self.error = None
            self.url = None
            self.starting = True

            try:
                self.proc = subprocess.Popen(
                    [binary, "tunnel", "--no-autoupdate",
                     "--url", f"http://127.0.0.1:{port}"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    bufsize=1,
                    # 視窗模式的程式去啟動主控台程式會冒出黑視窗
                    **({"creationflags": subprocess.CREATE_NO_WINDOW}
                       if os.name == "nt" else {}),
                )
            except OSError as exc:
                self.starting = False
                self.error = f"無法啟動 cloudflared：{exc}"
                return self.status()

        # cloudflared 把配發到的網址印在 stderr 的橫幅裡，讀到為止
        deadline = time.time() + timeout
        assert self.proc.stderr is not None
        while time.time() < deadline:
            line = self.proc.stderr.readline()
            if not line:
                if self.proc.poll() is not None:
                    self.error = "cloudflared 意外結束"
                    break
                continue
            match = URL_RE.search(line)
            if match:
                self.url = match.group(0)
                break

        self.starting = False
        if self.url:
            # 之後的輸出繼續讀掉，否則管線塞滿會讓 cloudflared 卡住
            threading.Thread(target=self._drain, daemon=True).start()
            print(f"[tunnel] 公開網址：{self.url}", flush=True)
        else:
            if not self.error:
                self.error = "等不到 Cloudflare 配發網址（可能是網路不通）"
            self.stop()
        return self.status()

    def _drain(self) -> None:
        try:
            for _ in self.proc.stderr:  # type: ignore[union-attr]
                pass
        except (ValueError, AttributeError):
            pass

    def stop(self) -> dict:
        proc, self.proc = self.proc, None
        self.url = None
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        return self.status()
