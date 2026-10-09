import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "./atomic-write.mjs";

const ACTIVE_STATES = new Set([
  "created",
  "running",
  "waiting_user",
  "needs_user",
  "interrupted"
]);

const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateSessionId(sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error("Session id must be a valid UUID");
  }
  return sessionId;
}

function sessionDirectory(sessionRoot, sessionId) {
  return path.join(sessionRoot, validateSessionId(sessionId));
}

function sessionFile(sessionRoot, sessionId) {
  return path.join(sessionDirectory(sessionRoot, sessionId), "session.json");
}

export async function createSession({
  sessionRoot,
  repoPath,
  projectId,
  planMarkdown,
  tasks
}) {
  if (!sessionRoot) {
    throw new Error("sessionRoot is required");
  }
  if (!repoPath) {
    throw new Error("repoPath is required");
  }
  if (!projectId) {
    throw new Error("projectId is required");
  }
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error("At least one task is required");
  }

  const id = randomUUID();
  const directory = sessionDirectory(sessionRoot, id);
  const timestamp = new Date().toISOString();

  const session = {
    version: 1,
    id,
    projectId,
    repoPath,
    planMarkdown: planMarkdown ?? "",
    state: "created",
    currentTaskIndex: 0,
    tasks: tasks.map((task) => ({ ...task, status: "pending" })),
    checkpoint: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    viewerPort: 0,
    viewerToken: randomBytes(16).toString("hex"),
    codex: {
      pid: null,
      startedAt: null,
      stdoutPath: path.join(directory, "codex.stdout.jsonl"),
      stderrPath: path.join(directory, "codex.stderr.log"),
      taskReportPath: null
    },
    reportPath: path.join(repoPath, "REPORT.md")
  };

  await fs.mkdir(directory, { recursive: true });
  await saveSession(sessionRoot, session);
  return session;
}

export async function loadSession(sessionRoot, sessionId) {
  const text = await fs.readFile(sessionFile(sessionRoot, sessionId), "utf8");
  return JSON.parse(text);
}

export async function saveSession(sessionRoot, session) {
  if (!session?.id) {
    throw new Error("Session id is required");
  }
  validateSessionId(session.id);

  await writeFileAtomic(
    sessionFile(sessionRoot, session.id),
    `${JSON.stringify(session, null, 2)}\n`
  );
}

export async function appendSessionEvent(sessionRoot, sessionId, event) {
  validateSessionId(sessionId);
  const directory = sessionDirectory(sessionRoot, sessionId);
  await fs.mkdir(directory, { recursive: true });
  await fs.appendFile(
    path.join(directory, "events.jsonl"),
    `${JSON.stringify(event)}\n`,
    "utf8"
  );
}

export async function findActiveSessionByProject(sessionRoot, projectId) {
  let entries;
  try {
    entries = await fs.readdir(sessionRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      const session = await loadSession(sessionRoot, entry.name);
      if (session.projectId === projectId && ACTIVE_STATES.has(session.state)) {
        sessions.push(session);
      }
    } catch {
      // Ignore incomplete session directories left by an interrupted write.
    }
  }

  sessions.sort((left, right) =>
    String(right.updatedAt).localeCompare(String(left.updatedAt))
  );
  return sessions[0] ?? null;
}
