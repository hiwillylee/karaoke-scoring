"""伺服器的安全與協定驗證（不需要網路、torch 或 yt-dlp）。

在暫存資料夾裡起一份真的伺服器，用 http.client 直接打：
  - 只開放網頁檔，程式原始碼、憑證、曲庫、設定都拿不到（含大小寫、雙斜線、../ 的繞法）
  - 別的網站送來的 POST（CSRF）會被擋
  - Host 不是 IP／localhost／本機名稱的請求會被擋（DNS rebinding）
  - 公開網址（帶代理標頭）要存取碼、不能刪歌、看不到內網位址
  - HTTP/1.1 保持連線、gzip、Range、ETag
  - 成績與延遲設定檔存在伺服器上；meta.json 同時多執行緒寫入不會互相蓋掉

執行：python3 test/test_server.py
"""
import gzip
import http.client
import json
import os
import shutil
import socket
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"  {'✓' if ok else '✗'} {name}{('  → ' + detail) if detail else ''}")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


SONG = "abcdef123456"


def setup_data(tmp: Path) -> None:
    d = tmp / "library" / SONG
    d.mkdir(parents=True)
    (d / "instrumental.m4a").write_bytes(os.urandom(5000))
    (d / "chart.json").write_text(json.dumps({"hopMs": 16, "durationMs": 1000, "notes": [],
                                              "frames": {"midi": [0] * 2000}}))
    (d / "meta.json").write_text(json.dumps({"id": SONG, "name": "測試", "addedAt": 1,
                                             "durationMs": 1000, "notes": 0}))
    (tmp / "certs").mkdir()
    (tmp / "certs" / "key.pem").write_text("SECRET")


