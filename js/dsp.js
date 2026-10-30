// dsp.js — 共用訊號處理：YIN 音高偵測、音分換算、音框後處理、note 切段
// 前端即時偵測與譜面重算都使用這裡的實作，確保基準一致。

export const A4_HZ = 440;

export function hzToMidi(hz) {
  return 69 + 12 * Math.log2(hz / A4_HZ);
}

export function midiToHz(midi) {
  return A4_HZ * Math.pow(2, (midi - 69) / 12);
}

/** 兩個音高相差幾音分（cent）。可傳 midi 或 hz（用 hzToMidi 先轉）。 */
export function centsBetween(midiA, midiB) {
  return (midiA - midiB) * 100;
}

export function rms(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

/**
 * YIN 基頻偵測（含累積均值正規化與拋物線內插）。
 * 回傳 { hz, confidence }；無法判定時 hz = 0。
 */
export class Yin {
  constructor(sampleRate, bufferSize = 2048, threshold = 0.15) {
    this.sampleRate = sampleRate;
    this.bufferSize = bufferSize;
    this.threshold = threshold;
    this.halfSize = bufferSize >> 1;
    this.yinBuffer = new Float32Array(this.halfSize);
    // 只搜尋人聲合理範圍，順便避開低頻雜訊造成的假 tau
    this.minTau = Math.max(2, Math.floor(sampleRate / 1200));
    this.maxTau = Math.min(this.halfSize - 1, Math.floor(sampleRate / 60));
  }

  detect(buf) {
    const yb = this.yinBuffer;
    const half = this.halfSize;

    // 1) 差分函數
    yb[0] = 1;
    for (let tau = 1; tau < half; tau++) {
      let sum = 0;
      for (let i = 0; i < half; i++) {
        const d = buf[i] - buf[i + tau];
        sum += d * d;
      }
      yb[tau] = sum;
    }

    // 2) 累積均值正規化
    let running = 0;
    for (let tau = 1; tau < half; tau++) {
      running += yb[tau];
      yb[tau] = running === 0 ? 1 : (yb[tau] * tau) / running;
    }

    // 3) 絕對門檻：取第一個低於 threshold 的區域極小值
    let tauEstimate = -1;
    for (let tau = this.minTau; tau <= this.maxTau; tau++) {
      if (yb[tau] < this.threshold) {
        while (tau + 1 <= this.maxTau && yb[tau + 1] < yb[tau]) tau++;
        tauEstimate = tau;
        break;
      }
    }
    if (tauEstimate === -1) {
      // 沒有低於門檻者，退而取範圍內全域極小值，信心度會很低
      let best = this.minTau;
      for (let tau = this.minTau; tau <= this.maxTau; tau++) {
        if (yb[tau] < yb[best]) best = tau;
      }
      if (yb[best] > 0.6) return { hz: 0, confidence: 0 };
      tauEstimate = best;
    }

    // 4) 拋物線內插求次樣本精度
    const x0 = tauEstimate > 0 ? tauEstimate - 1 : tauEstimate;
    const x2 = tauEstimate + 1 < half ? tauEstimate + 1 : tauEstimate;
    let betterTau;
    if (x0 === tauEstimate) {
      betterTau = yb[tauEstimate] <= yb[x2] ? tauEstimate : x2;
    } else if (x2 === tauEstimate) {
      betterTau = yb[tauEstimate] <= yb[x0] ? tauEstimate : x0;
    } else {
      const s0 = yb[x0], s1 = yb[tauEstimate], s2 = yb[x2];
      const denom = 2 * (2 * s1 - s2 - s0);
      betterTau = denom === 0 ? tauEstimate : tauEstimate + (s2 - s0) / denom;
    }

    return {
      hz: this.sampleRate / betterTau,
      confidence: 1 - yb[tauEstimate],
    };
  }
}

/** 中值濾波（對 NaN/0 視為無音，跳過不參與）。 */
export function medianFilter(values, window = 5) {
  const out = new Float32Array(values.length);
  const half = window >> 1;
  const scratch = [];
  for (let i = 0; i < values.length; i++) {
    if (!values[i]) { out[i] = 0; continue; }
    scratch.length = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j++) {
      if (values[j]) scratch.push(values[j]);
    }
    scratch.sort((a, b) => a - b);
    out[i] = scratch[scratch.length >> 1];
  }
  return out;
}

