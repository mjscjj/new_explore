// 豆包端到端实时语音 后端代理（独立模块，仅处理豆包）。
// 对上：与浏览器走 CONTRACT.md 的统一线路协议。
// 对下：连火山引擎实时对话 WebSocket（自定义二进制协议，见 protocol.js）。
import { WebSocket } from "ws";
import { build, decode, Event, MsgType } from "./protocol.js";

const ENDPOINT = "wss://openspeech.bytedance.com/api/v3/realtime/dialogue";
const RESOURCE_ID = "volc.speech.dialog";
const APP_KEY = "PlgvMymc7f3tQnJ6"; // 对话服务固定 app key

const DEFAULT_SYSTEM_ROLE = "你是一个友好的中文语音助手，回答自然、简洁、口语化。";
const DEFAULT_BOT_NAME = "小助手";
const DEFAULT_STYLE = "自然亲切、有活力";
const DEFAULT_LANGUAGE = "zh-CN";
const LANGUAGE_NAMES = {
  "zh-CN": "简体中文",
  "en-US": "英语",
  "ja-JP": "日语",
  "ko-KR": "韩语",
  "fr-FR": "法语",
  "de-DE": "德语",
  "es-ES": "西班牙语",
};

function buildSessionConfig(config = {}) {
  const language = config.language || DEFAULT_LANGUAGE;
  const languageName = LANGUAGE_NAMES[language] || language;
  // 关键：format 必须是 "pcm_s16le"（16-bit 有符号小端），与前端 Int16Array 播放一致。
  // 若用 "pcm" 豆包会返回 float32@48k，被当成 int16 播放就是“滋滋滋”噪音。
  const audioConfig = { channel: 1, format: "pcm_s16le", sample_rate: 24000 };
  // 语速/音量：-50~100，0=默认；仅 2.0 版本模型生效。非 0 才下发。
  if (config.doubaoSpeechRate) audioConfig.speech_rate = Number(config.doubaoSpeechRate);
  if (config.doubaoLoudness) audioConfig.loudness_rate = Number(config.doubaoLoudness);

  const tts = { audio_config: audioConfig };
  // 豆包音色：speaker 必须放在 tts 顶层（不是 audio_config 里），否则不生效
  if (config.voice) tts.speaker = config.voice;

  const dialog = {
    bot_name: config.doubaoBotName || DEFAULT_BOT_NAME,
    system_role:
      `${config.systemPrompt || DEFAULT_SYSTEM_ROLE}\n\n` +
      `始终使用${languageName}回复。执行翻译任务时，必须将${languageName}作为目标语言。`,
    speaking_style: config.doubaoStyle || DEFAULT_STYLE,
  };
  // 唱歌能力 enable_music：放在 dialog.extra，仅 O2.0(1.2.1.1) 生效。开启才下发。
  // 注意：不默认下发 input_mod:"keep_alive"——它会影响服务端全双工打断判定，导致打不断。
  if (config.doubaoSing) dialog.extra = { enable_music: true };

  return { dialog, tts };
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
  let modelSpeaking = false; // 模型当前是否在回复（用于打断判定）
  let interruptedThisTurn = false; // 本轮是否已上报过打断，避免重复

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

      case Event.ASRInfo:
      case Event.ASRResponse: {
        const j = parseJson(f.payload);
        // 打断判定：服务端明确标记 is_duplex_interrupted，或模型正在说话时用户又开口
        const duplexInterrupted = j?.is_duplex_interrupted === true;
        const text = j?.results?.[0]?.text ?? j?.text;
        if ((duplexInterrupted || (modelSpeaking && text)) && !interruptedThisTurn) {
          interruptedThisTurn = true;
          modelSpeaking = false;
          sendJson(clientWs, { type: "interrupted" }); // 前端据此立即清空已缓冲音频
        }
        // 用户识别文字（覆盖式）：只在文本变化时上报最新全量
        if (f.event === Event.ASRResponse && text && text !== lastAsr) {
          lastAsr = text;
          sendJson(clientWs, { type: "text", role: "user", text, mode: "replace" });
        }
        break;
      }

      case Event.TTSSentenceStart:
        // 模型开始说一句：进入“说话中”，允许下一次用户开口触发打断
        modelSpeaking = true;
        interruptedThisTurn = false;
        break;

      case Event.ChatResponse: {
        // 助手回复文字（增量追加）
        modelSpeaking = true;
        const j = parseJson(f.payload);
        if (j?.content) sendJson(clientWs, { type: "text", role: "assistant", text: j.content, mode: "append" });
        break;
      }

      case Event.TTSResponse:
        // 回复音频（24k PCM）
        modelSpeaking = true;
        if (f.payload && f.payload.length > 0 && clientWs.readyState === clientWs.OPEN) {
          clientWs.send(f.payload);
        }
        break;

      case Event.TTSEnded:
        modelSpeaking = false;
        break;

      case Event.ChatEnded:
        modelSpeaking = false;
        interruptedThisTurn = false;
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
