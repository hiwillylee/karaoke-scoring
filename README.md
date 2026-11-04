# カラオケ 精密採點

日式卡拉OK（DAM／JOYSOUND 風格）的唱歌評分系統。丟一首歌進來，自動產出
**純伴奏**、**原唱音高譜**與**原唱技巧標記**，然後戴上耳機開唱，即時看音程條、
結算時給 0–100 分與五角雷達圖。

所有處理都在本機完成，音檔不會離開這台電腦。抓歌詞時只會把歌名、歌手（YouTube 來源另加影片 ID）送到
YT Music、LRCLIB、酷狗、網易雲查詢。

## 功能

- **貼網址加歌**：搜尋列貼上 YouTube／YouTube Music／Bilibili 網址就自動取得並製譜（用 yt-dlp）；
  同一首歌貼不同形式的網址（youtu.be、music.youtube.com）會認出「已經下載過了」，不會重複下載
- **曲庫存在電腦上**：音檔與譜面留在跑伺服器的那台電腦，手機開曲庫只拿清單，
  按下「演唱」或「譜面」才把音軌抓到手機，抓過的會快取起來（設定頁可清除）
- **自動製譜**：Demucs 分離人聲／伴奏 → 對乾淨人聲軌跑 pYIN 抽主旋律 → 切成音程條
- **原唱技巧標記**：標出原唱在哪裡用了ビブラート／しゃくり／フォール，唱到同樣位置會加分
- **精密採點**：音程 60%、節奏 15%、安定性 15%、技巧 10%，另計完唱度
- **升降調**：−6 ～ +6 半音，變調不變速，演唱中也能即時切換，評分基準同步移動
- **手機掃碼連線**：這台電腦的頁面上有「📱 手機連線」，掃 QR 就能讓手機連上曲庫
- **臨時公開網址**：透過 Cloudflare 取得一組隨機網址（`*.trycloudflare.com`），
  不在同一個 Wi-Fi 也能連，而且憑證有效不會有警告；預設不開，可設定成啟動時自動建立
- **第一次使用導覽**：6 步帶過各功能在哪，可略過，設定頁可重看
- **原唱導唱**：演唱畫面可隨時開關原唱。伴奏與原唱放在同一個播放引擎裡共用播放位置，
  切換不會跑掉拍；用喇叭時原唱會被麥克風收到而干擾評分，建議戴耳機
- **同步歌詞（KTV 字幕）**：加歌時自動在背景抓歌詞（移植自「歌詞讀音」App 個人版）——
  YT Music 同步歌詞 → LRCLIB → YouTube 影片上傳者提供的原文 CC 字幕；抓不到或抓錯時，
  在「譜面」頁可改歌名重搜、上傳 .lrc、貼 LRCLIB／.lrc 網址，並用「提早／延後」對齊時間
  （試聽時同步顯示，方便對）
- **KTV 逐字上色**：逐字時間優先用 Enhanced LRC，其次抓酷狗 KRC／網易雲 YRC 並逐字比對到歌詞上；
  都沒有時依**參考譜的音符**估算每個字什麼時候唱（長音、拖拍、換氣都已經在譜裡）
- **日文振假名＋羅馬拼音**：日文歌在漢字上方標平假名讀音（送り仮名不重複標），可另開羅馬拼音；
  中文歌不會被誤標。設定頁可開關
- **拍手延遲校準**：量測「聽到聲音 → 麥克風收到」的總延遲，依「麥克風 × 輸出裝置」分別記憶

## 要給別人用？

`打包說明.md` 說明如何產出使用者「點兩下安裝、點兩下執行」的檔案：
macOS 的 .dmg 可直接建，Windows 的 .exe 必須在 Windows 上建。
打包後的程式自帶 Python、PyTorch、Demucs 權重與 ffmpeg，使用者不需要
安裝任何東西。

```bash
packaging/build_macos.sh          # → build/唱歌評分-1.0.0.dmg
```

## 開發環境安裝

```bash
./setup.sh
```

需要 `uv` 與 `ffmpeg`（`brew install uv ffmpeg`）。腳本會用 CPython 3.12 建 `.venv`
並安裝 torch／demucs／librosa。第一次約 2.5GB，之後不必再跑。

> 版本說明：本機系統 python3 為 3.14（torch 尚無對應 wheel），Homebrew 的 python3.13
> 為損壞狀態，因此固定使用 uv 管理的 3.12。

## 啟動

```bash
.venv/bin/python server.py
```

啟動後會印出可用的網址：

