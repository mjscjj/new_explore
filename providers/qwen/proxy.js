// Qwen-Audio 实时语音后端代理（独立模块，仅处理 Qwen，不与豆包/Gemini 互相 import）。
// 对上：与浏览器走 CONTRACT.md 的统一线路协议。
// 对下：直连阿里云百炼 DashScope 的 Realtime WebSocket（OpenAI-Realtime 风格事件协议）。
//
// 端点（已实测：用 DashScope API Key 直连即可，无需 WorkspaceId）：
//   wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=<model>
// 鉴权：HTTP header Authorization: Bearer <API_KEY>（浏览器无法自定义 WS header，
// 所以必须由本后端代理，同时也避免把 key 泄漏到前端）。
//
// 能力对齐说明（已实测）：
//   - Function Calling：支持。run_codex 走「后端自执行 + 异步」，与 Gemini 一致。
//   - 视觉/摄像头：qwen-audio-3.0-realtime-plus 是纯音频模型，不支持图像输入（实测模型自述“看不到图”），
//     因此不接 capture_camera（视觉是 qwen-omni-realtime 系列才有的能力）。
//   - thinkingLevel/temperature：qwen realtime 不支持，不下发。
import WebSocket from "ws";
import { RUN_CODEX_DECLARATION, runCodex } from "../tools/codex.js";

const ENDPOINT = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
const DEFAULT_MODEL = "qwen-audio-3.0-realtime-plus";
const DEFAULT_VOICE = "longanqian"; // 系统默认音色
const DEFAULT_PROMPT =
  "你是一个友好的中文语音助手。请用自然、口语化的中文回答，简洁一些，适合语音播报。";

// server_vad 的默认参数（对话场景推荐）。
const VAD_DEFAULT = { threshold: 0.5, silence_duration_ms: 800 };
// 前端 vad 档位 → server_vad 参数映射（沿用契约 LOW/''/HIGH 的语义）。
const VAD_PRESET = {
  LOW: { threshold: 0.7, silence_duration_ms: 1200 },
  "": VAD_DEFAULT,
  HIGH: { threshold: 0.3, silence_duration_ms: 500 },
};

// run_codex 是「后端自执行工具」：模型发起后由本进程直接跑 codex，不转发前端。
const BACKEND_TOOLS = { run_codex: runCodex };

// 把 Gemini 风格的工具声明转成 qwen(OpenAI-Realtime) 的 tools schema。
function toQwenTool(decl) {
  return {
    type: "function",
    function: { name: decl.name, description: decl.description, parameters: decl.parameters },
  };
}

