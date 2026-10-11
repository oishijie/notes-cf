/**
 * 本地开发启动器：同时拉起 Vite（前端热更新）与 Wrangler（Workers 运行时）。
 *
 * 与旧版 Docker/Express 方案的差异：后端不再是 `tsx watch server/index.ts`，
 * 而是 Cloudflare 官方的本地 Workers 运行时 `wrangler dev`，它同样连接本地的
 * D1 与 R2 模拟器，因此本地行为与线上一致。
 *
 * 首次使用前请先初始化本地 D1：npm run db:local
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const environmentPath = path.join(rootDir, ".env");

if (existsSync(environmentPath)) {
  loadEnvFile(environmentPath);
}

const binaryExtension = process.platform === "win32" ? ".cmd" : "";
const binDir = path.join(rootDir, "node_modules", ".bin");
const frontendPort = process.env.VITE_PORT || "15173";
const workerPort = process.env.WORKER_PORT || "8787";
const extraFrontendArgs = process.argv.slice(2);

const commands = [
  {
    label: "worker",
    command: path.join(binDir, `wrangler${binaryExtension}`),
    args: ["dev", "--port", workerPort, "--local"],
    env: process.env,
  },
  {
    label: "frontend",
    command: path.join(binDir, `vite${binaryExtension}`),
    args: [
      "--host",
      "127.0.0.1",
      "--port",
      frontendPort,
      "--strictPort",
      ...extraFrontendArgs,
    ],
    env: process.env,
  },
];

const children = [];
let shuttingDown = false;
let exitCode = 0;

function stopChildren(signal = "SIGTERM") {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of children) {
    if (child.exitCode == null && child.signalCode == null) {
      child.kill(signal);
    }
  }
}

for (const entry of commands) {
  const child = spawn(entry.command, entry.args, {
    cwd: rootDir,
    env: entry.env,
    shell: process.platform === "win32",
    stdio: "inherit",
  });

  children.push(child);

  child.on("error", (error) => {
    console.error(`[dev:${entry.label}] 启动失败`, error);
    exitCode = 1;
    stopChildren();
  });

  child.on("exit", (code, signal) => {
    if (!shuttingDown) {
      exitCode = code || (signal ? 1 : 0);
      console.error(
        `[dev:${entry.label}] 已退出${signal ? `（${signal}）` : `（code ${code ?? 0}）`}`,
      );
      stopChildren();
    }

    if (
      children.every(
        (candidate) => candidate.exitCode != null || candidate.signalCode != null,
      )
    ) {
      process.exit(exitCode);
    }
  });
}

process.on("SIGINT", () => {
  exitCode = 130;
  stopChildren("SIGINT");
});

process.on("SIGTERM", () => {
  stopChildren("SIGTERM");
});