- **這台電腦**：<http://localhost:8000>
- **內網其他裝置**：`https://<本機IP>:8443`

## 讓別人一起唱

在**這台電腦**的頁面上點右上角「📱 手機連線」，裡面有兩個 QR：

| 方式 | 適用 | 說明 |
|---|---|---|
| 同一個 Wi-Fi | 家裡、辦公室 | 掃了直接連內網位址。第一次會有憑證警告，選「繼續前往」 |
| 臨時公開網址 | 對方不在同一個網路 | 按「建立公開網址」，透過 Cloudflare 取得隨機網址；憑證有效、不會有警告 |

這兩個 QR 與公開網址的開關**只在這台電腦上看得到**——手機是掃碼進來的，不需要再看一次，
而把機器公開到網際網路這種事也不該讓連進來的人代為決定。

需要 `cloudflared` 才能建立公開網址（`brew install cloudflared` / `winget install Cloudflare.cloudflared`）。

> **公開網址沒有任何密碼**，拿到網址的人就能瀏覽曲庫、加歌、刪歌。只分享給信任的人，
> 用完請按「關閉公開網址」。關掉程式時也會自動收掉。

## 內網使用

伺服器綁在所有網路介面，運算（Demucs 分離、音高抽取）全部在跑 `server.py`
的這台電腦上，其他裝置只負責播放、收音與畫面。

**內網一定要走 https 那個網址。** 瀏覽器只在 secure context（https 或 localhost）
才開放 `getUserMedia`，用 `http://<本機IP>:8000` 連進來會沒有麥克風，只能看不能唱。
直接開 `index.html`（`file://`）同樣不行。

https 用的是啟動時自動產生的自簽憑證（`certs/`，涵蓋 localhost、主機名稱與目前的
內網 IP；IP 變了會自動重簽）。第一次連會出現憑證警告：

- Chrome／Edge：進階 → 繼續前往
- Safari／iOS：顯示詳細資訊 → 瀏覽此網站
- 想完全免警告，可用 `mkcert` 產生受信任的憑證覆蓋 `certs/cert.pem` 與 `certs/key.pem`

其他注意事項：

- macOS 第一次會跳出「是否允許接受連入連線」，要按允許，否則內網連不進來。
- 多人同時上傳歌曲時，分析會排隊依序處理（Demucs 很吃資源），畫面會顯示前面還有幾首。
- 曲庫、成績與延遲設定檔存在**各自的瀏覽器**裡，不會跨裝置同步；每台裝置要各自做一次拍手校準。
- 這是給信任的內網用的工具，沒有帳號或密碼機制，別開到公開網路上。

## 使用順序

1. **延遲校準**（第一次用、或換耳機時）：外放播節拍、跟著用力拍手，8 拍中至少 6 拍有效才會存檔。
2. **加歌**：搜尋列貼上 YouTube／YouTube Music／Bilibili 的網址按 Enter，或按右邊的 ＋ 上傳本機音檔
   （也可以直接把檔案拖進搜尋列）。等分離與分析完成（第一次會下載 htdemucs 模型）。
   打字則是在已下載的歌裡面搜尋。
3. **譜面確認**：音程條是固定比例的長條，可左右拖曳（或用滾輪／觸控板）細看，下方細長條是全曲總覽，
   點一下就跳到那一段；另有播放與 ±5 秒按鈕。走勢對不上時展開「進階」：整體高／低八度拉「八度位移」，
   旋律斷斷續續就調低「偵測靈敏度」。
4. **演唱**：建議戴耳機（用喇叭的話麥克風會收到伴奏聲）。可隨時按 ♯／♭ 換 key。
5. **結算**：分數、雷達圖、整曲音程對照、技巧次數；成績存在瀏覽器裡，曲庫會顯示個人最佳。

## 驗證

```bash
.venv/bin/python test/test_analyze.py
```

以合成訊號驗證後端的音高抽取、note 切段與技巧偵測（12 項）。

```bash
.venv/bin/python test/test_library.py
```

驗證曲庫存取、歌名搜尋、網址判別、跨網址的重複偵測與路徑安全（32 項，不需網路）。

```bash
.venv/bin/python test/test_lyrics.py
```

驗證 LRC／Enhanced LRC 解析、歌名歌手判斷、振假名與羅馬拼音、逐字時間對齊、
網址防護（25 項，不需網路）。單首歌實際抓一次（會連網）：

```bash
.venv/bin/python lyrics.py library/<歌曲ID>
```

整條後端流程（含 Demucs 分離）可用附的測試音檔跑一次：

