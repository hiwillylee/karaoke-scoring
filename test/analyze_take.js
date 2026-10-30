// analyze_take.js — 分析一次真實演唱的原始收音資料。
//
// 用途：評分的門檻該訂在哪，取決於麥克風實際收到什麼——伴奏漏音多大聲、
// 信心值掉到多少、八度誤判多頻繁、延遲補償準不準。這些都得從真實的一次
// 演唱量，不能靠合成訊號猜；用自己編的雜訊模型調出來的參數，只是在驗證
// 自己的假設。
//
// 取得資料：開 app 時網址加上 ?debug=1，唱完在結算畫面按「⬇ 匯出本次演唱
// 原始資料」，會下載 take-*.json。
//
//   deno run --allow-read test/analyze_take.js <take.json> [library 目錄]

import { rebuildChart } from '../js/chart.js';
import { levelFloor } from '../js/dsp.js';
import { PARAMS } from '../js/techniques.js';

const [takePath, libDir = 'library'] = Deno.args;
if (!takePath) {
  console.error('用法: deno run --allow-read test/analyze_take.js <take.json> [library 目錄]');
  Deno.exit(1);
}

const take = JSON.parse(await Deno.readTextFile(takePath));
const raw = JSON.parse(await Deno.readTextFile(`${libDir}/${take.songId}/chart.json`));
const chart = rebuildChart(raw, { edits: take.chartEdits });
const hop = chart.hopMs;

// frames: [t, rawMidi, midi, conf, rms]
const F = take.frames.map(([t, rm, m, c, r]) => ({ t, rawMidi: rm, midi: m, conf: c, rms: r }));
const q = (a, p) => a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length * p)] : NaN;
const pct = (n, d) => `${(n / d * 100).toFixed(1)}%`;

console.log(`\n=== ${take.songName} — ${take.total} 分 ===`);
console.log(`分項  音程${take.breakdown.pitch} 節奏${take.breakdown.rhythm} `
  + `安定${take.breakdown.stability} 技巧${take.breakdown.technique} 完唱${take.breakdown.completion}`);
console.log(`收音  ${take.micLabel || '?'} → ${take.outputLabel || '?'}`);
console.log(`延遲補償 ${take.latencyMs}ms（${take.latencyCalibrated ? '已拍手校準' : '未校準，估計值'}）`
  + `  導唱原唱:${take.guideVocalOn ? '開' : '關'}  八度對齊 ${take.octaveOffset}`);

// ── 1. 有多少框被門檻擋掉，擋掉的是什麼 ──────────────────────
const detected = F.filter((f) => f.rawMidi > 0);
const gatedOut = detected.filter((f) => f.conf < PARAMS.pitch.minConfidence);
console.log(`\n[1] 音框門檻（收到 ${F.length} 框，偵測到音高 ${detected.length} 框）`);
console.log(`  信心值分佈  p10 ${q(detected.map(f=>f.conf),.1).toFixed(2)}  `
  + `中位 ${q(detected.map(f=>f.conf),.5).toFixed(2)}  p90 ${q(detected.map(f=>f.conf),.9).toFixed(2)}`);
console.log(`  被信心門檻(${PARAMS.pitch.minConfidence})擋掉: ${gatedOut.length} 框 (${pct(gatedOut.length, detected.length)})`);
const floor = levelFloor(F.filter(f => f.midi > 0), PARAMS.pitch.minLevelDb);
const belowFloor = detected.filter((f) => f.rms < floor);
console.log(`  音量門檻落在 rms ${floor.toExponential(2)}，低於它: ${belowFloor.length} 框 (${pct(belowFloor.length, detected.length)})`);
console.log(`  rms 分佈  p10 ${q(detected.map(f=>f.rms),.1).toExponential(2)}  `
  + `中位 ${q(detected.map(f=>f.rms),.5).toExponential(2)}  p90 ${q(detected.map(f=>f.rms),.9).toExponential(2)}`);

