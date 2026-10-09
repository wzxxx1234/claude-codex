import { spawn } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";

import { normalizeCodexEvent } from "./event-normalizer.mjs";
import { redactSecrets } from "./redact.mjs";

const SCRIPT_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);

function isScriptPath(filePath) {
  return SCRIPT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function resolveCodexCommand({ codexPath, nodePath }) {
  if (!codexPath) {
    throw new Error("codexPath is required");
  }

  if (isScriptPath(codexPath)) {
    if (!nodePath) {
      throw new Error("nodePath is required for a JavaScript Codex fixture");
    }
    return {
      command: nodePath,
      argsPrefix: [codexPath]
    };
  }

  return {
    command: codexPath,
    argsPrefix: []
  };
}

export function buildCodexArgs({
  repoPath,
  sandbox = "workspace-write",
  windowsSandboxMode = "unelevated",
  reportPath
}) {
  if (!repoPath) {
    throw new Error("repoPath is required");
  }
  if (!reportPath) {
    throw new Error("reportPath is required");
  }

  return [
    "exec",
    "-C",
    repoPath,
    "-c",
    `windows.sandbox="${windowsSandboxMode}"`,
    "-c",
    "mcp_servers.node_repl.enabled=false",
    "-s",
    sandbox,
    "-c",
    'approval_policy="never"',
    "--json",
    "-o",
    reportPath,
    "--skip-git-repo-check",
    "-"
  ];
}

function pathDefaults(sessionRoot, session, task) {
  const directory = path.join(sessionRoot, session.id);
  return {
    stdoutPath:
      session.codex?.stdoutPath ??
      path.join(directory, "codex.stdout.jsonl"),
    stderrPath:
      session.codex?.stderrPath ??
      path.join(directory, "codex.stderr.log"),
    reportPath:
      session.codex?.taskReportPath ??
      path.join(directory, "tasks", `${task.id}.md`)
  };
}

function createTaskPrompt(task) {
  return [
    "Execute exactly one task from the supplied plan.",
    `Task ID: ${task.id}`,
    `Title: ${task.title ?? ""}`,
    "",
    task.body ?? "",
    "",
    "Stop after this task. Do not start or execute any later task.",
    ""
  ].join("\n");
}

function createLineBuffer(onLine) {
  let pending = "";

  function consume(text, flush = false) {
    pending += text;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (trimmed.trim() !== "") {
        onLine(trimmed);
      }
    }

    if (flush && pending.trim() !== "") {
      const finalLine = pending.endsWith("\r")
        ? pending.slice(0, -1)
        : pending;
      pending = "";
      onLine(finalLine);
    }
  }

  return {
    push(chunk) {
      consume(chunk.toString("utf8"));
    },
    flush() {
      consume("", true);
    }
  };
}

function classifyFailure(stdout, stderr, exitCode) {
  const combined = `${stdout}\n${stderr}`;
  if (/helper_unknown_error|sandbox.*(?:failed|error)|setup refresh had errors/i.test(combined)) {
    return {
      status: "needs_user",
      errorKind: "sandbox_error",
      exitCode
    };
  }

  if (
    /provider|connection (?:failed|refused)|ECONNREFUSED|127\.0\.0\.1:\d+/i.test(
      combined
    )
  ) {
    return {
      status: "needs_user",
      errorKind: "provider_error",
      exitCode
    };
  }

  return {
    status: "failed",
    errorKind: "task_failed",
    exitCode
  };
}

async function readText(filePath) {
  try {
    return await fsPromises.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

export function startCodexTask({
  session,
  task,
  codexPath,
  nodePath,
  sessionRoot,
  onEvent,
  spawnImpl = spawn,
  env = process.env
}) {
  if (!session?.id || !session?.repoPath) {
    throw new Error("session id and repoPath are required");
  }
  if (!task?.id) {
    throw new Error("task id is required");
  }
  if (!sessionRoot) {
    throw new Error("sessionRoot is required");
  }

  const paths = pathDefaults(sessionRoot, session, task);
  const { command, argsPrefix } = resolveCodexCommand({
    codexPath,
    nodePath
  });
  const args = [
    ...argsPrefix,
    ...buildCodexArgs({
      repoPath: session.repoPath,
      sandbox: session.sandbox ?? "workspace-write",
      windowsSandboxMode: session.windowsSandboxMode ?? "unelevated",
      reportPath: paths.reportPath
    })
  ];

  fs.mkdirSync(path.dirname(paths.stdoutPath), { recursive: true });
  fs.mkdirSync(path.dirname(paths.stderrPath), { recursive: true });
  fs.mkdirSync(path.dirname(paths.reportPath), { recursive: true });

  const stdoutStream = fs.createWriteStream(paths.stdoutPath, { flags: "a" });
  const stderrStream = fs.createWriteStream(paths.stderrPath, { flags: "a" });
  const stdoutFinished = finished(stdoutStream);
  const stderrFinished = finished(stderrStream);

  const stdoutLines = createLineBuffer((line) => {
    stdoutStream.write(`${redactSecrets(line)}\n`);
    const normalized = normalizeCodexEvent(line);
    if (normalized) {
      Promise.resolve(onEvent?.(normalized)).catch(() => {});
    }
  });
  const stderrLines = createLineBuffer((line) => {
    stderrStream.write(`${redactSecrets(line)}\n`);
  });

  const child = spawnImpl(command, args, {
    cwd: session.repoPath,
    detached: true,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });

  child.stdout.on("data", (chunk) => {
    stdoutLines.push(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderrLines.push(chunk);
  });

  child.stdin.end(createTaskPrompt(task), "utf8");

  const completion = new Promise((resolve, reject) => {
    let spawnError;

    child.once("error", (error) => {
      spawnError = error;
    });

    child.once("close", async (exitCode, signal) => {
      stdoutLines.flush();
      stderrLines.flush();
      stdoutStream.end();
      stderrStream.end();

      try {
        await Promise.all([stdoutFinished, stderrFinished]);
      } catch (error) {
        reject(error);
        return;
      }

      if (spawnError) {
        reject(spawnError);
        return;
      }

      const stdout = await readText(paths.stdoutPath);
      const stderr = await readText(paths.stderrPath);
      const result =
        exitCode === 0
          ? {
              status: "completed",
              exitCode,
              signal
            }
          : classifyFailure(stdout, stderr, exitCode);

      resolve({
        taskId: task.id,
        ...result
      });
    });
  });

  return {
    pid: child.pid,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    completion
  };
}
