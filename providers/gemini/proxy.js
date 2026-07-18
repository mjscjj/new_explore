// Gemini Live 后端代理（独立模块，仅处理 Gemini）。
// 对上：与浏览器走 CONTRACT.md 的统一线路协议。
// 对下：用官方 @google/genai SDK 的 Live API（ai.live.connect）连 Gemini。
import { GoogleGenAI, Modality } from "@google/genai";
import { RUN_CODEX_DECLARATION, runCodex } from "../tools/codex.js";

const DEFAULT_PROMPT =
  "你是一个友好的中文语音助手。请用自然、口语化的中文回答，简洁一些，适合语音播报。";

const CAMERA_DECLARATION = {
  name: "capture_camera",
  description:
    "拍摄用户当前摄像头的一张照片。当你需要看到用户本人、用户展示的物体、或用户周围环境才能回答问题时，调用这个工具。例如用户问『你看我手里拿的是什么』『我穿的什么颜色』『帮我看看这个』时。",
  parameters: { type: "object", properties: {}, required: [] },
};

// run_codex 是「后端自执行工具」：模型发起后由本进程直接跑 codex，不转发前端。
const BACKEND_TOOLS = { run_codex: runCodex };

export function handleGeminiConnection(clientWs) {
  const apiKey = process.env.GEMINI_API_KEY;
  const defaultModel = process.env.GEMINI_LIVE_MODEL || "models/gemini-3.1-flash-live-preview";

  if (!apiKey) {
    sendJson(clientWs, { type: "error", message: "缺少 GEMINI_API_KEY" });
    clientWs.close();
    return;
  }

  const ai = new GoogleGenAI({ apiKey });

  let session = null; // SDK Live session
  let upstreamReady = false;
  let turnAudioBytes = 0; // 本轮累计音频字节，用于检测“空音频（没声音）”
  let activeVoice = ""; // 记录当前音色，用于空音频报错文案
  let activeModel = defaultModel;

  // 等浏览器发来 start（带 config）后再连上游，这样能应用用户设置
  clientWs.on("message", (data, isBinary) => {
    if (isBinary) {
      if (!upstreamReady) return;
      session.sendRealtimeInput({
        audio: { data: Buffer.from(data).toString("base64"), mimeType: "audio/pcm;rate=16000" },
      });
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
      session.sendRealtimeInput({ audioStreamEnd: true });
    } else if (m.type === "tool_result") {
      session.sendToolResponse({
        functionResponses: [{ id: m.id, name: m.name, response: m.response || {} }],
      });
    } else if (m.type === "image") {
      // 把一帧图像作为一轮 user 内容发给模型（摄像头视觉）
      session.sendClientContent({
        turns: [{ role: "user", parts: [{ inlineData: { mimeType: m.mime || "image/jpeg", data: m.data } }] }],
        turnComplete: true,
      });
    }
  });

  async function startUpstream(config) {
    const model = config.model || defaultModel;
    activeModel = model;
    activeVoice = config.voice || "";

    // 目标模型：gemini-3.1-flash-live-preview（实时对话）/ gemini-3.5-live-translate（翻译），都是 3.x。
    // 各配置项对 3.1 的支持已实测：voice ✅ / languageCode ✅ / thinkingLevel ✅ / VAD ✅ /
    // 摄像头 function calling ✅；affectiveDialog / proactiveAudio ❌（3.1 不支持，坚决不下发）。
    // SDK 的 config 是「扁平」的：无 setup / generationConfig 包裹，各字段直接放顶层。
    const liveConfig = {
      responseModalities: [Modality.AUDIO],
      systemInstruction: { parts: [{ text: config.systemPrompt || DEFAULT_PROMPT }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };

    if (config.temperature != null) liveConfig.temperature = Number(config.temperature);

    // speechConfig：音色 + 语言。3.1 两者都接受，可同时下发。
    const speechConfig = {};
    if (config.voice) speechConfig.voiceConfig = { prebuiltVoiceConfig: { voiceName: config.voice } };
    if (config.language) speechConfig.languageCode = config.language;
    if (Object.keys(speechConfig).length) liveConfig.speechConfig = speechConfig;

    // 思考深度：3.x 用 thinkingLevel（minimal/low/medium/high），默认 minimal（最低延迟）。
    if (config.thinkingLevel) {
      liveConfig.thinkingConfig = { thinkingLevel: config.thinkingLevel };
    }

    // 工具集合：run_codex 常驻（后端自执行）；capture_camera 仅在开启摄像头时加入。
    const functionDeclarations = [RUN_CODEX_DECLARATION];
    if (config.camera) functionDeclarations.push(CAMERA_DECLARATION);
    liveConfig.tools = [{ functionDeclarations }];
    if (config.vad) {
      liveConfig.realtimeInputConfig = {
        automaticActivityDetection: { startOfSpeechSensitivity: `START_SENSITIVITY_${config.vad}` },
      };
    }

    try {
      // 注意：onopen 回调会在 ai.live.connect 的 Promise resolve 之前触发，
      // 那时 session 还没赋值。所以不能在 onopen 里就放行音频，否则会出现
      // upstreamReady=true 但 session=null 的竞态。统一在 await 返回后再放行。
      session = await ai.live.connect({
        model,
        config: liveConfig,
        callbacks: {
          onmessage: (msg) => handleServerMessage(msg),
          onerror: (e) =>
            sendJson(clientWs, { type: "error", message: "Gemini 上游错误: " + (e?.message || e) }),
          onclose: (e) => {
            if (clientWs.readyState === clientWs.OPEN) {
              sendJson(clientWs, {
                type: "error",
                message: `Gemini 连接关闭 ${e?.code ?? ""} ${String(e?.reason ?? "").slice(0, 120)}`,
              });
              clientWs.close();
            }
          },
        },
      });
      // session 已就绪，此时才放行浏览器上行音频
      upstreamReady = true;
      sendJson(clientWs, { type: "ready" });
    } catch (e) {
      sendJson(clientWs, { type: "error", message: "Gemini 连接失败: " + (e?.message || e) });
      if (clientWs.readyState === clientWs.OPEN) clientWs.close();
    }
  }

  // 后端自执行工具：本进程跑完（如 codex），把结果通过 sendToolResponse 回灌给模型。
  async function runBackendTool(call, fn) {
    // 给前端一个轻量提示，让 UI 能显示“正在执行本地工具”
    sendJson(clientWs, { type: "text", role: "assistant", text: `[调用 ${call.name}…]`, mode: "append" });
    let response;
    try {
      response = await fn(call.args || {});
    } catch (e) {
      response = { success: false, error: `工具执行异常: ${e?.message || e}` };
    }
    if (!session) return; // 会话可能已在执行期间关闭
    try {
      session.sendToolResponse({
        functionResponses: [{ id: call.id, name: call.name, response }],
      });
    } catch (e) {
      sendJson(clientWs, { type: "error", message: "回填工具结果失败: " + (e?.message || e) });
    }
  }

  function handleServerMessage(msg) {
    // setupComplete 已由 await 返回后的 ready 覆盖，这里无需重复放行
    if (msg.setupComplete) return;

    if (msg.toolCall) {
      for (const call of msg.toolCall.functionCalls || []) {
        const backendFn = BACKEND_TOOLS[call.name];
        if (backendFn) {
          runBackendTool(call, backendFn);
        } else {
          // 前端执行的工具（如 capture_camera）：转发给浏览器，等它回 tool_result
          sendJson(clientWs, { type: "tool_call", id: call.id, name: call.name });
        }
      }
      return;
    }
    if (msg.toolCallCancellation) return;

    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.interrupted) sendJson(clientWs, { type: "interrupted" });
    if (sc.inputTranscription?.text)
      sendJson(clientWs, { type: "text", role: "user", text: sc.inputTranscription.text, mode: "append" });
    if (sc.outputTranscription?.text)
      sendJson(clientWs, { type: "text", role: "assistant", text: sc.outputTranscription.text, mode: "append" });

    for (const p of sc.modelTurn?.parts || []) {
      if (p.inlineData?.data) {
        const buf = Buffer.from(p.inlineData.data, "base64");
        turnAudioBytes += buf.length;
        if (clientWs.readyState === clientWs.OPEN) clientWs.send(buf);
      }
    }

    if (sc.turnComplete) {
      // fail-fast：一轮结束却没有任何音频，通常是该音色在当前模型下不出声
      if (turnAudioBytes === 0) {
        sendJson(clientWs, {
          type: "error",
          message: `当前音色「${activeVoice || "默认"}」在模型「${activeModel.replace("models/", "")}」下没有语音输出，请在设置里换一个音色或模型。`,
        });
      }
      turnAudioBytes = 0;
      sendJson(clientWs, { type: "turn_end" });
    }
  }

  clientWs.on("close", () => {
    if (session) {
      try {
        session.close();
      } catch (_) {}
      session = null;
    }
  });
}

function sendJson(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