/**
 * 八度錯誤修正：與前一個有效音相差接近整八度時，往前一個音的八度靠攏。
 * 輸入輸出皆為 MIDI 音高陣列（0 表無音）。
 *
 * 關鍵是「不能無條件拉回」——真的往上飆一個八度是很常見的唱法，
 * 一律當成誤判修掉的話，高音樂句整段都會被壓到低八度。
 * 判準改成停留長度：偵測誤判只會零星幾框就跳回去，真的換八度會唱好一陣子。
 */
export function fixOctaveJumps(midis, opts = {}) {
  const { minLeapFrames = 6, octaveTolerance = 1.5 } = opts;
  const out = Float32Array.from(midis);

  const idx = [];
  for (let i = 0; i < out.length; i++) if (out[i]) idx.push(i);
  if (idx.length < 2) return out;

  let prev = out[idx[0]];
  for (let k = 1; k < idx.length; k++) {
    const cur = out[idx[k]];
    let oct = 0;
    for (const o of [12, -12, 24, -24]) {
      if (Math.abs(cur - prev - o) < octaveTolerance) { oct = o; break; }
    }
    if (!oct) { prev = cur; continue; }

    // 往後看這個八度停留了幾框
    let run = 1;
    while (k + run < idx.length &&
           Math.abs(out[idx[k + run]] - cur) < octaveTolerance) run++;

    // 停得夠久＝真的跳八度，原樣保留並把基準搬過去
    if (run < minLeapFrames) {
      for (let j = 0; j < run; j++) out[idx[k + j]] -= oct;
    }
    prev = out[idx[k + run - 1]];
    k += run - 1;
  }
  return out;
}

/** 音框的典型間距（ms），用來把「幾毫秒」換算成「幾框」。 */
function frameSpacingMs(frames) {
  const diffs = [];
  for (let i = 1; i < frames.length && diffs.length < 64; i++) {
    const d = frames[i].t - frames[i - 1].t;
    if (d > 0) diffs.push(d);
  }
  if (!diffs.length) return 0;
  diffs.sort((a, b) => a - b);
  return diffs[diffs.length >> 1];
}

/**
 * 音量門檻，相對於這段訊號自己的音量。
 *
 * 分離出的人聲軌會殘留一點伴奏、和聲與殘響尾巴，這些幾乎聽不見卻仍有
 * 週期性，音高偵測照樣算得出穩定的音——結果就是譜上出現「有音符卻沒聲音」
 * 的幽靈。絕對音量門檻會因歌而異，所以改成相對於這段訊號人聲音量
 * （第 90 百分位）的相對門檻。
 */
export function levelFloor(frames, minLevelDb) {
  const voiced = frames.filter((f) => f.midi > 0 && f.rms > 0).map((f) => f.rms);
  if (voiced.length < 10) return 0;
  voiced.sort((a, b) => a - b);
  const reference = voiced[Math.floor(voiced.length * 0.9)];
  return reference * Math.pow(10, minLevelDb / 20);
}

/**
 * 套用門檻並修正八度，產生可直接用來切段與偵測技巧的音框。
 *
 * 順序很重要：先剔除信心不足與太小聲的音框，再做八度修正。反過來的話，
 * 幾乎聽不見的殘留會把旁邊真實音的八度一起帶偏。
 */
export function prepareFrames(frames, opts = {}) {
  const { minConfidence = 0.75, minLevelDb = -24, octaveLeapMs = 100 } = opts;
  const floor = levelFloor(frames, minLevelDb);

  const gated = new Float32Array(frames.length);
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    gated[i] = f.midi > 0 && f.conf >= minConfidence && f.rms >= floor ? f.midi : 0;
  }
  // 參考譜 16ms、麥克風約 10ms 一框，換算成框數才不會因來源不同鬆緊不一
  const dt = frameSpacingMs(frames);
  const fixed = fixOctaveJumps(gated, {
    minLeapFrames: dt > 0 ? Math.max(3, Math.round(octaveLeapMs / dt)) : 6,
  });

  const out = new Array(frames.length);
  for (let i = 0; i < frames.length; i++) out[i] = { ...frames[i], midi: fixed[i] };
  out.prepared = true;
  return out;
}

