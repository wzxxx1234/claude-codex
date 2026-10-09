import test from "node:test";
import assert from "node:assert/strict";

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
