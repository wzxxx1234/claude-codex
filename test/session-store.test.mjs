import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writeFileAtomic } from "../src/atomic-write.mjs";
import {
  InvalidStateTransitionError,
  transitionSession
} from "../src/state-machine.mjs";
import {
  appendSessionEvent,
  createSession,
  findActiveSessionByProject,
  loadSession,
  saveSession
} from "../src/session-store.mjs";

async function withTempRoot(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-session-store-"));
  try {
    return await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("state transitions allow the planned task flow", () => {
  const created = { state: "created" };
  const running = transitionSession(created, "running");
  const waiting = transitionSession(running, "waiting_user");

  assert.equal(created.state, "created");
  assert.equal(running.state, "running");
  assert.equal(waiting.state, "waiting_user");
  assert.throws(
    () => transitionSession(waiting, "completed"),
    InvalidStateTransitionError
  );
});

test("session JSON survives save and load", async () => {
  await withTempRoot(async (root) => {
    const session = await createSession({
      sessionRoot: root,
      repoPath: path.join(root, "project"),
      projectId: "0123456789abcdef",
      planMarkdown: "## T1 First\nDo A",
      tasks: [{ id: "T1", title: "First", body: "Do A", ordinal: 0 }]
    });

    await saveSession(root, session);
    const loaded = await loadSession(root, session.id);

    assert.deepEqual(loaded, session);
  });
});

test("appending events writes valid JSONL", async () => {
  await withTempRoot(async (root) => {
    const session = await createSession({
      sessionRoot: root,
      repoPath: path.join(root, "project"),
      projectId: "0123456789abcdef",
      planMarkdown: "## T1 First\nDo A",
      tasks: [{ id: "T1", title: "First", body: "Do A", ordinal: 0 }]
    });
    await saveSession(root, session);

    await appendSessionEvent(root, session.id, { kind: "status", text: "started" });
    await appendSessionEvent(root, session.id, { kind: "command", text: "npm test" });

    const text = await fs.readFile(
      path.join(root, session.id, "events.jsonl"),
      "utf8"
    );
    const events = text
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));

    assert.deepEqual(events, [
      { kind: "status", text: "started" },
      { kind: "command", text: "npm test" }
    ]);
  });
});

test("findActiveSessionByProject ignores completed and cancelled sessions", async () => {
  await withTempRoot(async (root) => {
    const { session: active } = await createStoredSession(root, {
      projectId: "active-project"
    });
    const { session: completed } = await createStoredSession(root, {
      projectId: "active-project",
      state: "completed"
    });
    const { session: cancelled } = await createStoredSession(root, {
      projectId: "active-project",
      state: "cancelled"
    });

    const found = await findActiveSessionByProject(root, "active-project");

    assert.equal(found.id, active.id);
    assert.notEqual(found.id, completed.id);
    assert.notEqual(found.id, cancelled.id);
  });
});

test("atomic writes replace a complete JSON file", async () => {
  await withTempRoot(async (root) => {
    const target = path.join(root, "session.json");

    for (let index = 0; index < 20; index += 1) {
      const payload = JSON.stringify({ index, values: "x".repeat(50_000) });
      await writeFileAtomic(target, payload);
      const written = await fs.readFile(target, "utf8");
      assert.equal(JSON.parse(written).index, index);
    }

    const entries = await fs.readdir(root);
    assert.deepEqual(entries, ["session.json"]);
  });
});

async function createStoredSession(
  root,
  { projectId, state = "created" }
) {
  const session = await createSession({
    sessionRoot: root,
    repoPath: path.join(root, "project"),
    projectId,
    planMarkdown: "## T1 First\nDo A",
    tasks: [{ id: "T1", title: "First", body: "Do A", ordinal: 0 }]
  });
  session.state = state;
  await saveSession(root, session);
  return { session };
}