// ── 2. 參考譜沒有 note 的地方，使用者唱了什麼 ──
// 注意：這裡多半不是雜訊。參考譜的切段會漏掉很多自己抽到的音高（實測某首
// 有 38% 的參考音框沒被切成 note），使用者照著唱就會落在這些空隙裡。
const refVoiced = new Set();
for (const n of chart.notes) {
  for (let i = Math.round(n.startMs / hop); i <= Math.round(n.endMs / hop); i++) refVoiced.add(i);
}
const refPitchBins = new Set();
raw.frames.midi.forEach((m, i) => { if (m > 0) refPitchBins.add(i); });
const inGap = detected.filter((f) => !refVoiced.has(Math.round(f.t / hop)));
const gapWithRef = inGap.filter((f) => refPitchBins.has(Math.round(f.t / hop)));
console.log(`\n[2] 參考譜沒有 note 的位置`);
console.log(`  使用者在那裡唱了: ${inGap.length} 框 (${pct(inGap.length, detected.length)} 的偵測框)`);
if (inGap.length) {
  console.log(`  其中 ${pct(gapWithRef.length, inGap.length)} 參考「音框」其實抽到了音高`
    + ` → 原唱有唱，只是沒被切成 note，不是雜訊`);
  console.log(`  它們的 rms 中位 ${q(inGap.map(f=>f.rms),.5).toExponential(2)}`
    + `（人聲段 ${q(detected.filter(f=>refVoiced.has(Math.round(f.t/hop))).map(f=>f.rms),.5).toExponential(2)}）`);
}
let refFramed = 0, refNoted = 0;
for (const i of refPitchBins) { refFramed++; if (refVoiced.has(i)) refNoted++; }
console.log(`  參考譜自己: 抽到音高 ${refFramed} 框，只有 ${pct(refNoted, refFramed)} 被切成 note`);
console.log(`  → 切段落差越大，節奏配對越難對齊（節奏分數偏低多半來自這裡）`);

// ── 3. 延遲補償準不準：試各種偏移，看音高吻合度何時最高 ──────
const refAt = new Map();
for (const n of chart.notes) {
  for (let i = Math.round(n.startMs / hop); i <= Math.round(n.endMs / hop); i++) refAt.set(i, n.midi);
}
const voiced = F.filter((f) => f.midi > 0);
function agreement(shiftMs) {
  let hit = 0, tot = 0;
  for (const f of voiced) {
    const r = refAt.get(Math.round((f.t + shiftMs) / hop));
    if (r === undefined) continue;
    tot++;
    const d = Math.abs(((f.midi + take.octaveOffset - r) % 12 + 18) % 12 - 6);
    if (d < 1) hit++;
  }
  return tot ? hit / tot : 0;
}
let bestShift = 0, bestAgree = -1;
for (let sh = -300; sh <= 300; sh += 10) {
  const a = agreement(sh);
  if (a > bestAgree) { bestAgree = a; bestShift = sh; }
}
console.log(`\n[3] 延遲補償檢查`);
console.log(`  目前補償 ${take.latencyMs}ms，吻合度 ${(agreement(0) * 100).toFixed(1)}%`);
console.log(`  再偏移 ${bestShift > 0 ? '+' : ''}${bestShift}ms 時吻合度最高 ${(bestAgree * 100).toFixed(1)}%`);
if (Math.abs(bestShift) >= 30) {
  console.log(`  → 延遲校準偏了約 ${Math.abs(bestShift)}ms。建議重做拍手校準；`);
  console.log(`     或把補償改成 ${take.latencyMs + bestShift}ms 再測一次`);
} else {
  console.log(`  → 延遲補償沒問題`);
}

// ── 4. 八度誤判到底有多頻繁 ────────────────────────────────
let oct = 0, near = 0, off = 0;
for (const f of voiced) {
  const r = refAt.get(Math.round((f.t + bestShift) / hop));
  if (r === undefined) continue;
  const d = f.midi + take.octaveOffset - r;
  if (Math.abs(d) <= 1) near++;
  else if ([12, -12, 24, -24].some((o) => Math.abs(d - o) < 1.5)) oct++;
  else off++;
}
const tot = near + oct + off;
console.log(`\n[4] 音高偵測品質（以最佳偏移對齊後，共 ${tot} 框）`);
console.log(`  對到參考音 ±1 半音: ${pct(near, tot)}`);
console.log(`  剛好差整數個八度  : ${pct(oct, tot)}  ← 這是偵測誤判，不是唱錯`);
console.log(`  其他偏差          : ${pct(off, tot)}  ← 這才是真的唱不準`);
console.log('');
