#!/bin/bash
# 把整個系統打包成 macOS 應用程式與 .dmg。
#
# 產出的 .app 自己帶著 Python、所有套件、ffmpeg 與 Demucs 權重，
# 使用者不需要安裝任何東西。
#
# 用法：packaging/build_macos.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PROJ="$PWD"

APP_NAME="唱歌評分"
BUNDLE_ID="com.karaoke.scoring"
VERSION="${VERSION:-2.0.1}"
BUILD="$PROJ/build"
APP="$BUILD/$APP_NAME.app"
RES="$APP/Contents/Resources"
PYVER="python3.12"

echo "==> 檢查建置環境"
[ -d .venv ] || { echo "找不到 .venv，請先執行 ./setup.sh"; exit 1; }
command -v uv >/dev/null || { echo "找不到 uv"; exit 1; }
command -v ffmpeg >/dev/null || { echo "找不到 ffmpeg（brew install ffmpeg）"; exit 1; }
command -v ffprobe >/dev/null || { echo "找不到 ffprobe（brew install ffmpeg）"; exit 1; }

# 一定要從專案外面找。在專案目錄裡執行的話，uv 會優先回報本專案的 .venv，
# 而 .venv/bin/python3.12 只是指向外部直譯器的符號連結——照著複製進 .app 會
# 得到一個看似成功、實際上開不起來的空殼。--managed-python 則確保拿到的是
# 可整包搬移的獨立版，而不是系統或 Homebrew 的 Python。
PYBIN="$(cd / && uv python find 3.12 --managed-python)"
PYROOT="$(cd "$(dirname "$PYBIN")/.." && pwd)"
[ -x "$PYROOT/bin/$PYVER" ] || { echo "找不到獨立版 Python：$PYROOT"; exit 1; }
[ -f "$PYROOT/pyvenv.cfg" ] && { echo "抓到的是虛擬環境而非獨立版 Python：$PYROOT"; exit 1; }
[ -L "$PYROOT/bin/$PYVER" ] && { echo "$PYROOT/bin/$PYVER 是符號連結，不能拿來打包"; exit 1; }
echo "    Python：$PYROOT"

rm -rf "$BUILD"
mkdir -p "$APP/Contents/MacOS" "$RES"

echo "==> 複製 Python 執行環境"
ditto "$PYROOT" "$RES/python"

echo "==> 複製套件"
ditto ".venv/lib/$PYVER/site-packages" "$RES/lib"

echo "==> 精簡不需要的檔案"
find "$RES/lib" -name "__pycache__" -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$RES/lib" -name "*.pyc" -delete 2>/dev/null || true
# 靜態函式庫與 C++ 標頭只有編譯時才用得到
rm -rf "$RES/lib/torch/include" "$RES/lib/torch/test" 2>/dev/null || true
find "$RES/lib" -name "*.a" -delete 2>/dev/null || true
find "$RES/lib" -path "*/tests/*" -name "*.py" -delete 2>/dev/null || true

echo "==> 複製程式與網頁資源"
mkdir -p "$RES/app"
for item in server.py analyze.py launcher.py library.py fetcher.py tunnel.py gpu_pack.py lyrics.py covers.py index.html js css config assets; do
  ditto "$item" "$RES/app/$item"
done

echo "==> 附上第三方授權聲明"
# ffmpeg／mutagen／lameenc／soxr 是 GPL／LGPL 授權，散佈時要附上授權全文，
# 詳見 THIRD_PARTY_LICENSES.md。這裡把它跟對應的授權檔一起放進 app 目錄。
mkdir -p "$RES/app/licenses"
ditto packaging/licenses "$RES/app/licenses"
ditto THIRD_PARTY_LICENSES.md "$RES/app/licenses/THIRD_PARTY_LICENSES.md"

echo "==> 內附 ffmpeg 與 ffprobe（含相依函式庫）"
# ffprobe 一定要一起包。Demucs 讀非 wav 的音檔時會先呼叫 ffprobe 探測格式
# （demucs/audio.py），少了它就只會回報「FFmpeg is not installed」，
# 於是 YouTube 抓下來的 webm／m4a 全部分離失敗——但 wav 反而正常，
# 因為 wav 走的是另一條不需要 ffprobe 的路徑，很容易測不出來。
for tool in ffmpeg ffprobe; do
  "$PROJ/.venv/bin/python" packaging/bundle_dylibs.py "$(command -v "$tool")" "$RES/app/bin"
done

# CREPE（音高抽取）的權重是隨 torchcrepe 套件附帶的（assets/full.pth，89MB），
# 上面 ditto site-packages 時就一起進來了，不需要像 Demucs 這樣另外下載。
echo "==> 下載 Demucs 權重並內附"
HF_HOME="$RES/app/models" HF_HUB_DISABLE_TELEMETRY=1 \
  "$PROJ/.venv/bin/python" -c "from demucs.pretrained import get_model; get_model('htdemucs'); print('   權重就緒')"

echo "==> 產生圖示"
"$PROJ/.venv/bin/python" packaging/make_icon.py "$BUILD/icon.iconset"
iconutil -c icns "$BUILD/icon.iconset" -o "$RES/icon.icns"
rm -rf "$BUILD/icon.iconset"

