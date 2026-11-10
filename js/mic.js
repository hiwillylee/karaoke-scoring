// mic.js — 麥克風擷取與即時音高偵測。
//
// PCM 由 AudioWorklet 搬到主執行緒，降到 16kHz 後跑 YIN（與後端 pyin 相同
// 的 64ms 分析窗），如此顫音等快速音高變化不會被長分析窗平均掉。

import { Yin, resample, hzToMidi, rms, PitchSmoother } from './dsp.js';

export const MIC_SR = 16000;
export const MIC_FRAME = 1024;   // 64ms 分析窗
// 每收到一塊 PCM（512 樣本 ≈ 11.6ms）就偵測一次，確保取樣密度
// 高於參考譜的 16ms 音框間距。
export const DETECT_INTERVAL_MS = 10;

// AudioWorklet 模組是掛在個別 AudioContext 上的，因此要逐 context 記錄，
// 否則換一個 context 會誤以為已載入。
const micWorkletReady = new WeakMap();

/**
 * 取得麥克風串流。三個瀏覽器預設的語音處理都必須關閉，
 * 否則會改變音高與音量，評分基準就不對了。
 */
export async function openMicStream(deviceId = null) {
  const audio = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return navigator.mediaDevices.getUserMedia({ audio });
}

export async function listDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return {
    inputs: devices.filter((d) => d.kind === 'audioinput'),
    outputs: devices.filter((d) => d.kind === 'audiooutput'),
  };
}

export class MicTracker {
  /**
   * @param {AudioContext} audioCtx
   * @param {object} opts  { silenceRms, onFrame(frame), onRaw(chunk), refMidiAt(t) }
   *   refMidiAt 傳入音框的 AudioContext 時間（秒），回傳參考譜當下的音，
   *   用來輔助判斷八度；0 表示這一刻沒有可信的參考。譜面的查詢牽涉到歌曲
   *   時間與延遲補償，那是呼叫端的事，所以用 callback 注入而不是把整份譜
   *   交給 MicTracker。
   */
  constructor(audioCtx, opts = {}) {
    this.ctx = audioCtx;
    this.silenceRms = opts.silenceRms ?? 0.008;
    this.onFrame = opts.onFrame || null;
    this.onRaw = opts.onRaw || null;
    this.refMidiAt = opts.refMidiAt || null;

    this.stream = null;
    this.source = null;
    this.node = null;
    this.yin = new Yin(MIC_SR, MIC_FRAME, 0.15);
    // 即時路徑沒有整段資料可做中值濾波，改用遲滯式平滑擋掉八度誤判
    this.smoother = new PitchSmoother();
    this.minConfidence = opts.minConfidence ?? 0.75;

    // 以原始取樣率保存最近一段訊號
    this.ringSize = Math.ceil(audioCtx.sampleRate * 0.3);
    this.ring = new Float32Array(this.ringSize);
    this.ringPos = 0;
    this.ringEndTime = 0;
    this.lastDetect = 0;
    this.running = false;
    this.recording = null;
    // 偵測用的暫存陣列只配置一次（以前每 10ms 配置三個新陣列，手機上會
    // 頻繁觸發垃圾回收、造成畫面頓一下）
    this.winBuf = null;
    this.downBuf = new Float32Array(MIC_FRAME + 8);
    this.level = 0;   // 最近一次的音量（設定頁的音量表用）
  }