export function handleQwenConnection(clientWs) {
  const apiKey = process.env.QWEN_API_KEY;
  const defaultModel = process.env.QWEN_REALTIME_MODEL || DEFAULT_MODEL;

  if (!apiKey) {
    sendJson(clientWs, { type: "error", message: "缺少 QWEN_API_KEY" });
    clientWs.close();
    return;
  }

  let upstream = null; // 到 DashScope 的 WS
  let upstreamReady = false; // 收到 session.created 且已发 session.update 后置真
  let turnAudioBytes = 0; // 本轮下行音频字节，用于检测“空音频（没出声）”
  let activeVoice = DEFAULT_VOICE;
  let activeModel = defaultModel;
  let responding = false; // 是否正在生成回复，用于打断判断

  clientWs.on("message", (data, isBinary) => {
    // 二进制 = 麦克风上行 PCM（16k/16bit/mono），转 base64 走 input_audio_buffer.append
    if (isBinary) {
      if (!upstreamReady) return;
      sendUpstream({
        type: "input_audio_buffer.append",
        audio: Buffer.from(data).toString("base64"),
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
      // server_vad/smart_turn 下由服务端自动检测轮次结束，客户端手动 commit 会冲突并可能报
      // "buffer too small"。仅 push-to-talk（本项目未启用）才需要手动 commit，这里不做。
    }
    // 注：qwen-audio 无视觉，image / capture_camera 不处理（见文件头说明）
  });

  function startUpstream(config) {
    activeModel = config.qwenModel || defaultModel;
    activeVoice = config.voice || DEFAULT_VOICE;

    const url = `${ENDPOINT}?model=${encodeURIComponent(activeModel)}`;
    upstream = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "x-dashscope-dataInspection": "disable",
      },
    });

    upstream.on("open", () => {
      // 等 session.created 后再发 session.update（音色/turn_detection 只在首次 update 生效）
    });

    upstream.on("message", (raw) => handleUpstreamEvent(raw, config));

    upstream.on("error", (e) => {
      sendJson(clientWs, { type: "error", message: "Qwen 上游错误: " + (e?.message || e) });
    });

    upstream.on("close", (code, reason) => {
      if (clientWs.readyState === clientWs.OPEN) {
        sendJson(clientWs, {
          type: "error",
          message: `Qwen 连接关闭 ${code ?? ""} ${String(reason ?? "").slice(0, 120)}`,
        });
        clientWs.close();
      }
    });
  }

  // 组装首次 session.update 的 turn_detection（交互模式）。
  function buildTurnDetection(config) {
    if (config.qwenTurnMode === "smart_turn") {
      // 智能语义轮次：融合声学与语义，无意义附和声不打断
      return { type: "smart_turn" };
    }
    // 默认 server_vad，按前端灵敏度档位取参数
    const vad = VAD_PRESET[config.vad] || VAD_DEFAULT;
    return { type: "server_vad", ...vad };
  }

  function handleUpstreamEvent(raw, config) {
    let ev;
    try {
      ev = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const t = ev.type;

    switch (t) {
      case "session.created": {
        // 首次配置：音色、系统指令、交互模式、历史轮数、工具。这些只在首个 session.update 生效。
        const session = {
          modalities: ["text", "audio"],
          voice: activeVoice,
          instructions: config.systemPrompt || DEFAULT_PROMPT,
          input_audio_format: "pcm",
          output_audio_format: "pcm",
          turn_detection: buildTurnDetection(config),
          tools: [toQwenTool(RUN_CODEX_DECLARATION)],
        };
        // 历史轮数（1-50），仅在传了有效值时下发
        const mh = Number(config.qwenMaxHistory);
        if (Number.isFinite(mh) && mh >= 1 && mh <= 50) session.max_history_turns = mh;

        sendUpstream({ type: "session.update", session });
        upstreamReady = true;
        sendJson(clientWs, { type: "ready" });
        break;
      }

      case "response.created":
        responding = true;
        turnAudioBytes = 0;
        break;

      case "input_audio_buffer.speech_started":
        // 打断：用户开始说话时，① 通知前端停播；② 向上游 response.cancel 真正取消当前回复，
        // 否则模型会继续生成，表现为“打断不了”。
        if (responding) {
          sendJson(clientWs, { type: "interrupted" });
          sendUpstream({ type: "response.cancel" });
          responding = false;
        }
        break;

      case "response.audio.delta": {
        if (!ev.delta) break;
        const buf = Buffer.from(ev.delta, "base64");
        turnAudioBytes += buf.length;
        if (clientWs.readyState === clientWs.OPEN) clientWs.send(buf);
        break;
      }

      // 用户语音识别结果（全量）
      case "conversation.item.input_audio_transcription.completed":
        if (ev.transcript)
          sendJson(clientWs, { type: "text", role: "user", text: ev.transcript, mode: "replace" });
        break;

      // 助手回复文本增量
      case "response.audio_transcript.delta":
        if (ev.delta)
          sendJson(clientWs, { type: "text", role: "assistant", text: ev.delta, mode: "append" });
        break;

      // Function Calling：拿到完整参数后执行工具（后端自执行）
      case "response.function_call_arguments.done":
        handleFunctionCall(ev);
        break;

      case "response.done": {
        responding = false;
        // fail-fast：一轮结束却没有任何音频，通常是该音色在当前模型下不出声。
        // 但纯函数调用轮（无文本无音频）是正常的，不报错——用 status 判断是否被工具占用。
        const isFcRound = (ev.response?.output || []).some((o) => o?.type === "function_call");
        if (turnAudioBytes === 0 && !isFcRound) {
          sendJson(clientWs, {
            type: "error",
            message: `当前音色「${activeVoice}」在模型「${activeModel}」下没有语音输出，请在设置里换一个音色。`,
          });
        }
        turnAudioBytes = 0;
        sendJson(clientWs, { type: "turn_end" });
        break;
      }

      case "error":
        // fail-fast：上游错误直接透传，不静默降级
        sendJson(clientWs, {
          type: "error",
          message: "Qwen: " + (ev.error?.message || JSON.stringify(ev.error || ev)),
        });
        break;

      default:
        break;
    }
  }

  // 后端自执行工具（异步，不阻塞语音），与 Gemini 同一套逻辑：
  // 1) 前端 tool_activity(start) 建卡；2) 立即回一个 running 的 function_call_output 让本轮不卡；
  // 3) codex 后台真正跑（允许并行），跑完把【入参+输出+背景】作为新一轮 user 内容推给模型主动播报；
  // 4) tool_activity(done) 回填结果卡。
  function handleFunctionCall(ev) {
    const name = ev.name;
    const callId = ev.call_id;
    let args = {};
    try {
      args = ev.arguments ? JSON.parse(ev.arguments) : {};
    } catch (_) {}

    const fn = BACKEND_TOOLS[name];
    if (!fn) {
      // 未知工具：回一个错误结果，触发模型继续（不静默丢弃）
      writeToolOutput(callId, { error: `未注册的工具: ${name}` });
      sendUpstream({ type: "response.create" });
      return;
    }

    sendJson(clientWs, { type: "tool_activity", phase: "start", id: callId, name, args });

    // 立即回“已在后台执行”，解除本轮等待
    writeToolOutput(callId, { status: "running", note: "任务已在后台开始执行，完成后会告诉你结果。" });
    sendUpstream({ type: "response.create" });

    // 后台真正执行，不 await（允许并行）
    Promise.resolve()
      .then(() => fn(args))
      .catch((e) => ({ success: false, error: `工具执行异常: ${e?.message || e}` }))
      .then((result) => {
        sendJson(clientWs, { type: "tool_activity", phase: "done", id: callId, name, args, result });
        if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
        // 把入参+输出+背景合成一段 user 内容推给模型，让它主动、连贯地播报
        const brief = summarizeToolResult(name, args, result);
        sendUpstream({
          type: "conversation.item.create",
          item: { type: "message", role: "user", content: [{ type: "input_text", text: brief }] },
        });
        sendUpstream({ type: "response.create" });
      });
  }

  function writeToolOutput(callId, output) {
    sendUpstream({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) },
    });
  }

  function sendUpstream(obj) {
    if (upstream?.readyState === WebSocket.OPEN) {
      obj.event_id = "event_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      upstream.send(JSON.stringify(obj));
    }
  }

  clientWs.on("close", () => {
    if (upstream) {
      try {
        upstream.close();
      } catch (_) {}
      upstream = null;
    }
  });
}

function sendJson(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
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
