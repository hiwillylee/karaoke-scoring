// piano.js — 把抽出來的參考譜用鋼琴音色彈出來，跟原唱對照聽。
//
// 為什麼需要這個：音高偵測器（pyin 與 CREPE 都一樣）在二次諧波比基頻強的
// 段落會整句鎖在諧波上，譜就整段高一個八度。這種錯誤用看的不容易確定——
// 音程條本身看起來很正常，只是位置不對。但用聽的一秒就知道：鋼琴跟原唱
// 差一個八度是非常明顯的。聽出來之後就能用「段落八度修正」改掉。

import { midiToHz } from './dsp.js';

const LOOKAHEAD_MS = 400;    // 每次排程往前看多久
const TICK_MS = 120;         // 排程器多久跑一次
const RELEASE = 0.25;        // 音符結束後的釋放時間，讓樂句聽起來連得起來

// 真實鋼琴取樣（assets/piano/，CC0，見 packaging/fetch_piano_samples.py）。
// 每 3 個半音一個取樣，播放時最多只需拉伸 ±1.5 半音，聽不出變調感。
const SAMPLE_DIR = 'assets/piano';

// 取樣載入失敗時的合成備援。加法合成怎麼調都只是「像鋼琴」，所以只當備胎。
const ATTACK = 0.004;        // 敲擊：起音必須極短，長一點就變成風琴
const N_PARTIALS = 12;
// 弦的非諧性係數。真實的鋼琴弦有張力，第 n 個泛音不在剛好 n 倍頻，而是
// 略高一點——少了這個，聽起來就是電子合成的正弦堆疊而不是弦。
const INHARMONICITY = 0.0004;

export class ChartPiano {
  /**
   * @param {AudioContext} ctx
   * @param {() => number|null} positionMs 目前的播放位置（毫秒）；沒在播就回 null
   */
  constructor(ctx, positionMs) {
    this.ctx = ctx;
    this.positionMs = positionMs;
    this.notes = [];
    this.enabled = false;
    this.timer = null;
    this.voices = new Set();
    this.samples = null;      // [{ midi, buffer }]，載入前為 null（會退回合成）
    this.loading = null;

    this.out = ctx.createGain();
    this.out.gain.value = 0.22;

    // 只在真正疊音時才作用的保險絲，不是音色的一部分。
    //
    // 門檻訂太低（-10dB）的話單音就會一直被壓住，鋼琴最重要的敲擊瞬間會被
    // 削平，聽起來就是軟軟的、慢半拍——那不是延遲，是 transient 被吃掉。
    // 現在把單音峰值壓在門檻以下，只有前後音延音疊在一起時才會介入。
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 3;
    this.limiter.ratio.value = 4;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.08;
    this.out.connect(this.limiter);
  }

  connect(dest) {
    this.limiter.connect(dest);
  }

  setNotes(notes) {
    this.notes = notes || [];
    // 譜換了（改了滑桿或加了段落修正），已排程的音就過時了
    this.reschedule();
  }

  setVolume(v) {
    this.out.gain.value = v;
  }

  setEnabled(on) {
    this.enabled = on;
    if (on) {
      this.loadSamples();   // 邊載邊彈：還沒好之前先用合成，載好自動換過去
      this.start();
    } else {
      this.stop();
    }
  }

