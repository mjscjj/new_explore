import { AudioRecorder } from "./core/audio-recorder.js";
import { AudioPlayer } from "./core/audio-player.js";
import { GeminiClient } from "./providers/gemini-client.js";
import { DoubaoClient } from "./providers/doubao-client.js";

// provider 注册表：新增 provider 只需在这里加一行 + 一个 client 文件。
const PROVIDERS = {
  doubao: { label: "豆包", ctor: DoubaoClient, sub: "豆包端到端实时语音 · 超拟人中文" },
  gemini: { label: "Gemini", ctor: GeminiClient, sub: "Gemini Live · 端到端多模态、可看摄像头" },
};

// ---------- 设置 ----------
const DEFAULT_PROMPT = "你是一个友好的中文语音助手。请用自然、口语化的中文回答，简洁一些，适合语音播报。";
const settings = {
  provider: "doubao",
  systemPrompt: DEFAULT_PROMPT,
  doubaoVoice: "", // 豆包音色（speaker），空=默认 vv
  geminiVoice: "", // Gemini 音色，空=默认
  model: "models/gemini-3.1-flash-live-preview",
  temperature: 0.7,
  vad: "",
  camera: false,
};
function loadSettings() {
  try { Object.assign(settings, JSON.parse(localStorage.getItem("voice_settings") || "{}")); } catch (_) {}
}
function persistSettings() {
  localStorage.setItem("voice_settings", JSON.stringify(settings));
}

// ---------- DOM ----------
const connectBtn = document.getElementById("connectBtn");
const statusEl = document.getElementById("status");
const orbEl = document.getElementById("orb");
const logEl = document.getElementById("log");
const emptyHint = document.getElementById("emptyHint");
const statusDot = document.getElementById("statusDot");
const subtitleEl = document.getElementById("subtitle");
const providerSwitch = document.getElementById("providerSwitch");

const settingsBtn = document.getElementById("settingsBtn");
const settingsOverlay = document.getElementById("settingsOverlay");
const closeSettingsBtn = document.getElementById("closeSettings");
const saveSettingsBtn = document.getElementById("saveSettings");
const promptInput = document.getElementById("systemPrompt");
const doubaoVoiceSel = document.getElementById("doubaoVoice");
const geminiVoiceSel = document.getElementById("geminiVoice");
const modelSel = document.getElementById("model");
const tempInput = document.getElementById("temperature");
const tempVal = document.getElementById("tempVal");
const vadSel = document.getElementById("vad");
const cameraToggle = document.getElementById("camera");

// ---------- 状态 ----------
let client = null;
let recorder = null;
let player = null;
let connected = false;
let curYou = null;
let curBot = null;

// 摄像头
let cameraStream = null;
let videoEl = null;
const CAM_MAX_EDGE = 768;
const CAM_JPEG_QUALITY = 0.6;

// ---------- 工具 ----------
function setStatus(text, cls = "") {
  statusEl.textContent = text;
  statusEl.className = "status" + (cls ? " " + cls : "");
}
// 状态 → 卡通形象表情
const EXPR_MAP = {
  "": "idle",
  connecting: "thinking",
  listening: "listening",
  speaking: "speaking",
  thinking: "camera", // 截图/看摄像头时用"看"的表情
};
function setOrb(state) {
  orbEl.className = "orb character" + (state ? " " + state : "");
  orbEl.dataset.expr = EXPR_MAP[state] ?? "idle";
}
function setDot(cls) { statusDot.className = "dot" + (cls ? " " + cls : ""); }

function logLine(role, text) {
  if (emptyHint) emptyHint.style.display = "none";
  const div = document.createElement("div");
  div.className = "line " + role;
  div.innerHTML = `<span class="tag">${role === "you" ? "你" : "助手"}</span><span class="txt"></span>`;
  div.querySelector(".txt").textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
  return div.querySelector(".txt");
}
function onText(role, text, mode) {
  if (!text) return;
  if (role === "user") {
    if (!curYou) curYou = logLine("you", "");
    curYou.textContent = mode === "replace" ? text : curYou.textContent + text;
    curBot = null;
  } else {
    if (!curBot) curBot = logLine("bot", "");
    curBot.textContent = mode === "replace" ? text : curBot.textContent + text;
    curYou = null;
  }
  logEl.scrollTop = logEl.scrollHeight;
}
function endTurn() { curYou = null; curBot = null; }

