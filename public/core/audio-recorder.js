// 共用录音器：封装麦克风采集 + worklet，输出 16kHz PCM ArrayBuffer 回调。
// 与 provider 无关。
export class AudioRecorder {
  constructor(onChunk) {
    this.onChunk = onChunk; // (ArrayBuffer) => void
    this.stream = null;
    this.ctx = null;
    this.node = null;
    this.source = null;
  }

  get recording() {
    return !!this.node;
  }

  async start() {
    if (this.node) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule("core/pcm-recorder-worklet.js");
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "pcm-recorder");
    this.node.port.onmessage = (e) => {
      if (this.onChunk) this.onChunk(e.data); // ArrayBuffer(16-bit PCM 16k)
    };
    this.source.connect(this.node);
    // 不接 destination，避免自己听到自己
  }

  async stop() {
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.node = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
    }
  }
}