echo "==> 寫入啟動器與 Info.plist"
cat > "$APP/Contents/MacOS/launch" <<'LAUNCH'
#!/bin/bash
# .app 的進入點：指好內附資源的位置後交給 launcher.py
#
# -B 一定要用命令列旗標，不能只靠 PYTHONDONTWRITEBYTECODE：-E 會忽略所有
# PYTHON* 環境變數，那個變數等於沒設。一旦 Python 把 .pyc 寫進 .app 內部，
# 就等於改動了已簽章的 bundle，macOS 會在啟動後幾秒內以 SIGTRAP 殺掉行程
# ——畫面看起來有開，但很快就整個沒反應。
# 同理 PYTHONPATH 也被 -E 吃掉，改由 launcher.py 自己把 lib 掛進 sys.path。
#
# 伺服器丟到背景之後這個腳本就結束。這個程式沒有原生視窗，若留在前景，
# Dock 會一直等它「完成啟動」而讓圖示無止盡地跳。主程式結束後跳動即停，
# 而伺服器繼續在背景服務——要收掉請用網頁右上角的「關閉程式」。
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
export KARAOKE_APP_ROOT="$RES/app"
nohup "$RES/python/bin/python3.12" -s -E -B "$RES/app/launcher.py" >/dev/null 2>&1 &
exit 0
LAUNCH
chmod +x "$APP/Contents/MacOS/launch"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <!-- 這裡刻意不加 LSUIElement：加了雖然不會在 Dock 跳，但 Launchpad 和
       「應用程式」裡也會一起消失，使用者就找不到怎麼開了。改成讓
       Contents/MacOS/launch 把伺服器丟到背景後立刻結束，Dock 同樣不會跳。 -->
  <key>NSLocalNetworkUsageDescription</key>
  <string>讓內網的手機、平板連進來一起使用唱歌評分。</string>
</dict>
</plist>
PLIST

echo "==> 簽章前清掉位元碼快取"
# 簽章涵蓋 bundle 內的每一個檔案，之後任何新增都會讓驗證失敗。這裡先清乾淨，
# 執行期則靠啟動器的 -B 確保不會再產生。
find "$APP" -name "__pycache__" -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$APP" -name "*.pyc" -delete 2>/dev/null || true

echo "==> 移除 bundle 層的封印簽章"
# 這裡刻意不對整個 .app 簽章。
#
# 臨時簽章（codesign --sign -）會把 bundle 內每一個檔案封印起來，之後只要多出
# 或改動任何一個檔案，macOS 就會在執行中以 SIGTRAP 直接中止程式。但這個 App
# 執行時本來就會在自己的目錄裡產生檔案——Python 的 .pyc、numba 的 JIT 快取
# （.nbi/.nbc）等等，套件內部行為我們控制不完——於是變成「第一次開得起來，
# 之後就神秘當掉」。
#
# 臨時簽章本來也沒有通過公證，使用者第一次還是得用右鍵→打開，所以拿掉它
# 不會讓安裝體驗變差，卻能一次消掉整類當機。真正需要執行的二進位檔
# （內附的 Python、ffmpeg 與各套件的 .dylib）本身都已各自帶有簽章。
codesign --remove-signature "$APP" 2>/dev/null || true
if codesign -dv "$APP" 2>/dev/null; then
  echo "    ！bundle 仍帶有簽章，執行期寫入可能導致程式被中止"
else
  echo "    已確認未封印（執行期寫入不會讓 App 被系統中止）"
fi

echo "==> 製作 .dmg"
DMG_SRC="$BUILD/dmg"
mkdir -p "$DMG_SRC"
ditto "$APP" "$DMG_SRC/$APP_NAME.app"
ln -s /Applications "$DMG_SRC/Applications"
cat > "$DMG_SRC/請先看我.txt" <<'NOTE'
唱歌評分 安裝說明
==================

1. 把左邊的「唱歌評分」拖到右邊的 Applications 資料夾。

2. 第一次開啟時，因為這個程式沒有經過 Apple 付費簽章，
   直接點兩下會出現「無法打開，因為無法驗證開發者」。
   請改成：在「應用程式」裡對它按【右鍵】→ 選【打開】→ 再按一次【打開】。
   之後就可以正常點兩下開啟了。

3. 開啟後會自動跳出瀏覽器分頁。第一次分析歌曲需要一點時間。

4. 想讓同一個 Wi-Fi 下的手機、平板一起用：
   開啟後到頁面右上角的【設定】，裡面會顯示內網網址（https://…）。
   手機用那個網址連，第一次會有憑證警告，選「繼續前往」即可。
   一定要用 https 那個網址，瀏覽器只在 https 才開放麥克風。
NOTE
ditto THIRD_PARTY_LICENSES.md "$DMG_SRC/第三方軟體授權聲明.md"

DMG="$BUILD/$APP_NAME-$VERSION.dmg"
rm -f "$DMG"
hdiutil create -volname "$APP_NAME" -srcfolder "$DMG_SRC" -ov -format UDZO "$DMG" >/dev/null
# dmg 已經做好了，這裡只是收暫存目錄。Finder／Spotlight 有時還握著裡面的檔案，
# 讓它失敗而中止整個建置（set -e）沒有意義，殘留下次建置也會清掉。
rm -rf "$DMG_SRC" 2>/dev/null || true

echo
echo "==> 完成"
echo "    應用程式：$APP"
echo "    安裝檔：  $DMG"
du -sh "$APP" "$DMG"
