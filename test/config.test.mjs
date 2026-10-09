import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadBridgeConfig } from "../src/config.mjs";

test("loadBridgeConfig uses localhost and the known Windows defaults", () => {
  const config = loadBridgeConfig({
    LOCALAPPDATA: "C:\\Users\\Baby\\AppData\\Local",
    APPDATA: "C:\\Users\\Baby\\AppData\\Roaming",
    PROGRAMFILES: "C:\\Program Files"
  });

  assert.equal(config.viewerHost, "127.0.0.1");
  assert.equal(config.viewerPort, 0);
  assert.equal(config.defaultSandbox, "workspace-write");
  assert.equal(config.windowsSandboxMode, "unelevated");
  assert.match(config.sessionRoot, /ClaudeCodexBridge\\sessions$/);
  assert.match(config.claudeConfigPath, /Claude\\claude_desktop_config\.json$/);
});

test("loadBridgeConfig prefers the active Claude 3p config when present", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-config-"));
  const localAppData = path.join(root, "Local");
  const appData = path.join(root, "Roaming");
  const activeConfig = path.join(
    localAppData,
    "Claude-3p",
    "claude_desktop_config.json"
  );

  try {
    fs.mkdirSync(path.dirname(activeConfig), { recursive: true });
    fs.writeFileSync(activeConfig, "{}\n", "utf8");

    const config = loadBridgeConfig({
      LOCALAPPDATA: localAppData,
      APPDATA: appData,
      PATH: process.env.PATH
    });

    assert.equal(config.claudeConfigPath, activeConfig);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
