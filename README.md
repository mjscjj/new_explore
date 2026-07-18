# 实时语音对话 · 豆包 / Gemini

一个可切换 **豆包端到端实时语音** 与 **Gemini Live** 的浏览器语音对话应用。
说话即可，机器人实时用语音回你，支持随时打断。

两家 provider **彻底隔离、各自独立模块**，新增 provider（如 GPT Realtime）只需
加一个后端代理 + 一个前端 client，不改动其他任何代码。

## 效果

- 🎙️ 端到端实时语音：录音 → 识别 → 回复文字 → 回复语音，全程流式
- 🔀 一键切换豆包 / Gemini
- ✂️ 支持打断（barge-in）
- 📝 实时字幕（用户说的话 + 助手回复）
- ⚙️ 设置面板：人设/系统提示（两家）、音色/模型/temperature/打断灵敏度（Gemini）
- 📷 摄像头视觉（Gemini）：由模型自主决定何时"看"摄像头（function calling），
  截图缩放压缩后回传给模型，转写区显示它看到的画面

## 架构

```
浏览器 UI (public/app.js)
  ├─ core/audio-recorder.js      录音 → 16kHz PCM（共用，与 provider 无关）
  ├─ core/audio-player.js        24kHz PCM 流式播放（共用，与 provider 无关）
  ├─ core/pcm-recorder-worklet.js  重采样 worklet（共用）
  └─ providers/
       ├─ gemini-client.js       连 /ws/gemini（独立）
       └─ doubao-client.js       连 /ws/doubao（独立）

后端 (server.js) —— 极简：静态服务 + 按路径挂载各 provider WS 代理
  └─ providers/
       ├─ gemini/proxy.js        Gemini Live 代理（JSON 帧，独立）
       └─ doubao/
            ├─ proxy.js          豆包代理（独立）
            └─ protocol.js       豆包二进制协议编解码（独立）
```

**隔离原则**：`providers/gemini/*` 与 `providers/doubao/*` 互不 import。
前端 UI 与音频底座完全不感知底层是哪家。

统一线路协议见 [`providers/CONTRACT.md`](providers/CONTRACT.md)。

## 为什么要后端代理

- **豆包**：使用火山引擎自定义 WebSocket 二进制协议，且鉴权走 HTTP header。
  浏览器 WebSocket 无法自定义 header，必须由后端代理并做协议转换。
- **Gemini**：走后端代理可避免 API Key 暴露到浏览器。
- 后端统一把两家转成同一套「浏览器 ⇄ 后端」线路协议，前端只认这一套。

## 音频规格（统一）

- 上行（麦克风）：16kHz / 16-bit / 单声道 / PCM
- 下行（回复）：24kHz / 16-bit / 单声道 / PCM

provider 内部若需别的格式，各自在 proxy 里转换，不泄漏差异给前端。

## 快速开始

```bash
npm install
cp .env.example .env   # 填入各家凭证
npm start
```

浏览器打开 http://localhost:8787 ，点「开始通话」，授权麦克风即可说话。

> ⚠️ 浏览器麦克风需要安全上下文。localhost 允许；若换 IP/域名访问需 HTTPS。

## 环境变量（.env）

```
PORT=8787

# Gemini Live (Google)
GEMINI_API_KEY=...
GEMINI_LIVE_MODEL=models/gemini-3.1-flash-live-preview

# 豆包端到端实时语音（火山引擎 · 语音服务 AppID + Access Token）
DOUBAO_APP_ID=...
DOUBAO_ACCESS_TOKEN=...
DOUBAO_SECRET_KEY=...
```

- Gemini 有 **地区限制**：某些 IP 会返回 `User location is not supported`。
- 豆包用的是**火山引擎「语音技术」控制台的 AppID + Access Token**（对话服务），
  不是 Ark 大模型的 api-key。

## 如何新增一个 provider

1. 后端：新建 `providers/<name>/proxy.js`，导出 `handle<Name>Connection(clientWs)`，
   对上遵守 `CONTRACT.md`，对下对接你的上游。
2. 前端：新建 `public/providers/<name>-client.js`，与现有 client 同接口。
3. `server.js` 路由表加一行；`public/app.js` 的 `PROVIDERS` 注册表加一行。

不需要改动其他任何 provider 的代码。
```
