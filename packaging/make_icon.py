"""make_icon.py — 產生應用程式圖示（不依賴 Pillow，用 numpy 直接畫像素）。

畫面是深色圓角底 + 青色的音程條，跟程式介面同一套視覺。
輸出 icon.iconset/ 之後由 iconutil 轉成 .icns。
"""

from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

import numpy as np

BG = (0x0B, 0x0B, 0x14)
CYAN = (0x00, 0xE5, 0xFF)
MAGENTA = (0xFF, 0x2B, 0xD6)
GOLD = (0xFF, 0xD5, 0x4A)


def write_png(path: Path, rgba: np.ndarray) -> None:
    h, w, _ = rgba.shape
    raw = b"".join(b"\x00" + rgba[y].tobytes() for y in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    path.write_bytes(png)


def rounded_mask(size: int, radius_ratio: float = 0.225) -> np.ndarray:
    """macOS 風格的圓角遮罩，邊緣做抗鋸齒。"""
    r = size * radius_ratio
    y, x = np.mgrid[0:size, 0:size].astype(np.float64)
    cx = np.clip(x + 0.5, r, size - r)
    cy = np.clip(y + 0.5, r, size - r)
    dist = np.hypot(x + 0.5 - cx, y + 0.5 - cy)
    return np.clip((r - dist) + 0.5, 0, 1)


def draw(size: int) -> np.ndarray:
    img = np.zeros((size, size, 4), dtype=np.float64)
    s = size / 512.0

    # 底色帶一點對角光暈
    y, x = np.mgrid[0:size, 0:size].astype(np.float64)
    glow = np.clip(1.2 - (x + y) / (size * 1.6), 0, 1)
    for i, c in enumerate(BG):
        img[:, :, i] = c + glow * 26

    def bar(x0, y0, w, h, color, alpha=1.0):
        xs = slice(int(x0 * s), int((x0 + w) * s))
        ys = slice(int(y0 * s), int((y0 + h) * s))
        for i, c in enumerate(color):
            img[ys, xs, i] = img[ys, xs, i] * (1 - alpha) + c * alpha

    # 音程條：高低錯落的橫條，像譜面畫面
    bars = [(96, 300, 96, 30), (208, 232, 120, 30), (344, 288, 80, 30),
            (128, 176, 72, 30), (240, 348, 88, 30)]
    for bx, by, bw, bh in bars:
        bar(bx, by, bw, bh, CYAN, 0.92)

    # 實唱線（洋紅）與命中處（金）
    bar(96, 256, 330, 10, MAGENTA, 0.85)
    bar(208, 256, 120, 10, GOLD, 0.95)

    # 判定線
    bar(250, 120, 6, 300, (255, 255, 255), 0.35)

    img[:, :, 3] = 255
    alpha = rounded_mask(size)
    img[:, :, 3] *= alpha
    for i in range(3):
        img[:, :, i] *= alpha
    return np.clip(img, 0, 255).astype(np.uint8)


def write_ico(path: Path, sizes=(16, 32, 48, 64, 128, 256)) -> None:
    """Windows 圖示。Vista 以後的 .ico 可以直接內嵌 PNG，不必存點陣圖。"""
    import io
    import tempfile

    images = []
    tmpdir = Path(tempfile.gettempdir())
    for size in sizes:
        buf = io.BytesIO()
        tmp = tmpdir / f"_ico_{size}.png"
        write_png(tmp, draw(size))
        buf.write(tmp.read_bytes())
        tmp.unlink(missing_ok=True)
        images.append((size, buf.getvalue()))

    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries, blobs = b"", b""
    for size, data in images:
        entries += struct.pack("<BBBBHHII",
                               0 if size >= 256 else size, 0 if size >= 256 else size,
                               0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    path.write_bytes(header + entries + blobs)


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if "--ico" in sys.argv:
        ico_path = Path(sys.argv[sys.argv.index("--ico") + 1])
        write_ico(ico_path)
        print(f"Windows 圖示已輸出到 {ico_path}")

    out = Path(args[0] if args else "icon.iconset")
    out.mkdir(parents=True, exist_ok=True)
    for size, names in [
        (16, ["icon_16x16.png"]), (32, ["icon_16x16@2x.png", "icon_32x32.png"]),
        (64, ["icon_32x32@2x.png"]), (128, ["icon_128x128.png"]),
        (256, ["icon_128x128@2x.png", "icon_256x256.png"]),
        (512, ["icon_256x256@2x.png", "icon_512x512.png"]),
        (1024, ["icon_512x512@2x.png"]),
    ]:
        img = draw(size)
        for name in names:
            write_png(out / name, img)
    print(f"圖示已輸出到 {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
