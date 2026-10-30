"""analyze.py — 丟一首歌進來，產出純伴奏、原唱音高譜與原唱技巧標記。

流程：
  1. Demucs 音源分離（--two-stems=vocals）→ 人聲軌 + 純伴奏軌
  2. 對乾淨的人聲軌跑 librosa.pyin 抽主旋律音高
  3. 後處理（八度誤判修正 → 中值濾波 → 八度跳修正 → 半音量化 → 切 note）
  4. 以與前端 js/techniques.js 相同的判準標出原唱的
     ビブラート／しゃくり／フォール

判準常數一律讀 config/params.json，與前端共用。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import librosa
import numpy as np

ROOT = Path(__file__).resolve().parent
PARAMS = json.loads((ROOT / "config" / "params.json").read_text(encoding="utf-8"))

ANALYSIS_SR = 16000  # 人聲基頻遠低於 8kHz，降到 16k 可大幅加速 pyin


# --------------------------------------------------------------------------
# 1. 音源分離
# --------------------------------------------------------------------------

# 由快到慢的候選順序。同一份 PyTorch 只會內含其中一種 GPU 後端
# （CUDA 版與 XPU 版是不同的 wheel），因此這裡用「探測到什麼就用什麼」
# 的方式，讓同一份程式碼在各種安裝上都能自動挑到最好的。
DEVICE_CANDIDATES = ["cuda", "xpu", "mps", "directml", "cpu"]

DEVICE_LABELS = {
    "cuda": "NVIDIA 顯示卡（CUDA）",
    "xpu": "Intel 顯示卡（XPU）",
    "mps": "Apple 晶片（Metal）",
    "directml": "DirectX 12 顯示卡（DirectML）",
    "cpu": "CPU",
}

_device_cache: str | None = None


def _resolve(name: str) -> str | None:
    """把候選名稱轉成實際可用的 torch device 字串，不可用就回 None。"""
    import torch

    if name == "cuda":
        return "cuda" if torch.cuda.is_available() else None
    if name == "xpu":
        return "xpu" if getattr(torch, "xpu", None) and torch.xpu.is_available() else None
    if name == "mps":
        return "mps" if torch.backends.mps.is_available() else None
    if name == "directml":
        try:
            import torch_directml
        except ImportError:
            return None
        return str(torch_directml.device()) if torch_directml.is_available() else None
    return "cpu"


def _no_window() -> dict:
    """Windows 上別讓子行程彈出黑色主控台視窗。

    打包後的程式是視窗模式（pythonw.exe），一旦去啟動 python.exe、ffmpeg.exe
    這類主控台程式，Windows 就會另外配一個主控台視窗給它，使用者會看到莫名其妙
    的黑視窗閃出來。macOS／Linux 沒有這個概念，直接跳過。
    """
    if os.name == "nt":
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {}


def _child_env() -> dict:
    """給 Python 子行程用的環境變數。

    打包成 .app 之後，第三方套件放在 bundle 裡的 lib，是啟動時由 launcher.py
    直接塞進 sys.path 的，並不存在於任何環境變數。子行程不會繼承 sys.path，
    所以要在這裡轉成 PYTHONPATH——否則 `python -m demucs` 只會回報
    「No module named demucs」，分析永遠失敗。
    """
    env = dict(os.environ)
    paths = [p for p in sys.path if p and os.path.isdir(p)]
    if env.get("PYTHONPATH"):
        paths.append(env["PYTHONPATH"])
    if paths:
        env["PYTHONPATH"] = os.pathsep.join(paths)
    # 子行程也不能寫位元碼。打包後的套件在已簽章的 .app 內，多出任何一個
    # .pyc 都會讓簽章驗證失敗，macOS 之後會直接用 SIGTRAP 中止程式。
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env


_PROBE_CODE = (
    "import json,sys;"
    "sys.path[:]=json.loads(sys.argv[1]);"
    "import torch;"
    "d=sys.argv[2];"
    "x=torch.randn(256,256,device=d);"
    "float((x@x).sum().cpu());"
    "sig=torch.randn(2,8192,device=d);"
    "win=torch.hann_window(1024,device=d);"
    "spec=torch.stft(sig,n_fft=1024,hop_length=256,window=win,return_complex=True);"
    "torch.istft(spec,n_fft=1024,hop_length=256,window=win)"
)


def _probe(device: str, timeout: float = 180.0) -> bool:
    """實際跑一次才敢用。

    只檢查 is_available() 是不夠的——Demucs 需要複數 STFT，DirectML 這類
    後端的運算子覆蓋不全，會在真正分離時才爆掉。這裡先用小張量把矩陣運算
    與 STFT/iSTFT 都跑過一遍，過不了就換下一個。

    這一段跑在子行程裡。GPU 驅動出問題時給的是 segfault 而不是 Python 例外，
    try/except 攔不到；在本行程直接跑的話，整個程式會毫無訊息地消失
    （打包成 .app 後跑 Metal 探測就會這樣）。隔離到子行程之後，最壞情況
    只是這個裝置被判定不可用，自動退到下一個候選。
    """
    try:
        proc = subprocess.run(
            [sys.executable, "-s", "-E", "-B", "-c", _PROBE_CODE,
             json.dumps(sys.path), device],
            capture_output=True, timeout=timeout, **_no_window(),
        )
    except subprocess.TimeoutExpired:
        print(f"[analyze] {device} 探測逾時（超過 {timeout:.0f} 秒），改試下一個",
              file=sys.stderr)
        return False
    except Exception as exc:  # noqa: BLE001
        print(f"[analyze] {device} 無法探測（{type(exc).__name__}: {exc}），改試下一個",
              file=sys.stderr)
        return False

    if proc.returncode == 0:
        return True

    detail = (proc.stderr or b"").decode("utf-8", "replace").strip().splitlines()
    reason = detail[-1] if detail else f"結束碼 {proc.returncode}"
    if proc.returncode < 0:
        reason = f"子行程被訊號 {-proc.returncode} 中止（驅動層錯誤）"
    print(f"[analyze] {device} 無法使用（{reason}），改試下一個", file=sys.stderr)
    return False


def pick_device(force: str | None = None) -> str:
    """挑出可用且真的跑得動的運算裝置。結果會快取，不必每首歌重測。"""
    global _device_cache
    if force:
        return force
    if _device_cache:
        return _device_cache

    for name in DEVICE_CANDIDATES:
        device = _resolve(name)
        if device is None:
            continue
        if name != "cpu" and not _probe(device):
            continue
        _device_cache = device
        print(f"[analyze] 使用 {DEVICE_LABELS.get(name, name)}（{device}）", flush=True)
        return device

    _device_cache = "cpu"
    return "cpu"


def describe_devices() -> list[dict]:
    """列出各候選裝置的狀態，供啟動時顯示與診斷。"""
    import torch

    rows = []
    for name in DEVICE_CANDIDATES:
        try:
            device = _resolve(name)
        except Exception:  # noqa: BLE001
            device = None
        rows.append({
            "name": name,
            "label": DEVICE_LABELS.get(name, name),
            "available": device is not None,
            "device": device,
        })
    rows.append({"name": "_torch", "label": f"PyTorch {torch.__version__}",
                 "available": True, "device": None})
    return rows


def separate(input_path: Path, work_dir: Path, progress) -> tuple[Path, Path]:
    """跑 Demucs，回傳 (人聲軌, 伴奏軌)。MPS 失敗時自動退回 CPU。"""
    out_dir = work_dir / "demucs"
    out_dir.mkdir(parents=True, exist_ok=True)

    chosen = pick_device()
    fallbacks = [chosen] + (["cpu"] if chosen != "cpu" else [])
    for device in fallbacks:
        progress(f"以 {DEVICE_LABELS.get(device.split(':')[0], device)} 進行音源分離…", 0.05)
        cmd = [
            sys.executable, "-B", "-m", "demucs",
            "--two-stems=vocals",
            "-n", "htdemucs",
            "-d", device,
            "-o", str(out_dir),
            str(input_path),
        ]
        started = time.time()
        # 一定要指明 utf-8：demucs 的進度條含非 ASCII 字元，若用系統地區編碼
        # （繁中 Windows 是 cp950）解碼會在讀取執行緒炸掉，連帶讓 stderr 變成
        # None，真正的錯誤訊息反而被蓋掉。
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              encoding="utf-8", errors="replace",
                              env=_child_env(), **_no_window())
        if proc.returncode == 0:
            stems = sorted(out_dir.glob("htdemucs/*/vocals.wav"))
            if stems:
                vocals = stems[0]
                inst = vocals.with_name("no_vocals.wav")
                progress(f"分離完成（{device}，{time.time() - started:.1f}s）", 0.55)
                return vocals, inst
        print(f"[analyze] demucs 於 {device} 失敗：\n{proc.stderr[-2000:]}", file=sys.stderr)
        global _device_cache
        _device_cache = "cpu"  # 這個裝置實際跑不動，之後直接用 CPU
        if device == "cpu":
            raise RuntimeError("Demucs 分離失敗，詳見伺服器輸出")
    raise RuntimeError("Demucs 分離失敗")


def ffmpeg_bin() -> str:
    """打包後用內附的 ffmpeg，開發時用系統上的。"""
    bundled = os.environ.get("KARAOKE_FFMPEG")
    if bundled and Path(bundled).exists():
        return bundled
    return shutil.which("ffmpeg") or "ffmpeg"


def to_m4a(src: Path, dst: Path) -> Path:
    """轉成 AAC/m4a —— Chrome 與 Safari 的 decodeAudioData 都能解。"""
    subprocess.run(
        [ffmpeg_bin(), "-y", "-loglevel", "error", "-i", str(src),
         "-c:a", "aac", "-b:a", "160k", str(dst)],
        check=True, **_no_window(),
    )
    return dst


# --------------------------------------------------------------------------
# 2~3. 音高抽取與後處理
# --------------------------------------------------------------------------

# CREPE 的 periodicity 門檻。低於此值視為無人聲——這是 torchcrepe 作者建議的
# 起手值，實測對分離後的人聲軌也合適。
CREPE_PERIODICITY_MIN = 0.21
CREPE_MODEL = "full"   # 太慢的話改 "tiny"，八度穩健性會下降但仍優於 pyin


def f0_crepe(y: np.ndarray, hop_length: int, fmin: float, fmax: float) -> tuple:
    """用 CREPE（CNN）抽基頻。回傳 (f0, valid)，無人聲處 f0 為 NaN。

    換掉 pyin 的理由就是八度：pyin 屬於自相關／YIN 家族，二次諧波比基頻強時
    會整段鎖在諧波上（實測 Ado 的副歌諧波是基頻的 6 倍），而它用 Viterbi 解
    整條路徑，一鎖就鎖一整句——看起來跟「真的飆上一個八度」一模一樣，事後
    完全分不出來。CREPE 是在標註資料上訓練的 CNN，八度穩健性正是它的強項。

    CREPE 原生就是 16kHz，與 ANALYSIS_SR 相同，不需要重取樣。
    """
    import torch
    import torchcrepe

    device = pick_device()
    audio = torch.from_numpy(y)[None].float()

    def run(dev: str):
        return torchcrepe.predict(
            audio, ANALYSIS_SR, hop_length, fmin, fmax,
            model=CREPE_MODEL, batch_size=1024, device=dev,
            return_periodicity=True,
        )

    try:
        pitch, periodicity = run(device)
    except Exception as exc:  # noqa: BLE001
        # GPU 後端的運算子覆蓋不全時才會在這裡爆；退回 CPU 一定跑得動
        print(f"[analyze] CREPE 於 {device} 失敗（{type(exc).__name__}: {exc}），改用 CPU",
              file=sys.stderr)
        pitch, periodicity = run("cpu")

    # 先用 periodicity 濾掉無人聲，再平滑；順序反過來會把靜音的 NaN 抹進真實音高
    periodicity = torchcrepe.filter.median(periodicity, 3)
    pitch = torchcrepe.threshold.At(CREPE_PERIODICITY_MIN)(pitch, periodicity)
    pitch = torchcrepe.filter.mean(pitch, 3)

    f0 = pitch[0].cpu().numpy().astype(np.float64)
    return f0, ~np.isnan(f0)


def f0_pyin(y: np.ndarray, hop_length: int, frame_length: int,
            fmin: float, fmax: float) -> tuple:
    """pyin 備援：沒裝 torchcrepe 的環境仍然能分析，只是八度誤判會多。"""
    f0, voiced_flag, _ = librosa.pyin(
        y, fmin=fmin, fmax=fmax, sr=ANALYSIS_SR,
        frame_length=frame_length, hop_length=hop_length,
    )
    # 有無人聲以 pyin 自己的 Viterbi 判斷（voiced_flag）為準。voiced_prob 是
    # 狀態的後驗機率質量，尺度與「像不像人聲」無關，拿來當門檻會誤刪大半音框。
    return f0, (~np.isnan(f0)) & np.nan_to_num(voiced_flag, nan=0).astype(bool)


def extract_frames(vocals_path: Path, progress) -> dict:
    p = PARAMS["pitch"]
    hop_ms = p["hopMs"]
    hop_length = int(round(ANALYSIS_SR * hop_ms / 1000))

    progress("抽取人聲音高…", 0.6)
    y, _ = librosa.load(str(vocals_path), sr=ANALYSIS_SR, mono=True)

    try:
        import torchcrepe  # noqa: F401
    except ImportError:
        print("[analyze] 找不到 torchcrepe，改用 pyin（八度誤判會較多，"
              "建議重跑 setup.sh）", file=sys.stderr)
        f0, valid = f0_pyin(y, hop_length, p["frameLength"], p["fminHz"], p["fmaxHz"])
    else:
        f0, valid = f0_crepe(y, hop_length, p["fminHz"], p["fmaxHz"])

    rms = librosa.feature.rms(y=y, frame_length=p["frameLength"], hop_length=hop_length)[0]

    # 兩種抽取器的音框數可能差一兩框，統一對齊到較短的那個
    n = min(len(f0), len(rms))
    f0, valid, rms = f0[:n], valid[:n], rms[:n]

    # 諧波誤判要在轉成 midi 之前修掉，否則後面每一步都建立在錯的八度上
    f0 = fix_octave_errors(y, f0, valid, ANALYSIS_SR, p["frameLength"], hop_length,
                           p["fminHz"], p["fmaxHz"])

    midi = np.zeros(n, dtype=np.float64)
    midi[valid] = librosa.hz_to_midi(f0[valid])

    # 信心值改用「該週期上的正規化自相關」，定義與前端 YIN 的
    # 1 − d'(τ) 行為一致，兩邊才能共用同一個靈敏度門檻。
    conf = periodicity(y, f0, valid, ANALYSIS_SR, p["frameLength"], hop_length)

    progress("整理音高曲線…", 0.8)
    # 只做中值濾波。八度修正留到切段時、過濾掉微弱訊號之後才做——
    # 否則殘留的幽靈音會把旁邊真實音的八度一起帶偏。
    midi = median_filter_voiced(midi, 5)

    return {
        "hopMs": hop_ms,
        "midi": midi,
        "conf": conf,
        "rms": rms,
        "durationMs": len(y) / ANALYSIS_SR * 1000.0,
    }


def periodicity(y: np.ndarray, f0: np.ndarray, valid: np.ndarray,
                sr: int, frame_length: int, hop_length: int) -> np.ndarray:
    """每個音框在其基頻週期上的正規化自相關，值域約 0～1。

    乾淨的週期訊號接近 1，混入雜訊或多個音高時下降——與前端 YIN 的信心值
    是同一種量，因此「偵測靈敏度」滑桿在兩條路徑上意義相同。
    """
    n = len(f0)
    conf = np.zeros(n)
    half = frame_length // 2
    for i in range(n):
        if not valid[i]:
            continue
        lag = int(round(sr / f0[i]))
        start = i * hop_length
        if lag < 2 or start + half + lag > len(y):
            continue
        a = y[start:start + half]
        b = y[start + lag:start + half + lag]
        denom = np.sqrt(float(a @ a) * float(b @ b))
        if denom > 1e-12:
            conf[i] = max(0.0, float(a @ b) / denom)
    return conf


def fix_octave_errors(y: np.ndarray, f0: np.ndarray, valid: np.ndarray,
                      sr: int, frame_length: int, hop_length: int,
                      fmin: float, fmax: float) -> np.ndarray:
    """修正 pyin 的八度誤判——往上往下兩個方向都修。

    pyin 會往兩邊出錯：
      - 往上：強聲區的二次諧波比基頻大好幾倍（實測 Ado 副歌是 6 倍），
        直接鎖在諧波上，整句高音被記高一個八度。
      - 往下：氣聲或含混的低音會出現次諧波，pyin 掉到真正基頻的一半。
        fminHz 開到 65 等於為這種錯誤留了整整一個八度的空間。

    做法是逐框在 {f0/2, f0, 2·f0} 之間重新選擇，判準見下方註解——關鍵是
    永遠去問「較低的那個候選」，不能讓各候選拿自己的分數互比。門檻訂得保守，
    pyin 大多數時候是對的，這裡只處理它明顯站不住腳的那些框。

    fix_octave_jumps 處理不了這種錯：它的判準是「停留夠久＝真的跳八度」，
    而 pyin 用 Viterbi 解整條路徑，一旦鎖錯就會鎖著一整句，完全符合那個
    「真的跳八度」的特徵。
    """
    n = len(f0)
    out = f0.copy()
    win = np.hanning(frame_length)
    freqs = np.fft.rfftfreq(frame_length, 1 / sr)
    nyquist = sr / 2
    choice = np.zeros(n, dtype=np.int8)   # -1 減半、0 不動、+1 加倍

    # 這首歌自己音域的上緣（四分位上緣再放 10 個半音）。高過這裡的音框先驗上
    # 就可疑，減半的門檻可以放寬一點。
    #
    # 但不能只靠音域就砍：向日葵在同樣的高音帶有 2514 框，其中只有 4.2% 是
    # 錯的，單看音域會把整段真實高音誤殺。所以音域只用來調整門檻鬆緊，
    # 真正下判斷的還是頻譜證據。
    voiced_midi = librosa.hz_to_midi(f0[valid]) if valid.any() else np.array([60.0])
    q75 = float(np.percentile(voiced_midi, 75))
    hi_hz = float(librosa.midi_to_hz(q75 + 10))

    for i in range(n):
        if not valid[i]:
            continue
        start = i * hop_length
        if start + frame_length > len(y):
            continue
        spec = np.abs(np.fft.rfft(y[start:start + frame_length] * win))
        base = f0[i]
        floor = float(np.median(spec[(freqs > base * 0.4)
                                     & (freqs < base * 3.2)])) + 1e-12

        def amp(f: float) -> float:
            if f >= nyquist:
                return 0.0
            band = (freqs > f * 0.97) & (freqs < f * 1.03)
            return float(spec[band].max()) / floor if band.any() else 0.0

        # 兩個判斷都問「較低的那個候選，它獨有的奇數倍諧波在不在」。
        # 不能讓各候選拿自己的分數互比：候選 2f 的奇數倍是 2f、6f、10f，
        # 而 2f 本來就是真實基頻 f 的二次諧波、能量很強，只要 H1 偏弱
        # （人聲很常見）2f 就會贏，於是整首歌被往上搬一個八度。
        # 高於這首歌音域上緣時放寬減半門檻，見上方 hi_hz 的說明
        t_half = 3.0 if base > hi_hz else 6.0

        # 奇數倍 vs 偶數倍諧波的相對強度，用來判斷低了一個八度。
        #
        # f0 正確時奇偶兩邊都有能量；f0 低了一個八度時，真正的基頻是 2·f0，
        # 它的諧波全部落在 2f、4f、6f 上，奇數倍的位置什麼都沒有。
        #
        # 用比值而不是絕對值，是因為 pyin 掉到次諧波時，f0 那個位置往往還是
        # 有一點微弱能量（週期倍化的殘留），先前「基頻必須完全沒能量」的
        # 判準就是這樣被騙過去的。比值不受這點殘留影響。
        odd_r = max(amp(3 * base), amp(5 * base))
        even_r = max(amp(2 * base), amp(4 * base))

        # 加倍後若會落到這首歌音域上緣之外，要求更強的證據。真正的次諧波誤判
        # 修回去之後應該落在歌手的主音域內；會把音推到全曲最高處的那些
        # 「修正」實測多半是誤判（一輪花被推到 81、向日葵的高八度從 1 個變 8 個）。
        t_dbl = 0.08 if base * 2 > hi_hz else 0.16

        if (fmin <= base / 2 and amp(0.5 * base) > t_half
                and max(amp(1.5 * base), amp(2.5 * base)) > t_half):
            # f0/2 獨有的奇數倍諧波都在 → 真正的基頻是 f0/2
            choice[i] = -1
        elif (base * 2 <= fmax and even_r > 6 and odd_r < t_dbl * even_r):
            # f0 那個位置根本沒有能量，能量在 2·f0 上 → 基頻是 2·f0。
            #
            # 只用這三個條件，是因為人聲軌裡的伴奏殘留與和聲會在高次諧波的
            # 位置製造孤立強峰，把「5f 也要缺席」之類的條件全部破壞掉。實測
            # 「基頻位置有沒有能量」的判別力最強：明顯錯誤的音框有 99% 在這裡
            # 交白卷，正常音框只有 3%。
            #
            # 仍然要求 3·f0 缺席：基頻被高通濾掉、但泛音列完整的「缺基音」
            # 訊號，聽感上的音高仍然是 f0，那種不能動。3·f0 在就代表 f0 是
            # 真的基頻，只是它本人被濾掉了。
            choice[i] = 1

    # 兩層平滑。逐框各判各的會漏——奇數倍諧波本來就弱，某些框剛好被氣音或
    # 殘響蓋掉就驗不出來，於是一句話裡有幾框被搬走、有幾框留著，切段時就
    # 變成兩個八度不同的碎音。
    #
    # 第一層：以連續樂句為單位投票。pyin 一旦鎖錯就鎖著一整句，所以誤判
    # 本來就是整段出現的。樂句界線取「連續有聲且音高沒有大跳」。
    # 第二層：局部否決。樂句界線可能把一段長長的持續發聲串成好幾句，遠處
    # 真的有誤判的框會把沒問題的框一起拖下水，所以還要求該框附近確實找得到
    # 同方向的證據。
    half_w = 8
    final = np.zeros(n, dtype=np.int8)
    i = 0
    while i < n:
        if not valid[i]:
            i += 1
            continue
        j = i + 1
        while (j < n and valid[j]
               and abs(np.log2(f0[j] / f0[j - 1])) * 12 < 3.0):
            j += 1
        run = choice[i:j]
        for step in (-1, 1):
            if (run == step).sum() < 0.35 * (j - i):
                continue
            for k in range(i, j):
                if not valid[k]:
                    continue
                lo, hi = max(i, k - half_w), min(j, k + half_w + 1)
                if (choice[lo:hi] == step).mean() >= 0.10:
                    final[k] = step
        i = j

    out[valid & (final == -1)] /= 2.0
    out[valid & (final == 1)] *= 2.0
    return out



def median_filter_voiced(values: np.ndarray, window: int = 5) -> np.ndarray:
    """中值濾波，無音（0）的位置不參與也不被填補。"""
    out = values.copy()
    half = window // 2
    for i in range(len(values)):
        if values[i] == 0:
            continue
        lo, hi = max(0, i - half), min(len(values), i + half + 1)
        seg = values[lo:hi]
        seg = seg[seg > 0]
        if len(seg):
            out[i] = float(np.median(seg))
    return out


def fix_octave_jumps(midi: np.ndarray, min_leap_frames: int = 6,
                     octave_tolerance: float = 1.5) -> np.ndarray:
    """修掉 pyin 常見的八度跳，但保留真正的八度跳躍。

    不能無條件往回靠攏：歌手真的飆上一個八度是很常見的唱法，一律當成誤判
    修掉的話，整段高音樂句都會被壓到低八度。判準改成停留長度——pyin 的
    半頻／倍頻誤判只會零星幾框就跳回去，真的換八度會唱好一陣子。
    """
    out = midi.copy()
    idx = [i for i in range(len(out)) if out[i] != 0]
    if len(idx) < 2:
        return out

    prev = out[idx[0]]
    k = 1
    while k < len(idx):
        cur = out[idx[k]]
        oct_ = 0
        for o in (12, -12, 24, -24):
            if abs(cur - prev - o) < octave_tolerance:
                oct_ = o
                break
        if not oct_:
            prev = cur
            k += 1
            continue

        # 往後看這個八度停留了幾框
        run = 1
        while (k + run < len(idx)
               and abs(out[idx[k + run]] - cur) < octave_tolerance):
            run += 1

        # 停得夠久＝真的跳八度，原樣保留並把基準搬過去
        if run < min_leap_frames:
            for j in range(run):
                out[idx[k + j]] -= oct_
        prev = out[idx[k + run - 1]]
        k += run
    return out


def level_floor(frames: dict, min_level_db: float) -> float:
    """音量門檻，相對於這首歌自己的人聲音量。

    Demucs 的人聲軌會殘留一點伴奏、和聲與殘響尾巴，這些訊號雖然幾乎聽不見，
    卻仍然有週期性，pyin 照樣算得出穩定音高——結果就是譜上出現「有音符卻
    沒聲音」的幽靈。用絕對音量當門檻會因歌而異，所以改成相對於這首歌自己
    人聲音量（取第 90 百分位）的相對門檻。
    """
    voiced = frames["rms"][frames["midi"] > 0]
    voiced = voiced[voiced > 0]
    if len(voiced) < 10:
        return 0.0
    reference = float(np.percentile(voiced, 90))
    return reference * (10 ** (min_level_db / 20))


def prepare_frames(frames: dict, min_confidence: float | None = None,
                   min_level_db: float | None = None) -> dict:
    """套用門檻並修正八度，產生可直接用來切段與偵測技巧的音框。

    順序很重要：先剔除信心不足與太小聲的音框，再做八度修正。反過來的話，
    幾乎聽不見的殘留會把旁邊真實音的八度一起帶偏。
    """
    p = PARAMS["pitch"]
    min_conf = p["minConfidence"] if min_confidence is None else min_confidence
    floor = level_floor(frames, p["minLevelDb"] if min_level_db is None else min_level_db)

    gated = np.where((frames["conf"] >= min_conf) & (frames["rms"] >= floor),
                     frames["midi"], 0.0)
    # 「真的跳八度」以停留 100ms 為界，換算成這份音框的框數
    hop_ms = frames["hopMs"]
    min_leap = max(3, round(100 / hop_ms)) if hop_ms else 6
    return {**frames, "midi": fix_octave_jumps(gated, min_leap), "_prepared": True}


def frames_to_notes(frames: dict, min_confidence: float | None = None,
                    min_level_db: float | None = None) -> list[dict]:
    """把音框切成 note（與 js/dsp.js 的 framesToNotes 同演算法）。

    傳入的音框若尚未經過 prepare_frames，這裡會先處理過。
    """
    p = PARAMS["pitch"]
    if not frames.get("_prepared"):
        frames = prepare_frames(frames, min_confidence, min_level_db)
    min_dur = p["minNoteDurationMs"]
    max_dev = p["maxDeviationSemitones"]
    max_gap = p["maxGapMs"]
    hop_ms = frames["hopMs"]

    midi = frames["midi"]
    notes: list[dict] = []
    cur = None

    def close():
        nonlocal cur
        if cur and cur["endMs"] - cur["startMs"] >= min_dur:
            notes.append({
                "startMs": round(cur["startMs"], 1),
                "endMs": round(cur["endMs"], 1),
                # 量化到半音。音框平均會是 62.76 這種值——那是原唱當下的實際
                # 音高，但譜面該標的是他「在唱哪個音」。不量化的話畫面上音符
                # 會在格線之間浮著，看起來像抽錯了。
                #
                # 對技巧偵測沒有影響：ビブラート／しゃくり／フォール 的判準
                # 全都相對於該 note 的 stable（核心段中位數）或經過 detrend，
                # 基準整體位移最多半個半音會互相抵消。
                "midi": float(round(cur["sum"] / cur["count"])),
            })
        cur = None

    for i in range(len(midi)):
        t = i * hop_ms
        voiced = midi[i] > 0
        if not voiced:
            if cur and t - cur["lastT"] > max_gap:
                close()
            continue
        if cur:
            mean = cur["sum"] / cur["count"]
            if abs(midi[i] - mean) > max_dev or t - cur["lastT"] > max_gap:
                close()
        if not cur:
            cur = {"startMs": t, "endMs": t, "sum": 0.0, "count": 0, "lastT": t}
        cur["sum"] += float(midi[i])
        cur["count"] += 1
        cur["endMs"] = t
        cur["lastT"] = t
    close()
    return merge_glide_notes(notes)


def merge_glide_notes(notes: list[dict]) -> list[dict]:
    """把起音滑上／尾音下滑產生的短碎音併回主音。

    判準：短碎音（< glideMergeMs）緊貼著鄰近音（間隔 <= maxGapMs）、音高差
    在 glideMergeSemitones 內，且它的另一側是靜音——也就是位於樂句邊緣。
    中間被其他音夾住的短音是真正的快速樂句，不合併。
    """
    p = PARAMS["pitch"]
    max_glide, max_gap = p["glideMergeMs"], p["maxGapMs"]
    max_semi = p["glideMergeSemitones"]
    if len(notes) < 2:
        return notes

    def is_short(n):
        return n["endMs"] - n["startMs"] < max_glide

    out: list[dict] = []
    for note in notes:
        note = dict(note)
        if out:
            prev = out[-1]
            gap = note["startMs"] - prev["endMs"]
            close_enough = gap <= max_gap and abs(note["midi"] - prev["midi"]) < max_semi
            # prev 是樂句開頭的滑音（前面沒有緊鄰的音）
            prev_isolated = len(out) < 2 or prev["startMs"] - out[-2]["endMs"] > max_gap
            if close_enough and is_short(prev) and prev_isolated:
                prev["endMs"] = note["endMs"]
                prev["midi"] = note["midi"]
                continue
            if close_enough and is_short(note):
                prev["endMs"] = note["endMs"]
                continue
        out.append(note)
    return out


# --------------------------------------------------------------------------
# 4. 原唱技巧標記（與 js/techniques.js 判準一致）
# --------------------------------------------------------------------------

def _detrend(values: np.ndarray) -> np.ndarray:
    n = len(values)
    if n < 2:
        return values.astype(float)
    x = np.arange(n, dtype=float)
    slope, intercept = np.polyfit(x, values, 1)
    return values - (slope * x + intercept)


def _oscillation(curve: np.ndarray, hop_ms: float) -> tuple[float, float, float]:
    n = len(curve)
    if n < 4:
        return 0.0, 0.0, 0.0
    signs = np.sign(curve)
    nz = signs[signs != 0]
    crossings = int(np.sum(nz[1:] != nz[:-1])) if len(nz) > 1 else 0
    duration_sec = n * hop_ms / 1000.0
    cycles = crossings / 2.0
    rate = cycles / duration_sec if duration_sec > 0 else 0.0
    depth = float(np.sqrt(np.mean(curve ** 2)) * np.sqrt(2))
    return rate, depth, cycles


def analyze_note(core: np.ndarray, onset: np.ndarray, tail: np.ndarray,
                 duration_ms: float, hop_ms: float) -> dict:
    """core/onset/tail 皆為相對該 note 基準音高的音分曲線。

    onset 與 tail 會超出 note 邊界（涵蓋樂句邊緣的滑音），因此即使切段時
    把滑音切成獨立碎音，技巧偵測仍看得到完整的起落。
    """
    res = {"vibrato": None, "shakuri": False, "fall": False}
    cents = core
    if len(cents) < 3:
        return res

    vp = PARAMS["vibrato"]
    if duration_ms >= vp["minNoteMs"]:
        skip = max(1, round(80 / hop_ms))
        mid = cents[skip:max(skip + 3, len(cents) - skip)]
        rate, depth, cycles = _oscillation(_detrend(mid), hop_ms)
        if (vp["minRateHz"] <= rate <= vp["maxRateHz"]
                and vp["minDepthCents"] <= depth <= vp["maxDepthCents"]
                and cycles >= vp["minCycles"]):
            rate_mid = (vp["minRateHz"] + vp["maxRateHz"]) / 2
            rate_score = 1 - abs(rate - rate_mid) / ((vp["maxRateHz"] - vp["minRateHz"]) / 2)
            depth_score = min(1.0, depth / 50)
            res["vibrato"] = {
                "rateHz": round(rate, 2),
                "depthCents": round(depth, 1),
                "quality": round(max(0.0, min(1.0, rate_score * 0.5 + depth_score * 0.5)), 2),
            }

    lo = len(cents) // 4
    hi = max(lo + 1, len(cents) * 3 // 4)
    stable = float(np.median(cents[lo:hi]))

    sp = PARAMS["shakuri"]
    if len(onset) >= 3:
        rise = stable - float(np.min(onset))
        started_below = onset[0] < stable - sp["minRiseCents"] * 0.6
        reached = abs(onset[-1] - stable) <= sp["targetBandCents"]
        if rise >= sp["minRiseCents"] and started_below and reached:
            res["shakuri"] = True

    fp = PARAMS["fall"]
    if len(tail) >= 3:
        drop = stable - float(np.min(tail))
        ends_low = tail[-1] < stable - fp["minDropCents"] * 0.6
        if drop >= fp["minDropCents"] and ends_low:
            res["fall"] = True

    return res


def detect_techniques(notes: list[dict], frames: dict) -> list[dict]:
    """frames 必須是 prepare_frames 的輸出，否則音高與 note 的基準不一致。"""
    hop_ms = frames["hopMs"]
    midi, conf = frames["midi"], frames["conf"]
    min_conf = PARAMS["pitch"]["minConfidence"]
    sw, fw = PARAMS["shakuri"]["windowMs"], PARAMS["fall"]["windowMs"]
    events = []

    def cents_in(note, start_ms, end_ms):
        i0 = max(0, int(round(start_ms / hop_ms)))
        i1 = min(len(midi), int(round(end_ms / hop_ms)) + 1)
        seg = [midi[i] for i in range(i0, i1) if midi[i] > 0 and conf[i] >= min_conf]
        return (np.array(seg) - note["midi"]) * 100 if seg else np.array([])

    for idx, note in enumerate(notes):
        core = cents_in(note, note["startMs"], note["endMs"])
        if len(core) < 3:
            continue
        # 分析窗只有在「這一側是樂句邊緣」時才能往 note 外面伸。
        # 音與音之間的過渡音框從本音看過去一律是先低再爬上來，只要往外看，
        # 每一次換音都會被算成しゃくり＋フォール——這正是原唱被標出上百次
        # 技巧的原因。真正的しゃくり前面是靜音，真正的フォール後面也是靜音。
        prev_n = notes[idx - 1] if idx > 0 else None
        next_n = notes[idx + 1] if idx < len(notes) - 1 else None
        onset_from = (note["startMs"] if prev_n and prev_n["endMs"] > note["startMs"] - sw
                      else note["startMs"] - sw)
        tail_to = (note["endMs"] if next_n and next_n["startMs"] < note["endMs"] + fw
                   else note["endMs"] + fw)

        onset = cents_in(note, onset_from, min(note["startMs"] + sw, note["endMs"]))
        tail = cents_in(note, max(note["endMs"] - fw, note["startMs"]), tail_to)
        res = analyze_note(core, onset, tail, note["endMs"] - note["startMs"], hop_ms)
        base = {"startMs": note["startMs"], "endMs": note["endMs"], "noteIndex": idx}
        if res["vibrato"]:
            events.append({"type": "vibrato", **base, "detail": res["vibrato"]})
        if res["shakuri"]:
            events.append({"type": "shakuri", **base, "detail": None})
        if res["fall"]:
            events.append({"type": "fall", **base, "detail": None})
    return events


# --------------------------------------------------------------------------
# 對外入口
# --------------------------------------------------------------------------

def analyze(input_path: Path, work_dir: Path, progress=lambda *_: None) -> dict:
    work_dir.mkdir(parents=True, exist_ok=True)
    started = time.time()

    vocals_wav, inst_wav = separate(input_path, work_dir, progress)

    progress("轉檔中…", 0.57)
    vocals_m4a = to_m4a(vocals_wav, work_dir / "vocals.m4a")
    inst_m4a = to_m4a(inst_wav, work_dir / "instrumental.m4a")

    frames = extract_frames(vocals_wav, progress)
    prepared = prepare_frames(frames)
    notes = frames_to_notes(prepared)

    progress("標記原唱技巧…", 0.92)
    techniques = detect_techniques(notes, prepared)

    chart = {
        "hopMs": frames["hopMs"],
        "durationMs": round(frames["durationMs"], 1),
        "frames": {
            "midi": [round(float(v), 3) for v in frames["midi"]],
            "conf": [round(float(v), 3) for v in frames["conf"]],
            "rms": [round(float(v), 4) for v in frames["rms"]],
        },
        "notes": notes,
        "techniques": techniques,
        "elapsedSec": round(time.time() - started, 1),
    }
    progress("完成", 1.0)

    shutil.rmtree(work_dir / "demucs", ignore_errors=True)
    return {"chart": chart, "vocals": vocals_m4a, "instrumental": inst_m4a}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法：python analyze.py <歌曲檔案> [輸出資料夾]")
        raise SystemExit(1)
    src = Path(sys.argv[1])
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "work" / src.stem
    result = analyze(src, out, lambda msg, pct: print(f"[{pct * 100:5.1f}%] {msg}", flush=True))
    chart = result["chart"]
    (out / "chart.json").write_text(json.dumps(chart, ensure_ascii=False), encoding="utf-8")
    counts: dict[str, int] = {}
    for ev in chart["techniques"]:
        counts[ev["type"]] = counts.get(ev["type"], 0) + 1
    print(f"note 數：{len(chart['notes'])}　技巧：{counts}　耗時 {chart['elapsedSec']}s")
    print(f"伴奏：{result['instrumental']}")