  /** 載入鋼琴取樣。失敗就維持 null，play() 會自動退回合成。 */
  loadSamples() {
    if (this.samples || this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const res = await fetch(`${SAMPLE_DIR}/manifest.json`);
        if (!res.ok) throw new Error(`manifest ${res.status}`);
        const { midi } = await res.json();
        const loaded = await Promise.all(midi.map(async (m) => {
          const r = await fetch(`${SAMPLE_DIR}/${m}.flac`);
          if (!r.ok) throw new Error(`${m}.flac ${r.status}`);
          return { midi: m, buffer: await this.ctx.decodeAudioData(await r.arrayBuffer()) };
        }));
        loaded.sort((a, b) => a.midi - b.midi);
        this.samples = loaded;
      } catch (err) {
        console.warn('[piano] 取樣載入失敗，改用合成音色', err);
        this.samples = null;
      }
    })();
    return this.loading;
  }

  nearestSample(midi) {
    let best = this.samples[0];
    for (const s of this.samples) {
      if (Math.abs(s.midi - midi) < Math.abs(best.midi - midi)) best = s;
    }
    return best;
  }

  start() {
    if (this.timer) return;
    this.nextIndex = 0;
    this.syncIndex();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.killVoices();
  }

  /** 跳轉或改譜之後呼叫：丟掉正在響的音，重新對齊排程位置。 */
  reschedule() {
    if (!this.enabled) return;
    this.killVoices();
    this.syncIndex();
  }

  killVoices() {
    const now = this.ctx.currentTime;
    for (const v of this.voices) {
      try {
        v.gain.gain.cancelScheduledValues(now);
        v.gain.gain.setTargetAtTime(0, now, 0.02);
        v.stopAt(now + 0.1);
      } catch { /* 已經結束的音源會丟例外，忽略 */ }
    }
    this.voices.clear();
  }

  /** 把排程指標移到目前播放位置，避免跳轉後從頭補彈一大串音。 */
  syncIndex() {
    const pos = this.positionMs();
    if (pos === null) { this.nextIndex = 0; return; }
    let i = 0;
    while (i < this.notes.length && this.notes[i].startMs < pos) i++;
    this.nextIndex = i;
  }

  tick() {
    if (!this.enabled) return;
    const pos = this.positionMs();
    if (pos === null) return;

    // 播放位置往回跳（使用者拖了時間軸）時重新對齊
    if (this.lastPos !== undefined && (pos < this.lastPos - 200 || pos > this.lastPos + 2000)) {
      this.killVoices();
      this.syncIndex();
    }
    this.lastPos = pos;

    const until = pos + LOOKAHEAD_MS;
    while (this.nextIndex < this.notes.length && this.notes[this.nextIndex].startMs < until) {
      const note = this.notes[this.nextIndex++];
      // 排程時刻換算成 AudioContext 的時間軸
      const delay = (note.startMs - pos) / 1000;
      if (delay < -0.05) continue;   // 已經過去的音不補彈
      this.play(note, this.ctx.currentTime + Math.max(0, delay),
        (note.endMs - note.startMs) / 1000);
    }
  }

  play(note, at, dur) {
    if (this.samples && this.samples.length) this.playSample(note, at, dur);
    else this.playSynth(note, at, dur);
  }

  /** 真實鋼琴取樣：挑最近的音，用播放速率補足半音差。 */
  playSample(note, at, dur) {
    const ctx = this.ctx;
    const s = this.nearestSample(note.midi);

    const src = ctx.createBufferSource();
    src.buffer = s.buffer;
    src.playbackRate.value = 2 ** ((note.midi - s.midi) / 12);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(1, at);
    // 取樣本身已經帶著鋼琴的敲擊與自然衰減，這裡只做音符結束的釋放；
    // 放到音符結束後才收乾淨，樂句才不會一顆顆斷開。
    gain.gain.setValueAtTime(1, at + dur);
    gain.gain.setTargetAtTime(0.0001, at + dur, RELEASE / 3);

    src.connect(gain).connect(this.out);
    const stopAt = at + dur + RELEASE * 2;
    src.start(at);
    src.stop(stopAt);

    const voice = { gain, stopAt: (t) => { try { src.stop(t); } catch { /* 已停 */ } } };
    this.voices.add(voice);
    src.onended = () => { this.voices.delete(voice); gain.disconnect(); };
  }

  /** 備援：加法合成。取樣載不進來時才會走到這裡。 */
  playSynth(note, at, dur) {
    const ctx = this.ctx;
    const hz = midiToHz(note.midi);

    const bus = ctx.createGain();
    bus.gain.value = 1;
    bus.connect(this.out);

    // 基礎衰減時間：低音拖得久、高音散得快，這是鋼琴很明顯的特徵。
    // midi 48 約 3 秒，midi 84 約 0.9 秒。
    const tau0 = Math.max(0.6, 3.4 * 2 ** ((48 - note.midi) / 36));
    // 放到音符結束後才完全消失，樂句才連得起來；但不設持平段——一有持平
    // 就會聽成風琴。
    const tail = Math.min(dur + tau0 * 0.6, dur + 1.6);
    const stopAt = at + tail + 0.05;

    const oscs = [];
    for (let n = 1; n <= N_PARTIALS; n++) {
      // 非諧性：第 n 個泛音比 n 倍頻略高
      const f = hz * n * Math.sqrt(1 + INHARMONICITY * n * n);
      if (f > ctx.sampleRate / 2 - 1000) break;

      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;

      const g = ctx.createGain();
      // 高次泛音一開始就比較小，而且衰減得更快——這兩件事一起才像弦，
      // 只做其中一件會像電子琴。
      const amp = 0.9 / n ** 1.25;
      const tau = tau0 / (1 + 0.45 * (n - 1));
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(amp, at + ATTACK);
      // 指數衰減，中間沒有任何持平段
      g.gain.setTargetAtTime(0.0001, at + ATTACK, tau / 3);
      // 停止前快速收乾淨，避免截斷造成的喀聲
      g.gain.setTargetAtTime(0.00001, stopAt - 0.03, 0.008);

      osc.connect(g).connect(bus);
      osc.start(at);
      osc.stop(stopAt);
      oscs.push(osc);
    }

    // 榔頭敲擊聲：非常短的一撮噪音。少了它起音會太乾淨，聽起來不像被敲的弦。
    const noiseLen = Math.floor(ctx.sampleRate * 0.02);
    const nb = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < noiseLen; i++) {
      nd[i] = (Math.random() * 2 - 1) * (1 - i / noiseLen) ** 3;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = nb;
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = Math.min(hz * 4, 4000);
    nf.Q.value = 0.7;
    const ng = ctx.createGain();
    ng.gain.value = 0.09;
    noise.connect(nf).connect(ng).connect(bus);
    noise.start(at);

    const voice = {
      gain: bus,
      stopAt: (t) => {
        oscs.forEach((o) => { try { o.stop(t); } catch { /* 已停 */ } });
        try { noise.stop(t); } catch { /* 已停 */ }
      },
    };
    this.voices.add(voice);
    if (oscs.length) {
      oscs[0].onended = () => {
        this.voices.delete(voice);
        bus.disconnect();
      };
    }
  }
}
