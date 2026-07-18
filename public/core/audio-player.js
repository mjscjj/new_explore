// 共用流式播放器：接收 24kHz 16-bit PCM 分片，按时间轴无缝排队播放。
// 支持打断（barge-in）时立即清空。与 provider 无关。
//
// 关键：AudioContext 用硬件原生采样率（不强制 24000），每个 AudioBuffer 用「源
// 采样率 srcRate=24000」创建，由 Web Audio 自动重采样到硬件率。这样即使浏览器
// 不接受 24000 的 context（会静默回退到 48000），也不会出现 2 倍速的“滋滋滋”噪音。
export class AudioPlayer {
  constructor(srcRate = 24000) {
    this.srcRate = srcRate; // 上游 PCM 的真实采样率（用于给 AudioBuffer 打标签）
    this.ctx = null;
    this.nextTime = 0;
    this.sources = new Set();
    this.onStateChange = null; // (playing:boolean) => void
    this._playing = false;
  }

  _ensureCtx() {
    if (!this.ctx) {
      // 不指定 sampleRate，交给硬件；Web Audio 会在播放时把 24k buffer 重采样到硬件率
      this.ctx = new AudioContext();
      this.nextTime = this.ctx.currentTime;
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  }

  _setPlaying(v) {
    if (this._playing !== v) {
      this._playing = v;
      if (this.onStateChange) this.onStateChange(v);
    }
  }

  // 输入 ArrayBuffer（16-bit PCM, srcRate, mono, little-endian）
  enqueue(arrayBuffer) {
    this._ensureCtx();
    // WebSocket 分片不保证按 2 字节对齐边界切分；只取偶数字节，避免半个采样导致噪音
    const usableBytes = arrayBuffer.byteLength - (arrayBuffer.byteLength % 2);
    if (usableBytes <= 0) return;
    const int16 = new Int16Array(arrayBuffer, 0, usableBytes / 2);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

    // 用源采样率创建 buffer，Web Audio 播放时自动重采样到 ctx.sampleRate
    const buffer = this.ctx.createBuffer(1, float32.length, this.srcRate);
    buffer.copyToChannel(float32, 0);

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);

    const now = this.ctx.currentTime;
    if (this.nextTime < now) this.nextTime = now;
    src.start(this.nextTime);
    this.nextTime += buffer.duration;

    this.sources.add(src);
    this._setPlaying(true);
    src.onended = () => {
      this.sources.delete(src);
      if (this.sources.size === 0) this._setPlaying(false);
    };
  }

  // 打断：立即停止并清空所有已排队音频
  clear() {
    for (const src of this.sources) {
      try {
        src.onended = null;
        src.stop();
      } catch (_) {}
    }
    this.sources.clear();
    if (this.ctx) this.nextTime = this.ctx.currentTime;
    this._setPlaying(false);
  }

  async close() {
    this.clear();
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
    }
  }
}
