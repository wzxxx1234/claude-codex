import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "./atomic-write.mjs";
import { redactSecrets } from "./redact.mjs";

const IGNORED_DIRECTORIES = new Set([".git", "node_modules"]);

function redactedClone(value) {
  try {
    return JSON.parse(redactSecrets(value));
  } catch {
    return value;
  }
}

function normalizeChangedFiles(changedFiles = {}) {
  return {
    created: [...(changedFiles.created ?? [])],
    modified: [...(changedFiles.modified ?? [])],
    deleted: [...(changedFiles.deleted ?? [])]
  };
}

async function fingerprintFile(filePath) {
  const [content, stats] = await Promise.all([
    fs.readFile(filePath),
    fs.stat(filePath)
  ]);

  return {
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    sha256: createHash("sha256").update(content).digest("hex")
  };
}

async function walkProject(root, current, snapshot) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(current, entry.name);
    const stats = await fs.lstat(fullPath);
    if (stats.isSymbolicLink()) {
      continue;
    }
    if (stats.isDirectory()) {
      await walkProject(root, fullPath, snapshot);
      continue;
    }
    if (!stats.isFile()) {
      continue;
    }

    const relativePath = path
      .relative(root, fullPath)
      .split(path.sep)
      .join("/");
    snapshot.set(relativePath, await fingerprintFile(fullPath));
  }
}

export async function createProjectSnapshot(repoPath) {
  const snapshot = new Map();
  await walkProject(repoPath, repoPath, snapshot);
  return snapshot;
}

export function diffProjectSnapshot(before, after) {
  const created = [];
  const modified = [];
  const deleted = [];

  for (const [filePath, fingerprint] of after) {
    const previous = before.get(filePath);
    if (!previous) {
      created.push(filePath);
    } else if (
      previous.size !== fingerprint.size ||
      previous.sha256 !== fingerprint.sha256
    ) {
      modified.push(filePath);
    }
  }

  for (const filePath of before.keys()) {
    if (!after.has(filePath)) {
      deleted.push(filePath);
    }
  }

  created.sort();
  modified.sort();
  deleted.sort();
  return { created, modified, deleted };
}

export function buildTaskCheckpoint({
  session,
  task,
  taskResult = {},
  changedFiles = {}
}) {
  const safeResult = redactedClone(taskResult);
  return {
    sessionId: session.id,
    taskId: task.id,
    title: redactSecrets(task.title ?? ""),
    status: safeResult.status ?? "completed",
    errorKind: safeResult.errorKind ?? null,
    summary: safeResult.summary ?? "",
    changedFiles: redactedClone(normalizeChangedFiles(changedFiles)),
    commands: safeResult.commands ?? [],
    verification: safeResult.verification ?? [],
    openItems: safeResult.openItems ?? []
  };
}

function formatList(items, render) {
  if (!items || items.length === 0) {
    return "- none\n";
  }
  return `${items.map((item) => `- ${render(item)}`).join("\n")}\n`;
}

function renderChangedFiles(changedFiles = {}) {
  const files = normalizeChangedFiles(changedFiles);
  const lines = [];
  for (const category of ["created", "modified", "deleted"]) {
    for (const filePath of files[category]) {
      lines.push(`${category}: ${filePath}`);
    }
  }
  return formatList(lines, (line) => line);
}

function renderCommands(commands = []) {
  return formatList(
    commands,
    (entry) => `${entry.command ?? entry} -> ${entry.result ?? ""}`.trim()
  );
}

function renderVerification(verification = []) {
  return formatList(
    verification,
    (entry) => `${entry.command ?? entry} -> ${entry.result ?? ""}`.trim()
  );
}

function renderTask(task) {
  const summary = task.summary ? `${task.summary}\n` : "";
  const openItems = formatList(
    task.openItems ?? [],
    (item) => String(item)
  );

  return [
    `### ${task.id} ${task.title ?? ""}`.trim(),
    `status: ${task.status ?? "pending"}`,
    "",
    summary,
    "changed files:",
    renderChangedFiles(task.changedFiles).trimEnd(),
    "",
    "commands:",
    renderCommands(task.commands).trimEnd(),
    "",
    "verification:",
    renderVerification(task.verification).trimEnd(),
    "",
    "open items:",
    openItems.trimEnd(),
    ""
  ]
    .filter((line, index, lines) => {
      if (line === "" && lines[index - 1] === "") {
        return false;
      }
      return true;
    })
    .join("\n");
}

export function renderReport(session) {
  const taskSections = (session.tasks ?? []).map(renderTask).join("\n\n");
  const report = [
    "# REPORT.md",
    "",
    "## Summary",
    session.summary ?? "No summary provided.",
    "",
    "## Tasks",
    taskSections || "No tasks recorded.",
    ""
  ].join("\n");

  return redactSecrets(report);
}

export async function writeTaskReport(sessionRoot, session, task, result) {
  const reportPath =
    session?.codex?.taskReportPath ??
    path.join(sessionRoot, session.id, "tasks", `${task.id}.md`);
  const safeResult = redactedClone(result);
  const checkpoint = buildTaskCheckpoint({
    session,
    task,
    taskResult: safeResult,
    changedFiles: safeResult.changedFiles
  });
  const text = renderReport({
    ...session,
    tasks: [
      {
        ...task,
        ...checkpoint
      }
    ]
  });

  await writeFileAtomic(reportPath, text);
  return reportPath;
}
