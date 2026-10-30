// mic-worklet.js — 只負責把麥克風 PCM 搬到主執行緒，附上精確時間戳。
// 音高偵測放在主執行緒做，避免拖慢音訊執行緒造成爆音。

const CHUNK = 512;

class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(CHUNK);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];

    for (let i = 0; i < ch.length; i++) {
      this.buf[this.filled++] = ch[i];
      if (this.filled === CHUNK) {
        const copy = this.buf.slice();
        // 這一塊最後一個樣本對應的 AudioContext 時間
        this.port.postMessage(
          { pcm: copy.buffer, endTime: currentTime + (i - ch.length + 1) / sampleRate },
          [copy.buffer]
        );
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('mic-capture-processor', MicCaptureProcessor);
