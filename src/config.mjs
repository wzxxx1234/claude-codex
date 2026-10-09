import fs from "node:fs";
import path from "node:path";

const CODEX_FALLBACK_ROOT = ["OpenAI", "Codex", "bin"];

function pathEntries(value) {
  if (!value) {
    return [];
  }
  return value.split(path.delimiter).filter(Boolean);
}

function findNewestCodexExecutable(root) {
  if (!root || !fs.existsSync(root)) {
    return null;
  }

  const stack = [root];
  const matches = [];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase() === "codex.exe") {
        const stat = fs.statSync(fullPath);
        matches.push({ fullPath, mtimeMs: stat.mtimeMs });
      }
    }
  }

  matches.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return matches[0]?.fullPath ?? null;
}

export function resolveCodexPath(env = process.env) {
  if (env.CODEX_PATH && fs.existsSync(env.CODEX_PATH)) {
    return env.CODEX_PATH;
  }

  for (const entry of pathEntries(env.PATH)) {
    const candidate = path.join(entry, "codex.exe");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const fallbackRoot = path.join(env.LOCALAPPDATA ?? "", ...CODEX_FALLBACK_ROOT);
  return findNewestCodexExecutable(fallbackRoot) ?? "codex.exe";
}

export function loadBridgeConfig(env = process.env) {
  const source = { ...process.env, ...env };
  const localAppData = source.LOCALAPPDATA ?? path.join(source.USERPROFILE ?? "", "AppData", "Local");
  const appData = source.APPDATA ?? path.join(source.USERPROFILE ?? "", "AppData", "Roaming");
  const claude3pConfigPath = path.join(
    localAppData,
    "Claude-3p",
    "claude_desktop_config.json"
  );
  const claudeConfigPath =
    source.CLAUDE_DESKTOP_CONFIG_PATH ??
    (fs.existsSync(claude3pConfigPath)
      ? claude3pConfigPath
      : path.join(appData, "Claude", "claude_desktop_config.json"));

  return {
    codexPath: resolveCodexPath(source),
    nodePath: source.CODEX_NODE_PATH ?? process.execPath,
    sessionRoot: path.join(localAppData, "ClaudeCodexBridge", "sessions"),
    claudeConfigPath,
    viewerHost: "127.0.0.1",
    viewerPort: 0,
    defaultSandbox: "workspace-write",
    windowsSandboxMode: "unelevated"
  };
}
