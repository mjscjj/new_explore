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
    // 抖动缓冲：首块到达后先垫一段再排播，用来吸收跨境网络抖动，避免块晚到时断续。
    // 代价是首字多等 ~jitterBufferSec。听感断续时调大，觉得延迟高时调小。
    this.jitterBufferSec = 0.15;
    this._underruns = 0; // 统计：排播时发现已“饿死”（nextTime 落后于当前时间）的次数
  }

  _ensureCtx() {
    if (!this.ctx) {
      // 不指定 sampleRate，交给硬件；Web Audio 会在播放时把 24k buffer 重采样到硬件率
      this.ctx = new AudioContext();
      // 首块起播前先垫一段抖动缓冲，让后续晚到的块有时间赶上
      this.nextTime = this.ctx.currentTime + this.jitterBufferSec;
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
    // nextTime 落后于当前时间 = 缓冲被耗尽（块晚到，饿死）。
    // 此时不立即硬接（会断续），而是重新垫回抖动缓冲，给后续块留出赶上的余量。
    if (this.nextTime < now) {
      this._underruns++;
      this.nextTime = now + this.jitterBufferSec;
    }
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
    // 打断后下一轮回复重新垫抖动缓冲
    if (this.ctx) this.nextTime = this.ctx.currentTime + this.jitterBufferSec;
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
