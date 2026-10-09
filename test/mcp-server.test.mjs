import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../src/mcp-server.mjs";
import { createSessionManager } from "../src/session-manager.mjs";
import * as reportWriter from "../src/report-writer.mjs";
import * as store from "../src/session-store.mjs";

const TOOL_NAMES = [
  "codex_start",
  "codex_watch",
  "codex_continue",
  "codex_retry",
  "codex_cancel",
  "codex_status",
  "codex_open_viewer"
];

function createFakeRunner() {
  const starts = [];
  const runs = new Map();
  const terminated = [];

  return {
    starts,
    terminated,
    startTask({ session, task, onEvent }) {
      const pid = 10_000 + starts.length + 1;
      let resolveCompletion;
      const completion = new Promise((resolve) => {
        resolveCompletion = resolve;
      });
      const run = {
        sessionId: session.id,
        taskId: task.id,
        pid,
        onEvent,
        completion,
        resolve: resolveCompletion
      };
      starts.push({ sessionId: session.id, taskId: task.id, pid });
      runs.set(`${session.id}:${task.id}`, run);

      queueMicrotask(() => {
        onEvent?.({
          kind: "message",
          text: `${task.id} started`,
          rawType: "test.started",
          timestamp: new Date().toISOString()
        });
      });

      return { pid, completion };
    },
    async complete(sessionId, taskId, result = {}, { beforeResolve } = {}) {
      const run = runs.get(`${sessionId}:${taskId}`);
      assert.ok(run, `No fake runner task for ${sessionId}:${taskId}`);
      if (beforeResolve) {
        await beforeResolve();
      }
      run.onEvent?.({
        kind: "command",
        text: `run ${taskId}`,
        rawType: "test.command",
        timestamp: new Date().toISOString()
      });
      run.resolve({
        taskId,
        status: "completed",
        exitCode: 0,
        summary: `${taskId} complete`,
        ...result
      });
    },
    async terminate(pid) {
      terminated.push(pid);
      const run = [...runs.values()].find((entry) => entry.pid === pid);
      if (run) {
        run.resolve({
          taskId: run.taskId,
          status: "failed",
          errorKind: "cancelled",
          exitCode: null
        });
      }
    }
  };
}

function createViewer() {
  const published = [];
  const opened = [];
  const viewer = {
    published,
    opened,
    urlFor(sessionId, token) {
      return `http://127.0.0.1:4567/view/${sessionId}?token=${token}`;
    },
    publish(sessionId, event) {
      published.push({ sessionId, event });
    },
    async open(sessionId, token) {
      opened.push({ sessionId, token });
    },
    async close() {}
  };
  return viewer;
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

async function createHarness({ viewer = createViewer() } = {}) {
  const root = await fs.mkdtemp(
    path.join(process.cwd(), ".tmp-mcp-server-")
  );
  const repoPath = path.join(root, "project");
  const sessionRoot = path.join(root, "sessions");
  await fs.mkdir(repoPath, { recursive: true });

  const runner = createFakeRunner();
  const manager = createSessionManager({
    config: {
      codexPath: "fake-codex",
      nodePath: process.execPath,
      sessionRoot,
      viewerHost: "127.0.0.1",
      viewerPort: 0,
      defaultSandbox: "workspace-write",
      windowsSandboxMode: "unelevated"
    },
    store,
    runner,
    viewer,
    reportWriter
  });
  const server = createMcpServer({ manager });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({
    name: "bridge-test-client",
    version: "1.0.0"
  });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport)
  ]);

  return {
    root,
    repoPath,
    sessionRoot,
    runner,
    viewer,
    manager,
    server,
    client,
    async cleanup() {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      await fs.rm(root, { recursive: true, force: true });
    }
  };
}

function structured(result) {
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.ok(result.structuredContent, "missing structuredContent");
  return result.structuredContent;
}

async function startSession(client, repoPath, overrides = {}) {
  const response = await client.callTool({
    name: "codex_start",
    arguments: {
      repoPath,
      planMarkdown: [
        "## T1 First",
        "Create one file.",
        "",
        "## T2 Second",
        "Create the next file."
      ].join("\n"),
      checkpointMode: "per_task",
      ...overrides
    }
  });
  return structured(response);
}

