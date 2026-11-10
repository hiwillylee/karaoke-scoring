"""Python 與 JS 兩份「音框 → note → 技巧」實作的一致性測試。

參考譜是後端（analyze.py）抽的，但譜面頁的滑桿、編輯、演唱前的重算都在前端
（js/dsp.js、js/techniques.js）重跑同一套演算法。兩邊的註解都寫著「必須一致」，
這支測試讓這句話有東西把關：同一份合成音框餵給兩邊，切出來的 note 與技巧
必須完全相同。

只用到 numpy 與 node，不需要 librosa／torch（analyze.py 頂端的 librosa 匯入
用空殼代替，這幾個函式本來就用不到它）。

執行：python3 test/test_parity.py
"""
import json
import shutil
import subprocess
import sys
import tempfile
import types
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
if "librosa" not in sys.modules:
    try:
        import librosa  # noqa: F401
    except ImportError:
        sys.modules["librosa"] = types.ModuleType("librosa")
import analyze as A  # noqa: E402

PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"  {'✓' if ok else '✗'} {name}{('  → ' + detail) if detail else ''}")


HOP = 16.0


def synth(seed: int) -> dict:
    """一段有各種情況的合成音框：長音、顫音、滑上、下滑、八度誤判、
    低信心、小聲殘響、短碎音、緊鄰的快速音群。"""
    rng = np.random.default_rng(seed)
    n = int(40000 / HOP)
    midi = np.zeros(n)
    conf = np.zeros(n)
    rms = np.zeros(n)
    t = 0
    while t < n - 40:
        kind = rng.choice(["long", "vibrato", "scoop", "fall", "octave", "run", "ghost", "gap"])
        base = float(rng.integers(55, 76))
        length = int(rng.integers(20, 90))
        idx = np.arange(t, min(n, t + length))
        k = np.arange(len(idx))
        if kind == "gap":
            t += length
            continue
        curve = np.full(len(idx), base) + rng.normal(0, 0.05, len(idx))
        if kind == "vibrato":
            curve += 0.45 * np.sin(2 * np.pi * 5.5 * k * HOP / 1000)
        elif kind == "scoop":
            ramp = min(len(idx), 8)
            curve[:ramp] -= np.linspace(1.6, 0, ramp)
        elif kind == "fall":
            ramp = min(len(idx), 10)
            curve[-ramp:] -= np.linspace(0, 2.2, ramp)
        elif kind == "octave":
            j = int(len(idx) * 0.4)
            curve[j:j + 4] += 12
        elif kind == "run":
            curve += np.floor(k / 9) % 3
        c = np.clip(rng.normal(0.9, 0.06, len(idx)), 0, 1)
        r = np.clip(rng.normal(0.12, 0.02, len(idx)), 0.001, None)
        if kind == "ghost":
            r *= 0.02     # 幾乎聽不見的殘響：應被音量門檻濾掉
        lowc = rng.random(len(idx)) < 0.05
        c[lowc] = 0.3
        midi[idx], conf[idx], rms[idx] = curve, c, r
        t += length + int(rng.integers(0, 12))
    return {"hopMs": HOP, "midi": midi, "conf": conf, "rms": rms}


JS = r"""
import { readFileSync } from 'node:fs';
const root = process.argv[2];
const { prepareFrames, framesToNotes } = await import(`${root}/js/dsp.js`);
const { PARAMS, detectTechniques } = await import(`${root}/js/techniques.js`);
const params = JSON.parse(readFileSync(new URL(`${root}/config/params.json`), 'utf8'));
for (const key of Object.keys(PARAMS)) if (params[key]) Object.assign(PARAMS[key], params[key]);
const input = JSON.parse(readFileSync(0, 'utf8'));
const out = input.map(({ hopMs, midi, conf, rms }) => {
  const raw = midi.map((m, i) => ({ t: i * hopMs, midi: m, conf: conf[i], rms: rms[i] }));
  const frames = prepareFrames(raw, PARAMS.pitch);
  const notes = framesToNotes(frames, PARAMS.pitch);
  const techniques = detectTechniques(notes, frames, hopMs);
  return { notes, techniques };
});
process.stdout.write(JSON.stringify(out));
"""


def run_js(cases: list[dict]) -> list[dict]:
    node = shutil.which("node")
    if not node:
        raise SystemExit("找不到 node，無法比對前端實作")
    with tempfile.TemporaryDirectory() as tmp:
        script = Path(tmp) / "parity.mjs"
        script.write_text(JS, encoding="utf-8")
        payload = json.dumps([{k: (v.tolist() if isinstance(v, np.ndarray) else v)
                               for k, v in c.items()} for c in cases])
        res = subprocess.run([node, str(script), ROOT.resolve().as_uri()], input=payload,
                             capture_output=True, text=True, check=False)
        if res.returncode != 0:
            raise SystemExit(f"node 執行失敗：{res.stderr}")
        return json.loads(res.stdout)


def main():
    cases = [synth(seed) for seed in range(12)]
    js = run_js(cases)
    for seed, (frames, got) in enumerate(zip(cases, js)):
        prep = A.prepare_frames(frames)
        notes = A.frames_to_notes(prep)
        techs = A.detect_techniques(notes, prep)

        same_count = len(notes) == len(got["notes"])
        diffs = []
        for a, b in zip(notes, got["notes"]):
            if (abs(a["startMs"] - b["startMs"]) > 0.5 or abs(a["endMs"] - b["endMs"]) > 0.5
                    or a["midi"] != b["midi"]):
                diffs.append((a, b))
        check(f"seed {seed}: note 一致（{len(notes)} 個）", same_count and not diffs,
              "" if same_count and not diffs else
              f"py {len(notes)} / js {len(got['notes'])}；第一個差異 {diffs[:1]}")

        pt = sorted((e["type"], round(e["startMs"])) for e in techs)
        jt = sorted((e["type"], round(e["startMs"])) for e in got["techniques"])
        check(f"seed {seed}: 技巧一致（{len(pt)} 個）", pt == jt,
              "" if pt == jt else f"只在 py：{sorted(set(pt) - set(jt))[:3]}  只在 js：{sorted(set(jt) - set(pt))[:3]}")

    print(f"\n{len(PASS)} 通過，{len(FAIL)} 失敗")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
