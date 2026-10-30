# 第三方軟體授權聲明

本程式（唱歌評分）自己撰寫的原始碼（`js/`、`css/`、`index.html`、`server.py`、
`analyze.py`、`launcher.py`、`library.py`、`fetcher.py`、`tunnel.py` 等）未另外
宣告授權；本檔案記錄的是**打包進安裝檔裡的第三方軟體與模型**，依授權條款分類列出。

打包後的應用程式（.app / 安裝後的資料夾）裡，`app/licenses/` 目錄含有下列
copyleft 套件的完整授權全文；其餘寬鬆授權的套件則各自把自己的授權檔帶在
`lib/<套件>-<版本>.dist-info/licenses/` 內，一併隨應用程式散佈。

## 需要特別留意的四項（copyleft）

打包時內附以下四個元件，散佈時必須附上其授權全文與原始碼取得方式（皆為
公開專案，原始碼已可從對應連結取得）。四者皆**以獨立行程或子行程呼叫**執行
（demucs 透過 `python -m demucs` 子行程、ffmpeg/ffprobe 為外部執行檔），
沒有被靜態連結進本專案自己的程式碼；即便如此，散佈這些檔案本身仍須遵守
其授權條款。

| 元件 | 授權 | 在本專案的用途 | 是否會被執行到 | 原始碼 |
|---|---|---|---|---|
| **ffmpeg / ffprobe** | GPL-3.0（Homebrew／gyan.dev 的建置版本啟用了 `--enable-gpl` 與 `libx264` 等） | 音檔轉檔、格式探測 | 會，每次分析都用到 | <https://github.com/FFmpeg/FFmpeg> |
| **mutagen** | GPL-2.0-or-later | yt-dlp 用來在 `--embed-thumbnail` 時寫入音檔縮圖標籤 | 不會 — 本專案沒有使用 `--embed-thumbnail`，這個套件只是隨 `yt-dlp[default]` 一起被安裝、打包，實際執行路徑不會匯入它 | <https://github.com/quodlibet/mutagen> |
| **lameenc** | LGPL-3.0-or-later | Demucs 的相依套件，供輸出 MP3 用 | 不會 — 本專案沒有要求 Demucs 輸出 MP3（輸出的是 wav），程式碼不會呼叫到 | <https://github.com/chrisstaite/lameenc> |
| **python-soxr** | LGPL-2.1-or-later | librosa 內部做音訊重取樣 | **會**，`librosa.load`／`resample` 實際路徑可能用到 | <https://github.com/dofuuz/python-soxr>（底層 `libsoxr`：<https://sourceforge.net/p/soxr/>） |

**若只是自己使用或私下分享給少數朋友**，以上不構成實質風險。**若要公開發布
給不特定人下載**，建議至少：

1. 保留應用程式裡的 `app/licenses/` 目錄與這份文件，不要在打包時精簡掉。
2. 在下載頁或安裝說明附上這份文件的連結。
3. 如果之後想徹底避開 GPL 疑慮，ffmpeg 可以換成不啟用 `--enable-gpl` 的
   建置版本（會失去 `libx264`／`libx265` 等編碼器，但本專案只用到解碼與
   重新編碼成 m4a/wav，通常不受影響）；`mutagen`／`lameenc` 因為本專案
   從未實際呼叫，之後可以考慮從 `yt-dlp[default]` 改成更精簡的可選相依
   組合，讓它們連被打包進去都不會發生。

完整授權全文在：
- [`packaging/licenses/ffmpeg-GPLv3.txt`](packaging/licenses/ffmpeg-GPLv3.txt)
- [`packaging/licenses/mutagen-GPLv2.txt`](packaging/licenses/mutagen-GPLv2.txt)
- [`packaging/licenses/lameenc-LGPLv3.txt`](packaging/licenses/lameenc-LGPLv3.txt)
- [`packaging/licenses/soxr-LGPLv2.1.txt`](packaging/licenses/soxr-LGPLv2.1.txt)

## AI 模型：Demucs（htdemucs）

- **Demucs 程式碼**：MIT License，Meta Platforms, Inc.
- **htdemucs 預訓練權重**：同樣是 MIT License（來源：
  <https://huggingface.co/adefossez/HTDemucs>，model card 標示 `license: mit`）

MIT 授權下可自由使用、修改、再散佈（含商用），只需保留原始著作權聲明。
全文在 [`packaging/licenses/demucs-and-htdemucs-weights-MIT.txt`](packaging/licenses/demucs-and-htdemucs-weights-MIT.txt)。

## AI 模型：CREPE（torchcrepe）

- **torchcrepe 程式碼與內附權重**：MIT License，Max Morrison
  （<https://github.com/maxrmorrison/torchcrepe>）。權重檔
  `torchcrepe/assets/full.pth` 隨套件一起安裝與打包，執行時不需連網。
- 原始 CREPE 論文與模型：Kim et al., 2018，同為 MIT。

用途是抽取原唱的音高曲線（取代先前的 librosa pyin，八度誤判少很多）。

## 音訊素材：鋼琴取樣

- **Upright Piano KW (small)**，FreePats 專案
  （<https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html#UprightKW>）
