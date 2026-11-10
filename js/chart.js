// chart.js — 參考譜的展開與查詢工具。
// 後端為了縮小 JSON，逐幀資料以平行陣列傳回，這裡展開成物件陣列。

import { framesToNotes, prepareFrames } from './dsp.js';
import { detectTechniques, PARAMS } from './techniques.js';

export function expandFrames(chart) {
  const { hopMs } = chart;
  const { midi, conf, rms } = chart.frames;
  const out = new Array(midi.length);
  for (let i = 0; i < midi.length; i++) {
    out[i] = { t: i * hopMs, midi: midi[i], conf: conf[i], rms: rms ? rms[i] : 0 };
  }
  return out;
}

export const EMPTY_EDITS = { pitchShifts: [], notes: null };

/**
 * 依「靈敏度」「八度位移」與使用者的編輯重新切出參考 note。
 * 不需重跑後端，因為逐幀音高已經在手上了。
 *
 * edits 有兩層，因為兩種編輯的性質不同：
 *
 *   pitchShifts — 逐幀的音高位移（八度修正就是它）。套在切段之前，所以
 *     note 邊界與技巧偵測都會跟著重算，結果跟後端自己抽出來的一樣自然。
 *
 *   notes — 整份 note 的覆寫。改長度、刪音符這類「結構性」的編輯沒辦法用
 *     逐幀位移表達，只能直接接管切段結果。一旦存在就以它為準，靈敏度與
 *     音量門檻兩個滑桿也就不再影響 note（它們是「產生」階段的參數，
 *     人工編輯過之後再重新產生會把編輯洗掉）。
 *
 * 演唱前走的也是同一個 rebuildChart，所以編輯會自動流進評分。
 */
export function rebuildChart(
  chart,
  { minConfidence, minLevelDb, octaveOffset = 0, edits = EMPTY_EDITS } = {},
) {
  const raw = expandFrames(chart);
  if (octaveOffset) {
    for (const f of raw) if (f.midi > 0) f.midi += octaveOffset * 12;
  }
  for (const fix of edits.pitchShifts || []) {
    for (const f of raw) {
      if (f.midi > 0 && f.t >= fix.startMs && f.t <= fix.endMs) f.midi += fix.semitones;
    }
  }
  const opts = {
    ...PARAMS.pitch,
    minConfidence: minConfidence ?? PARAMS.pitch.minConfidence,
    minLevelDb: minLevelDb ?? PARAMS.pitch.minLevelDb,
  };
  // 切段與技巧偵測要用同一份處理過的音框，否則兩邊的八度基準會不一致
  const frames = prepareFrames(raw, opts);
  const derived = framesToNotes(frames, opts);
  const notes = edits.notes ? edits.notes.map((n) => ({ ...n })) : derived;
  // 技巧仍然從音框偵測。手動改過音高或長度的 note，偵測結果會失準——那是
  // 人工編輯必然的代價，畢竟音框記錄的是原唱實際唱的東西。
  const techniques = detectTechniques(notes, frames, chart.hopMs);
  // refFrames 一併回傳：評分需要原唱「實際唱的音高」當基準，而 chart.frames
  // 是還沒套上八度修正與逐幀編輯的原始資料，評分端自己重算會兩邊不一致。
  return { ...chart, notes, techniques, octaveOffset, edits, refFrames: frames,
    minLevelDb: opts.minLevelDb };
}

/** 音高範圍，用來決定畫面縱軸。 */
export function noteRange(notes, padSemitones = 3) {
  if (!notes.length) return { min: 55, max: 79 };
  let min = Infinity, max = -Infinity;
  for (const n of notes) {
    if (n.midi < min) min = n.midi;
    if (n.midi > max) max = n.midi;
  }
  // 至少維持兩個八度，避免音域窄的歌把畫面拉得太扁
  const center = (min + max) / 2;
  min = Math.min(min - padSemitones, center - 12);
  max = Math.max(max + padSemitones, center + 12);
  return { min, max };
}

/** 目前時間點所在的 note（沒有就回傳 null）。 */
export function noteAt(notes, timeMs) {
  for (const n of notes) {
    if (timeMs >= n.startMs && timeMs <= n.endMs) return n;
    if (n.startMs > timeMs) break;
  }
  return null;
}

export const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

export function midiToName(midi) {
  const m = Math.round(midi);
  return `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}
