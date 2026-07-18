// 共用录音 worklet：麦克风 → 16kHz 单声道 16-bit PCM，postMessage 回主线程。
// 与具体 provider 无关。上行统一 16kHz（见 CONTRACT.md）。
class PCMRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.inputRate = sampleRate; // 硬件采样率（全局）
    this._buffer = [];
    this._chunkSamples = Math.round(this.targetRate * 0.1); // ~100ms 一包
  }

  _downsample(input) {
    if (this.inputRate === this.targetRate) return input;
    const ratio = this.inputRate / this.targetRate;
    const outLen = Math.floor(input.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = input[idx] || 0;
      const b = input[idx + 1] || a;
      out[i] = a + (b - a) * frac;
    }
    return out;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;

    const down = this._downsample(channel);
    for (let i = 0; i < down.length; i++) this._buffer.push(down[i]);

    while (this._buffer.length >= this._chunkSamples) {
      const slice = this._buffer.splice(0, this._chunkSamples);
      const pcm = new Int16Array(slice.length);
      for (let i = 0; i < slice.length; i++) {
        const s = Math.max(-1, Math.min(1, slice[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor("pcm-recorder", PCMRecorderProcessor);
