import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { installClaudeBridge } from "../src/claude-config.mjs";
import { loadBridgeConfig } from "../src/config.mjs";

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] ?? null;
}

try {
  const config = loadBridgeConfig();
  const configPath = optionValue("--config") ?? config.claudeConfigPath;
  const bridgeServerPath =
    optionValue("--server") ??
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "src",
      "server.mjs"
    );
  const result = await installClaudeBridge({
    configPath,
    nodePath: config.nodePath,
    bridgeServerPath
  });

  if (result.changed) {
    console.log("Claude Desktop 配置已更新。");
    console.log(`备份文件：${result.backupPath}`);
  } else {
    console.log("Claude Desktop 配置已是最新，无需修改。");
  }
  console.log(`配置文件：${result.configPath}`);
} catch (error) {
  console.error(`安装失败：${error.message}`);
  process.exitCode = 1;
}
