import fs from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "./atomic-write.mjs";

const BRIDGE_SERVER_NAME = "claude-codex-bridge";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
}

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.(\d{3})Z$/, "$1Z");
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function createBackup(configPath, originalBytes) {
  const basePath = `${configPath}.backup-${timestamp()}`;
  let backupPath = basePath;
  let suffix = 1;
  while (await pathExists(backupPath)) {
    backupPath = `${basePath}-${suffix}`;
    suffix += 1;
  }
  await writeFileAtomic(backupPath, originalBytes);
  return backupPath;
}

function parseConfig(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid Claude configuration JSON: ${error.message}`, {
      cause: error
    });
  }
  if (!isPlainObject(parsed)) {
    throw new Error("Invalid Claude configuration JSON: root must be an object");
  }
  return parsed;
}

function sameEntry(left, right) {
  return (
    isPlainObject(left) &&
    left.command === right.command &&
    Array.isArray(left.args) &&
    left.args.length === right.args.length &&
    left.args.every((value, index) => value === right.args[index])
  );
}

export async function installClaudeBridge({
  configPath,
  nodePath,
  bridgeServerPath
}) {
  requireString(configPath, "configPath");
  requireString(nodePath, "nodePath");
  requireString(bridgeServerPath, "bridgeServerPath");

  let originalBytes;
  try {
    originalBytes = await fs.readFile(configPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    originalBytes = Buffer.from("{}\n", "utf8");
  }

  const originalText = originalBytes.toString("utf8");
  const current = parseConfig(originalText);
  const currentServers = isPlainObject(current.mcpServers)
    ? current.mcpServers
    : {};
  const server = {
    command: nodePath,
    args: [bridgeServerPath]
  };

  if (sameEntry(currentServers[BRIDGE_SERVER_NAME], server)) {
    return {
      configPath,
      backupPath: null,
      changed: false,
      server
    };
  }

  const next = {
    ...current,
    mcpServers: {
      ...currentServers,
      [BRIDGE_SERVER_NAME]: server
    }
  };
  const nextText = `${JSON.stringify(next, null, 2)}\n`;
  const backupPath = await createBackup(configPath, originalBytes);
  await writeFileAtomic(configPath, nextText);

  return {
    configPath,
    backupPath,
    changed: true,
    server
  };
}

export async function restoreClaudeBridge({ configPath, backupPath }) {
  requireString(configPath, "configPath");
  requireString(backupPath, "backupPath");

  const backupBytes = await fs.readFile(backupPath);
  const config = parseConfig(backupBytes.toString("utf8"));
  await writeFileAtomic(configPath, backupBytes);

  return {
    configPath,
    backupPath,
    restored: true,
    config
  };
}
