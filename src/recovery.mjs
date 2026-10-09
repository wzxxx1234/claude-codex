import fs from "node:fs/promises";
import path from "node:path";

import { isProcessAlive as defaultIsProcessAlive } from "./process-manager.mjs";
import { saveSession } from "./session-store.mjs";
import { transitionSession } from "./state-machine.mjs";

async function listSessionIds(sessionRoot) {
  let entries;
  try {
    entries = await fs.readdir(sessionRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

async function loadSessionIfPresent(sessionRoot, sessionId) {
  try {
    const text = await fs.readFile(
      path.join(sessionRoot, sessionId, "session.json"),
      "utf8"
    );
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function markInterrupted(session) {
  return transitionSession(session, "interrupted", {
    codex: {
      ...session.codex,
      pid: null
    },
    tasks: session.tasks.map((task, index) =>
      index === session.currentTaskIndex && task.status === "running"
        ? { ...task, status: "pending" }
        : task
    )
  });
}

export async function recoverSessions({
  sessionRoot,
  isProcessAlive = defaultIsProcessAlive
}) {
  if (typeof sessionRoot !== "string" || sessionRoot.trim() === "") {
    throw new Error("sessionRoot is required");
  }
  if (typeof isProcessAlive !== "function") {
    throw new Error("isProcessAlive must be a function");
  }

  const result = {
    resumed: [],
    interrupted: [],
    completed: []
  };

  for (const sessionId of await listSessionIds(sessionRoot)) {
    const session = await loadSessionIfPresent(sessionRoot, sessionId);
    if (!session?.id) {
      continue;
    }

    if (session.state === "completed") {
      result.completed.push(session.id);
      continue;
    }

    if (session.state !== "running") {
      continue;
    }

    const pid = session.codex?.pid;
    const alive = await Promise.resolve(isProcessAlive(pid));
    if (alive) {
      result.resumed.push(session.id);
      continue;
    }

    const interrupted = markInterrupted(session);
    await saveSession(sessionRoot, interrupted);
    result.interrupted.push(session.id);
  }

  return result;
}
