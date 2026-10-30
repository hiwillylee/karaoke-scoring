"""gpu_pack.py — NVIDIA 加速包：在使用者電腦上把 CPU 版 PyTorch 升級成 CUDA 版。

為什麼不直接發 CUDA 版的安裝檔：Windows 的 CUDA 版 PyTorch 把 cuDNN、cuBLAS
都包在 wheel 裡，整個安裝檔會到 2.8GB，超過 GitHub Releases 單檔 2GB 的上限。
所以安裝檔一律內附 CPU 版，有 N 卡的人在設定頁按一下，程式自己去 PyTorch
官方伺服器抓對應版本的 CUDA wheel，解開放在使用者資料夾，下次啟動時排在
內附套件前面，蓋過 CPU 版。

安全性的考量：
  - 只抓「跟內附 torch 同一版號」的 wheel，demucs／torchaudio 的相依不會亂掉
  - 驗 PyTorch 索引附的 sha256，下載中斷可續傳
  - 解開後先在子行程實際跑一次矩陣運算與 STFT，過了才寫入 ok.json；
    啟動器只認有 ok.json 的加速包，裝到一半或跑不動的都不會被載入
  - 內附 torch 換版本（程式更新）時，舊的加速包自動失效，介面會提示重新下載
"""

from __future__ import annotations

import hashlib
import html
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

INDEX_URL = "https://download.pytorch.org/whl"
# PyTorch 每個版本只針對其中幾種 CUDA 出 wheel（例如 2.15 只有 cu132），
# 所以由新到舊逐一找有沒有跟內附 torch 同版號的。後面是該 CUDA 在 Windows
# 上要求的最低驅動版本。
CUDA_TAGS = [("cu132", (580, 88)), ("cu130", (580, 88)),
             ("cu128", (528, 33)), ("cu126", (528, 33))]
MIN_DRIVER = min(d for _, d in CUDA_TAGS)
# 下載 2.5GB ＋解開後約 4.5GB，留一點餘裕
NEED_FREE_BYTES = 8 * 1024 ** 3


def data_dir() -> Path:
    return Path(os.environ.get("KARAOKE_DATA_DIR", Path(__file__).resolve().parent))


def pack_dir(data: Path | None = None) -> Path:
    return (data or data_dir()) / "gpu" / "cuda"


def bundled_lib() -> Path | None:
    """打包後內附套件的位置（app 與 lib 同層）。開發環境沒有這個資料夾。"""
    root = Path(os.environ.get("KARAOKE_APP_ROOT", Path(__file__).resolve().parent))
    lib = root.parent / "lib"
    return lib if lib.is_dir() else None


def bundled_torch_version(lib: Path | None = None, pkg: str = "torch") -> str | None:
    """不 import torch，直接讀內附 torch 的版號（例如 2.8.0+cpu）。

    執行中的行程可能已經載入了加速包的 torch，import 拿到的不是內附那份。
    """
    lib = lib or bundled_lib()
    if not lib:
        return None
    ver = lib / pkg / "version.py"
    if not ver.exists():
        return None
    m = re.search(r"__version__\s*=\s*['\"]([^'\"]+)['\"]", ver.read_text("utf-8", "replace"))
    return m.group(1) if m else None


def _base(version: str | None) -> str | None:
    return version.split("+", 1)[0] if version else None


def active_pack(data: Path, lib: Path | None) -> Path | None:
    """啟動器用：回傳可以載入的加速包路徑，沒有就回 None。"""
    if os.environ.get("KARAOKE_NO_GPU_PACK"):
        return None
    site = pack_dir(data) / "site"
    marker = pack_dir(data) / "ok.json"
    if not marker.exists() or not site.is_dir():
        return None
    try:
        info = json.loads(marker.read_text("utf-8"))
    except ValueError:
        return None
    if info.get("torchBase") != _base(bundled_torch_version(lib)):
        return None
    return site


def cleanup_leftovers(data: Path) -> None:
    """啟動器用：清掉上次移除時因為 DLL 還在使用而刪不掉的舊加速包。"""
    for old in (data / "gpu").glob("cuda.remove-*"):
        shutil.rmtree(_long(old), ignore_errors=True)


def disable_pack(data: Path, reason: str) -> None:
    """啟動失敗時呼叫：讓加速包失效，下次啟動退回內附的 CPU 版。"""
    marker = pack_dir(data) / "ok.json"
    if marker.exists():
        marker.replace(marker.with_name("disabled.json"))
        (marker.with_name("disabled-reason.txt")).write_text(reason, "utf-8")


