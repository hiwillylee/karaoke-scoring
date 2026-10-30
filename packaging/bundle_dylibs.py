"""bundle_dylibs.py — 把 macOS 執行檔連到的非系統動態函式庫一起收進來。

Homebrew 的 ffmpeg 連到 18 個 homebrew dylib，直接複製執行檔到別台電腦會跑不動。
這支程式遞迴收集相依函式庫、改寫載入路徑成 @executable_path，並重新做臨時簽章
（Apple Silicon 上修改過的 Mach-O 沒有有效簽章會被系統拒絕執行）。

用法：python3 bundle_dylibs.py <來源執行檔> <輸出的 bin 目錄>
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

SYSTEM_PREFIXES = ("/usr/lib/", "/System/")


def deps_of(binary: Path) -> list[str]:
    out = subprocess.run(["otool", "-L", str(binary)],
                         capture_output=True, text=True, check=True).stdout
    deps = []
    for line in out.splitlines()[1:]:
        path = line.strip().split(" (")[0]
        if not path or path.startswith(SYSTEM_PREFIXES):
            continue
        if path.startswith("@"):        # 已經是相對路徑
            continue
        deps.append(path)
    return deps


def resign(target: Path) -> None:
    """改寫過的 Mach-O 一定要重新簽章，否則在 Apple Silicon 上無法執行。"""
    subprocess.run(["codesign", "--force", "--sign", "-", str(target)],
                   capture_output=True, check=False)


def bundle(exe_src: Path, bin_dir: Path) -> None:
    lib_dir = bin_dir / "lib"
    bin_dir.mkdir(parents=True, exist_ok=True)
    lib_dir.mkdir(parents=True, exist_ok=True)

    exe_dst = bin_dir / exe_src.name
    shutil.copy2(exe_src, exe_dst)
    exe_dst.chmod(0o755)

    pending: list[tuple[Path, Path]] = [(exe_src, exe_dst)]
    copied: dict[str, Path] = {}

    while pending:
        original, target = pending.pop()
        for dep in deps_of(target):
            name = Path(dep).name
            if name not in copied:
                source = Path(dep)
                if not source.exists():
                    print(f"  ！找不到 {dep}，略過")
                    continue
                dest = lib_dir / name
                shutil.copy2(source, dest)
                dest.chmod(0o755)
                copied[name] = dest
                subprocess.run(
                    ["install_name_tool", "-id", f"@executable_path/lib/{name}", str(dest)],
                    capture_output=True, check=False)
                pending.append((source, dest))
            subprocess.run(
                ["install_name_tool", "-change", dep, f"@executable_path/lib/{name}", str(target)],
                capture_output=True, check=False)
        resign(target)

    print(f"  收進 {len(copied)} 個相依函式庫")


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    src = Path(sys.argv[1]).resolve()
    if not src.exists():
        print(f"找不到 {src}")
        return 1
    bundle(src, Path(sys.argv[2]).resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