/**
 * 把逐幀音高切成 note。
 * frames: [{ t, midi, conf, rms }]，midi=0 表無音
 * opts.minConfidence 由「靈敏度」滑桿控制；opts.minDurationMs 過濾過短碎音。
 */
export function framesToNotes(frames, opts = {}) {
  const {
    minNoteDurationMs = 80,
    maxDeviationSemitones = 0.5,
    maxGapMs = 60,
  } = opts;

  // 尚未處理過的音框先套門檻與八度修正
  if (!frames.prepared) frames = prepareFrames(frames, opts);

  const notes = [];
  let cur = null;

  const closeNote = () => {
    if (!cur) return;
    const dur = cur.endMs - cur.startMs;
    if (dur >= minNoteDurationMs) {
      // 量化到半音。音框平均會是 62.76 這種值——那是原唱當下的實際音高，
      // 但譜面該標的是他「在唱哪個音」；不量化的話音符會浮在格線之間。
      // 與 analyze.py 的 frames_to_notes 同步，兩邊必須一致。
      cur.midi = Math.round(cur.sum / cur.count);
      delete cur.sum; delete cur.count; delete cur.lastT;
      notes.push(cur);
    }
    cur = null;
  };

  for (const f of frames) {
    const voiced = f.midi > 0;
    if (!voiced) {
      if (cur && f.t - cur.lastT > maxGapMs) closeNote();
      continue;
    }
    if (cur) {
      const mean = cur.sum / cur.count;
      if (Math.abs(f.midi - mean) > maxDeviationSemitones || f.t - cur.lastT > maxGapMs) {
        closeNote();
      }
    }
    if (!cur) {
      cur = { startMs: f.t, endMs: f.t, sum: 0, count: 0, lastT: f.t };
    }
    cur.sum += f.midi;
    cur.count += 1;
    cur.endMs = f.t;
    cur.lastT = f.t;
  }
  closeNote();
  return mergeGlideNotes(notes, opts);
}

/**
 * 把起音滑上／尾音下滑產生的短碎音併回主音。
 * 判準：短碎音緊貼鄰近音、音高差在範圍內，且它的另一側是靜音（位於樂句邊緣）。
 * 中間被其他音夾住的短音是真正的快速樂句，不合併。
 */
export function mergeGlideNotes(notes, opts = {}) {
  const { glideMergeMs = 200, glideMergeSemitones = 2.0, maxGapMs = 60 } = opts;
  if (notes.length < 2) return notes;
  const isShort = (n) => n.endMs - n.startMs < glideMergeMs;

  const out = [];
  for (const raw of notes) {
    const note = { ...raw };
    if (out.length) {
      const prev = out[out.length - 1];
      const gap = note.startMs - prev.endMs;
      const closeEnough = gap <= maxGapMs && Math.abs(note.midi - prev.midi) < glideMergeSemitones;
      const prevIsolated =
        out.length < 2 || prev.startMs - out[out.length - 2].endMs > maxGapMs;
      if (closeEnough && isShort(prev) && prevIsolated) {
        prev.endMs = note.endMs;
        prev.midi = note.midi;
        continue;
      }
      if (closeEnough && isShort(note)) {
        prev.endMs = note.endMs;
        continue;
      }
    }
    out.push(note);
  }
  return out;
}

/**
 * 即時音高平滑器：擋掉 YIN 偶發的半頻／倍頻誤判與單框亂跳。
 *
 * 後端有整段資料可以做中值濾波，即時路徑沒有未來的資料，因此改用
 * 「遲滯」策略：偏離近期音高太多的偵測先擋一次，只有連續兩框都指向
 * 同一個新音高才接受。這樣真正的換音幾乎不延遲，孤立的尖刺則被濾掉。
 *
 * 另外可以餵入參考譜當下的音（push 的 refMidi），當作「這一刻大概在哪個
 * 八度」的旁證。它只參與八度這個離散選擇，不會動到音分——使用者唱偏多少
 * 依然完全由麥克風決定，偏掉的分數照樣扣。
 */
