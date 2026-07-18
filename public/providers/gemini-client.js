// Gemini 前端 client（独立模块）。只负责连到本项目后端的 /ws/gemini，
// 遵守 CONTRACT.md 的统一线路协议。不含任何 Gemini 上游细节（那在后端）。
export class GeminiClient {
  constructor(handlers) {
    this.h = handlers || {};
    this.ws = null;
  }

  get name() { return "gemini"; }

  connect(config = {}) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${proto}://${location.host}/ws/gemini`);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => this.ws.send(JSON.stringify({ type: "start", config }));
    this.ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        const m = JSON.parse(ev.data);
        switch (m.type) {
          case "ready": this.h.onReady?.(); break;
          case "text": this.h.onText?.(m.role, m.text, m.mode); break;
          case "tool_call": this.h.onToolCall?.(m.id, m.name); break;
          case "tool_activity": this.h.onToolActivity?.(m); break;
          case "interrupted": this.h.onInterrupted?.(); break;
          case "turn_end": this.h.onTurnEnd?.(); break;
          case "error": this.h.onError?.(m.message); break;
        }
      } else {
        this.h.onAudio?.(ev.data);
      }
    };
    this.ws.onerror = () => this.h.onError?.("与后端连接出错");
    this.ws.onclose = () => this.h.onClose?.();
  }

  sendAudio(arrayBuffer) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(arrayBuffer);
  }
  stopTurn() { this._json({ type: "stop" }); }
  sendToolResult(id, name, response) { this._json({ type: "tool_result", id, name, response }); }
  sendImage(mime, base64) { this._json({ type: "image", mime, data: base64 }); }

  _json(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  close() {
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
  }
}
