import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { restoreClaudeBridge } from "../src/claude-config.mjs";
import { loadBridgeConfig } from "../src/config.mjs";

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] ?? null;
}

async function latestBackup(configPath) {
  const directory = path.dirname(configPath);
  const prefix = `${path.basename(configPath)}.backup-`;
  const names = (await fs.readdir(directory))
    .filter((name) => name.startsWith(prefix))
    .sort();
  if (names.length === 0) {
    throw new Error(`找不到备份文件：${directory}${path.sep}${prefix}*`);
  }
  return path.join(directory, names.at(-1));
}

try {
  const configPath =
    optionValue("--config") ?? loadBridgeConfig().claudeConfigPath;
  const backupPath =
    optionValue("--backup") ?? (await latestBackup(configPath));
  const result = await restoreClaudeBridge({ configPath, backupPath });

  console.log("Claude Desktop 配置已恢复。");
  console.log(`配置文件：${result.configPath}`);
  console.log(`来源备份：${result.backupPath}`);
} catch (error) {
  console.error(`恢复失败：${error.message}`);
  process.exitCode = 1;
}
