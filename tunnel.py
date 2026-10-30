"""tunnel.py — 用 Cloudflare Quick Tunnel 取得一組臨時的公開網址。

`cloudflared tunnel --url http://127.0.0.1:PORT` 會配發一個隨機的
`*.trycloudflare.com` 網址，不需要帳號、不需要設定 DNS，關掉就失效。
用來臨時把這台電腦上的唱歌評分分享給不在同一個 Wi-Fi 的人。

附帶好處：這個網址是真正的 HTTPS 且憑證有效，所以對方的瀏覽器不會跳
憑證警告，麥克風也能直接使用（內網的自簽憑證要手動信任才行）。

安全性：Quick Tunnel 沒有任何驗證，**拿到網址的人就能用**——瀏覽曲庫、
上傳、下載、刪歌都可以。所以預設不開，要使用者自己按下去。
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
import time

URL_RE = re.compile(r"https://[-a-z0-9]+\.trycloudflare\.com", re.I)
INSTALL_HINT = {
    "Darwin": "brew install cloudflared",
    "Windows": "winget install Cloudflare.cloudflared",
    "Linux": "參考 https://pkg.cloudflare.com 安裝 cloudflared",
}


class Tunnel:
    """管理一個 cloudflared 子行程。同一時間只會有一條。"""

    def __init__(self):
        self.proc: subprocess.Popen | None = None
        self.url: str | None = None
        self.error: str | None = None
        self.starting = False
        self._lock = threading.Lock()

    # -- 狀態 ---------------------------------------------------------------

    @staticmethod
    def binary() -> str | None:
        return shutil.which("cloudflared")

    @staticmethod
    def install_hint() -> str:
        import platform
        return INSTALL_HINT.get(platform.system(), INSTALL_HINT["Linux"])

    @property
    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def status(self) -> dict:
        return {
            "available": self.binary() is not None,
            "installHint": self.install_hint(),
            "running": self.running,
            "starting": self.starting,
            "url": self.url if self.running else None,
            "error": self.error,
        }

    # -- 控制 ---------------------------------------------------------------

    def start(self, port: int, timeout: float = 25.0) -> dict:
        with self._lock:
            if self.running:
                return self.status()

            binary = self.binary()
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
