// 后端自执行工具：把本机的 Codex CLI（codex exec）包装成一个可被语音模型调用的工具。
//
// 与 capture_camera（前端执行）不同，codex 只能在本机后端跑，因此模型发起 tool_call 后，
// 由 proxy 直接在这里 spawn 执行，拿到结果再回灌给模型，不经过浏览器往返。
//
// 固定策略（不暴露给模型，写死保证非交互稳定 + 按用户要求）：
//   - --dangerously-bypass-approvals-and-sandbox：full-access，不问审批、不加沙箱
//   - -m gpt-5.6-luna + model_reasoning_effort=medium：指定模型与思考级别
//   - --skip-git-repo-check：允许在非 git 目录运行
//   - -o <tmpfile>：把 codex 的“最后一条总结”落盘，作为返回值主体
import { spawn } from "child_process";
import { mkdtemp, readFile, rm } from "fs/promises";
import { homedir, tmpdir } from "os";
import path from "path";

const CODEX_BIN = process.env.CODEX_BIN || "codex";
const CODEX_MODEL = process.env.CODEX_MODEL || "gpt-5.6-luna";
const CODEX_REASONING = process.env.CODEX_REASONING || "medium";
// 单次任务最长执行时间，超时强杀，避免卡死整条语音会话。
const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || 300000);
// 模型不指定 working_dir 时用的默认工作目录（本项目根目录）。
const DEFAULT_WORKING_DIR = process.env.CODEX_DEFAULT_DIR || path.join(homedir(), "workspace-local/new_explore");

// 把 ~ 展开成用户家目录，返回绝对路径。
function resolveDir(dir) {
  if (!dir) return DEFAULT_WORKING_DIR;
  if (dir === "~") return homedir();
  if (dir.startsWith("~/")) return path.join(homedir(), dir.slice(2));
  return dir;
}

// 暴露给模型的工具声明（仅 2 个入参：prompt + working_dir）。
export const RUN_CODEX_DECLARATION = {
  name: "run_codex",
  description:
    "在本机调用 Codex 编码助手，在指定工作目录里执行一个编码或分析任务（可读写代码、运行命令、修改文件），并返回它完成后的总结。当用户要求写代码、改代码、跑脚本、排查项目问题、分析某个目录下的代码时调用。",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "交给 Codex 的任务，用自然语言清楚描述要做什么。",
      },
      working_dir: {
        type: "string",
        description:
          "可选。Codex 的工作根目录（绝对路径，如 /Users/bytedance/workspace-local/xxx，支持 ~）。不传则默认在本项目目录 ~/workspace-local/new_explore 下运行。Codex 的所有读写都以此为根。",
      },
    },
    required: ["prompt"],
  },
};

// 执行一次 codex exec。返回结构固定，包含工作目录，供模型/前端回显。
export async function runCodex({ prompt, working_dir }) {
  const startedAt = Date.now();
  // 不传则用默认目录；支持 ~ 展开。返回值里回显真正用到的目录。
  const resolvedDir = resolveDir(working_dir);
  const base = {
    working_dir: resolvedDir,
    exit_code: null,
    success: false,
    summary: "",
    duration_ms: 0,
    error: null,
  };

  if (!prompt || typeof prompt !== "string") {
    return { ...base, error: "缺少 prompt", duration_ms: Date.now() - startedAt };
  }
  if (!path.isAbsolute(resolvedDir)) {
    return {
      ...base,
      error: "working_dir 必须是绝对路径（或用 ~ 开头）",
      duration_ms: Date.now() - startedAt,
    };
  }

  // 用临时文件承接 codex 的最后一条总结（-o），跑完读出来当 summary。
  const workDir = await mkdtemp(path.join(tmpdir(), "codex-tool-"));
  const lastMsgFile = path.join(workDir, "last.txt");

  const args = [
    "exec",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "-m",
    CODEX_MODEL,
    "-c",
    `model_reasoning_effort="${CODEX_REASONING}"`,
    "-C",
    resolvedDir,
    "-o",
    lastMsgFile,
    prompt,
  ];

  return await new Promise((resolve) => {
    let stderr = "";
    let settled = false;
    const finish = async (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
      resolve(result);
    };

    // stdin 必须关闭：codex exec 若发现 stdin 是打开的管道，会把它当额外输入并阻塞等 EOF。
    // stdio = [ignore, pipe, pipe]：不给 stdin，正常收 stdout/stderr。
    const child = spawn(CODEX_BIN, args, {
      cwd: resolvedDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        ...base,
        error: `执行超时（>${CODEX_TIMEOUT_MS}ms），已终止`,
        duration_ms: Date.now() - startedAt,
      });
    }, CODEX_TIMEOUT_MS);

    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", (e) => {
      finish({
        ...base,
        error: `无法启动 codex：${e.message}`,
        duration_ms: Date.now() - startedAt,
      });
    });

    child.on("close", async (code) => {
      const summary = await readFile(lastMsgFile, "utf8").catch(() => "");
      finish({
        ...base,
        exit_code: code,
        success: code === 0,
        summary: summary.trim(),
        error: code === 0 ? null : stderr.trim().slice(-2000) || `退出码 ${code}`,
        duration_ms: Date.now() - startedAt,
      });
    });
  });
}
