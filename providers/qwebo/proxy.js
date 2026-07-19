// QwebO（Qwen-Omni 全模态实时）后端代理（独立模块，仅处理 QwebO，不与其他 provider 互相 import）。
// 对上：与浏览器走 CONTRACT.md 的统一线路协议。
// 对下：直连阿里云百炼 DashScope 的 Realtime WebSocket（OpenAI-Realtime 风格事件协议）。
//
// 底层模型：qwen3.5-omni-plus-realtime（已实测：国内 key 直连 dashscope.aliyuncs.com 可用，
// 且支持图像输入——实测能识别图片颜色）。
//
// 与 qwen-audio proxy 的差异：Omni 是「全模态」，支持视觉。因此在 qwen 那套能力之上，额外接入：
//   - capture_camera（前端执行工具）：模型自主决定何时看摄像头，前端截几张图回传。
//     视觉时序（server_vad 原生方式，不与自动断句冲突）：模型触发工具 → 前端截图 → proxy 把图
//     input_image_buffer.append 挂到 buffer（不手动 commit——server_vad 下手动 commit 会被上游拒绝
//     报 buffer too small）→ 图随用户「下一句话」由 server_vad 自动连音频一起提交，模型那一轮即看到画面。
import WebSocket from "ws";
import { RUN_CODEX_DECLARATION, runCodex } from "../tools/codex.js";

const ENDPOINT = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
const DEFAULT_MODEL = "qwen3.5-omni-plus-realtime";
const DEFAULT_VOICE = "Tina"; // Omni 系统默认音色（与 qwen-audio 的 longan 系列不同）
const DEFAULT_PROMPT =
  "你是一个友好的中文语音助手。请用自然、口语化的中文回答，简洁一些，适合语音播报。";

const VAD_DEFAULT = { threshold: 0.5, silence_duration_ms: 800 };
const VAD_PRESET = {
  LOW: { threshold: 0.7, silence_duration_ms: 1200 },
  "": VAD_DEFAULT,
  HIGH: { threshold: 0.3, silence_duration_ms: 500 },
};

// 摄像头视觉工具（前端执行）：模型自主发起，前端截几张图 → tool_result + image 帧 + image_done 回传。
const CAMERA_DECLARATION = {
  name: "capture_camera",
  description:
    "拍摄用户当前摄像头画面。当你需要看到用户本人、用户展示的物体或周围环境才能回答时调用，例如用户说『你看我手里拿的是什么』『我穿的什么颜色』『帮我看看这个』。调用后会拿到最新画面。",
  parameters: { type: "object", properties: {}, required: [] },
};

// run_codex 是「后端自执行工具」：模型发起后由本进程直接跑 codex，不转发前端。
const BACKEND_TOOLS = { run_codex: runCodex };

function toOmniTool(decl) {
  return {
    type: "function",
    function: { name: decl.name, description: decl.description, parameters: decl.parameters },
  };
}

