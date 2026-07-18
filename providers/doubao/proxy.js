// 豆包端到端实时语音 后端代理（独立模块，仅处理豆包）。
// 对上：与浏览器走 CONTRACT.md 的统一线路协议。
// 对下：连火山引擎实时对话 WebSocket（自定义二进制协议，见 protocol.js）。
import { WebSocket } from "ws";
import { build, decode, Event, MsgType } from "./protocol.js";

const ENDPOINT = "wss://openspeech.bytedance.com/api/v3/realtime/dialogue";
const RESOURCE_ID = "volc.speech.dialog";
const APP_KEY = "PlgvMymc7f3tQnJ6"; // 对话服务固定 app key

const DEFAULT_SYSTEM_ROLE = "你是一个友好的中文语音助手，回答自然、简洁、口语化。";

function buildSessionConfig(config = {}) {
  const tts = { audio_config: { channel: 1, format: "pcm", sample_rate: 24000 } };
  // 豆包音色：config.voice 若提供则作为 speaker
  if (config.voice) tts.audio_config.speaker = config.voice;
  return {
    dialog: {
      bot_name: "小助手",
      system_role: config.systemPrompt || DEFAULT_SYSTEM_ROLE,
      speaking_style: "自然亲切、有活力",
    },
    tts,
  };
}

export function handleDoubaoConnection(clientWs) {
  const appId = process.env.DOUBAO_APP_ID;
  const accessToken = process.env.DOUBAO_ACCESS_TOKEN;
  if (!appId || !accessToken) {
    sendJson(clientWs, { type: "error", message: "缺少 DOUBAO_APP_ID / DOUBAO_ACCESS_TOKEN" });
    clientWs.close();
    return;
  }

  const sessionId = "sess-" + Math.random().toString(36).slice(2);
  const upstream = new WebSocket(ENDPOINT, {
    headers: {
      "X-Api-App-ID": appId,
      "X-Api-App-Key": APP_KEY,
      "X-Api-Access-Key": accessToken,
      "X-Api-Resource-Id": RESOURCE_ID,
      "X-Api-Connect-Id": "conn-" + Math.random().toString(36).slice(2),
    },
  });

  let clientReady = false;
  let lastAsr = ""; // 451 是覆盖式，去重只在变化时上报
  let sessionConfig = null; // 来自浏览器 start 的 config
  let connectionStarted = false;

  // 拿到 ConnectionStarted 且拿到浏览器 config 后，才发 StartSession
  function maybeStartSession() {
    if (connectionStarted && sessionConfig && !clientReady) {
      upstream.send(build.startSession(sessionId, buildSessionConfig(sessionConfig)));
    }
  }

  upstream.on("open", () => upstream.send(build.startConnection()));

  upstream.on("message", (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const f = decode(buf);

    // 错误优先
    if (f.msgType === MsgType.ERROR) {
      const desc = safeText(f.payload);
      sendJson(clientWs, { type: "error", message: `豆包错误 ${f.errorCode}: ${desc}` });
      return;
    }

    switch (f.event) {
      case Event.ConnectionStarted:
        connectionStarted = true;
        maybeStartSession();
        break;

      case Event.ConnectionFailed:
        sendJson(clientWs, { type: "error", message: "豆包连接失败: " + safeText(f.payload) });
        break;

      case Event.SessionStarted:
        clientReady = true;
        sendJson(clientWs, { type: "ready" });
        break;

      case Event.SessionFailed:
        sendJson(clientWs, { type: "error", message: "豆包会话失败: " + safeText(f.payload) });
        break;

      case Event.ASRResponse: {
        // 用户识别文字（覆盖式）：只在文本变化时上报最新全量
        const j = parseJson(f.payload);
        const text = j?.results?.[0]?.text ?? j?.text;
        if (text && text !== lastAsr) {
          lastAsr = text;
          sendJson(clientWs, { type: "text", role: "user", text, mode: "replace" });
        }
        break;
      }

      case Event.ChatResponse: {
        // 助手回复文字（增量追加）
        const j = parseJson(f.payload);
        if (j?.content) sendJson(clientWs, { type: "text", role: "assistant", text: j.content, mode: "append" });
        break;
      }

      case Event.TTSResponse:
        // 回复音频（24k PCM）
        if (f.payload && f.payload.length > 0 && clientWs.readyState === clientWs.OPEN) {
          clientWs.send(f.payload);
        }
        break;

      case Event.ChatEnded:
        lastAsr = ""; // 下一轮重新累积
        sendJson(clientWs, { type: "turn_end" });
        break;

      case Event.SessionFinished:
        if (clientWs.readyState === clientWs.OPEN) clientWs.close();
        break;
    }
  });

  upstream.on("error", (e) => sendJson(clientWs, { type: "error", message: "豆包上游错误: " + e.message }));
  upstream.on("close", () => {
    if (clientWs.readyState === clientWs.OPEN) clientWs.close();
  });

  // 浏览器 → 我们 → 豆包
  clientWs.on("message", (data, isBinary) => {
    if (isBinary) {
      if (!clientReady) return;
      upstream.send(build.audio(sessionId, Buffer.from(data)));
      return;
    }
    let m;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (m.type === "start") {
      sessionConfig = m.config || {};
      maybeStartSession();
    } else if (m.type === "stop") {
      if (clientReady) upstream.send(build.finishSession(sessionId));
    }
    // 豆包不支持 tool_call/image（无视觉工具），忽略
  });

  clientWs.on("close", () => {
    if (upstream.readyState === upstream.OPEN) {
      try {
        upstream.send(build.finishSession(sessionId));
      } catch (_) {}
      upstream.close();
    } else if (upstream.readyState === upstream.CONNECTING) {
      upstream.close();
    }
  });
}

function parseJson(buf) {
  if (!buf) return null;
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
}
function safeText(buf) {
  return buf ? buf.toString("utf8").slice(0, 200) : "";
}
function sendJson(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
