"""launcher.py — 打包成應用程式後的進入點。

負責：
  1. 指好內附資源（Python 套件、ffmpeg、Demucs 權重）的位置
  2. 啟動本機伺服器（連接埠被占用會自動往後找）
  3. 自動打開瀏覽器分頁
  4. 把訊息寫進記錄檔——應用程式沒有主控台，出問題只能看這個檔

使用者資料（曲庫暫存、憑證、記錄）一律寫到使用者目錄，因為安裝目錄是唯讀的。
"""

from __future__ import annotations

import os
import platform
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path


def app_root() -> Path:
    """程式與網頁資源的所在位置。"""
    return Path(os.environ.get("KARAOKE_APP_ROOT", Path(__file__).resolve().parent))


def data_dir() -> Path:
    """可寫入的使用者資料目錄。"""
    override = os.environ.get("KARAOKE_DATA_DIR")
    if override:
        return Path(override)
    if platform.system() == "Darwin":
        base = Path.home() / "Library" / "Application Support"
    elif platform.system() == "Windows":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return base / "KaraokeScoring"


class Tee:
    """同時寫到記錄檔與原本的輸出。"""

    def __init__(self, *streams):
        self.streams = [s for s in streams if s is not None]

    def write(self, text):
        for s in self.streams:
            try:
                s.write(text)
                s.flush()
            except Exception:  # noqa: BLE001
                pass

    def flush(self):
        for s in self.streams:
            try:
                s.flush()
            except Exception:  # noqa: BLE001
                pass


def setup_environment() -> tuple[Path, Path]:
    root = app_root()
    data = data_dir()
    data.mkdir(parents=True, exist_ok=True)

    os.environ.setdefault("KARAOKE_APP_ROOT", str(root))
    os.environ.setdefault("KARAOKE_DATA_DIR", str(data))

    # librosa 內部的 numba 函式開了 cache=True，會把編譯結果（.nbi/.nbc）寫進
    # 套件旁邊的 __pycache__。打包後那是已簽章的 .app 內部，多出檔案就會讓
    # 簽章驗證失敗，macOS 會直接用 SIGTRAP 中止程式。-B 只管得住 .pyc，管不到
    # 這些，所以要把 numba 的快取整個導到可寫的資料目錄。
    numba_cache = data / "cache" / "numba"
    numba_cache.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("NUMBA_CACHE_DIR", str(numba_cache))

    # 內附的 Demucs 權重。demucs 4 是從 Hugging Face 取模型，所以要指 HF_HOME；
    # 一併關掉連線檢查，沒網路也能用。
    models = root / "models"
    if models.exists():
        os.environ.setdefault("HF_HOME", str(models))
        os.environ.setdefault("TORCH_HOME", str(models))
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

    # 內附的 ffmpeg
    exe = "ffmpeg.exe" if platform.system() == "Windows" else "ffmpeg"
    bundled = root / "bin" / exe
    if bundled.exists():
        os.environ.setdefault("KARAOKE_FFMPEG", str(bundled))
        os.environ["PATH"] = f"{bundled.parent}{os.pathsep}{os.environ.get('PATH', '')}"

    # 內附的第三方套件。啟動器是用 -E 執行 Python（隔離使用者自己的環境變數），
    # 連帶會忽略我們設的 PYTHONPATH，所以這裡直接把 lib 補進 sys.path。
    # 打包後的結構兩個平台一致：app 與 lib 同層。
    lib = root.parent / "lib"
    if lib.is_dir():
        sys.path.insert(0, str(lib))

    sys.path.insert(0, str(root))
    return root, data


def already_serving(port: int) -> str | None:
    """這台電腦上是否已經有一份在跑。

    .app 的進入點啟動伺服器後就會結束（否則 Dock 圖示會一直跳），所以再點一次
    圖示時沒有任何「已在執行」的跡象。少了這道檢查，第二次點擊會因為 8000 被
    占用而另外開在 8001，變成兩個伺服器搶同一份曲庫。
    """
    import json as _json
    import urllib.request

    try:
        with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/api/info", timeout=2.0) as resp:
            _json.loads(resp.read().decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None
    return f"http://localhost:{port}"


def main() -> int:
    root, data = setup_environment()

    log_path = data / "karaoke.log"
    log_file = open(log_path, "a", encoding="utf-8", buffering=1)  # noqa: SIM115
    sys.stdout = Tee(sys.__stdout__, log_file)
    sys.stderr = Tee(sys.__stderr__, log_file)

    print(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} 啟動 =====")
    print(f"程式目錄：{root}")
    print(f"資料目錄：{data}")
    print(f"記錄檔：{log_path}")

    try:
        import server
    except Exception as exc:  # noqa: BLE001
        print(f"無法載入伺服器：{exc}")
        import traceback
        traceback.print_exc()
        return 1

    # 已經有一份在服務就別再開一個，直接把瀏覽器帶過去
    running = already_serving(server.HTTP_PORT)
    if running:
        print(f"已經有一份在執行（{running}），直接開啟瀏覽器")
        open_browser(running)
        return 0

    info = server.start()
    local_url = info["localUrl"]

    print("\n唱歌評分系統已啟動")
    print(f"  這台電腦：{local_url}")
    for url in info["lanUrls"]:
        print(f"  內網其他裝置（麥克風要用這個）：{url}")

    # 背景先把運算裝置探測好，第一首歌就不用等
    threading.Thread(target=warm_up, daemon=True).start()

    # 等伺服器真的能接受連線再開瀏覽器，避免出現連線失敗的分頁
    if wait_until_up(info["httpPort"]):
        open_browser(local_url)
    else:
        print("！伺服器沒有在時限內就緒，請手動開啟上面的網址")

    print("\n關閉這個程式就會停止服務。")
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        print("\n已停止")
    return 0


def open_browser(url: str) -> None:
    """打開瀏覽器。

    優先用絕對路徑的系統指令：webbrowser 模組在 macOS 上是靠 PATH 找
    osascript，而應用程式拿到的環境很精簡，會在記錄檔留下一堆找不到指令的
    錯誤。webbrowser 留作最後的備援。
    """
    system = platform.system()
    try:
        if system == "Darwin" and Path("/usr/bin/open").exists():
            if subprocess.run(["/usr/bin/open", url], check=False).returncode == 0:
                return
        elif system == "Windows":
            os.startfile(url)  # noqa: S606
            return
        elif system == "Linux":
            if subprocess.run(["xdg-open", url], check=False).returncode == 0:
                return
    except Exception:  # noqa: BLE001
        pass

    try:
        if webbrowser.open(url):
            return
    except Exception:  # noqa: BLE001
        pass
    print(f"！無法自動開啟瀏覽器，請手動開啟：{url}")


def wait_until_up(port: int, timeout: float = 15.0) -> bool:
    import socket

    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(0.2)
    return False


def warm_up() -> None:
    try:
        import analyze
        analyze.pick_device()
    except Exception as exc:  # noqa: BLE001
        print(f"！運算裝置探測失敗：{exc}")


if __name__ == "__main__":
    raise SystemExit(main())
