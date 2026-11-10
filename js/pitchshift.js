// pitchshift.js — 主執行緒端的升降調播放器封裝。
// 速度完全不變（合成 hop 固定），因此來源時間軸 == 輸出時間軸，
// 播放位置可直接用 AudioContext.currentTime 推算，不需與 worklet 往返。

// AudioWorklet 模組掛在個別 AudioContext 上，逐 context 記錄載入狀態。
const workletReady = new WeakMap();

export async function ensureWorklet(audioCtx) {
  if (!workletReady.has(audioCtx)) {
    workletReady.set(audioCtx,
      audioCtx.audioWorklet.addModule(new URL('./pitchshift-worklet.js', import.meta.url)));
  }
  return workletReady.get(audioCtx);
}

export class KeyPlayer {
  constructor(audioCtx) {
    this.ctx = audioCtx;
    this.node = null;
    this.semitones = 0;
    this.duration = 0;
    this._playing = false;
    this._posAtStart = 0;
    this._ctxTimeAtStart = 0;
    this.onended = null;
    this.gain = audioCtx.createGain();
  }

  /**
   * 載入音軌。可傳單一 AudioBuffer，或多軌（例如伴奏 + 原唱導唱）：
   *   load([{ buffer: 伴奏 }, { buffer: 原唱, gain: 0 }])
   * 所有軌共用同一個播放位置，因此永遠同步。
   */
  async load(input) {
    await ensureWorklet(this.ctx);
    if (this.node) this.node.disconnect();

    const tracks = Array.isArray(input) ? input : [{ buffer: input }];
    const numChannels = tracks.reduce(
      (n, t) => Math.max(n, Math.min(2, t.buffer.numberOfChannels)), 1);
    this.node = new AudioWorkletNode(this.ctx, 'pitch-shift-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [numChannels],
    });
    this.node.connect(this.gain);
    this.node.port.onmessage = (e) => {
      if (e.data.cmd === 'ended') {
        this._playing = false;
        if (this.onended) this.onended();
      }
    };

    const transfer = [];
    const stems = tracks.map((track) => {
      const chCount = Math.min(2, track.buffer.numberOfChannels);
      const channels = [];
      for (let c = 0; c < chCount; c++) {
        const buf = track.buffer.getChannelData(c).slice().buffer;
        channels.push(buf);
        transfer.push(buf);
      }
      return { channels, gain: track.gain === undefined ? 1 : track.gain };
    });
    this.node.port.postMessage(
      { cmd: 'load', stems, semitones: this.semitones }, transfer);

    this.duration = Math.max(...tracks.map((t) => t.buffer.duration));
    this._posAtStart = 0;
    this._playing = false;
  }

  /** 即時調整某一軌的音量（0 = 靜音）。導唱開關用這個。 */
  setStemGain(index, value) {
    if (this.node) this.node.port.postMessage({ cmd: 'gain', index, value });
  }

  connect(dest) {
    this.gain.connect(dest);
    return dest;
  }

  setVolume(v) {
    this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  /** 升降調（半音，−6 ～ +6）。演唱中也可即時切換。 */
  setSemitones(n) {
    this.semitones = Math.max(-6, Math.min(6, Math.round(n)));
    if (this.node) this.node.port.postMessage({ cmd: 'semitones', value: this.semitones });
    return this.semitones;
  }

  play(fromSeconds = null) {
    if (!this.node) return;
    if (fromSeconds !== null) this.seek(fromSeconds);
    this._ctxTimeAtStart = this.ctx.currentTime;
    this._playing = true;
    this.node.port.postMessage({ cmd: 'play' });
  }

  pause() {
    if (!this.node || !this._playing) return;
    this._posAtStart = this.currentTime;
    this._playing = false;
    this.node.port.postMessage({ cmd: 'pause' });
  }

  seek(seconds) {
    if (!this.node) return;
    this._posAtStart = Math.max(0, Math.min(this.duration, seconds));
    this._ctxTimeAtStart = this.ctx.currentTime;
    this.node.port.postMessage({ cmd: 'seek', seconds: this._posAtStart });
  }

  stop() {
    this.pause();
    this.seek(0);
  }

  get playing() {
    return this._playing;
  }

  /** 目前播放位置（秒，來源時間軸）。 */
  get currentTime() {
    return this.songTimeAt(this.ctx.currentTime);
  }

  /** 某個 AudioContext 時刻對應的歌曲位置（秒）。麥克風音框對位用。 */
  songTimeAt(ctxTime) {
    if (!this._playing) return this._posAtStart;
    return this._posAtStart + (ctxTime - this._ctxTimeAtStart);
  }
}

/**
 * 離線 WSOLA 升降調（與 worklet 內的串流版同演算法）。
 *
 * 顆粒在取出時以 r = 2^(semitones/12) 重取樣（改變音高），合成 hop 固定
 * （保持速度）。關鍵在於每個顆粒的取樣位置要在標稱位置附近搜尋，找出與
 * 前一顆粒「自然延續」最相符的相位——少了這一步，重疊相加會把音高拉回
 * 原本的頻率。
 *
 * @returns 長度與輸入相同的 Float32Array
 */
export function shiftOffline(input, semitones, opts = {}) {
  const GRAIN = opts.grain || 2048;
  const HOP = opts.hop || GRAIN / 4;
  const SEARCH = opts.search ?? 512;
  const STEP = opts.searchStep || 2;

  const r = Math.pow(2, semitones / 12);
  const out = new Float32Array(input.length);
  if (Math.abs(r - 1) < 1e-9) { out.set(input); return out; }

  const win = new Float32Array(GRAIN);
  for (let i = 0; i < GRAIN; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / GRAIN);

  let prevOffset = 0;
  for (let pos = 0; pos + HOP < input.length; pos += HOP) {
    const offset = bestOffset(input, pos, prevOffset, r, HOP, SEARCH, STEP);
    prevOffset = offset;
    for (let i = 0; i < GRAIN; i++) {
      const sp = offset + i * r;
      const i0 = Math.floor(sp);
      if (i0 < 0 || i0 + 1 >= input.length) break;
      const frac = sp - i0;
      const s = (input[i0] + (input[i0 + 1] - input[i0]) * frac) * win[i] * 0.5;
      if (pos + i < out.length) out[pos + i] += s;
    }
  }
  return out;
}

/**
 * 在 nominal 附近找出與「自然延續」相關性最高的來源位置。
 * 這一步讓相鄰顆粒的相位接得上，音高才會真的落在 f×r。
 */
export function bestOffset(src, nominal, prevOffset, r, hop, search, step = 2) {
  const natural = Math.round(prevOffset + hop * r);
  if (natural + hop >= src.length) return nominal;

  let bestLag = 0;
  let bestScore = -Infinity;
  for (let lag = -search; lag <= search; lag += step) {
    const cand = nominal + lag;
    if (cand < 0 || cand + hop >= src.length) continue;
    let dot = 0, energy = 1e-9;
    for (let i = 0; i < hop; i += 4) {
      const v = src[cand + i];
      dot += v * src[natural + i];
      energy += v * v;
    }
    const score = dot / Math.sqrt(energy);
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  return nominal + bestLag;
}
