// Gemini Live 后端代理（独立模块，仅处理 Gemini）。
// 对上：与浏览器走 CONTRACT.md 的统一线路协议。
// 对下：用官方 @google/genai SDK 的 Live API（ai.live.connect）连 Gemini。
import { GoogleGenAI, Modality } from "@google/genai";
import {
  LIST_CODEX_WORKSPACES_DECLARATION,
  RUN_CODEX_DECLARATION,
  listCodexWorkspaces,
  runCodex,
} from "../tools/codex.js";

const DEFAULT_PROMPT =
  "你是一个友好的中文语音助手。请用自然、口语化的中文回答，简洁一些，适合语音播报。";
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

const CAMERA_DECLARATION = {
  name: "capture_camera",
  description:
    "拍摄用户当前摄像头的一张照片。当你需要看到用户本人、用户展示的物体、或用户周围环境才能回答问题时，调用这个工具。例如用户问『你看我手里拿的是什么』『我穿的什么颜色』『帮我看看这个』时。",
  parameters: { type: "object", properties: {}, required: [] },
};

const WAKE_UP_DECLARATION = {
  name: "wake_up",
  description: "仅当听到配置的唤醒词时调用，用于恢复主语音会话。",
  parameters: { type: "object", properties: {}, required: [] },
};