test("MCP exposes seven checkpoint tools and no generic shell", async () => {
  const harness = await createHarness();
  try {
    const listed = await harness.client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      [...TOOL_NAMES].sort()
    );
    assert.equal(listed.tools.some((tool) => /shell|exec/i.test(tool.name)), false);

    const descriptions = listed.tools
      .map((tool) => tool.description ?? "")
      .join("\n");
    assert.match(descriptions, /检查点/);
    assert.match(descriptions, /最终报告/);
    assert.match(descriptions, /继续/);
  } finally {
    await harness.cleanup();
  }
});

test("codex_start writes PLAN.md and starts only T1", async () => {
  const harness = await createHarness();
  try {
    const started = await startSession(harness.client, harness.repoPath);

    assert.equal(started.state, "running");
    assert.equal(started.task.id, "T1");
    assert.equal(started.nextAction, "call_codex_watch_again");
    assert.deepEqual(
      harness.runner.starts.map((entry) => entry.taskId),
      ["T1"]
    );
    assert.match(
      await fs.readFile(path.join(harness.repoPath, "PLAN.md"), "utf8"),
      /## T1 First/
    );
  } finally {
    await harness.cleanup();
  }
});

test("codex_start rejects duplicate active sessions and protects PLAN.md", async () => {
  const harness = await createHarness();
  try {
    await fs.writeFile(
      path.join(harness.repoPath, "PLAN.md"),
      "## T1 Existing\nDo not replace.",
      "utf8"
    );

    const needsConfirmation = await startSession(
      harness.client,
      harness.repoPath
    );
    assert.equal(needsConfirmation.nextAction, "ask_user_for_decision");
    assert.equal(harness.runner.starts.length, 0);
    assert.equal(
      await fs.readFile(path.join(harness.repoPath, "PLAN.md"), "utf8"),
      "## T1 Existing\nDo not replace."
    );

    const started = await startSession(harness.client, harness.repoPath, {
      overwritePlan: true
    });
    const duplicate = await harness.client.callTool({
      name: "codex_start",
      arguments: {
        repoPath: harness.repoPath,
        planMarkdown: "## T3 Duplicate\nDo not start.",
        checkpointMode: "per_task",
        overwritePlan: true
      }
    });

    assert.equal(started.state, "running");
    assert.equal(duplicate.isError, true);
    assert.match(duplicate.content[0].text, /active session/i);
    assert.equal(harness.runner.starts.length, 1);
  } finally {
    await harness.cleanup();
  }
});

test("codex_watch waits for T1, emits progress, and updates REPORT.md", async () => {
  const harness = await createHarness();
  try {
    const started = await startSession(harness.client, harness.repoPath);
    const progress = [];
    const watching = harness.client.callTool(
      {
        name: "codex_watch",
        arguments: {
          sessionId: started.sessionId,
          waitMs: 1_000
        }
      },
      undefined,
      {
        onprogress(notification) {
          progress.push(notification);
        }
      }
    );

    await waitFor(() => harness.runner.starts.length === 1);
    await harness.runner.complete(started.sessionId, "T1", {}, {
      beforeResolve: async () => {
        await fs.writeFile(
          path.join(harness.repoPath, "t1.txt"),
          "done\n",
          "utf8"
        );
      }
    });

    const watched = structured(await watching);

    assert.equal(watched.nextAction, "display_checkpoint_wait_for_user");
    assert.equal(watched.checkpoint.taskId, "T1");
    assert.equal(watched.checkpoint.status, "completed");
    assert.deepEqual(watched.checkpoint.changedFiles.created, ["t1.txt"]);
    assert.ok(progress.length >= 1);
    assert.match(
      await fs.readFile(path.join(harness.repoPath, "REPORT.md"), "utf8"),
      /T1/
    );
  } finally {
    await harness.cleanup();
  }
});

test("codex_continue starts T2 and rejects a duplicate continue", async () => {
  const harness = await createHarness();
  try {
    const started = await startSession(harness.client, harness.repoPath);
    await harness.runner.complete(started.sessionId, "T1");
    await harness.client.callTool({
      name: "codex_watch",
      arguments: { sessionId: started.sessionId, waitMs: 1_000 }
    });

    const continued = structured(
      await harness.client.callTool({
        name: "codex_continue",
        arguments: { sessionId: started.sessionId }
      })
    );
    const duplicate = await harness.client.callTool({
      name: "codex_continue",
      arguments: { sessionId: started.sessionId }
    });

    assert.equal(continued.task.id, "T2");
    assert.equal(continued.state, "running");
    assert.equal(duplicate.isError, true);
    assert.deepEqual(
      harness.runner.starts.map((entry) => entry.taskId),
      ["T1", "T2"]
    );
  } finally {
    await harness.cleanup();
  }
});

