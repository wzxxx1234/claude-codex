import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  installClaudeBridge,
  restoreClaudeBridge
} from "../src/claude-config.mjs";

async function createFixture(initialConfig) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-claude-config-"));
  const configPath = path.join(directory, "claude_desktop_config.json");
  await fs.writeFile(
    configPath,
    `${JSON.stringify(initialConfig, null, 2)}\n`,
    "utf8"
  );
  return { directory, configPath };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

test("install preserves preferences and other MCP servers with a timestamped backup", async () => {
  const initial = {
    preferences: { theme: "dark", language: "zh-CN" },
    mcpServers: {
      existing: { command: "existing.exe", args: ["--keep"] },
      "claude-codex-bridge": { command: "old-node.exe", args: ["old.mjs"] }
    }
  };
  const { configPath } = await createFixture(initial);
  const nodePath = "C:\\Program Files\\nodejs\\node.exe";
  const bridgeServerPath = "C:\\bridge\\src\\server.mjs";

  const result = await installClaudeBridge({
    configPath,
    nodePath,
    bridgeServerPath
  });

  assert.equal(result.changed, true);
  assert.match(
    path.basename(result.backupPath),
    /^claude_desktop_config\.json\.backup-\d{8}T\d{9}Z$/
  );
  assert.deepEqual(await readJson(result.backupPath), initial);

  const installed = await readJson(configPath);
  assert.deepEqual(installed.preferences, initial.preferences);
  assert.deepEqual(installed.mcpServers.existing, initial.mcpServers.existing);
  assert.deepEqual(installed.mcpServers["claude-codex-bridge"], {
    command: nodePath,
    args: [bridgeServerPath]
  });
});

test("installing twice is idempotent and does not create another backup", async () => {
  const { directory, configPath } = await createFixture({
    preferences: { theme: "light" }
  });
  const input = {
    configPath,
    nodePath: "C:\\node.exe",
    bridgeServerPath: "C:\\bridge\\server.mjs"
  };

  const first = await installClaudeBridge(input);
  const beforeSecondInstall = await fs.readFile(configPath, "utf8");
  const second = await installClaudeBridge(input);
  const afterSecondInstall = await fs.readFile(configPath, "utf8");
  const backups = (await fs.readdir(directory)).filter((name) =>
    name.includes(".backup-")
  );

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(second.backupPath, null);
  assert.equal(afterSecondInstall, beforeSecondInstall);
  assert.equal(backups.length, 1);
});

test("restore returns the exact previous JSON object", async () => {
  const initial = {
    preferences: { theme: "dark" },
    mcpServers: { existing: { command: "keep.exe" } }
  };
  const { configPath } = await createFixture(initial);
  const installed = await installClaudeBridge({
    configPath,
    nodePath: "C:\\node.exe",
    bridgeServerPath: "C:\\bridge\\server.mjs"
  });

  const restored = await restoreClaudeBridge({
    configPath,
    backupPath: installed.backupPath
  });

  assert.equal(restored.restored, true);
  assert.deepEqual(restored.config, initial);
  assert.deepEqual(await readJson(configPath), initial);
});

test("invalid JSON is rejected without modifying the file", async () => {
  const { directory, configPath } = await createFixture({});
  const invalidText = "{\"preferences\":";
  await fs.writeFile(configPath, invalidText, "utf8");

  await assert.rejects(
    installClaudeBridge({
      configPath,
      nodePath: "C:\\node.exe",
      bridgeServerPath: "C:\\bridge\\server.mjs"
    }),
    /Invalid Claude configuration JSON/
  );

  assert.equal(await fs.readFile(configPath, "utf8"), invalidText);
  assert.deepEqual(await fs.readdir(directory), ["claude_desktop_config.json"]);
});
