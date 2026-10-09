import { pathToFileURL } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { startCodexTask } from "./codex-runner.mjs";
import { loadBridgeConfig } from "./config.mjs";
import { createMcpServer } from "./mcp-server.mjs";
import { terminateProcessTree } from "./process-manager.mjs";
import { recoverSessions } from "./recovery.mjs";
import * as reportWriter from "./report-writer.mjs";
import { createSessionManager } from "./session-manager.mjs";
import * as store from "./session-store.mjs";
import { createViewerServer } from "./viewer-server.mjs";

export async function createBridgeRuntime({
  config = loadBridgeConfig(),
  recover = recoverSessions
} = {}) {
  const recovery = await recover({ sessionRoot: config.sessionRoot });
  let manager;
  const viewer = await createViewerServer({
    sessionRoot: config.sessionRoot,
    onCancel: (sessionId) => manager.cancel({ sessionId })
  });
  const runner = {
    startTask(input) {
      return startCodexTask({
        ...input,
        codexPath: config.codexPath,
        nodePath: config.nodePath,
        sessionRoot: config.sessionRoot
      });
    },
    terminate(pid) {
      return terminateProcessTree(pid);
    }
  };
  manager = createSessionManager({
    config,
    store,
    runner,
    viewer,
    reportWriter
  });
  const mcpServer = createMcpServer({ manager });

  return {
    config,
    viewer,
    manager,
    mcpServer,
    recovery,
    async close() {
      await mcpServer.close().catch(() => {});
      await viewer.close();
    }
  };
}

async function main() {
  const runtime = await createBridgeRuntime();
  const transport = new StdioServerTransport();
  await runtime.mcpServer.connect(transport);
}

const entryPoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : null;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
