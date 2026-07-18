// Gemini Live 后端代理（独立模块，仅处理 Gemini）。
// 对上：与浏览器走 CONTRACT.md 的统一线路协议。
// 对下：连 Google Gemini Live WebSocket（JSON 帧，音频 base64）。
import { WebSocket } from "ws";

const GEMINI_WS =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const DEFAULT_PROMPT =
  "你是一个友好的中文语音助手。请用自然、口语化的中文回答，简洁一些，适合语音播报。";

const CAMERA_TOOL = {
  functionDeclarations: [
    {
      name: "capture_camera",
      description:
        "拍摄用户当前摄像头的一张照片。当你需要看到用户本人、用户展示的物体、或用户周围环境才能回答问题时，调用这个工具。例如用户问『你看我手里拿的是什么』『我穿的什么颜色』『帮我看看这个』时。",
      parameters: { type: "object", properties: {}, required: [] },
    },
  ],
};

export function handleGeminiConnection(clientWs) {
  const apiKey = process.env.GEMINI_API_KEY;
  const defaultModel = process.env.GEMINI_LIVE_MODEL || "models/gemini-3.1-flash-live-preview";

  if (!apiKey) {
    sendJson(clientWs, { type: "error", message: "缺少 GEMINI_API_KEY" });
    clientWs.close();
    return;
  }

  let upstream = null;
  let upstreamReady = false;

  // 等浏览器发来 start（带 config）后再连上游，这样能应用用户设置
  clientWs.on("message", (data, isBinary) => {
    if (isBinary) {
      if (!upstreamReady) return;
      const b64 = Buffer.from(data).toString("base64");
      upstream.send(
        JSON.stringify({ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: b64 } } })
      );
      return;
    }

    let m;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (m.type === "start") {
      startUpstream(m.config || {});
      return;
    }
    if (!upstreamReady) return;

    if (m.type === "stop") {
      upstream.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    } else if (m.type === "tool_result") {
      upstream.send(
        JSON.stringify({
          toolResponse: {
            functionResponses: [{ id: m.id, name: m.name, response: m.response || {} }],
          },
        })
      );
    } else if (m.type === "image") {
      // 把一帧图像作为一轮 user 内容发给模型（摄像头视觉）
      upstream.send(
        JSON.stringify({
          clientContent: {
            turns: [{ role: "user", parts: [{ inlineData: { mimeType: m.mime || "image/jpeg", data: m.data } }] }],
            turnComplete: true,
          },
        })
      );
    }
  });

  function startUpstream(config) {
    const model = config.model || defaultModel;
    const generationConfig = { responseModalities: ["AUDIO"] };
    if (config.temperature != null) generationConfig.temperature = Number(config.temperature);
    if (config.voice) {
      generationConfig.speechConfig = {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice } },
      };
    }

    const setup = {
      model,
      generationConfig,
      systemInstruction: { parts: [{ text: config.systemPrompt || DEFAULT_PROMPT }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };
    if (config.camera) setup.tools = [CAMERA_TOOL];
    if (config.vad) {
      setup.realtimeInputConfig = {
        automaticActivityDetection: { startOfSpeechSensitivity: `START_SENSITIVITY_${config.vad}` },
      };
    }

    upstream = new WebSocket(`${GEMINI_WS}?key=${apiKey}`);
    upstream.on("open", () => upstream.send(JSON.stringify({ setup })));

    upstream.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg.setupComplete) {
        upstreamReady = true;
        sendJson(clientWs, { type: "ready" });
        return;
      }

      if (msg.toolCall) {
        for (const call of msg.toolCall.functionCalls || []) {
          sendJson(clientWs, { type: "tool_call", id: call.id, name: call.name });
        }
        return;
      }
      if (msg.toolCallCancellation) return;

      const sc = msg.serverContent;
      if (sc) {
        if (sc.interrupted) sendJson(clientWs, { type: "interrupted" });
        if (sc.inputTranscription?.text)
          sendJson(clientWs, { type: "text", role: "user", text: sc.inputTranscription.text, mode: "append" });
        if (sc.outputTranscription?.text)
          sendJson(clientWs, { type: "text", role: "assistant", text: sc.outputTranscription.text, mode: "append" });
        for (const p of sc.modelTurn?.parts || []) {
          if (p.inlineData?.data) {
            const buf = Buffer.from(p.inlineData.data, "base64");
            if (clientWs.readyState === clientWs.OPEN) clientWs.send(buf);
          }
        }
        if (sc.turnComplete) sendJson(clientWs, { type: "turn_end" });
      }
    });

    upstream.on("error", (e) => sendJson(clientWs, { type: "error", message: "Gemini 上游错误: " + e.message }));
    upstream.on("close", (code, reason) => {
      if (clientWs.readyState === clientWs.OPEN) {
        sendJson(clientWs, { type: "error", message: `Gemini 连接关闭 ${code} ${reason.toString().slice(0, 120)}` });
        clientWs.close();
      }
    });
  }

  clientWs.on("close", () => {
    if (upstream && (upstream.readyState === upstream.OPEN || upstream.readyState === upstream.CONNECTING)) {
      upstream.close();
    }
  });
}

function sendJson(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