// run_codex 是「后端自执行工具」：模型发起后由本进程直接跑 codex，不转发前端。
const BACKEND_TOOLS = {
  list_codex_workspaces: listCodexWorkspaces,
  run_codex: runCodex,
};

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
  let activeBackgroundSleep = true;
  let activeWakeWord = "小助手";
  let sleepingForTask = false;
  let sleepingTranscript = "";
  let wakeSession = null;
  let wakeSessionReady = false;
  let wakeSessionStarting = false;
  let wakeSessionFailed = false;
  let wakeAudioQueue = [];
  let wakeAudioBytes = 0;

  // 等浏览器发来 start（带 config）后再连上游，这样能应用用户设置
  clientWs.on("message", (data, isBinary) => {
    if (isBinary) {
      if (!upstreamReady) return;
      const audio = Buffer.from(data);
      if (sleepingForTask && !wakeSessionFailed) {
        if (wakeSessionReady && wakeSession) {
          sendAudio(wakeSession, audio);
        } else {
          wakeAudioQueue.push(audio);
          wakeAudioBytes += audio.length;
          while (wakeAudioBytes > 192000 && wakeAudioQueue.length > 1) {
            wakeAudioBytes -= wakeAudioQueue.shift().length;
          }
        }
        return;
      }
      sendAudio(session, audio);
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
    } else if (m.type === "wake_word") {
      wakeFromSleep("client");
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
    const language = config.language || DEFAULT_LANGUAGE;
    const languageName = LANGUAGE_NAMES[language] || language;
    const wakeWord = String(config.wakeWord || "小助手").trim() || "小助手";
    activeWakeWord = wakeWord;
    activeBackgroundSleep = config.backgroundSleep !== false;
    const sleepInstruction = activeBackgroundSleep
      ? `当 run_codex 工具返回 status=running 时，用户界面会进入休眠。在后台任务完成或用户说出唤醒词“${wakeWord}”之前，不要回复用户，也不要调用新的工具。`
      : "";
    activeModel = model;
    activeVoice = config.voice || "";

    // 目标模型：gemini-3.1-flash-live-preview（实时对话）/ gemini-3.5-live-translate（翻译），都是 3.x。
    // 各配置项对 3.1 的支持已实测：voice ✅ / languageCode ✅ / thinkingLevel ✅ / VAD ✅ /
    // 摄像头 function calling ✅；affectiveDialog / proactiveAudio ❌（3.1 不支持，坚决不下发）。
    // SDK 的 config 是「扁平」的：无 setup / generationConfig 包裹，各字段直接放顶层。
    const liveConfig = {
      responseModalities: [Modality.AUDIO],
      systemInstruction: {
        parts: [{
          text:
            `${config.systemPrompt || DEFAULT_PROMPT}\n\n` +
            `始终使用${languageName}回复。执行翻译任务时，必须将${languageName}作为目标语言。` +
            (sleepInstruction ? `\n${sleepInstruction}` : ""),
        }],
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };

    if (config.temperature != null) liveConfig.temperature = Number(config.temperature);

    // speechConfig：音色 + 语言。3.1 两者都接受，可同时下发。
    const speechConfig = {};
    if (config.voice) speechConfig.voiceConfig = { prebuiltVoiceConfig: { voiceName: config.voice } };
    speechConfig.languageCode = language;
    if (Object.keys(speechConfig).length) liveConfig.speechConfig = speechConfig;

    // 思考深度：3.x 用 thinkingLevel（minimal/low/medium/high），默认 minimal（最低延迟）。
    if (config.thinkingLevel) {
      liveConfig.thinkingConfig = { thinkingLevel: config.thinkingLevel };
    }

    // 工具集合：run_codex 常驻（后端自执行）；capture_camera 仅在开启摄像头时加入。
    const functionDeclarations = [LIST_CODEX_WORKSPACES_DECLARATION, RUN_CODEX_DECLARATION];
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

  function stopWakeListening() {
    wakeSessionReady = false;
    wakeSessionStarting = false;
    wakeAudioQueue = [];
    wakeAudioBytes = 0;
    if (wakeSession) {
      try { wakeSession.close(); } catch (_) {}
      wakeSession = null;
    }
  }

  function flushWakeAudioTo(targetSession) {
    for (const audio of wakeAudioQueue) sendAudio(targetSession, audio);
    wakeAudioQueue = [];
    wakeAudioBytes = 0;
  }

  async function startWakeListening() {
    if (!sleepingForTask || wakeSessionReady || wakeSessionStarting) return;
    wakeSessionStarting = true;
    wakeSessionFailed = false;
    sendJson(clientWs, { type: "wake_listener", status: "connecting" });

    try {
      const newWakeSession = await ai.live.connect({
        model: activeModel,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: {
            parts: [{
              text:
                `你是一个静默的唤醒词检测器。目标唤醒词是“${activeWakeWord}”。` +
                `只有明确听到这个词时才调用 wake_up；其他声音一律忽略，不要说话。`,
            }],
          },
          inputAudioTranscription: {},
          tools: [{ functionDeclarations: [WAKE_UP_DECLARATION] }],
        },
        callbacks: {
          onmessage: (msg) => handleWakeMessage(msg),
          onerror: () => {
            wakeSessionFailed = true;
            wakeSessionReady = false;
            sendJson(clientWs, { type: "wake_listener", status: "fallback" });
            if (session) flushWakeAudioTo(session);
          },
          onclose: () => {},
        },
      });

      wakeSessionStarting = false;
      if (!sleepingForTask) {
        try { newWakeSession.close(); } catch (_) {}
        return;
      }
      wakeSession = newWakeSession;
      wakeSessionReady = true;
      sendJson(clientWs, { type: "wake_listener", status: "ready" });
      flushWakeAudioTo(wakeSession);
    } catch (_) {
      wakeSessionStarting = false;
      wakeSessionFailed = true;
      sendJson(clientWs, { type: "wake_listener", status: "fallback" });
      if (session) flushWakeAudioTo(session);
    }
  }

  function handleWakeMessage(msg) {
    for (const call of msg.toolCall?.functionCalls || []) {
      if (call.name === "wake_up") {
        wakeFromSleep("listener");
        return;
      }
    }

    const text = msg.serverContent?.inputTranscription?.text;
    if (!text) return;
    sleepingTranscript = (sleepingTranscript + text).slice(-120);
    if (normalizeWakeText(sleepingTranscript).includes(normalizeWakeText(activeWakeWord))) {
      wakeFromSleep("listener");
    }
  }

  function wakeFromSleep(source) {
    if (!sleepingForTask) return;
    sleepingForTask = false;
    sleepingTranscript = "";
    stopWakeListening();
    sendJson(clientWs, { type: "sleep_state", state: "awake", reason: "wake-word" });
    sendJson(clientWs, { type: "wake_word", text: activeWakeWord, source });
    try {
      session?.sendClientContent({
        turns: [{
          role: "user",
          parts: [{ text: `[系统事件] 用户刚刚说出唤醒词“${activeWakeWord}”，请恢复正常对话。` }],
        }],
        turnComplete: true,
      });
    } catch (_) {}
  }

  // 后端自执行工具（异步）：不阻塞语音链路。
  // 1) 立即回一个“已在后台开跑”的 toolResponse，让模型这一轮马上继续（不卡）。
  // 2) codex 在后台真正跑（允许多个并行），跑完把【入参 + 输出 + 背景】作为新一轮 user
  //    内容通过 sendClientContent 推给模型，模型主动播报结果，上下文连贯。
  // 3) 前后两阶段都用 tool_activity 事件透传给前端，用于折叠卡片展示。
  function runBackendTool(call, fn) {
    const args = call.args || {};
    const shouldSleep = call.name === "run_codex" && activeBackgroundSleep;
    if (shouldSleep) {
      sleepingForTask = true;
      sleepingTranscript = "";
      sendJson(clientWs, {
        type: "sleep_state",
        state: "sleeping",
        reason: "background-task",
        task_id: call.id,
        wake_word: activeWakeWord,
      });
      void startWakeListening();
    }

    // 前端：工具开始（带入参），用于渲染折叠卡片
    sendJson(clientWs, { type: "tool_activity", phase: "start", id: call.id, name: call.name, args });

    // 立即告诉模型“已在后台执行”，解除这一轮的等待
    if (session) {
      try {
        session.sendToolResponse({
          functionResponses: [
            {
              id: call.id,
              name: call.name,
              response: {
                status: "running",
                sleeping: shouldSleep,
                note: shouldSleep
                  ? "任务已在后台开始执行。界面已休眠，在任务完成或用户说出唤醒词前不要回复。"
                  : "工具正在执行，完成后会把结果告诉你。",
              },
            },
          ],
        });
      } catch (e) {
        sendJson(clientWs, { type: "error", message: "回填工具结果失败: " + (e?.message || e) });
      }
    }

    // 后台真正执行，不 await（允许并行）
    Promise.resolve()
      .then(() => fn(args))
      .catch((e) => ({ success: false, error: `工具执行异常: ${e?.message || e}` }))
      .then((result) => {
        if (call.name === "run_codex") {
          sleepingForTask = false;
          sleepingTranscript = "";
          stopWakeListening();
          sendJson(clientWs, {
            type: "sleep_state",
            state: "awake",
            reason: "task-complete",
            task_id: call.id,
          });
        }
        // 前端：工具完成（带结果）
        sendJson(clientWs, { type: "tool_activity", phase: "done", id: call.id, name: call.name, args, result });

        if (!session) return; // 会话可能已在执行期间关闭
        // 把入参 + 输出 + 背景合并成一段 user 内容，推给模型，让它主动、连贯地播报
        const brief = summarizeToolResult(call.name, args, result);
        try {
          session.sendClientContent({
            turns: [{ role: "user", parts: [{ text: brief }] }],
            turnComplete: true,
          });
        } catch (e) {
          sendJson(clientWs, { type: "error", message: "推送工具结果失败: " + (e?.message || e) });
        }
      });
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
    if (sc.inputTranscription?.text) {
      if (sleepingForTask) {
        sleepingTranscript = (sleepingTranscript + sc.inputTranscription.text).slice(-120);
        if (normalizeWakeText(sleepingTranscript).includes(normalizeWakeText(activeWakeWord))) {
          sleepingForTask = false;
          sleepingTranscript = "";
          sendJson(clientWs, { type: "wake_word", text: activeWakeWord });
        }
      }
      sendJson(clientWs, { type: "text", role: "user", text: sc.inputTranscription.text, mode: "append" });
    }
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
    stopWakeListening();
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

function sendAudio(targetSession, audio) {
  targetSession.sendRealtimeInput({
    audio: { data: audio.toString("base64"), mimeType: "audio/pcm;rate=16000" },
  });
}

function normalizeWakeText(text) {
  return String(text || "").toLocaleLowerCase().replace(/[\s，。！？、,.!?]/g, "");
}

// 把工具的【入参 + 输出 + 背景】拼成一段给模型的连贯提示，让它主动播报结果。
function summarizeToolResult(name, args, result) {
  const argStr = JSON.stringify(args ?? {});
  const resStr = JSON.stringify(result ?? {});
  return (
    `[后台工具「${name}」已执行完毕]\n` +
    `刚才你请求执行的这个任务已经在后台跑完了，下面是完整信息，请用自然口语把结果讲给用户听：\n` +
    `- 调用入参：${argStr}\n` +
    `- 执行结果：${resStr}\n` +
    `如果成功，简要说明它做了什么、关键结论；如果失败，说明失败原因。`
  );
}
