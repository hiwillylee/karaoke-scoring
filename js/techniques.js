// techniques.js — 演唱技巧偵測：ビブラート／しゃくり／フォール
// 判準來自 config/params.json，與後端 analyze.py 共用同一組數值。

import { framesInRange } from './dsp.js';

/** 預設值與 config/params.json 相同；loadParams() 會以檔案內容覆寫。 */
export const PARAMS = {
  vibrato: { minNoteMs: 500, minRateHz: 4.5, maxRateHz: 7.5, minDepthCents: 20, maxDepthCents: 100, minCycles: 3 },
  shakuri: { windowMs: 200, minRiseCents: 60, targetBandCents: 50 },
  fall: { windowMs: 150, minDropCents: 80 },
  pitch: {
    minConfidence: 0.75, minNoteDurationMs: 80, maxDeviationSemitones: 0.5,
    maxGapMs: 60, fminHz: 65, fmaxHz: 1050, hopMs: 16, frameLength: 1024,
    glideMergeMs: 200, glideMergeSemitones: 2.0, minLevelDb: -24,
  },
  scoring: {
    weights: { pitch: 0.6, rhythm: 0.15, stability: 0.15, technique: 0.1 },
    pitchPerfectCents: 30, pitchZeroCents: 180, pitchCurve: 1.5, pitchOnsetGuardMs: 55, refTargetMaxOffsetCents: 100,
    rhythmPerfectMs: 40, rhythmZeroMs: 260, rhythmCurve: 1.3, rhythmExtraPenalty: 0.35,
    stabilityPerfectCents: 25, stabilityZeroCents: 110, stabilityCurve: 1.3, stabilityOutlierCents: 400, octaveRepairMaxMs: 300,
    sustainedNoteMs: 400, techniqueTargetCount: 18, techniqueMinTarget: 8,
    unmatchedTechniqueCap: 0.5, originalMatchBonus: 1.0,
    completionFullMark: 0.9, completionFloor: 0.5,
    pivotScore: 85, pivotStretch: 1.5,
  },
};

export async function loadParams() {
  try {
    // 以模組自身位置解析，測試頁放在子目錄也能正確取得
    const url = new URL('../config/params.json', import.meta.url);
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    const json = await res.json();
    for (const key of Object.keys(PARAMS)) {
      if (json[key]) Object.assign(PARAMS[key], json[key]);
    }
  } catch (err) {
    console.warn('params.json 載入失敗，使用內建預設值', err);
  }
  return PARAMS;
}

export const TECHNIQUE_LABELS = {
  vibrato: 'ビブラート',
  shakuri: 'しゃくり',
  fall: 'フォール',
};

/**
 * 技巧改用顏色區分，不再顯示文字。
 * 以 "R,G,B" 保存，疊透明度時才不用另外解析色碼。
 */
export const TECHNIQUE_RGB = {
  vibrato: '167,139,250',   // 紫
  shakuri: '124,252,154',   // 綠
  fall: '255,159,67',       // 橙
};

export function techniqueColor(type, alpha = 1) {
  return `rgba(${TECHNIQUE_RGB[type] || '255,255,255'},${alpha})`;
}

/** 去掉線性趨勢，只留下震盪成分。回傳新陣列。 */
function detrend(values) {
  const n = values.length;
  if (n < 2) return Float64Array.from(values);
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i; sy += values[i]; sxx += i * i; sxy += i * values[i];
  }
  const denom = n * sxx - sx * sx;
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = values[i] - (slope * i + intercept);
  return out;
}

/**
 * 由去趨勢後的曲線估計震盪頻率（以正負穿越計算）與深度。
 * hopMs = 相鄰取樣的時間間隔。
 */
function oscillation(curve, hopMs) {
  const n = curve.length;
  if (n < 4) return { rateHz: 0, depthCents: 0, cycles: 0 };

  let crossings = 0;
  let prevSign = Math.sign(curve[0]);
  for (let i = 1; i < n; i++) {
    const s = Math.sign(curve[i]);
    if (s !== 0 && prevSign !== 0 && s !== prevSign) crossings++;
    if (s !== 0) prevSign = s;
  }
  const durationSec = (n * hopMs) / 1000;
  const cycles = crossings / 2;
  const rateHz = durationSec > 0 ? cycles / durationSec : 0;

  // 深度取 RMS 換算成等效正弦的峰值，比 max-min 抗離群值
  let sq = 0;
  for (let i = 0; i < n; i++) sq += curve[i] * curve[i];
  const depthCents = Math.sqrt(sq / n) * Math.SQRT2;

  return { rateHz, depthCents, cycles };
}

/**
 * 分析單一 note 的技巧。
 * frames: 該 note 涵蓋時間內的音框 [{t, midi}]（已過濾無音）
 * targetMidi: 該 note 的基準音高
 * 回傳 { vibrato, shakuri, fall }，vibrato 另含 rateHz / depthCents。
 */
