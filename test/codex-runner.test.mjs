import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCodexArgs,
  resolveCodexCommand,
  startCodexTask
} from "../src/codex-runner.mjs";
import {
  isProcessAlive,
  terminateProcessTree
} from "../src/process-manager.mjs";

const fixturePath = fileURLToPath(
  new URL("./fixtures/fake-codex.mjs", import.meta.url)
);

async function withTempRoot(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-codex-runner-"));
  try {
    return await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function makeSession(root) {
  const sessionRoot = path.join(root, "sessions");
  const sessionId = "session-1";
  const sessionDirectory = path.join(sessionRoot, sessionId);
  return {
    sessionRoot,
    session: {
      id: sessionId,
      repoPath: path.join(root, "project"),
      codex: {
        stdoutPath: path.join(sessionDirectory, "stdout.jsonl"),
        stderrPath: path.join(sessionDirectory, "stderr.log"),
        taskReportPath: path.join(sessionDirectory, "tasks", "T1.md")
      }
    }
  };
}

async function waitForFile(filePath, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

test("resolveCodexCommand runs JavaScript fixtures through Node", () => {
  assert.deepEqual(
    resolveCodexCommand({
      codexPath: fixturePath,
      nodePath: process.execPath
    }),
    {
      command: process.execPath,
      argsPrefix: [fixturePath]
    }
  );
});

test("buildCodexArgs includes JSON, sandbox controls, and no danger access", () => {
  const args = buildCodexArgs({
    repoPath: "C:\\work\\project",
    sandbox: "workspace-write",
    windowsSandboxMode: "unelevated",
    reportPath: "C:\\sessions\\T1.md"
  });

  assert.ok(args.includes("--json"));
  assert.ok(args.includes("workspace-write"));
  assert.ok(args.includes('windows.sandbox="unelevated"'));
  assert.ok(args.includes("mcp_servers.node_repl.enabled=false"));
  assert.equal(args.includes("danger-full-access"), false);
});

test("startCodexTask runs exactly one task with safe process options", async () => {
  await withTempRoot(async (root) => {
    const { sessionRoot, session } = makeSession(root);
    await fs.mkdir(session.repoPath, { recursive: true });
    const capturePath = path.join(root, "prompt.txt");
    const outputFile = path.join(root, "fake-output.txt");
    const spawnCalls = [];
    const normalizedEvents = [];

    const execution = startCodexTask({
      session,
      task: { id: "T1", title: "First task", body: "Write one file." },
      codexPath: fixturePath,
      nodePath: process.execPath,
      sessionRoot,
      onEvent: (event) => normalizedEvents.push(event),
      spawnImpl: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return spawn(command, args, options);
      },
      env: {
        ...process.env,
        FAKE_CODEX_SCENARIO: "success",
        FAKE_CODEX_CAPTURE_PATH: capturePath,
        FAKE_CODEX_OUTPUT_FILE: outputFile
      }
    });

    const result = await execution.completion;
    const prompt = await fs.readFile(capturePath, "utf8");

    assert.equal(result.status, "completed");
    assert.equal(await fs.readFile(outputFile, "utf8"), "fake task complete\n");
    assert.match(prompt, /T1/);
    assert.doesNotMatch(prompt, /T2/);
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].options.detached, true);
    assert.equal(spawnCalls[0].options.windowsHide, true);
    assert.ok(spawnCalls[0].args.includes("--json"));
    assert.ok(spawnCalls[0].args.includes('windows.sandbox="unelevated"'));
    assert.ok(
      spawnCalls[0].args.includes("mcp_servers.node_repl.enabled=false")
    );
    assert.equal(spawnCalls[0].args.includes("danger-full-access"), false);
    assert.deepEqual(
      normalizedEvents.map((event) => event.kind),
      ["command", "message"]
    );
    assert.match(await fs.readFile(execution.stdoutPath, "utf8"), /agent_message/);
  });
});

test("malformed JSONL does not reject task completion", async () => {
  await withTempRoot(async (root) => {
    const { sessionRoot, session } = makeSession(root);
    await fs.mkdir(session.repoPath, { recursive: true });
    const events = [];

    const execution = startCodexTask({
      session,
      task: { id: "T1", title: "Recover", body: "Ignore malformed lines." },
      codexPath: fixturePath,
      nodePath: process.execPath,
      sessionRoot,
      onEvent: (event) => events.push(event),
      env: {
        ...process.env,
        FAKE_CODEX_SCENARIO: "bad-json"
      }
    });

    const result = await execution.completion;

    assert.equal(result.status, "completed");
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "message");
  });
});

test("provider errors are classified as needs_user", async () => {
  await withTempRoot(async (root) => {
    const { sessionRoot, session } = makeSession(root);
    await fs.mkdir(session.repoPath, { recursive: true });

    const execution = startCodexTask({
      session,
      task: { id: "T1", title: "Provider", body: "Run the task." },
      codexPath: fixturePath,
      nodePath: process.execPath,
      sessionRoot,
      env: {
        ...process.env,
        FAKE_CODEX_SCENARIO: "provider-error"
      }
    });

    const result = await execution.completion;

    assert.equal(result.status, "needs_user");
    assert.equal(result.errorKind, "provider_error");
    assert.notEqual(result.status, "completed");
  });
});

test("cancellation terminates the hanging process tree", async () => {
  await withTempRoot(async (root) => {
    const { sessionRoot, session } = makeSession(root);
    await fs.mkdir(session.repoPath, { recursive: true });
    const startedFile = path.join(root, "started.txt");

    const execution = startCodexTask({
      session,
      task: { id: "T1", title: "Hang", body: "Stay running." },
      codexPath: fixturePath,
      nodePath: process.execPath,
      sessionRoot,
      env: {
        ...process.env,
        FAKE_CODEX_SCENARIO: "hang",
        FAKE_CODEX_STARTED_PATH: startedFile
      }
    });

    await waitForFile(startedFile);
    assert.equal(isProcessAlive(execution.pid), true);
    await terminateProcessTree(execution.pid);
    await execution.completion;

    assert.equal(isProcessAlive(execution.pid), false);
  });
});

test("danger-full-access appears only when explicitly supplied", () => {
  const args = buildCodexArgs({
    repoPath: "C:\\work\\project",
    sandbox: "danger-full-access",
    windowsSandboxMode: "unelevated",
    reportPath: "C:\\sessions\\T1.md"
  });

  assert.ok(args.includes("danger-full-access"));
});
