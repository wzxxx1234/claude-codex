import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startCodexTask } from "../src/codex-runner.mjs";
import { terminateProcessTree } from "../src/process-manager.mjs";
import * as reportWriter from "../src/report-writer.mjs";
import { createSessionManager } from "../src/session-manager.mjs";
import * as store from "../src/session-store.mjs";

const fixturePath = fileURLToPath(
  new URL("./fixtures/fake-codex.mjs", import.meta.url)
);

function createViewer() {
  return {
    urlFor(sessionId, token) {
      return `http://127.0.0.1:4567/view/${sessionId}?token=${token}`;
    },
    publish() {},
    async open() {},
    async close() {}
  };
}

test("fake Codex pauses after T1 and completes T2 only after continue", async () => {
  const root = await fs.mkdtemp(
    path.join(process.cwd(), ".tmp-bridge-e2e-")
  );
  const repoPath = path.join(root, "project");
  const sessionRoot = path.join(root, "sessions");
  await fs.mkdir(repoPath, { recursive: true });

  const starts = [];
  const runner = {
    startTask(input) {
      starts.push(input.task.id);
      return startCodexTask({
        ...input,
        codexPath: fixturePath,
        nodePath: process.execPath,
        sessionRoot,
        env: {
          ...process.env,
          FAKE_CODEX_SCENARIO: "success",
          FAKE_CODEX_OUTPUT_FILE: path.join(
            repoPath,
            `${input.task.id}-output.txt`
          )
        }
      });
    },
    terminate(pid) {
      return terminateProcessTree(pid);
    }
  };
  const manager = createSessionManager({
    config: {
      codexPath: fixturePath,
      nodePath: process.execPath,
      sessionRoot,
      viewerHost: "127.0.0.1",
      viewerPort: 0,
      defaultSandbox: "workspace-write",
      windowsSandboxMode: "unelevated"
    },
    store,
    runner,
    viewer: createViewer(),
    reportWriter
  });

  try {
    const started = await manager.start({
      repoPath,
      checkpointMode: "per_task",
      planMarkdown: [
        "## T1 First",
        "Create the first output.",
        "",
        "## T2 Second",
        "Create the second output."
      ].join("\n")
    });

    assert.equal(started.nextAction, "call_codex_watch_again");
    assert.equal(started.task.id, "T1");
    assert.deepEqual(starts, ["T1"]);

    const firstCheckpoint = await manager.watch({
      sessionId: started.sessionId,
      waitMs: 5_000
    });

    assert.equal(firstCheckpoint.task.id, "T1");
    assert.equal(
      firstCheckpoint.nextAction,
      "display_checkpoint_wait_for_user"
    );
    assert.deepEqual(starts, ["T1"]);

    const continued = await manager.continue({
      sessionId: started.sessionId
    });
    assert.equal(continued.task.id, "T2");
    assert.deepEqual(starts, ["T1", "T2"]);

    const secondCheckpoint = await manager.watch({
      sessionId: started.sessionId,
      waitMs: 5_000
    });
    assert.equal(secondCheckpoint.task.id, "T2");
    assert.equal(secondCheckpoint.nextAction, "display_final_report");

    const final = await manager.watch({
      sessionId: started.sessionId,
      waitMs: 5_000
    });
    assert.equal(final.nextAction, "display_final_report");
    assert.match(final.report, /T1/);
    assert.match(final.report, /T2/);
    assert.equal(
      await fs.readFile(path.join(repoPath, "T1-output.txt"), "utf8"),
      "fake task complete\n"
    );
    assert.equal(
      await fs.readFile(path.join(repoPath, "T2-output.txt"), "utf8"),
      "fake task complete\n"
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