  async start(deviceId = null) {
    this.stream = await openMicStream(deviceId);
    if (!micWorkletReady.has(this.ctx)) {
      micWorkletReady.set(this.ctx,
        this.ctx.audioWorklet.addModule(new URL('./mic-worklet.js', import.meta.url)));
    }
    await micWorkletReady.get(this.ctx);

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'mic-capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
    });
    this.source.connect(this.node);
    this.node.port.onmessage = (e) => this.handleChunk(e.data);
    this.running = true;
    this.onEnded = null;

    const track = this.stream.getAudioTracks()[0];
    this.deviceLabel = track ? track.label || '預設麥克風' : '未知麥克風';
    this.deviceId = track ? track.getSettings().deviceId : null;
    // 拔掉耳機麥克風、藍牙斷線時軌道會結束，通知外面暫停演唱
    if (track) track.addEventListener('ended', () => this.onEnded?.());
  }

  stop() {
    this.running = false;
    if (this.node) { this.node.port.onmessage = null; this.node.disconnect(); this.node = null; }
    if (this.source) { this.source.disconnect(); this.source = null; }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
  }

  /** 開始／結束錄下原始 PCM（校準用）。 */
  startRecording() {
    this.recording = { chunks: [], startTime: this.ctx.currentTime };
  }

  stopRecording() {
    const rec = this.recording;
    this.recording = null;
    if (!rec || !rec.chunks.length) return null;
    const total = rec.chunks.reduce((n, c) => n + c.pcm.length, 0);
    const pcm = new Float32Array(total);
    let off = 0;
    for (const c of rec.chunks) { pcm.set(c.pcm, off); off += c.pcm.length; }
    return {
      pcm,
      sampleRate: this.ctx.sampleRate,
      // 第一個樣本對應的 AudioContext 時間
      startTime: rec.chunks[0].endTime - rec.chunks[0].pcm.length / this.ctx.sampleRate,
    };
  }

  handleChunk({ pcm, endTime }) {
    if (!this.running) return;
    // worklet 送來的是轉移過來的 ArrayBuffer，直接包一層視圖就好，不必複製
    const data = pcm instanceof Float32Array ? pcm : new Float32Array(pcm);

    if (this.recording) this.recording.chunks.push({ pcm: data, endTime });
    if (this.onRaw) this.onRaw(data, endTime);

    for (let i = 0; i < data.length; i++) {
      this.ring[this.ringPos] = data[i];
      this.ringPos = (this.ringPos + 1) % this.ringSize;
    }
    this.ringEndTime = endTime;

    const nowMs = endTime * 1000;
    if (nowMs - this.lastDetect < DETECT_INTERVAL_MS) return;
    this.lastDetect = nowMs;
    const frame = this.detect(endTime);
    if (frame && this.onFrame) this.onFrame(frame);
  }

  /** 對環形緩衝最新的 64ms 做一次音高偵測。 */
  detect(endTime) {
    const srcRate = this.ctx.sampleRate;
    const need = Math.ceil((MIC_FRAME / MIC_SR) * srcRate);
    if (need > this.ringSize) return null;

    if (!this.winBuf || this.winBuf.length !== need) this.winBuf = new Float32Array(need);
    const win = this.winBuf;
    let idx = (this.ringPos - need + this.ringSize) % this.ringSize;
    for (let i = 0; i < need; i++) {
      win[i] = this.ring[idx];
      idx = (idx + 1) % this.ringSize;
    }

    // 音高代表的是這段窗的中點時間
    const t = endTime - (MIC_FRAME / MIC_SR) / 2;

    const level = rms(win);
    this.level = level;
    if (level < this.silenceRms) {
      this.smoother.push(0, t * 1000);
      return { t, midi: 0, conf: 0, rms: level, raw: 0, ref: 0 };
    }

    const down = resample(win, srcRate, MIC_SR, this.downBuf);
    const { hz, confidence } = this.yin.detect(down.subarray(0, MIC_FRAME));

    // 信心不足的偵測不該進入平滑器，否則會污染近期音高的參考值
    if (hz <= 0 || confidence < this.minConfidence) {
      return { t, midi: 0, conf: confidence, rms: level, raw: hz > 0 ? hzToMidi(hz) : 0, ref: 0 };
    }

    // 參考譜只參與「哪個八度」的判斷，音分完全由 YIN 的結果決定
    const tMs = t * 1000;
    const refMidi = this.refMidiAt
      ? this.refMidiAt(t, this.smoother.isPhraseStart(tMs))
      : 0;
    const raw = hzToMidi(hz);
    const midi = this.smoother.push(raw, tMs, confidence, refMidi);
    // raw／ref 只給診斷用：raw 是平滑前的原始偵測，ref 是當下採用的參考音。
    // 八度出問題時，光看 midi 分不出是 YIN 抓錯還是平滑器判錯。
    return { t, midi, conf: midi ? confidence : 0, rms: level, raw, ref: refMidi };
  }
}