def main():
    tmp = Path(tempfile.mkdtemp())
    setup_data(tmp)
    port = free_port()
    os.environ.update(KARAOKE_DATA_DIR=str(tmp), KARAOKE_HTTP_PORT=str(port),
                      KARAOKE_HTTPS_PORT=str(free_port()))
    sys.path.insert(0, str(ROOT))
    import server  # noqa: E402  依上面的環境變數決定資料夾與連接埠

    srv = server.serve(port, None)
    server.INFO.update(httpPort=port, lanUrls=["https://192.168.1.2:8443"])

    def req(method, path, body=None, headers=None, conn=None):
        c = conn or http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        h = {"Host": f"localhost:{port}", **(headers or {})}
        data = json.dumps(body).encode() if isinstance(body, (dict, list)) else body
        if data is not None and "Content-Type" not in h:
            h["Content-Type"] = "application/json"
        c.request(method, path, body=data, headers=h)
        r = c.getresponse()
        return r, r.read()

    try:
        print("\n[1] 靜態檔白名單")
        r, _ = req("GET", "/")
        check("首頁 200", r.status == 200)
        r, _ = req("GET", "/js/main.js")
        check("js 200", r.status == 200)
        for path in ("/server.py", "/certs/key.pem", "/Certs/key.pem", "//certs/key.pem",
                     "/js/../server.py", "/js/%2e%2e/server.py", f"/library/{SONG}/meta.json",
                     "/settings.json", "/latency.json", "/js/", "/.git/config", "/test/test_server.py"):
            r, body = req("GET", path)
            check(f"{path} 拿不到", r.status == 404 and b"SECRET" not in body, str(r.status))

        print("\n[2] 跨站請求與主機名稱")
        r, _ = req("POST", "/api/song/delete", {"id": SONG}, {"Origin": "http://evil.example"})
        check("其他網站的 POST 被擋", r.status == 403)
        r, _ = req("POST", "/api/song/delete", {"id": SONG}, {"Sec-Fetch-Site": "cross-site"})
        check("Sec-Fetch-Site: cross-site 被擋", r.status == 403)
        r, _ = req("GET", "/api/songs", headers={"Host": "evil.example"})
        check("陌生 Host 被擋（DNS rebinding）", r.status == 403)
        r, _ = req("GET", "/api/songs", headers={"Host": f"192.168.1.2:{port}"})
        check("IP 當 Host 可以", r.status == 200)
        r, _ = req("POST", "/api/quit", {}, {"Host": f"192.168.1.2:{port}"})
        check("非本機不能關程式", r.status == 403)

        print("\n[3] 公開網址")
        proxy = {"CF-Ray": "x", "Host": "abc.trycloudflare.com"}
        r, _ = req("GET", "/", headers=proxy)
        check("沒有存取碼看到說明頁", r.status == 403)
        token = server.TUNNEL_TOKEN["value"]
        r, _ = req("GET", f"/?k={token}", headers=proxy)
        cookie = r.getheader("Set-Cookie") or ""
        check("帶存取碼會轉址並設 cookie", r.status == 302 and token in cookie)
        authed = {**proxy, "Cookie": f"{server.TOKEN_COOKIE}={token}"}
        r, body = req("GET", "/api/info", headers=authed)
        info = json.loads(body)
        check("有 cookie 可以用", r.status == 200)
        check("看不到內網位址", "lanUrls" not in info and info.get("public") is True)
        r, _ = req("POST", "/api/song/delete", {"id": SONG}, authed)
        check("公開網址不能刪歌", r.status == 403)
        r, _ = req("GET", "/api/info", headers={**proxy, "Cookie": f"{server.TOKEN_COOKIE}=wrong"})
        check("錯的存取碼被擋", r.status == 403)

        print("\n[4] 協定")
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        req("GET", "/js/api.js", conn=conn)
        sock = conn.sock
        req("GET", "/js/util.js", conn=conn)
        check("HTTP/1.1 保持連線", conn.sock is sock and sock is not None)
        r, body = req("GET", "/js/main.js", headers={"Accept-Encoding": "gzip"})
        check("gzip 壓縮", r.getheader("Content-Encoding") == "gzip" and gzip.decompress(body))
        etag = r.getheader("ETag")
        r, _ = req("GET", "/js/main.js", headers={"If-None-Match": etag})
        check("ETag 沒變回 304", r.status == 304)
        r, body = req("GET", f"/api/song?id={SONG}&kind=instrumental", headers={"Range": "bytes=0-999"})
        check("Range 回 206 與 1000 位元組", r.status == 206 and len(body) == 1000)
        r, body = req("GET", f"/api/song?id={SONG}&kind=instrumental", headers={"Range": "bytes=-100"})
        check("Range 尾段", r.status == 206 and len(body) == 100)
        r, _ = req("GET", f"/api/song?id={SONG}&kind=chart", headers={"Accept-Encoding": "gzip"})
        check("譜面有 ETag 與壓縮", r.getheader("ETag") and r.getheader("Content-Encoding") == "gzip")
        # 提早回錯誤而沒讀內容的 POST 不能把剩下的內容留給下一個請求
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        r, _ = req("POST", "/api/song/delete", b"x" * 5000,
                   {"Origin": "http://evil.example", "Content-Type": "application/octet-stream"}, conn=conn)
        try:
            r2, _ = req("GET", "/api/jobs", conn=conn)
            ok = r2.status == 200
        except (http.client.HTTPException, OSError):
            ok = True   # 伺服器關掉連線也是正確的處理
        check("沒讀完的請求內容不會污染下一個請求", ok)

        print("\n[5] 成績、設定檔與併發寫入")
        r, body = req("POST", "/api/scores", {"id": SONG, "record": {"total": 88.5, "breakdown": {"pitch": 90}}})
        meta = json.loads(body)
        check("成績存到伺服器", r.status == 200 and meta.get("best") == 88.5 and meta.get("plays") == 1)
        r, body = req("POST", "/api/scores", {"id": SONG, "record": {"total": 999}})
        check("不合理的分數被拒絕", json.loads(body).get("plays") == 1)
        r, body = req("GET", f"/api/scores?id={SONG}")
        check("讀得到成績", len(json.loads(body)["scores"]) == 1)
        r, body = req("POST", "/api/latency", {"profile": {"micLabel": "m", "outputLabel": "o", "offsetMs": 120,
                                                           "inputMs": 100, "outputLatencyMs": 20}})
        check("延遲設定檔存到伺服器", r.status == 200 and json.loads(body)["inputMs"] == 100)
        r, body = req("POST", "/api/song/settings", {"id": SONG, "keyShift": 3, "favorite": True,
                                                     "octaveOffset": "abc"})
        meta = json.loads(body)
        check("升降調與最愛跟著歌存", meta.get("keyShift") == 3 and meta.get("favorite") is True)
        check("型別錯的值不會寫入", "octaveOffset" not in meta)

        lib = server.LIBRARY
        errors = []

        def hammer(k):
            try:
                for i in range(20):
                    if k % 2:
                        lib.update_meta(SONG, lambda m, i=i, k=k: m.__setitem__(f"f{k}", i))
                    else:
                        lib.save_lyrics(SONG, {"lines": [{"text": "x"}], "source": f"s{k}-{i}"})
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)
        threads = [threading.Thread(target=hammer, args=(k,)) for k in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        meta = lib.meta(SONG)
        check("同時寫 meta.json 沒有遺失欄位",
              not errors and all(meta.get(f"f{k}") == 19 for k in (1, 3, 5)) and meta.get("lyrics"),
              str(errors[:1]))

        print("\n[6] 工作清單")
        r, body = req("GET", "/api/jobs")
        check("工作清單 API", r.status == 200 and "jobs" in json.loads(body))
        server.new_job("x", "url", url="https://youtu.be/x")
        jid = next(iter(server.JOBS))
        r, _ = req("POST", "/api/jobs/cancel", {"id": jid})
        check("排隊中的工作可以取消", r.status == 200 and server.JOBS[jid]["state"] == "cancelled")
        check("看得懂的錯誤訊息",
              server.friendly_error(Exception("ERROR: [youtube] abc: Private video")) == "這是私人影片，無法下載")

        print("\n[7] 前端打包檔")
        version = server.current_bundle()
        r, body = req("GET", "/")
        if version:
            check("打包檔與原始碼一致時首頁改用打包檔",
                  b"js/app.bundle.js?v=" in body and b'src="js/main.js"' not in body)
            r, _ = req("GET", "/js/app.bundle.js")
            check("打包檔拿得到", r.status == 200)
        else:
            print("  （沒有打包檔，略過「採用打包檔」的檢查；先跑 npm run build 可以一併測）")
            check("沒有打包檔時首頁逐支載入模組", b'src="js/main.js"' in body)
        # 原始碼改了但沒重新打包：雜湊對不上，必須退回原始模組
        stale = tmp / "stale.meta.json"
        stale.write_text(json.dumps({"sourceHash": "0" * 64}))
        real_meta, real_js = server.BUNDLE_META, server.BUNDLE_JS
        server.BUNDLE_META = stale
        if not real_js.is_file():
            server.BUNDLE_JS = stale
        server._BUNDLE.update(stamp=None, hash=None)
        try:
            check("打包檔過期時不採用", server.current_bundle() is None)
            r, body = req("GET", "/")
            check("過期時首頁退回原始模組", b'src="js/main.js"' in body and b"app.bundle.js" not in
                  body.split(b"<!-- modules:start -->")[0])
        finally:
            server.BUNDLE_META, server.BUNDLE_JS = real_meta, real_js
            server._BUNDLE.update(stamp=None, hash=None)
    finally:
        srv.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"\n{len(PASS)} 通過，{len(FAIL)} 失敗")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