export function handleQweboConnection(clientWs) {
  const apiKey = process.env.QWEBO_API_KEY;
  const defaultModel = process.env.QWEBO_REALTIME_MODEL || DEFAULT_MODEL;

  if (!apiKey) {
    sendJson(clientWs, { type: "error", message: "缺少 QWEBO_API_KEY" });
    clientWs.close();
    return;
  }

  let upstream = null;
  let upstreamReady = false;
  let turnAudioBytes = 0;
  let activeVoice = DEFAULT_VOICE;
  let activeModel = defaultModel;
  let responding = false;
  let currentResponseId = null; // 当前回复 id，打断时用于 response.cancel

  clientWs.on("message", (data, isBinary) => {
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
      // server_vad / smart_turn 下由服务端自动检测轮次结束，客户端手动 commit 会与之冲突
      // 并可能报 "buffer too small"。仅 push-to-talk（本项目未启用）才需要手动 commit，这里不做。
    } else if (m.type === "tool_result") {
      // capture_camera 的结果：写回 function_call_output（告知模型画面已就绪）。
      // 【关键】不在这里 response.create——server_vad 模式下手动 commit 图会被上游拒绝（buffer too small）。
      // 图只 append 挂在 buffer 上（见 image 分支），等用户下一句话时由 server_vad 自动连图一起带走。
      writeToolOutput(m.id, m.response || {});
    } else if (m.type === "image") {
      // 摄像头工具截来的帧：直接 append 挂到 image buffer，跟随音频流。
      // server_vad 会在用户下一次说话结束时，把这些图连同音频自动提交给模型（原生时序，不报错）。
      sendUpstream({ type: "input_image_buffer.append", image: m.data });
    } else if (m.type === "image_done") {
      // 所有帧已 append 完毕。server_vad 模式下无需客户端 commit，等用户开口自然带走，这里无动作。
    }
  });

  function startUpstream(config) {
    activeModel = config.qweboModel || defaultModel;
    activeVoice = config.voice || DEFAULT_VOICE;

    const url = `${ENDPOINT}?model=${encodeURIComponent(activeModel)}`;
    upstream = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "x-dashscope-dataInspection": "disable",
      },
    });

    upstream.on("open", () => {});
    upstream.on("message", (raw) => handleUpstreamEvent(raw, config));
    upstream.on("error", (e) => {
      sendJson(clientWs, { type: "error", message: "QwebO 上游错误: " + (e?.message || e) });
    });
    upstream.on("close", (code, reason) => {
      if (clientWs.readyState === clientWs.OPEN) {
        sendJson(clientWs, {
          type: "error",
          message: `QwebO 连接关闭 ${code ?? ""} ${String(reason ?? "").slice(0, 120)}`,
        });
        clientWs.close();
      }
    });
  }

  function buildTurnDetection(config) {
    if (config.qweboTurnMode === "smart_turn") return { type: "smart_turn" };
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
        // 工具集合：run_codex（后端自执行）常驻；capture_camera（前端执行）仅在用户开启摄像头开关时注册。
        const tools = [toOmniTool(RUN_CODEX_DECLARATION)];
        if (config.camera) tools.push(toOmniTool(CAMERA_DECLARATION));

        const session = {
          modalities: ["text", "audio"],
          voice: activeVoice,
          instructions: config.systemPrompt || DEFAULT_PROMPT,
          input_audio_format: "pcm",
          output_audio_format: "pcm",
          turn_detection: buildTurnDetection(config),
          tools,
        };
        const mh = Number(config.qweboMaxHistory);
        if (Number.isFinite(mh) && mh >= 1 && mh <= 50) session.max_history_turns = mh;

        sendUpstream({ type: "session.update", session });
        upstreamReady = true;
        sendJson(clientWs, { type: "ready" });
        break;
      }

      case "response.created":
        responding = true;
        currentResponseId = ev.response?.id || null;
        turnAudioBytes = 0;
        break;

      case "input_audio_buffer.speech_started":
        // 打断：用户开始说话时，① 通知前端停播；② 向上游 response.cancel 真正取消当前回复，
        // 否则模型会继续生成，表现为“打断不了”。
        if (responding) {
          sendJson(clientWs, { type: "interrupted" });
          sendUpstream({ type: "response.cancel" });
          responding = false;
          currentResponseId = null;
        }
        break;

      case "response.audio.delta": {
        if (!ev.delta) break;
        const buf = Buffer.from(ev.delta, "base64");
        turnAudioBytes += buf.length;
        if (clientWs.readyState === clientWs.OPEN) clientWs.send(buf);
        break;
      }

      case "conversation.item.input_audio_transcription.completed":
        if (ev.transcript)
          sendJson(clientWs, { type: "text", role: "user", text: ev.transcript, mode: "replace" });
        break;

      case "response.audio_transcript.delta":
        if (ev.delta)
          sendJson(clientWs, { type: "text", role: "assistant", text: ev.delta, mode: "append" });
        break;

      case "response.function_call_arguments.done":
        handleFunctionCall(ev);
        break;

      case "response.done": {
        responding = false;
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
        sendJson(clientWs, {
          type: "error",
          message: "QwebO: " + (ev.error?.message || JSON.stringify(ev.error || ev)),
        });
        break;

      default:
        break;
    }
  }

  // Function Calling：run_codex 后端自执行（异步）；capture_camera 转发前端执行。
  function handleFunctionCall(ev) {
    const name = ev.name;
    const callId = ev.call_id;
    let args = {};
    try {
      args = ev.arguments ? JSON.parse(ev.arguments) : {};
    } catch (_) {}

    // 前端执行工具（摄像头）：转发给浏览器，等它回 tool_result + image
    if (!BACKEND_TOOLS[name]) {
      sendJson(clientWs, { type: "tool_call", id: callId, name });
      return;
    }

    // 后端自执行工具（run_codex，异步）
    const fn = BACKEND_TOOLS[name];
    sendJson(clientWs, { type: "tool_activity", phase: "start", id: callId, name, args });
    writeToolOutput(callId, { status: "running", note: "任务已在后台开始执行，完成后会告诉你结果。" });
    sendUpstream({ type: "response.create" });

    Promise.resolve()
      .then(() => fn(args))
      .catch((e) => ({ success: false, error: `工具执行异常: ${e?.message || e}` }))
      .then((result) => {
        sendJson(clientWs, { type: "tool_activity", phase: "done", id: callId, name, args, result });
        if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
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
