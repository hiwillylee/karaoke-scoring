# 唱歌評分

日式卡拉OK精密採點。丟一首歌進來，自動分離人聲／伴奏、製作音高譜、抓同步歌詞，戴上耳機開唱即時評分。全部在本機運算。

- 貼 YouTube／YouTube Music／Bilibili 網址或上傳音檔加歌
- 即時音程條、技巧判定、0–100 分與雷達圖、升降調、原唱導唱
- 同步歌詞、KTV 逐字上色、日文振假名、歌曲封面、用歌手找歌
- 手機掃 QR 連線一起唱；也可建立臨時公開網址

## 下載

到 [Releases](https://github.com/hiwillylee/karaoke-scoring/releases) 下載 macOS（Apple Silicon）或 Windows 安裝檔。

## 開發

```bash
./setup.sh                      # 需要 uv 與 ffmpeg
.venv/bin/python server.py      # http://localhost:8000
```

測試：`test/test_analyze.py`、`test/test_library.py`、`test/test_lyrics.py`，前端開 `/test/pitch-test.html`。

打包見 [`打包說明.md`](打包說明.md)。

## 授權

GPL-3.0。第三方元件見 `THIRD_PARTY_LICENSES.md`。