test("the final watch returns the complete report", async () => {
  const harness = await createHarness();
  try {
    const started = await startSession(harness.client, harness.repoPath);
    await harness.runner.complete(started.sessionId, "T1");
    await harness.client.callTool({
      name: "codex_watch",
      arguments: { sessionId: started.sessionId, waitMs: 1_000 }
    });
    await harness.client.callTool({
      name: "codex_continue",
      arguments: { sessionId: started.sessionId }
    });
    await waitFor(() => harness.runner.starts.length === 2);
    await harness.runner.complete(started.sessionId, "T2");

    const response = await harness.client.callTool({
      name: "codex_watch",
      arguments: { sessionId: started.sessionId, waitMs: 1_000 }
    });
    const final = structured(response);

    assert.equal(final.state, "completed");
    assert.equal(final.nextAction, "display_final_report");
    assert.match(final.report, /T1/);
    assert.match(final.report, /T2/);
    assert.match(response.content[0].text, /T2/);
  } finally {
    await harness.cleanup();
  }
});

test("viewer publish failures do not fail the Codex task", async () => {
  const viewer = createViewer();
  viewer.publish = () => {
    throw new Error("viewer unavailable");
  };
  const harness = await createHarness({ viewer });
  try {
    const started = await startSession(harness.client, harness.repoPath);
    await harness.runner.complete(started.sessionId, "T1");

    const watched = structured(
      await harness.client.callTool({
        name: "codex_watch",
        arguments: { sessionId: started.sessionId, waitMs: 1_000 }
      })
    );

    assert.equal(watched.nextAction, "display_checkpoint_wait_for_user");
    assert.equal(watched.checkpoint.taskId, "T1");
  } finally {
    await harness.cleanup();
  }
});

test("codex_cancel terminates the running task and preserves checkpoints", async () => {
  const harness = await createHarness();
  try {
    const started = await startSession(harness.client, harness.repoPath);
    await harness.runner.complete(started.sessionId, "T1");
    await harness.client.callTool({
      name: "codex_watch",
      arguments: { sessionId: started.sessionId, waitMs: 1_000 }
    });
    await harness.client.callTool({
      name: "codex_continue",
      arguments: { sessionId: started.sessionId }
    });
    await waitFor(() => harness.runner.starts.length === 2);

    const cancelled = structured(
      await harness.client.callTool({
        name: "codex_cancel",
        arguments: { sessionId: started.sessionId }
      })
    );
    const status = structured(
      await harness.client.callTool({
        name: "codex_status",
        arguments: { sessionId: started.sessionId }
      })
    );

    assert.equal(cancelled.state, "cancelled");
    assert.equal(status.state, "cancelled");
    assert.equal(harness.runner.terminated.length, 1);
    assert.equal(status.tasks.find((task) => task.id === "T1").status, "completed");
    assert.equal(status.tasks.find((task) => task.id === "T2").status, "pending");
  } finally {
    await harness.cleanup();
  }
});

test("tool results never include the raw JSONL log", async () => {
  const harness = await createHarness();
  try {
    const started = await startSession(harness.client, harness.repoPath);
    const session = await store.loadSession(
      harness.sessionRoot,
      started.sessionId
    );
    await fs.mkdir(path.dirname(session.codex.stdoutPath), {
      recursive: true
    });
    await fs.writeFile(
      session.codex.stdoutPath,
      '{"secret":"raw-jsonl-marker"}\n',
      "utf8"
    );
    await harness.runner.complete(started.sessionId, "T1");

    const response = await harness.client.callTool({
      name: "codex_watch",
      arguments: { sessionId: started.sessionId, waitMs: 1_000 }
    });

    assert.doesNotMatch(JSON.stringify(response), /raw-jsonl-marker/);
  } finally {
    await harness.cleanup();
  }
});
