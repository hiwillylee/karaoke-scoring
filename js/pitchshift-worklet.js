// pitchshift-worklet.js — 變調不變速的多軌播放引擎（WSOLA + 顆粒重取樣）
//
// 作法：以固定合成 hop 疊加輸出（因此速度不變），每個顆粒在取出時依
// r = 2^(semitones/12) 重取樣（因此音高改變）。取樣位置以 WSOLA 相似度
// 搜尋微調，讓相鄰顆粒的相位接得上——少了這一步，重疊相加會把音高
// 拉回原本的頻率。
//
// 伴奏與原唱（導唱）放在同一個 processor 裡當作兩條 stem，共用同一個
// 播放位置，因此兩軌永遠取樣級同步；各自有獨立音量可即時開關。
//
// r = 1 時走直通路徑，完全無失真。

const GRAIN = 2048;      // 顆粒長度
const HOP = 512;         // 合成 hop（GRAIN/4，Hann 4 倍重疊，疊加總和固定為 2）
const SEARCH = 512;      // WSOLA 搜尋範圍（樣本）——需涵蓋低音的一個週期
const SEARCH_STEP = 2;

class PitchShiftProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.stems = [];          // [{ chans, out, prevOffsets, gain }]
    this.length = 0;
    this.playing = false;
    this.position = 0;        // 來源樣本位置（等同輸出時間）
    this.ratio = 1;
    this.ended = false;

    this.outLen = GRAIN * 4;
    this.outRead = 0;
    this.outWrite = 0;

    this.window = new Float32Array(GRAIN);
    for (let i = 0; i < GRAIN; i++) {
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / GRAIN);
    }

    this.port.onmessage = (e) => this.onCommand(e.data);
  }

  onCommand(msg) {
    switch (msg.cmd) {
      case 'load': {
        // 一次帶齊初始狀態：OfflineAudioContext 每個 render quantum 只投遞
        // 一則訊息，分成多則會在離線渲染時來不及送達。
        if (msg.semitones !== undefined) this.ratio = Math.pow(2, msg.semitones / 12);
        this.stems = (msg.stems || []).map((stem) => {
          const chans = stem.channels.map((c) => new Float32Array(c));
          return {
            chans,
            out: chans.map(() => new Float32Array(this.outLen)),
            prevOffsets: chans.map(() => 0),
            gain: stem.gain === undefined ? 1 : stem.gain,
          };
        });
        this.length = this.stems.reduce(
          (n, s) => Math.max(n, s.chans[0] ? s.chans[0].length : 0), 0);
        this.position = 0;
        this.resetOutput();
        if (msg.play) { this.ended = false; this.playing = true; }
        this.port.postMessage({ cmd: 'loaded', durationSec: this.length / sampleRate });
        break;
      }
      case 'gain':
        if (this.stems[msg.index]) this.stems[msg.index].gain = msg.value;
        break;
      case 'play':
        this.ended = false;
        this.playing = true;
        break;
      case 'pause':
        this.playing = false;
        break;
      case 'seek':
        this.position = Math.max(0, Math.min(Math.max(0, this.length - 1),
          Math.round(msg.seconds * sampleRate)));
        for (const stem of this.stems) stem.prevOffsets = stem.prevOffsets.map(() => this.position);
        this.resetOutput();
        break;
      case 'semitones':
        this.ratio = Math.pow(2, msg.value / 12);
        break;
    }
  }

  resetOutput() {
    for (const stem of this.stems) for (const buf of stem.out) buf.fill(0);
    this.outRead = 0;
    this.outWrite = 0;
  }

  /** 在 nominal 附近找出與「自然延續」最相似的來源位置。 */
  findBestOffset(src, nominal, prevOffset) {
    const natural = Math.round(prevOffset + HOP * this.ratio);
    if (natural + HOP >= src.length || nominal + HOP >= src.length) return nominal;

    let bestLag = 0;
    let bestScore = -Infinity;
    for (let lag = -SEARCH; lag <= SEARCH; lag += SEARCH_STEP) {
      const cand = nominal + lag;
      if (cand < 0 || cand + HOP >= src.length) continue;
      let dot = 0, energy = 1e-9;
      for (let i = 0; i < HOP; i += 4) {
        const s = src[cand + i];
        dot += s * src[natural + i];
        energy += s * s;
      }
      const score = dot / Math.sqrt(energy);
      if (score > bestScore) { bestScore = score; bestLag = lag; }
    }
    return nominal + bestLag;
  }

  /** 合成一個 hop 份量的輸出（所有 stem、所有聲道）。 */
  synthesizeGrain() {
    const r = this.ratio;
    const bypass = Math.abs(r - 1) < 1e-6;
    const base = this.outRead + this.outWrite;

    for (const stem of this.stems) {
      for (let c = 0; c < stem.chans.length; c++) {
        const src = stem.chans[c];
        const out = stem.out[c];

        if (bypass) {
          for (let i = 0; i < HOP; i++) {
            const idx = this.position + i;
            out[(base + i) % this.outLen] = idx < src.length ? src[idx] : 0;
          }
          continue;
        }

        const offset = this.findBestOffset(src, this.position, stem.prevOffsets[c]);
        stem.prevOffsets[c] = offset;

        for (let i = 0; i < GRAIN; i++) {
          const pos = offset + i * r;
          const i0 = Math.floor(pos);
          if (i0 < 0 || i0 + 1 >= src.length) break;
          const frac = pos - i0;
          out[(base + i) % this.outLen] +=
            (src[i0] + (src[i0 + 1] - src[i0]) * frac) * this.window[i] * 0.5;
        }
      }
    }

    this.outWrite += HOP;
    this.position += HOP;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const frames = output[0] ? output[0].length : 128;

    if (!this.playing || !this.stems.length) {
      for (const ch of output) ch.fill(0);
      return true;
    }

    if (this.position >= this.length && this.outWrite <= 0) {
      for (const ch of output) ch.fill(0);
      if (!this.ended) {
        this.ended = true;
        this.playing = false;
        this.port.postMessage({ cmd: 'ended' });
      }
      return true;
    }

    // 確保緩衝內至少有 frames 個樣本可送出
    while (this.outWrite < frames && this.position < this.length) {
      this.synthesizeGrain();
    }

    for (let c = 0; c < output.length; c++) {
      const dst = output[c];
      dst.fill(0);
      for (const stem of this.stems) {
        if (!stem.gain) continue;
        const buf = stem.out[Math.min(c, stem.chans.length - 1)];
        if (!buf) continue;
        for (let i = 0; i < frames; i++) {
          dst[i] += buf[(this.outRead + i) % this.outLen] * stem.gain;
        }
      }
    }

    // 送出後清掉已消耗的區段，供後續顆粒疊加
    for (const stem of this.stems) {
      for (const buf of stem.out) {
        for (let i = 0; i < frames; i++) buf[(this.outRead + i) % this.outLen] = 0;
      }
    }
    this.outRead = (this.outRead + frames) % this.outLen;
    this.outWrite -= frames;

    return true;
  }
}

registerProcessor('pitch-shift-processor', PitchShiftProcessor);