function showError(msg) {
  if (emptyHint) emptyHint.style.display = "none";
  const b = document.createElement("div");
  b.className = "error-banner";
  b.textContent = "出错了：" + msg;
  logEl.appendChild(b);
  logEl.scrollTop = logEl.scrollHeight;
}
function showSnapshot(dataUrl) {
  if (emptyHint) emptyHint.style.display = "none";
  const div = document.createElement("div");
  div.className = "line bot snapshot";
  div.innerHTML = `<span class="tag">看到</span>`;
  const img = document.createElement("img");
  img.src = dataUrl;
  img.className = "snap-img";
  div.appendChild(img);
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

// ---------- 摄像头视觉 ----------
async function ensureCamera() {
  if (cameraStream) return;
  cameraStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  videoEl = document.createElement("video");
  videoEl.autoplay = true;
  videoEl.playsInline = true;
  videoEl.muted = true;
  videoEl.srcObject = cameraStream;
  await videoEl.play().catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
}
function stopCamera() {
  if (cameraStream) { cameraStream.getTracks().forEach((t) => t.stop()); cameraStream = null; }
  videoEl = null;
}
function captureFrame() {
  if (!videoEl || !videoEl.videoWidth) return null;
  const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
  const scale = Math.min(1, CAM_MAX_EDGE / Math.min(vw, vh));
  const w = Math.round(vw * scale), h = Math.round(vh * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d").drawImage(videoEl, 0, 0, w, h);
  const dataUrl = canvas.toDataURL("image/jpeg", CAM_JPEG_QUALITY);
  return { base64: dataUrl.split(",")[1], dataUrl };
}

// 模型发起工具调用（目前仅 Gemini 的 capture_camera）
async function handleToolCall(id, name) {
  if (name !== "capture_camera") return;
  setOrb("thinking");
  setStatus("正在看摄像头…", "connecting");
  try {
    await ensureCamera();
    const frame = captureFrame();
    if (!frame) throw new Error("截图失败");
    showSnapshot(frame.dataUrl);
    client.sendToolResult(id, name, { status: "ok", note: "已截取一张照片，见下一条图片消息。" });
    client.sendImage("image/jpeg", frame.base64);
    setStatus("已连接，说话吧", "listening");
    setOrb("listening");
  } catch (err) {
    client.sendToolResult(id, name, { status: "error", message: String(err) });
    setStatus("摄像头访问失败：" + err, "error");
  }
}

// ---------- provider 切换 ----------
providerSwitch.addEventListener("click", (e) => {
  const btn = e.target.closest(".prov-btn");
  if (!btn || btn.disabled) return;
  const p = btn.dataset.provider;
  if (p === settings.provider) return;
  if (connected) disconnect();
  settings.provider = p;
  persistSettings();
  reflectProvider();
});
function reflectProvider() {
  [...providerSwitch.children].forEach((c) => c.classList.toggle("active", c.dataset.provider === settings.provider));
  subtitleEl.textContent = PROVIDERS[settings.provider].sub;
  // 设置面板按 provider 分区：只显示当前 provider 的专属区
  const isGemini = settings.provider === "gemini";
  document.querySelector(".gemini-only").classList.toggle("prov-hidden", !isGemini);
  document.querySelector(".doubao-only").classList.toggle("prov-hidden", isGemini);
}

// ---------- 连接 ----------
function buildConfig() {
  // 音色按 provider 取各自的值，统一用契约里的 voice 字段下发
  const voice = settings.provider === "gemini" ? settings.geminiVoice : settings.doubaoVoice;
  return {
    systemPrompt: settings.systemPrompt,
    voice,
    model: settings.model,
    temperature: settings.temperature,
    vad: settings.vad,
    camera: settings.camera,
  };
}

function connect() {
  const conf = PROVIDERS[settings.provider];
  setStatus("连接中…", "connecting");
  setOrb("connecting");
  setDot("");
  connectBtn.disabled = true;

  player = new AudioPlayer(24000);
  window.__player = player; // 调试：控制台可看 __player._underruns / 调 __player.jitterBufferSec
  player.onStateChange = (playing) => {
    if (connected) { setStatus(playing ? "对方说话中…" : "正在聆听…", playing ? "speaking" : "listening"); setOrb(playing ? "speaking" : "listening"); }
  };

  client = new conf.ctor({
    onReady: async () => {
      connected = true;
      connectBtn.disabled = false;
      connectBtn.textContent = "结束通话";
      connectBtn.classList.add("active");
      setStatus("已连接，说话吧", "listening");
      setOrb("listening");
      setDot("connected");
      recorder = new AudioRecorder((buf) => client.sendAudio(buf));
      try { await recorder.start(); } catch (e) { showError("无法访问麦克风：" + e.message); disconnect(); }
    },
    onText,
    onAudio: (buf) => { if (player) player.enqueue(buf); },
    onToolCall: (id, name) => handleToolCall(id, name),
    onInterrupted: () => { if (player) player.clear(); curBot = null; setStatus("正在聆听…", "listening"); setOrb("listening"); },
    onTurnEnd: () => { endTurn(); setStatus("正在聆听…", "listening"); setOrb("listening"); },
    onError: (m) => showError(m),
    onClose: () => { if (connected) disconnect(); },
  });

  client.connect(buildConfig());
}

async function disconnect() {
  connected = false;
  connectBtn.disabled = false;
  connectBtn.textContent = "开始通话";
  connectBtn.classList.remove("active");
  setStatus("已结束");
  setOrb("");
  setDot("");
  if (recorder) { await recorder.stop(); recorder = null; }
  if (client) { client.close(); client = null; }
  if (player) { await player.close(); player = null; }
  stopCamera();
  endTurn();
}

connectBtn.addEventListener("click", () => (connected ? disconnect() : connect()));

// ---------- 设置面板 ----------
function fillPanel() {
  promptInput.value = settings.systemPrompt || "";
  doubaoVoiceSel.value = settings.doubaoVoice || "";
  geminiVoiceSel.value = settings.geminiVoice || "";
  modelSel.value = settings.model;
  tempInput.value = settings.temperature;
  tempVal.textContent = Number(settings.temperature).toFixed(1);
  vadSel.value = settings.vad || "";
  cameraToggle.checked = !!settings.camera;
}
function readPanel() {
  settings.systemPrompt = promptInput.value.trim() || DEFAULT_PROMPT;
  settings.doubaoVoice = doubaoVoiceSel.value;
  settings.geminiVoice = geminiVoiceSel.value;
  settings.model = modelSel.value;
  settings.temperature = Number(tempInput.value);
  settings.vad = vadSel.value;
  settings.camera = cameraToggle.checked;
}
function openSettings() { fillPanel(); settingsOverlay.classList.remove("hidden"); }
function closeSettings() { settingsOverlay.classList.add("hidden"); }

settingsBtn.addEventListener("click", openSettings);
closeSettingsBtn.addEventListener("click", closeSettings);
settingsOverlay.addEventListener("click", (e) => { if (e.target === settingsOverlay) closeSettings(); });
tempInput.addEventListener("input", () => { tempVal.textContent = Number(tempInput.value).toFixed(1); });
saveSettingsBtn.addEventListener("click", () => {
  readPanel();
  persistSettings();
  closeSettings();
  setStatus(connected ? "已保存，重新通话后生效" : "设置已保存");
});

// ---------- 启动：探测可用 provider ----------
(async function init() {
  loadSettings();
  reflectProvider();
  try {
    const avail = await (await fetch("/api/providers")).json();
    [...providerSwitch.children].forEach((btn) => {
      const p = btn.dataset.provider;
      if (!avail[p]) { btn.disabled = true; btn.title = "未配置凭证"; }
    });
    if (!avail[settings.provider]) {
      const firstOk = Object.keys(PROVIDERS).find((p) => avail[p]);
      if (firstOk) { settings.provider = firstOk; reflectProvider(); }
    }
  } catch (_) {}
})();