# ── 硬體偵測 ──────────────────────────────────────────────

def _nvidia_smi() -> str | None:
    found = shutil.which("nvidia-smi")
    if found:
        return found
    sysroot = os.environ.get("SystemRoot", r"C:\Windows")
    for p in (Path(sysroot) / "System32" / "nvidia-smi.exe",
              Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
              / "NVIDIA Corporation" / "NVSMI" / "nvidia-smi.exe"):
        if p.exists():
            return str(p)
    return None


def detect_gpu() -> dict | None:
    """用驅動附的 nvidia-smi 找 N 卡，不需要 CUDA 版 torch 就能判斷。"""
    exe = _nvidia_smi()
    if not exe:
        return None
    try:
        kw = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
        out = subprocess.run(
            [exe, "--query-gpu=name,driver_version", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=10, **kw,
        ).stdout.strip().splitlines()
    except Exception:  # noqa: BLE001
        return None
    if not out:
        return None
    name, _, driver = (s.strip() for s in out[0].partition(","))
    try:
        parts = tuple(int(x) for x in driver.split(".")[:2])
    except ValueError:
        parts = (0, 0)
    return {"name": name, "driver": driver, "driverOk": parts >= MIN_DRIVER}


# ── 下載與安裝 ────────────────────────────────────────────

class _Cancelled(Exception):
    pass


class GpuPack:
    def __init__(self):
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._cancel = threading.Event()
        self._state = {"state": "idle", "done": 0, "total": 0, "message": "", "error": ""}
        self._gpu: dict | None | bool = False  # False＝還沒偵測

    # -- 狀態 --
    def _set(self, **kw):
        with self._lock:
            self._state.update(kw)

    def status(self) -> dict:
        if self._gpu is False:
            self._gpu = detect_gpu() if platform.system() == "Windows" else None
        lib = bundled_lib()
        version = bundled_torch_version(lib)
        data = data_dir()
        with self._lock:
            st = dict(self._state)
        marker = pack_dir(data) / "ok.json"
        installed = active_pack(data, lib) is not None
        loaded = bool(lib) and _torch_loaded_from_pack(data)
        stale = marker.exists() and not installed
        disabled = (pack_dir(data) / "disabled-reason.txt")

        reason = None
        if platform.system() != "Windows":
            reason = "只有 Windows 版需要另外下載，macOS 版已內建 Apple 晶片加速。"
        elif not lib or not version:
            reason = "開發環境請自行安裝 CUDA 版 PyTorch。"
        elif "+cu" in version:
            reason = "這份安裝檔已經內建 CUDA 版 PyTorch。"
        elif not self._gpu:
            reason = "這台電腦沒有偵測到 NVIDIA 顯示卡。"
        elif not self._gpu["driverOk"]:
            reason = (f"顯示卡驅動版本 {self._gpu['driver']} 太舊，"
                      f"請先更新到 {MIN_DRIVER[0]}.{MIN_DRIVER[1]} 以上。")

        st.update({
            "available": reason is None,
            "reason": reason,
            "gpu": self._gpu or None,
            "torch": version,
            "installed": installed,
            "loaded": loaded,
            "stale": stale,
            "disabledReason": disabled.read_text("utf-8") if disabled.exists() else None,
            "needRestart": installed and not loaded,
        })
        return st

    # -- 動作 --
    def start(self) -> dict:
        st = self.status()
        if not st["available"]:
            return {"error": st["reason"]}
        if self._thread and self._thread.is_alive():
            return self.status()
        self._cancel.clear()
        self._set(state="downloading", done=0, total=0, message="準備中…", error="")
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        return self.status()

    def cancel(self) -> dict:
        self._cancel.set()
        return self.status()

    def remove(self) -> dict:
        if self._thread and self._thread.is_alive():
            return {"error": "下載中，請先取消"}
        target = pack_dir()
        if target.exists():
            # 已載入的 DLL 在 Windows 上刪不掉，先改名，下次啟動時再清
            trash = target.with_name(f"cuda.remove-{int(time.time())}")
            try:
                target.rename(trash)
                shutil.rmtree(_long(trash), ignore_errors=True)
            except OSError as exc:
                return {"error": f"移除失敗：{exc}"}
        self._set(state="idle", done=0, total=0, message="", error="")
        return self.status()

    # -- 實際工作 --
    def _run(self):
        try:
            self._install()
        except _Cancelled:
            self._set(state="idle", message="已取消", error="")
        except Exception as exc:  # noqa: BLE001
            print(f"[gpu] 安裝失敗：{type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
            self._set(state="error", error=f"{type(exc).__name__}: {exc}")

    def _install(self):
        data = data_dir()
        root = pack_dir(data)
        dl = root.parent / "download"
        staging = root.parent / "cuda.partial"
        dl.mkdir(parents=True, exist_ok=True)

        free = shutil.disk_usage(dl).free
        if free < NEED_FREE_BYTES:
            raise RuntimeError(f"磁碟空間不足：需要約 {NEED_FREE_BYTES / 1024**3:.0f} GB，"
                               f"目前只剩 {free / 1024**3:.1f} GB")

        base = _base(bundled_torch_version())
        self._set(message="查詢 PyTorch 官方伺服器…")
        tag, wheels = _pick_wheels(base, self._gpu or {})
        total = sum(w["size"] or 0 for w in wheels)
        self._set(total=total)

        done_before = 0
        files = []
        for w in wheels:
            dest = dl / w["filename"]
            self._set(message=f"下載 {w['filename']}")
            self._download(w, dest, done_before)
            done_before += dest.stat().st_size
            files.append(dest)

        self._set(state="extracting", message="解壓縮中…")
        if staging.exists():
            shutil.rmtree(_long(staging))
        site = staging / "site"
        site.mkdir(parents=True)
        for f in files:
            with zipfile.ZipFile(f) as zf:
                for member in zf.infolist():
                    if self._cancel.is_set():
                        raise _Cancelled
                    if _skip_member(member.filename):
                        continue
                    zf.extract(member, _long(site))

        self._set(state="verifying", message="在顯示卡上試跑一次…")
        ok, detail = _verify(site)
        if not ok:
            raise RuntimeError(f"CUDA 版 PyTorch 無法在這台電腦上執行：{detail}")

        (staging / "ok.json").write_text(json.dumps({
            "torchBase": base, "cuda": tag, "installedAt": int(time.time()),
            "check": detail,
        }, ensure_ascii=False), "utf-8")
        if root.exists():
            shutil.rmtree(_long(root), ignore_errors=True)
        staging.replace(root)
        shutil.rmtree(dl, ignore_errors=True)
        print(f"[gpu] NVIDIA 加速包已安裝：{detail}", flush=True)
        self._set(state="done", message="安裝完成，重新啟動後生效", done=total)

    def _download(self, wheel: dict, dest: Path, offset: int):
        """可續傳的下載，邊下載邊算 sha256。"""
        part = dest.with_suffix(dest.suffix + ".part")
        if dest.exists() and _sha256(dest) == wheel["sha256"]:
            return
        for attempt in range(6):
            have = part.stat().st_size if part.exists() else 0
            req = urllib.request.Request(wheel["url"], headers={"User-Agent": "karaoke-scoring"})
            if have:
                req.add_header("Range", f"bytes={have}-")
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:
                    if have and resp.status != 206:
                        have = 0  # 伺服器不支援續傳，從頭來
                    with part.open("ab" if have else "wb") as fh:
                        while True:
                            if self._cancel.is_set():
                                raise _Cancelled
                            chunk = resp.read(1 << 20)
                            if not chunk:
                                break
                            fh.write(chunk)
                            have += len(chunk)
                            self._set(done=offset + have)
                break
            except _Cancelled:
                raise
            except Exception as exc:  # noqa: BLE001
                if attempt == 5:
                    raise
                print(f"[gpu] 下載中斷（{exc}），重試…", file=sys.stderr, flush=True)
                self._set(message=f"連線中斷，重試中（{attempt + 1}/5）…")
                time.sleep(3)

        if wheel["sha256"] and _sha256(part) != wheel["sha256"]:
            part.unlink(missing_ok=True)
            raise RuntimeError(f"{wheel['filename']} 校驗碼不符，檔案可能損毀，請再試一次")
        part.replace(dest)


# 執行時用不到的部分。torch/include 底下的 C++ 標頭路徑很深，解開後會超過
# Windows 260 字元的路徑上限；打包腳本也一樣把這幾個刪掉。
_SKIP_PREFIXES = ("torch/include/", "torch/test/", "torchaudio/include/")


def _skip_member(name: str) -> bool:
    if name.split("/", 1)[0].endswith(".data"):  # wheel 的 scripts、headers
        return True
    return name.startswith(_SKIP_PREFIXES) or name.endswith((".lib", ".pdb"))


def _long(path: Path) -> str:
    """Windows 上加 \\\\?\\ 前綴，解除 260 字元的路徑上限（使用者名稱很長時仍可能撞到）。"""
    p = str(path.resolve())
    if os.name == "nt" and not p.startswith("\\\\?\\"):
        return "\\\\?\\" + p
    return p


def _driver_tuple(gpu: dict) -> tuple[int, int]:
    try:
        return tuple(int(x) for x in str(gpu.get("driver", "")).split(".")[:2])
    except ValueError:
        return (0, 0)


def _pick_wheels(base: str | None, gpu: dict) -> tuple[str, list[dict]]:
    """挑出有同版號 wheel、而且驅動夠新的 CUDA 版本。"""
    if not base:
        raise RuntimeError("讀不到內附的 PyTorch 版本")
    driver = _driver_tuple(gpu)
    too_old = None
    for tag, need in CUDA_TAGS:
        torch_whl = _find_wheel("torch", base, tag)
        if not torch_whl:
            continue
        if driver < need:
            too_old = too_old or (tag, need)
            continue
        wheels = [torch_whl]
        # torchaudio 有自己的版號；伺服器上沒有對應的 CUDA 版就沿用內附的
        audio = _find_wheel("torchaudio", _base(bundled_torch_version(pkg="torchaudio")), tag)
        if audio:
            wheels.append(audio)
        return tag, wheels
    if too_old:
        raise RuntimeError(f"PyTorch {base} 需要 {too_old[0]}，顯示卡驅動要更新到 "
                           f"{too_old[1][0]}.{too_old[1][1]} 以上（目前 {gpu.get('driver')}）")
    raise RuntimeError(f"PyTorch 官方伺服器上沒有 {base} 的 Windows CUDA 版")


def _find_wheel(pkg: str, base: str | None, tag: str) -> dict | None:
    """從 PyTorch 的 simple index 找出對應這個 Python 與版號的 Windows wheel。"""
    if not base:
        return None
    url = f"{INDEX_URL}/{tag}/{pkg}/"
    try:
        with urllib.request.urlopen(urllib.request.Request(
                url, headers={"User-Agent": "karaoke-scoring"}), timeout=30) as resp:
            page = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise

    py = f"cp{sys.version_info.major}{sys.version_info.minor}"
    want = f"{pkg}-{base}+{tag}-{py}-{py}-win_amd64.whl"
    for href in re.findall(r'href="([^"]+)"', page):
        href = html.unescape(href)
        link, _, frag = href.partition("#")
        name = urllib.parse.unquote(link.rsplit("/", 1)[-1])
        if name != want:
            continue
        full = urllib.parse.urljoin(url, link)
        sha = frag.split("=", 1)[1] if frag.startswith("sha256=") else None
        return {"filename": name, "url": full, "sha256": sha, "size": _head_size(full)}
    return None


def _head_size(url: str) -> int | None:
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "karaoke-scoring"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            return int(resp.headers.get("Content-Length") or 0) or None
    except Exception:  # noqa: BLE001
        return None


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


_VERIFY_CODE = (
    "import json,sys;"
    "sys.path[:0]=[sys.argv[1]];"
    "import torch,torchaudio;"
    "assert torch.cuda.is_available(),'torch.cuda.is_available() 為 False';"
    "x=torch.randn(256,256,device='cuda');float((x@x).sum().cpu());"
    "s=torch.randn(2,8192,device='cuda');w=torch.hann_window(1024,device='cuda');"
    "torch.istft(torch.stft(s,1024,256,window=w,return_complex=True),1024,256,window=w);"
    "print(json.dumps(torch.__version__+' / '+torch.cuda.get_device_name(0)))"
)


def _verify(site: Path) -> tuple[bool, str]:
    """在獨立子行程裡用新的 torch 跑一次，驅動層的 segfault 也不會拖垮伺服器。"""
    env = dict(os.environ)
    paths = [p for p in sys.path if p and os.path.isdir(p)]
    env["PYTHONPATH"] = os.pathsep.join(paths)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    kw = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    try:
        proc = subprocess.run([sys.executable, "-s", "-B", "-c", _VERIFY_CODE, str(site)],
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=300, env=env, **kw)
    except subprocess.TimeoutExpired:
        return False, "試跑逾時"
    if proc.returncode == 0:
        try:
            return True, json.loads(proc.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            return True, proc.stdout.strip()
    lines = (proc.stderr or "").strip().splitlines()
    return False, lines[-1] if lines else f"結束碼 {proc.returncode}"


def _torch_loaded_from_pack(data: Path) -> bool:
    mod = sys.modules.get("torch")
    if mod is None:
        site = active_pack(data, bundled_lib())
        return bool(site) and str(site) in sys.path
    return str(pack_dir(data)) in str(getattr(mod, "__file__", ""))


PACK = GpuPack()
