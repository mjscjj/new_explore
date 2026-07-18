# Provider 统一接口契约

目标：豆包 / Gemini（以及未来的 GPT Realtime 等）彻底隔离，各自独立实现，
前端 UI 与音频底座完全不感知底层是哪家。新增 provider 只需加一个后端代理 +
一个前端 client，不改动其他任何代码。

## 架构

```
浏览器 UI (app.js)
  ├─ core/audio-recorder.js   录音 → 16kHz PCM（共用，与 provider 无关）
  ├─ core/audio-player.js     24kHz PCM 流式播放（共用，与 provider 无关）
  └─ providers/<name>-client.js  仅负责“连到本项目后端的 /ws/<name>”，遵守下方线路协议

本项目后端 (server.js)
  └─ providers/<name>/proxy.js  一个 provider 一个目录，互不引用
        └─ 对上：与浏览器走【统一线路协议】
        └─ 对下：各自对接真实上游（豆包二进制 WS / Gemini JSON WS）
```

## 浏览器 ⇄ 本项目后端 的统一线路协议

同一个 WebSocket 连接，混合传输 JSON 控制帧（文本）和音频（二进制）。

### 浏览器 → 后端

| 消息 | 形式 | 说明 |
|---|---|---|
| 开始会话 | JSON `{ "type": "start", "config": {...} }` | 连接后第一帧，config 由具体 provider 解释（见下「config 字段」） |
| 音频数据 | 二进制 ArrayBuffer | 16kHz / 16-bit / 单声道 / little-endian PCM |
| 结束发言 | JSON `{ "type": "stop" }` | 可选，表示用户主动结束一轮 |
| 工具结果 | JSON `{ "type": "tool_result", "id": "...", "name": "...", "response": {...} }` | 回应后端下发的 `tool_call`（如摄像头截图结果） |
| 图像输入 | JSON `{ "type": "image", "mime": "image/jpeg", "data": "<base64>" }` | 把一帧图像作为用户内容发给模型（摄像头视觉用） |

#### config 字段（provider 各取所需，不认识的忽略）

| 字段 | 适用 | 说明 |
|---|---|---|
| `voice` | gemini/doubao | 音色名（各家取值不同，空=默认） |
| `systemPrompt` | gemini/doubao | 人设 / 系统提示 |
| `model` | gemini | 模型 id |
| `temperature` | gemini | 采样温度 |
| `vad` | gemini | 打断灵敏度 `LOW`/``/`HIGH` |
| `camera` | gemini | 是否开启摄像头视觉工具（function calling） |

### 后端 → 浏览器

| 消息 | 形式 | 说明 |
|---|---|---|
| 就绪 | JSON `{ "type": "ready" }` | 上游握手完成、可以开始说话 |
| 文本 | JSON `{ "type": "text", "role": "user"\|"assistant", "text": "...", "mode": "append"\|"replace" }` | 识别结果 / 回复字幕。`replace`=覆盖当前气泡（ASR 全量），`append`=追加（流式增量） |
| 音频 | 二进制 ArrayBuffer | 24kHz / 16-bit / 单声道 / little-endian PCM，回复语音 |
| 打断 | JSON `{ "type": "interrupted" }` | 用户打断，前端应停止当前播放 |
| 一轮结束 | JSON `{ "type": "turn_end" }` | 助手本轮说完 |
| 工具调用 | JSON `{ "type": "tool_call", "id": "...", "name": "capture_camera" }` | 模型自主发起的工具调用，前端执行后用 `tool_result`(+`image`) 回应 |
| 错误 | JSON `{ "type": "error", "message": "..." }` | fail-fast：直接透传，不静默降级 |

## 约定

- 音频统一：上行 16kHz、下行 24kHz、16-bit PCM 单声道。provider 内部若需要别的
  采样率/格式，自己在 proxy 里转换，不把差异泄漏给前端。
- fail-fast：上游报错一律用 `{type:"error"}` 透传，不做兜底降级。
- 隔离：`providers/gemini/*` 与 `providers/doubao/*` 不得互相 import。
```