export function analyzeNote(core, onset, tail, durationMs, hopMs) {
  const result = { vibrato: null, shakuri: false, fall: false };
  if (core.length < 3) return result;
  const cents = core;

  // --- ビブラート ---
  const vp = PARAMS.vibrato;
  if (durationMs >= vp.minNoteMs) {
    // 只看中段，排除 onset 滑音與尾音下墜的干擾
    const skip = Math.max(1, Math.round(80 / hopMs));
    const mid = cents.slice(skip, Math.max(skip + 3, cents.length - skip));
    const { rateHz, depthCents, cycles } = oscillation(detrend(mid), hopMs);
    if (
      rateHz >= vp.minRateHz && rateHz <= vp.maxRateHz &&
      depthCents >= vp.minDepthCents && depthCents <= vp.maxDepthCents &&
      cycles >= vp.minCycles
    ) {
      // 速度落在區間中央、深度適中者視為漂亮的顫音
      const rateMid = (vp.minRateHz + vp.maxRateHz) / 2;
      const rateScore = 1 - Math.abs(rateHz - rateMid) / ((vp.maxRateHz - vp.minRateHz) / 2);
      const depthScore = Math.min(1, depthCents / 50);
      result.vibrato = {
        rateHz: +rateHz.toFixed(2),
        depthCents: +depthCents.toFixed(1),
        quality: +Math.max(0, Math.min(1, rateScore * 0.5 + depthScore * 0.5)).toFixed(2),
      };
    }
  }

  // 穩定音高：取中段中位數，避免被頭尾滑音拉走
  const stableSlice = cents.slice(
    Math.floor(cents.length * 0.25),
    Math.max(Math.floor(cents.length * 0.25) + 1, Math.floor(cents.length * 0.75))
  );
  // 中位數的算法要跟 numpy.median 一樣：偶數個時取中間兩個的平均
  // （以前取偏上的那一個，前後端標出來的しゃくり／フォール會不一樣）
  const sorted = [...stableSlice].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const stableCents = !sorted.length ? 0
    : sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  // --- しゃくり（起音由下往上滑進目標） ---
  const sp = PARAMS.shakuri;
  if (onset.length >= 3) {
    const rise = stableCents - Math.min(...onset);
    const startedBelow = onset[0] < stableCents - sp.minRiseCents * 0.6;
    const reachedTarget = Math.abs(onset[onset.length - 1] - stableCents) <= sp.targetBandCents;
    if (rise >= sp.minRiseCents && startedBelow && reachedTarget) result.shakuri = true;
  }

  // --- フォール（尾音下滑） ---
  const fp = PARAMS.fall;
  if (tail.length >= 3) {
    const drop = stableCents - Math.min(...tail);
    const endsLow = tail[tail.length - 1] < stableCents - fp.minDropCents * 0.6;
    if (drop >= fp.minDropCents && endsLow) result.fall = true;
  }

  return result;
}

/**
 * 掃過整份 note 清單，回傳技巧事件。
 * 回傳 [{ type, startMs, endMs, noteIndex, detail }]
 */
export function detectTechniques(notes, frames, hopMs) {
  const events = [];
  const sw = PARAMS.shakuri.windowMs;
  const fw = PARAMS.fall.windowMs;
  const centsIn = (note, a, b) =>
    framesInRange(frames, a, b).map((f) => (f.midi - note.midi) * 100);

  notes.forEach((note, i) => {
    const core = centsIn(note, note.startMs, note.endMs);
    if (core.length < 3) return;

    // 分析窗只有在「這一側是樂句邊緣」時才能往 note 外面伸。
    // 音與音之間的過渡音框從本音看過去一律是先低再爬上來，只要往外看，
    // 每一次換音都會被算成しゃくり＋フォール——這正是原唱被標出上百次
    // 技巧的原因。真正的しゃくり前面是靜音，真正的フォール後面也是靜音。
    const prev = notes[i - 1];
    const next = notes[i + 1];
    const onsetFrom = prev && prev.endMs > note.startMs - sw
      ? note.startMs : note.startMs - sw;
    const tailTo = next && next.startMs < note.endMs + fw
      ? note.endMs : note.endMs + fw;

    const onset = centsIn(note, onsetFrom, Math.min(note.startMs + sw, note.endMs));
    const tail = centsIn(note, Math.max(note.endMs - fw, note.startMs), tailTo);
    const res = analyzeNote(core, onset, tail, note.endMs - note.startMs, hopMs);
    const base = { startMs: note.startMs, endMs: note.endMs, noteIndex: i };
    if (res.vibrato) events.push({ type: 'vibrato', ...base, detail: res.vibrato });
    if (res.shakuri) events.push({ type: 'shakuri', ...base, detail: null });
    if (res.fall) events.push({ type: 'fall', ...base, detail: null });
  });
  return events;
}
