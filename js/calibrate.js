// calibrate.js — 拍手延遲校準。
//
// 播放固定節拍，請使用者跟著拍手，量測「聽到聲音 → 麥克風收到拍手」的
// 總延遲（輸出延遲 + 輸入延遲）。之後演唱時把麥克風時間戳減掉這個值，
// 音高才會對到正確的歌曲位置。
//
// 量測結果依「麥克風 × 輸出裝置」存成設定檔，換耳機不必重測。

import { saveLatencyProfile } from './storage.js';

const ENV_HOP_MS = 5;
const ENV_WIN_MS = 12;
const MIN_ONSET_GAP_MS = 180;
const MATCH_WINDOW_MS = 400;

/** 短促的 click，容易在包絡上形成銳利的起音。 */
export function makeClickBuffer(ctx) {
  const len = Math.floor(ctx.sampleRate * 0.04);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    const t = i / ctx.sampleRate;
    const env = Math.exp(-t * 90);
    data[i] = env * (Math.sin(2 * Math.PI * 1400 * t) * 0.7 + (Math.random() * 2 - 1) * 0.3);
  }
  return buf;
}

/** 能量包絡（RMS，固定 hop）。回傳 { env, hopMs }。 */
export function envelope(pcm, sampleRate) {
  const hop = Math.max(1, Math.round((sampleRate * ENV_HOP_MS) / 1000));
  const win = Math.max(hop, Math.round((sampleRate * ENV_WIN_MS) / 1000));
  const n = Math.max(0, Math.floor((pcm.length - win) / hop) + 1);
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const off = i * hop;
    for (let j = 0; j < win; j++) s += pcm[off + j] * pcm[off + j];
    env[i] = Math.sqrt(s / win);
  }
  return { env, hopMs: (hop / sampleRate) * 1000 };
}

/**
 * 以包絡的正向差分找拍手起音點。
 * 回傳時間陣列（相對 pcm 開頭的毫秒）。
 */
export function detectOnsets(pcm, sampleRate) {
  const { env, hopMs } = envelope(pcm, sampleRate);
  if (env.length < 4) return [];

  const flux = new Float32Array(env.length);
  for (let i = 1; i < env.length; i++) flux[i] = Math.max(0, env[i] - env[i - 1]);

  // 自適應門檻：平均 + 3 倍標準差，並要求絕對音量夠大
  let sum = 0;
  for (const v of flux) sum += v;
  const mean = sum / flux.length;
  let varSum = 0;
  for (const v of flux) varSum += (v - mean) ** 2;
  const std = Math.sqrt(varSum / flux.length);
  const threshold = Math.max(mean + 3 * std, 1e-4);

  const minGap = Math.round(MIN_ONSET_GAP_MS / hopMs);
  const onsets = [];
  let last = -minGap;
  for (let i = 1; i < flux.length - 1; i++) {
    if (flux[i] < threshold) continue;
    if (flux[i] < flux[i - 1] || flux[i] < flux[i + 1]) continue;
    if (i - last < minGap) continue;
    onsets.push(i * hopMs);
    last = i;
  }
  return onsets;
}

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 把偵測到的拍手對到節拍格點，回傳每拍的延遲。
 * @param onsetsMs 拍手時間（相對錄音開頭）
 * @param beatsMs  節拍時間（相對錄音開頭）
 */
export function matchOffsets(onsetsMs, beatsMs) {
  const raw = [];
  for (const beat of beatsMs) {
    let best = null;
    for (const onset of onsetsMs) {
      const d = onset - beat;
      if (d < -MATCH_WINDOW_MS / 2 || d > MATCH_WINDOW_MS) continue;
      if (best === null || Math.abs(d) < Math.abs(best)) best = d;
    }
    if (best !== null) raw.push(best);
  }
  if (raw.length < 3) return { offsets: raw, accepted: [], medianMs: 0 };

  // 以中位數絕對偏差剔除離群（拍歪、漏拍、雜音）
  const med = median(raw);
  const mad = median(raw.map((v) => Math.abs(v - med))) || 1;
  const accepted = raw.filter((v) => Math.abs(v - med) <= Math.max(3 * mad, 60));
  return { offsets: raw, accepted, medianMs: median(accepted) };
}

export class LatencyCalibrator {
  /**
   * @param {AudioContext} ctx
   * @param {MicTracker} mic 已 start() 的麥克風追蹤器
   */
  constructor(ctx, mic) {
    this.ctx = ctx;
    this.mic = mic;
  }

  /**
   * 執行一次校準。
   * @param opts { bpm, beats, leadIn, onBeat(i,total), destination }
   * @returns { offsetMs, accepted, total, onsets, beats }
   */
  async run(opts = {}) {
    const { bpm = 100, beats = 16, leadIn = 8, onBeat = null, destination = null } = opts;
    const interval = 60 / bpm;
    const ctx = this.ctx;
    const click = makeClickBuffer(ctx);
    const dest = destination || ctx.destination;

    const startAt = ctx.currentTime + 0.8;
    const beatTimes = [];
    for (let i = 0; i < beats; i++) {
      const when = startAt + i * interval;
      beatTimes.push(when);
      const src = ctx.createBufferSource();
      src.buffer = click;
      const gain = ctx.createGain();
      // 前導拍音量小一點，提示「還在數拍」
      gain.gain.value = i < leadIn ? 0.35 : 0.9;
      src.connect(gain).connect(dest);
      src.start(when);
      if (onBeat) {
        setTimeout(() => onBeat(i, beats), Math.max(0, (when - ctx.currentTime) * 1000));
      }
    }

    this.mic.startRecording();
    const totalMs = (startAt + beats * interval + 0.6 - ctx.currentTime) * 1000;
    await new Promise((r) => setTimeout(r, totalMs));
    const rec = this.mic.stopRecording();
    if (!rec) throw new Error('沒有錄到麥克風訊號，請確認麥克風權限');

    const onsets = detectOnsets(rec.pcm, rec.sampleRate);
    // 只比對正拍（跳過前導拍）
    const targetBeats = beatTimes.slice(leadIn).map((t) => (t - rec.startTime) * 1000);
    const { offsets, accepted, medianMs } = matchOffsets(onsets, targetBeats);

    return {
      offsetMs: Math.round(medianMs),
      accepted: accepted.length,
      total: targetBeats.length,
      spreadMs: accepted.length ? Math.round(Math.max(...accepted) - Math.min(...accepted)) : 0,
      onsets,
      rawOffsets: offsets,
    };
  }
}

/** 校準結果是否可信：至少 6 拍有效且離散度不過大。 */
export function isReliable(result) {
  return result.accepted >= 6 && result.spreadMs <= 160;
}

export async function persist(result, micLabel, outputLabel) {
  return saveLatencyProfile(micLabel, outputLabel, result.offsetMs, {
    accepted: result.accepted,
    total: result.total,
    spreadMs: result.spreadMs,
  });
}