export class PitchSmoother {
  constructor(opts = {}) {
    this.historySize = opts.historySize ?? 5;
    this.resetGapMs = opts.resetGapMs ?? 250;      // 靜音這麼久就重新開始
    this.jumpSemitones = opts.jumpSemitones ?? 6;  // 超過視為突兀跳動
    this.octaveTolerance = opts.octaveTolerance ?? 1.5;
    this.confirmFrames = opts.confirmFrames ?? 2;  // 需連續幾框確認
    // 八度要多看幾框再放行：YIN 的半頻／倍頻誤判常會連錯個兩三框，
    // 但真的飆高八度會唱上數百毫秒，5 框（約 50ms）分得開又感覺不到延遲。
    this.octaveConfirmFrames = opts.octaveConfirmFrames ?? 5;
    // 判斷八度時兩邊證據的權重：麥克風自己的歷史 0.7、參考譜 0.3。
    // 注意麥克風端的證據不能用 YIN 的信心值——CMND 在真週期 τ 與 2τ 上
    // 都有極小值，信心值對八度幾乎沒有鑑別力，這正是八度誤判的成因。
    // 真正有鑑別力的是「連續幾框指向同一個新八度」。
    this.micWeight = opts.micWeight ?? 0.7;
    this.refWeight = opts.refWeight ?? 0.3;
    // 參考譜要離得夠近才採信。差太多代表延遲對齊歪掉、或使用者根本唱別的
    // 音，這時候它的意見不值得聽。抓 1.5 半音而非 1 個，是要容得下顫音
    // 擺幅與一般的音準偏移，又不至於把「唱錯音」也含進來。
    this.refMaxSemitones = opts.refMaxSemitones ?? 1.5;
    this.reset();
  }

  /**
   * 參考譜對這次八度跳動的意見：+1 支持接受、-1 支持拉回、0 沒意見。
   * refMidi 必須已經換算到使用者自己的八度座標系（扣掉全域八度差、含升降調）。
   */
  refVote(jumped, folded, refMidi) {
    if (!refMidi) return 0;
    const dJump = Math.abs(jumped - refMidi);
    const dStay = Math.abs(folded - refMidi);
    if (Math.min(dJump, dStay) > this.refMaxSemitones) return 0;
    // 兩個候選差不多近的時候不表示意見，免得雜訊主導決策
    if (dJump + 0.5 < dStay) return 1;
    if (dStay + 0.5 < dJump) return -1;
    return 0;
  }

  /**
   * 樂句開頭把音搬到最接近參考譜的八度。
   *
   * 這裡沒有歷史可比對，八度完全由第一框決定——YIN 在這一框半頻誤判的話，
   * 整句都會錨在錯的八度，之後每一框正確的偵測反而變成「要確認的跳動」，
   * 一路被擋到樂句結束。參考譜是這一刻唯一的旁證。
   */
  snapToRef(midi, refMidi) {
    if (!refMidi) return midi;
    let best = midi;
    for (const o of [12, -12, 24, -24]) {
      if (Math.abs(midi + o - refMidi) < Math.abs(best - refMidi)) best = midi + o;
    }
    return Math.abs(best - refMidi) <= this.refMaxSemitones ? best : midi;
  }

  /**
   * 下一框會不會是新樂句的第一框（沒有任何歷史可比對）。
   * 呼叫端用它決定要不要放寬參考譜的採信條件——那一框麥克風端沒有證據，
   * 參考譜是唯一的旁證，這時候寧可採信也不要棄權。
   */
  isPhraseStart(tMs) {
    return !this.history.length || tMs - this.lastT > this.resetGapMs;
  }

  reset() {
    this.history = [];
    this.lastT = -Infinity;
    this.pending = 0;
    this.pendingMidi = 0;
    this.octPending = 0;
    this.octPendingMidi = 0;
  }

