import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { recoverSessions } from "../src/recovery.mjs";
import { createBridgeRuntime } from "../src/server.mjs";
import {
  createSession,
  loadSession,
  saveSession
} from "../src/session-store.mjs";

async function withTempRoot(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-recovery-"));
  try {
    return await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function createStoredSession(root) {
  const sessionRoot = path.join(root, "sessions");
  const session = await createSession({
    sessionRoot,
    repoPath: path.join(root, "project"),
    projectId: "project-1",
    planMarkdown: "## T1 First\nDo A.\n\n## T2 Second\nDo B.",
    tasks: [
      { id: "T1", title: "First", body: "Do A.", ordinal: 0 },
      { id: "T2", title: "Second", body: "Do B.", ordinal: 1 }
    ]
  });
  return { sessionRoot, session };
}

test("a running session with a live PID is resumed", async () => {
  await withTempRoot(async (root) => {
    const { sessionRoot, session } = await createStoredSession(root);
    await saveSession(sessionRoot, {
      ...session,
      state: "running",
      tasks: session.tasks.map((task, index) => ({
        ...task,
        status: index === 0 ? "running" : "pending"
      })),
      codex: { ...session.codex, pid: 1111 }
    });

    const result = await recoverSessions({
      sessionRoot,
      isProcessAlive: (pid) => pid === 1111
    });
    const loaded = await loadSession(sessionRoot, session.id);

    assert.deepEqual(result.resumed, [session.id]);
    assert.deepEqual(result.interrupted, []);
    assert.equal(loaded.state, "running");
    assert.equal(loaded.tasks[0].status, "running");
  });
});

test("a running session with a dead PID becomes interrupted without resetting completed tasks", async () => {
  await withTempRoot(async (root) => {
    const { sessionRoot, session } = await createStoredSession(root);
    await saveSession(sessionRoot, {
      ...session,
      state: "running",
      currentTaskIndex: 1,
      tasks: session.tasks.map((task, index) => ({
        ...task,
        status: index === 0 ? "completed" : "running"
      })),
      codex: { ...session.codex, pid: 2222 }
    });

    const result = await recoverSessions({
      sessionRoot,
      isProcessAlive: () => false
    });
    const loaded = await loadSession(sessionRoot, session.id);

    assert.deepEqual(result.interrupted, [session.id]);
    assert.equal(loaded.state, "interrupted");
    assert.equal(loaded.codex.pid, null);
    assert.equal(loaded.tasks[0].status, "completed");
    assert.equal(loaded.tasks[1].status, "pending");
  });
});

test("a waiting session stays waiting_user", async () => {
  await withTempRoot(async (root) => {
    const { sessionRoot, session } = await createStoredSession(root);
    await saveSession(sessionRoot, {
      ...session,
      state: "waiting_user",
      tasks: session.tasks.map((task, index) => ({
        ...task,
        status: index === 0 ? "completed" : "pending"
      })),
      checkpoint: { taskId: "T1", status: "completed" }
    });

    const result = await recoverSessions({
      sessionRoot,
      isProcessAlive: () => {
        throw new Error("waiting sessions should not check process liveness");
      }
    });
    const loaded = await loadSession(sessionRoot, session.id);

    assert.deepEqual(result.resumed, []);
    assert.deepEqual(result.interrupted, []);
    assert.equal(loaded.state, "waiting_user");
    assert.equal(loaded.tasks[0].status, "completed");
  });
});

test("completed sessions and tasks are reported without being reset", async () => {
  await withTempRoot(async (root) => {
    const { sessionRoot, session } = await createStoredSession(root);
    await saveSession(sessionRoot, {
      ...session,
      state: "completed",
      tasks: session.tasks.map((task) => ({
        ...task,
        status: "completed"
      }))
    });

    const result = await recoverSessions({
      sessionRoot,
      isProcessAlive: () => false
    });
    const loaded = await loadSession(sessionRoot, session.id);

    assert.deepEqual(result.completed, [session.id]);
    assert.deepEqual(result.resumed, []);
    assert.deepEqual(result.interrupted, []);
    assert.equal(loaded.state, "completed");
    assert.deepEqual(
      loaded.tasks.map((task) => task.status),
      ["completed", "completed"]
    );
  });
});

test("bridge runtime recovers running sessions during startup", async () => {
  await withTempRoot(async (root) => {
    const { sessionRoot, session } = await createStoredSession(root);
    await saveSession(sessionRoot, {
      ...session,
      state: "running",
      tasks: session.tasks.map((task, index) => ({
        ...task,
        status: index === 0 ? "running" : "pending"
      })),
      codex: { ...session.codex, pid: 2_147_483_647 }
    });

    const runtime = await createBridgeRuntime({
      config: {
        codexPath: "codex.exe",
        nodePath: process.execPath,
        sessionRoot,
        viewerHost: "127.0.0.1",
        viewerPort: 0,
        defaultSandbox: "workspace-write",
        windowsSandboxMode: "unelevated"
      }
    });

    try {
      const loaded = await loadSession(sessionRoot, session.id);
      assert.equal(loaded.state, "interrupted");
    } finally {
      await runtime.close();
    }
  });
});
