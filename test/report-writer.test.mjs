import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildTaskCheckpoint,
  createProjectSnapshot,
  diffProjectSnapshot,
  renderReport,
  writeTaskReport
} from "../src/report-writer.mjs";

async function withTempRoot(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-report-writer-"));
  try {
    return await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("project snapshots detect created, modified, and deleted files", async () => {
  await withTempRoot(async (root) => {
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
    await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
    await fs.writeFile(path.join(root, ".git", "ignored"), "ignored");
    await fs.writeFile(path.join(root, "node_modules", "ignored"), "ignored");
    await fs.writeFile(path.join(root, "kept.txt"), "before");
    await fs.writeFile(path.join(root, "removed.txt"), "remove me");

    const before = await createProjectSnapshot(root);
    await fs.writeFile(path.join(root, "kept.txt"), "after");
    await fs.rm(path.join(root, "removed.txt"));
    await fs.writeFile(path.join(root, "created.txt"), "new");
    const after = await createProjectSnapshot(root);
    const diff = diffProjectSnapshot(before, after);

    assert.deepEqual(diff.created, ["created.txt"]);
    assert.deepEqual(diff.modified, ["kept.txt"]);
    assert.deepEqual(diff.deleted, ["removed.txt"]);
    assert.equal([...after.keys()].some((file) => file.startsWith(".git")), false);
    assert.equal(
      [...after.keys()].some((file) => file.startsWith("node_modules")),
      false
    );
  });
});

test("a completed checkpoint contains task, files, commands, and verification", () => {
  const checkpoint = buildTaskCheckpoint({
    session: { id: "session-1" },
    task: { id: "T1", title: "Build feature" },
    taskResult: {
      status: "completed",
      summary: "Feature built",
      commands: [{ command: "npm test", result: "pass" }],
      verification: [{ command: "npm test", result: "12/12 pass" }],
      openItems: []
    },
    changedFiles: {
      created: ["created.txt"],
      modified: ["kept.txt"],
      deleted: ["removed.txt"]
    }
  });

  assert.equal(checkpoint.taskId, "T1");
  assert.equal(checkpoint.status, "completed");
  assert.deepEqual(checkpoint.changedFiles.modified, ["kept.txt"]);
  assert.equal(checkpoint.commands[0].command, "npm test");
  assert.equal(checkpoint.verification[0].result, "12/12 pass");
});

test("renderReport includes every task exactly once and preserves blocked status", () => {
  const report = renderReport({
    id: "session-1",
    summary: "Two tasks",
    tasks: [
      {
        id: "T1",
        title: "First",
        status: "completed",
        summary: "Done",
        changedFiles: { created: ["one.txt"], modified: [], deleted: [] },
        commands: [{ command: "npm test", result: "pass" }],
        verification: [{ command: "npm test", result: "1/1 pass" }]
      },
      {
        id: "T2",
        title: "Second",
        status: "blocked",
        summary: "Needs a decision",
        changedFiles: { created: [], modified: [], deleted: [] },
        commands: [],
        verification: [],
        openItems: ["Missing source data"]
      }
    ]
  });

  assert.equal((report.match(/\bT1\b/g) ?? []).length, 1);
  assert.equal((report.match(/\bT2\b/g) ?? []).length, 1);
  assert.match(report, /T2[\s\S]*blocked/i);
  assert.doesNotMatch(report, /T2[\s\S]*completed/i);
  assert.match(report, /Missing source data/);
});

test("task reports redact secret-like values before writing", async () => {
  await withTempRoot(async (root) => {
    const sessionRoot = path.join(root, "sessions");
    const session = {
      id: "session-1",
      codex: {
        taskReportPath: path.join(sessionRoot, "session-1", "tasks", "T1.md")
      }
    };
    const task = { id: "T1", title: "Safe report" };
    const result = {
      status: "completed",
      summary: "Used api_key=sk-secret-123",
      commands: [{ command: "curl -H 'Authorization: Bearer secret-token'", result: "ok" }],
      verification: [{ command: "npm test", result: "pass" }],
      openItems: []
    };

    const reportPath = await writeTaskReport(sessionRoot, session, task, result);
    const text = await fs.readFile(reportPath, "utf8");

    assert.doesNotMatch(text, /sk-secret-123|secret-token/);
    assert.match(text, /\[REDACTED\]/);
  });
});
