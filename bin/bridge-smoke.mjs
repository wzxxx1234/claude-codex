import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadBridgeConfig } from "../src/config.mjs";
import { createViewerServer } from "../src/viewer-server.mjs";

// Mirrors BRIDGE_SERVER_NAME in src/claude-config.mjs.
const BRIDGE_SERVER_NAME = "claude-codex-bridge";
const DEFAULT_PROVIDER_HOST = "127.0.0.1";
const DEFAULT_PROVIDER_PORT = 15721;
const PROVIDER_TIMEOUT_MS = 1500;

function existingFile(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  if (!path.isAbsolute(value)) {
    return null;
  }
  try {
    return fs.statSync(value).isFile() ? value : null;
  } catch {
    return null;
  }
}

async function checkSessionRoot(sessionRoot) {
  const probePath = path.join(sessionRoot, ".smoke-probe");
  try {
    await fsp.mkdir(sessionRoot, { recursive: true });
    await fsp.writeFile(probePath, "ok", "utf8");
    await fsp.rm(probePath, { force: true });
    return "ok";
  } catch {
    return "unwritable";
  }
}

function checkClaudeConfig({ configPath, nodePath, bridgeServerPath }) {
  let text;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return "not installed";
    }
    return "unreadable";
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "invalid";
  }

  const entry = parsed?.mcpServers?.[BRIDGE_SERVER_NAME];
  if (!entry || typeof entry !== "object") {
    return "not installed";
  }

  const pointsAtCurrentPaths =
    entry.command === nodePath &&
    Array.isArray(entry.args) &&
    path.resolve(String(entry.args[0] ?? "")) === path.resolve(bridgeServerPath);
  return pointsAtCurrentPaths ? "installed" : "stale";
}

async function checkViewer(sessionRoot) {
  const viewer = await createViewerServer({
    sessionRoot,
    onCancel: () => {}
  });
  try {
    const probeUrl = `http://${viewer.host}:${viewer.port}/view/smoke-probe?token=smoke-probe`;
    const response = await fetch(probeUrl);
    return `${viewer.host}:${viewer.port} ok (http ${response.status})`;
  } finally {
    await viewer.close();
  }
}

function checkProvider(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (reachable) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(PROVIDER_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function main() {
  const config = loadBridgeConfig();
  const bridgeServerPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "server.mjs"
  );
  const providerHost =
    process.env.CODEX_BRIDGE_PROVIDER_HOST ?? DEFAULT_PROVIDER_HOST;
  const providerPort =
    Number.parseInt(
      process.env.CODEX_BRIDGE_PROVIDER_PORT ?? String(DEFAULT_PROVIDER_PORT),
      10
    ) || DEFAULT_PROVIDER_PORT;

  const nodePath = existingFile(config.nodePath);
  const codexPath = existingFile(config.codexPath);
  const sessionRootStatus = await checkSessionRoot(config.sessionRoot);
  const claudeConfigStatus = checkClaudeConfig({
    configPath: config.claudeConfigPath,
    nodePath: config.nodePath,
    bridgeServerPath
  });
  const viewerStatus = await checkViewer(config.sessionRoot).catch(
    (error) => `failed (${error instanceof Error ? error.message : String(error)})`
  );
  const providerReachable = await checkProvider(providerHost, providerPort);

  const failures = [];
  if (!nodePath) {
    failures.push("Node 可执行文件未找到");
  }
  if (!codexPath) {
    failures.push(`Codex 可执行文件未找到（${config.codexPath}）`);
  }
  if (sessionRootStatus !== "ok") {
    failures.push("会话目录不可写");
  }

  const warnings = [];
  if (claudeConfigStatus !== "installed") {
    warnings.push(
      `Claude 配置状态 ${claudeConfigStatus}，运行 npm run install-claude 后重启 Claude 桌面版`
    );
  }
  if (typeof viewerStatus !== "string" || !viewerStatus.includes("ok")) {
    warnings.push(`本地查看页面检查失败：${viewerStatus}`);
  }
  if (!providerReachable) {
    warnings.push(
      `中转服务 ${providerHost}:${providerPort} 暂时连不上，请确认它已启动（例如 cc-switch.exe）`
    );
  }

  const lines = [
    "Claude Codex Bridge 自检",
    `node: ${config.nodePath} (${nodePath ? "ok" : "missing"})`,
    `codex: ${config.codexPath} (${codexPath ? "ok" : "missing"})`,
    `session root: ${config.sessionRoot} (${sessionRootStatus})`,
    `claude config: ${config.claudeConfigPath} (${claudeConfigStatus})`,
    `viewer: ${viewerStatus}`,
    providerReachable
      ? `provider: reachable at ${providerHost}:${providerPort}`
      : `provider: warning: ${providerHost}:${providerPort} unreachable`,
    failures.length === 0
      ? "result: ok（本地路径全部就绪）"
      : `result: failed（${failures.join("；")}）`
  ];
  for (const warning of warnings) {
    lines.push(`warning: ${warning}`);
  }

  console.log(lines.join("\n"));
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`自检失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
