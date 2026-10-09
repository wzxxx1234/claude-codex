import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { createViewerServer } from "../src/viewer-server.mjs";

async function createTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "bridge-viewer-"));
}

function endpointFor(viewer, pathname, token, sessionId) {
  const url = new URL(viewer.urlFor(sessionId, token));
  url.pathname = pathname;
  url.search = "";
  url.searchParams.set("token", token);
  return url;
}

async function readSseEvent(response, predicate, timeoutMs = 3_000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const read = await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("Timed out waiting for SSE")), remaining);
        })
      ]);

      if (read.done) {
        break;
      }

      buffer += decoder.decode(read.value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        if (predicate(block)) {
          return block;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  throw new Error("The expected SSE event was not received");
}

test("viewer binds to localhost and protects the HTML page with a token", async (t) => {
  const root = await createTempRoot();
  const viewer = await createViewerServer({
    sessionRoot: path.join(root, "sessions"),
    onCancel: async () => {}
  });
  t.after(async () => {
    await viewer.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const validResponse = await fetch(viewer.urlFor("session-1", "good-token"));
  const html = await validResponse.text();

  assert.equal(viewer.host, "127.0.0.1");
  assert.ok(viewer.port > 0);
  assert.equal(validResponse.status, 200);
  assert.match(validResponse.headers.get("content-type"), /text\/html/);
  assert.match(html, /session-1/);

  const missingToken = new URL(viewer.urlFor("session-1", "good-token"));
  missingToken.search = "";
  assert.equal((await fetch(missingToken)).status, 401);

  const invalidToken = new URL(viewer.urlFor("session-1", "good-token"));
  invalidToken.searchParams.set("token", "wrong-token");
  assert.equal((await fetch(invalidToken)).status, 401);
});

test("viewer streams normalized events without leaking secrets", async (t) => {
  const root = await createTempRoot();
  const viewer = await createViewerServer({
    sessionRoot: path.join(root, "sessions"),
    onCancel: async () => {}
  });
  t.after(async () => {
    await viewer.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const eventsUrl = endpointFor(
    viewer,
    "/events/session-1",
    "stream-token",
    "session-1"
  );
  const response = await fetch(eventsUrl);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);

  viewer.publish("session-1", {
    kind: "command",
    text: "Authorization: Bearer secret-token",
    rawType: "command_execution",
    timestamp: "2026-10-09T12:00:00.000Z"
  });

  const event = await readSseEvent(response, (block) =>
    block.includes('"kind":"command"')
  );

  assert.match(event, /\[REDACTED\]/);
  assert.doesNotMatch(event, /secret-token/);
});

test("viewer cancel endpoint calls the fixed callback and ignores request bodies", async (t) => {
  const root = await createTempRoot();
  const cancelCalls = [];
  const viewer = await createViewerServer({
    sessionRoot: path.join(root, "sessions"),
    onCancel: async (sessionId) => {
      cancelCalls.push(sessionId);
    }
  });
  t.after(async () => {
    await viewer.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const response = await fetch(
    endpointFor(viewer, "/cancel/session-1", "cancel-token", "session-1"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "calc.exe" })
    }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(cancelCalls, ["session-1"]);
});

test("closing the viewer releases its port", async (t) => {
  const root = await createTempRoot();
  const viewer = await createViewerServer({
    sessionRoot: path.join(root, "sessions"),
    onCancel: async () => {}
  });
  const { host, port } = viewer;

  await viewer.close();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const replacement = net.createServer();
  await new Promise((resolve, reject) => {
    replacement.once("error", reject);
    replacement.listen(port, host, resolve);
  });
  await new Promise((resolve) => replacement.close(resolve));
});
