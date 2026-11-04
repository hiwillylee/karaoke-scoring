"""make_icon.py — 產生應用程式圖示（不依賴 Pillow，用 numpy 直接畫像素）。

畫面是緋紅圓角底 + 白色音程條與金色的實唱線，跟網頁的分頁圖示同一個造型。
輸出 icon.iconset/ 之後由 iconutil 轉成 .icns。
"""

from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

import numpy as np

BG = (0xD7, 0x26, 0x3D)        # 介面主色（淺色主題的 --brand）
BG_DEEP = (0xA8, 0x16, 0x2C)
WHITE = (0xFF, 0xFF, 0xFF)
GOLD = (0xFF, 0xC8, 0x3D)


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

    # 由左上到右下的淡淡漸層
    y, x = np.mgrid[0:size, 0:size].astype(np.float64)
    t = np.clip((x + y) / (2 * size), 0, 1)
    for i in range(3):
        img[:, :, i] = BG[i] * (1 - t) + BG_DEEP[i] * t

    def bar(x0, y0, w, h, color, alpha=1.0):
        xs = slice(int(x0 * s), int((x0 + w) * s))
        ys = slice(int(y0 * s), int((y0 + h) * s))
        for i, c in enumerate(color):
            img[ys, xs, i] = img[ys, xs, i] * (1 - alpha) + c * alpha

    def pill(x0, y0, w, h, color, alpha=1.0):
        """圓頭長條，邊緣抗鋸齒（距離場算覆蓋率）。"""
        r = h / 2
        px, py = (x + 0.5) / s, (y + 0.5) / s
        cx = np.clip(px, x0 + r, x0 + w - r)
        cover = np.clip((r - np.hypot(px - cx, py - (y0 + r))) * s + 0.5, 0, 1) * alpha
        for i, c in enumerate(color):
            img[:, :, i] = img[:, :, i] * (1 - cover) + c * cover

    bar = pill  # noqa: F811  音程條都用圓頭

    # 音程條：高低錯落的白色橫條（與分頁圖示同一個構圖）
    for bx, by, bw, alpha in [(96, 270, 112, 0.9), (224, 176, 128, 1.0), (368, 240, 64, 0.9)]:
        bar(bx, by, bw, 54, WHITE, alpha)

    # 實唱線（金）
    bar(96, 372, 320, 34, GOLD, 1.0)

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