  /**
   * @param conf 這一框的偵測信心度（0–1）。信心度愈高，確認換八度所需的
   *   框數愈少——唱得夠準時，快速跳上高音幾乎不該有延遲；含糊不清的訊號
   *   才需要多看幾框。不提供時視為信心不足，用最保守的框數。
   * @param refMidi 參考譜當下的音，已換算到使用者自己的八度座標系；
   *   0 表示這一刻沒有可信的參考（前奏、換氣、對齊不可靠處）。只用來
   *   判斷八度，不影響音分。
   * @returns 修正後的 midi，或 0 表示這一框還不能確定（沉默或觀察中）
   */
  push(midi, tMs, conf = 0, refMidi = 0) {
    // 靜音框不更新時間戳：否則「距離上次有聲多久」永遠是一框的時間，
    // 換氣後的重置就不會觸發，新樂句會被上一句的音高擋住。
    if (!midi) return 0;
    if (tMs - this.lastT > this.resetGapMs) this.reset();
    this.lastT = tMs;

    if (!this.history.length) {
      const first = this.snapToRef(midi, refMidi);
      this.history.push(first);
      return first;
    }

    const ref = median(this.history);

    // 與近期音高差接近整八度：可能是 YIN 的半頻／倍頻誤判，
    // 也可能是真的飆上／掉下一個八度。無條件拉回會讓整段高音卡在低八度，
    // 所以先當成假設，連續指著同一個八度才承認。
    let oct = 0;
    for (const o of [12, -12, 24, -24]) {
      if (Math.abs(midi - ref - o) < this.octaveTolerance) { oct = o; break; }
    }
    if (oct) {
      if (Math.abs(midi - this.octPendingMidi) < this.octaveTolerance) this.octPending += 1;
      else { this.octPending = 1; this.octPendingMidi = midi; }
      const base = conf >= 0.92 ? 2 : conf >= 0.85 ? 3 : this.octaveConfirmFrames;
      // 麥克風端的證據（連續指向新八度的框數）佔 micWeight，參考譜佔
      // refWeight，換算成「還需要幾框才放行」：參考譜站在新八度那邊就少看
      // 幾框，站在舊八度那邊就多看幾框。沒有參考譜時 vote = 0，需要的框數
      // 與加入這段之前完全相同。
      const vote = this.refVote(midi, midi - oct, refMidi);
      const needed = Math.max(1, Math.ceil(base * (1 - (this.refWeight / this.micWeight) * vote)));
      if (this.octPending < needed) {
        // 還在觀察期：回報「不確定」而不是硬拉回舊八度。跳上高音的樂句
        // 常常唱得比確認所需的時間還短，硬拉回去會讓整句都顯示成低八度、
        // 永遠沒有機會被更正；回傳 0 頂多讓畫面短暫斷一下，不會顯示錯的音。
        return 0;
      }
      // 換完八度後，用同一個值把整個歷史窗填滿，讓新基準立刻站穩腳步——
      // 不然下一兩框只要有點雜訊，又會被拉著換回去，變成來回震盪。
      this.history = new Array(this.historySize).fill(midi);
      this.octPending = 0;
      this.octPendingMidi = 0;
      this.pending = 0;
      return midi;
    }
    this.octPending = 0;

    if (Math.abs(midi - ref) > this.jumpSemitones) {
      // 只有連續指向同一個新音高才相信，否則當成雜訊丟掉
      if (Math.abs(midi - this.pendingMidi) < 2) this.pending += 1;
      else { this.pending = 1; this.pendingMidi = midi; }
      if (this.pending < this.confirmFrames) return 0;
      this.history = [midi];
      this.pending = 0;
      return midi;
    }

    this.pending = 0;
    this.history.push(midi);
    if (this.history.length > this.historySize) this.history.shift();
    return midi;
  }
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/** 取某段時間內的音框（含端點內縮，避開 onset/offset 的滑音）。 */
export function framesInRange(frames, startMs, endMs) {
  return frames.filter((f) => f.t >= startMs && f.t <= endMs && f.midi > 0);
}

/** 把 AudioBuffer 混成單聲道 Float32Array。 */
export function toMono(audioBuffer) {
  const ch = audioBuffer.numberOfChannels;
  const len = audioBuffer.length;
  const out = new Float32Array(len);
  for (let c = 0; c < ch; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += data[i];
  }
  if (ch > 1) for (let i = 0; i < len; i++) out[i] /= ch;
  return out;
}

/** 線性內插重取樣。 */
export function resample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = input[i0] || 0;
    const b = input[i0 + 1] !== undefined ? input[i0 + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}
