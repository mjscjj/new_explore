import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";

import { handleGeminiConnection } from "./providers/gemini/proxy.js";
import { handleDoubaoConnection } from "./providers/doubao/proxy.js";
import { handleQwenConnection } from "./providers/qwen/proxy.js";
import { handleQweboConnection } from "./providers/qwebo/proxy.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;

const app = express();
app.use(express.static(path.join(__dirname, "public")));

// 告诉前端哪些 provider 配置就绪（缺凭证的置灰，不静默降级）
app.get("/api/providers", (req, res) => {
  res.json({
    gemini: !!process.env.GEMINI_API_KEY,
    doubao: !!(process.env.DOUBAO_APP_ID && process.env.DOUBAO_ACCESS_TOKEN),
    qwen: !!process.env.QWEN_API_KEY,
    qwebo: !!process.env.QWEBO_API_KEY,
  });
});

const server = createServer(app);

// 每个 provider 独立挂在自己的路径上，互不影响。
// 新增 provider = 新增一个 handler + 一条路由，不动其他代码。
const routes = {
  "/ws/gemini": handleGeminiConnection,
  "/ws/doubao": handleDoubaoConnection,
  "/ws/qwen": handleQwenConnection,
  "/ws/qwebo": handleQweboConnection,
};

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  const handler = routes[pathname];
  if (!handler) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (clientWs) => {
    clientWs.on("error", (e) => console.error("[client ws error]", e.message));
    try {
      handler(clientWs);
    } catch (e) {
      console.error("[handler error]", pathname, e);
      try {
        clientWs.send(JSON.stringify({ type: "error", message: "内部错误: " + e.message }));
        clientWs.close();
      } catch (_) {}
    }
  });
});

process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));

server.listen(PORT, () => {
  console.log(`实时语音对话服务已启动: http://localhost:${PORT}`);
  console.log(`  provider 路由: ${Object.keys(routes).join(", ")}`);
});
