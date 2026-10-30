"""octave_common.py — 八度驗證共用工具。

供 test_octave.py（回歸測試）與 find_suspects.py（找可疑音符）共用。

這裡的判準只有一個，而且是整個除錯過程中唯一能重現人工標記的那一個：
**比較奇數倍與偶數倍諧波的相對強度**。

原理：若譜上的 f0 正確，它的諧波是 2f0、3f0、4f0、5f0…，奇偶兩邊都有能量。
若 f0 其實低了一個八度（真正的基頻是 2·f0），諧波全部落在 2f0、4f0、6f0 上，
奇數倍的位置什麼都沒有。

用比值而不是絕對值很重要：pyin 掉到次諧波時，f0 那個位置往往還留著一點微弱
能量（週期倍化的殘留），「基頻必須完全沒能量」這種判準會被它騙過去。
"""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

import librosa
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
LIBRARY = ROOT / "library"
LABELS = Path(__file__).resolve().parent / "octave_labels.json"

PROBE_SR = 22050          # 分析用取樣率，與 analyze.py 的 16k 無關
SUSPECT_RATIO = 0.10      # 奇/偶比低於此值視為疑似低八度


def ffmpeg_bin() -> str:
    import shutil
    import os
    bundled = os.environ.get("KARAOKE_FFMPEG")
    if bundled and Path(bundled).exists():
        return bundled
    return shutil.which("ffmpeg") or "ffmpeg"


def load_vocals(song_dir: Path) -> tuple[np.ndarray, int]:
    """曲庫存的是 m4a，librosa 讀不了 AAC，先過 ffmpeg。"""
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "v.wav"
        subprocess.run(
            [ffmpeg_bin(), "-y", "-loglevel", "error", "-i", str(song_dir / "vocals.m4a"),
             "-ar", str(PROBE_SR), "-ac", "1", str(wav)],
            check=True,
        )
        return librosa.load(str(wav), sr=PROBE_SR, mono=True)


def odd_even_ratio(y: np.ndarray, sr: int, midi: float, t_sec: float) -> float | None:
    """奇數倍 / 偶數倍諧波的強度比。低於 SUSPECT_RATIO 代表這個音高低了一個八度。"""
    i0, i1 = int((t_sec - 0.08) * sr), int((t_sec + 0.08) * sr)
    if i0 < 0 or i1 > len(y):
        return None
    seg = y[i0:i1]
    if np.sqrt(np.mean(seg ** 2)) < 5e-4:
        return None
    spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
    freqs = np.fft.rfftfreq(len(seg), 1 / sr)
    f0 = float(librosa.midi_to_hz(midi))

    def amp(f: float) -> float:
        band = (freqs > f * 0.96) & (freqs < f * 1.04)
        return float(spec[band].max()) if band.any() else 0.0

    even = max(amp(2 * f0), amp(4 * f0))
    if even <= 0:
        return None
    return max(amp(3 * f0), amp(5 * f0)) / even


def note_ratio(y: np.ndarray, sr: int, note: dict) -> float | None:
    """整個 note 期間取五點的中位數，避免單一時間點的雜訊主導。"""
    vals = [odd_even_ratio(y, sr, note["midi"], t)
            for t in np.linspace(note["startMs"] / 1000, note["endMs"] / 1000, 5)]
    vals = [v for v in vals if v is not None]
    return float(np.median(vals)) if vals else None


def suspect_rate(y: np.ndarray, sr: int, notes: list[dict]) -> tuple[int, int]:
    """回傳 (疑似低八度的 note 數, 可檢驗的 note 數)。"""
    rs = [note_ratio(y, sr, n) for n in notes]
    ok = [r for r in rs if r is not None]
    return sum(1 for r in ok if r < SUSPECT_RATIO), len(ok)


def library_songs() -> list[Path]:
    """曲庫裡資料齊全（有 meta／chart／vocals）的歌曲資料夾。"""
    if not LIBRARY.is_dir():
        return []
    return [d for d in sorted(p for p in LIBRARY.iterdir() if p.is_dir())
            if (d / "meta.json").exists() and (d / "chart.json").exists()
            and (d / "vocals.m4a").exists()]


def song_name(song_dir: Path) -> str:
    return json.loads((song_dir / "meta.json").read_text(encoding="utf-8")).get("name") or song_dir.name


def find_song(match: str) -> Path | None:
    """以歌名子字串找曲庫資料夾。曲庫是使用者資料，資料夾名會變，不能寫死。"""
    for d in library_songs():
        if match in song_name(d):
            return d
    return None


def load_chart(song_dir: Path) -> dict:
    return json.loads((song_dir / "chart.json").read_text(encoding="utf-8"))


def note_at(notes: list[dict], t_ms: float) -> dict | None:
    for n in notes:
        if n["startMs"] <= t_ms <= n["endMs"]:
            return n
    return None


def load_labels() -> dict:
    return json.loads(LABELS.read_text(encoding="utf-8"))