```bash
.venv/bin/python analyze.py test/fixtures/test_song.mp3 work/smoke
```

覺得某首歌抽到的音數不合理時，用診斷工具看是哪一關把音框濾掉：

```bash
.venv/bin/python test/diagnose.py <歌曲檔案>
```

它會列出 pyin 判定有音的比例、信心值分佈，以及不同切段參數下的音數與「音／秒」。
一般流行歌大約 1.5～3.5 音／秒，低於 1 就代表過濾過頭了。

前端測試開 <http://localhost:8000/test/pitch-test.html>，驗證 YIN 準確度、掃頻追蹤、
八度修正、滑音合併、技巧判準、WSOLA 升降調（含實際跑一次 AudioWorklet）、
拍手延遲演算法與評分引擎（39 項），頁面直接顯示 PASS／FAIL。

## 檔案

| 檔案 | 作用 |
|---|---|
| `server.py` | 靜態網頁 + 分析 API（stdlib，只綁 127.0.0.1） |
| `analyze.py` | Demucs 分離、pYIN 音高抽取、原唱技巧標記 |
| `config/params.json` | 前後端共用的判準常數，改這裡兩邊同時生效 |
| `js/dsp.js` | YIN、中值濾波、八度修正、note 切段 |
| `js/techniques.js` | ビブラート／しゃくり／フォール 判準 |
| `js/mic.js` `js/mic-worklet.js` | 麥克風擷取與即時音高 |
| `js/pitchshift.js` `js/pitchshift-worklet.js` | WSOLA 升降調播放 |
| `js/calibrate.js` | 拍手延遲量測 |
| `js/score.js` | 評分引擎 |
| `js/render.js` `js/result.js` | 演唱畫面與結算圖表 |
| `js/localanalyze.js` `js/analyze-worker.js` | 後端未啟動時的降級分析 |
| `library.py` | 伺服器端曲庫：音檔、譜面、每首歌的調整參數 |
| `lyrics.py` | 同步歌詞：YT Music／LRCLIB／YouTube 字幕、酷狗／網易雲逐字時間、pykakasi 振假名 |
| `js/lyrics.js` | KTV 兩行歌詞顯示、逐字上色、依譜面估算逐字時間 |
| `fetcher.py` | 用 yt-dlp 從 YouTube／YouTube Music／Bilibili 取得音訊 |
| `tunnel.py` | Cloudflare Quick Tunnel：臨時公開網址的建立與收拾 |
| `js/api.js` | 前端與伺服器曲庫的溝通、音軌依需求下載與本機快取 |
| `js/tour.js` | 第一次使用的分步導覽 |
| `js/storage.js` | IndexedDB：音軌快取、成績、延遲設定檔 |
| `launcher.py` | 打包後的進入點：指好內附資源、啟動服務、開瀏覽器 |
| `packaging/` | macOS 與 Windows 的打包腳本、圖示產生器、dylib 收集 |

## 已知限制

- 分離品質取決於 Demucs：合唱、重疊人聲或人聲很小聲的曲子，抽出的譜會比較破碎，可用譜面確認畫面的靈敏度滑桿補救。
- 從網址取得音訊是呼叫 yt-dlp。這些平台的取流方式經常變動，抓不下來時多半是 yt-dlp 需要更新：
  `.venv/bin/uv pip install -U --pre "yt-dlp[default]"`。另外，從這些平台下載內容是否合乎各站服務條款
  與當地法規，請自行斟酌。
- 三個平台都已實測可用（yt-dlp nightly 2026.08.19）：YouTube、YouTube Music、Bilibili
  都跑過完整的下載→分離→製譜→演唱流程。Bilibili 的搜尋 API 從部分網路會回 412，
  但影片頁的取流不受影響。
- 用喇叭演唱時麥克風會收到伴奏，音高偵測會受干擾，建議戴耳機。
- 升降調用的是 WSOLA，超過 ±5 半音時伴奏會開始出現金屬感。
- 顯示卡加速：NVIDIA（CUDA）與 Apple Silicon（Metal）可用；AMD 在 Windows 上
  沒有官方 PyTorch 支援，Intel 內顯不一定比多核 CPU 快。程式會自動偵測、
  實際試跑，跑不動就退回 CPU。詳見 `打包說明.md`。

## 授權

本專案以 [GNU General Public License v3.0](LICENSE) 釋出。
內附或打包時使用的第三方元件（Demucs、ffmpeg、鋼琴取樣等）各有其授權，見 `THIRD_PARTY_LICENSES.md` 與 `packaging/licenses/`。