- **授權：Creative Commons CC0 1.0 公眾領域宣告**——可自由使用、修改、
  再散佈（含商用），**不強制標示**。這裡列出純粹是為了記錄來源。
- 錄音：Kawai 直立鋼琴，Gonzalo 與 Roberto 錄製於 2017 年 1 月。
- 在本專案的用途：譜面確認畫面的「🎹 鋼琴」試聽，把抽出來的參考譜彈出來
  跟原唱對照，用來判斷八度有沒有抽錯。
- 檔案在 [`assets/piano/`](assets/piano/)，取得與裁切的流程見
  [`packaging/fetch_piano_samples.py`](packaging/fetch_piano_samples.py)。

（同一頁的 YDP Grand Piano 與 Salamander Grand Piano 是 CC-BY 3.0、需要標示，
因此沒有採用。）

## 其餘 Python 相依套件（皆為寬鬆授權，無額外義務）

以下套件為 MIT／BSD／Apache-2.0／ISC／MPL-2.0／Unlicense（公有領域等同）
等寬鬆授權，使用、修改、再散佈都沒有強制回饋或公開原始碼的義務，通常只要
求保留著作權聲明。各自的完整授權檔已隨應用程式打包在
`lib/<套件名>-<版本>.dist-info/licenses/` 內。

| 套件 | 版本 | 授權 |
|---|---|---|
| anyio | 4.14.2 | MIT |
| brotli | 1.2.0 | MIT |
| certifi | 2026.7.22 | MPL-2.0 |
| cffi | 2.1.1 | MIT-0 |
| charset-normalizer | 3.5.1 | MIT |
| click | 8.4.2 | BSD-3-Clause |
| cryptography | 50.0.0 | Apache-2.0 OR BSD-3-Clause |
| decorator | 5.3.1 | BSD-2-Clause |
| demucs | 4.1.0 | MIT |
| einops | 0.8.2 | MIT |
| filelock | 3.32.3 | MIT |
| fsspec | 2026.7.0 | BSD-3-Clause |
| h11 | 0.16.0 | MIT |
| hf-xet | 1.6.0 | Apache-2.0 |
| httpcore | 1.0.9 | BSD-3-Clause |
| httpx | 0.28.1 | BSD-3-Clause |
| huggingface-hub | 1.28.0 | Apache-2.0 |
| idna | 3.19 | BSD-3-Clause |
| jinja2 | 3.1.6 | BSD |
| joblib | 1.5.3 | BSD-3-Clause |
| julius | 0.2.8 | MIT |
| lazy-loader | 0.5 | BSD-3-Clause |
| librosa | 1.0.0 | ISC |
| llvmlite | 0.49.0 | BSD-2-Clause + Apache-2.0（含 LLVM exception） |
| markupsafe | 3.0.3 | BSD-3-Clause |
| mpmath | 1.3.0 | BSD |
| msgpack | 1.2.1 | Apache-2.0 |
| narwhals | 2.24.0 | MIT |
| networkx | 3.6.1 | BSD-3-Clause |
| numba | 0.67.0 | BSD |
| numpy | 2.5.2 | BSD-3-Clause（部分子元件 0BSD／MIT／Zlib／CC0-1.0） |
| packaging | 26.3 | Apache-2.0 OR BSD-2-Clause |
| platformdirs | 4.11.3 | MIT |
| pooch | 1.9.0 | BSD-3-Clause |
| pycparser | 3.0 | BSD-3-Clause |
| pycryptodomex | 3.23.0 | BSD ／ 公有領域（雙授權） |
| pyyaml | 6.0.3 | MIT |
| requests | 2.34.2 | Apache-2.0 |
| safetensors | 0.8.0 | Apache-2.0 |
| scikit-learn | 1.9.0 | BSD-3-Clause |
| scipy | 1.18.0 | BSD-3-Clause |
| segno | 1.6.6 | BSD |
| setuptools | 84.0.0 | MIT |
| soundfile | 0.14.0 | BSD-3-Clause（另含 `libsndfile` 相關 LGPL 元件的第三方聲明，見套件自帶的 `license_notes.md`） |
| sphn | 0.2.1 | Apache-2.0 |
| sympy | 1.14.0 | BSD |
| threadpoolctl | 3.6.0 | BSD-3-Clause |
| torch | 2.13.0 | BSD 風格（含 Apache-2.0／BSL-1.0／MIT 等子元件） |
| torchaudio | 2.11.0 | BSD |
| tqdm | 4.70.0 | MPL-2.0 或 MIT（雙授權，可任選其一） |
| typing-extensions | 4.16.0 | PSF-2.0 |
| urllib3 | 2.7.0 | MIT |
| websockets | 17.0.1 | BSD-3-Clause |
| yt-dlp | 最新（滾動更新） | Unlicense（公有領域等同） |
| yt-dlp-ejs | 0.8.0 | Unlicense + MIT + ISC（混合） |

## 前端（js / css / html）

前端沒有使用任何 CDN、npm 套件或第三方函式庫 —— 全部是專為本專案撰寫的原生
JavaScript／CSS／HTML，應用程式圖示也是 `packaging/make_icon.py` 現場產生的
（非外部素材）。這部分沒有第三方授權需要聲明。
