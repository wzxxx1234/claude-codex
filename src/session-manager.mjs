import fs from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "./atomic-write.mjs";
import { parsePlan } from "./plan-parser.mjs";
import { validateProjectPath } from "./path-guard.mjs";
import { transitionSession } from "./state-machine.mjs";

const DEFAULT_WAIT_MS = 60_000;
const MAX_WAIT_MS = 10 * 60_000;

function clampWaitMs(value) {
  if (!Number.isFinite(value)) {
    return DEFAULT_WAIT_MS;
  }
  return Math.max(0, Math.min(MAX_WAIT_MS, Math.floor(value)));
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function toErrorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function currentTask(session) {
  return session?.tasks?.[session.currentTaskIndex] ?? null;
}

function taskSummary(task) {
  if (!task) {
    return null;
  }
  return {
    id: task.id,
    title: task.title,
    ordinal: task.ordinal,
    status: task.status
  };
}

function defaultNextAction(state, checkpoint = null) {
  if (state === "running" || state === "created") {
    return "call_codex_watch_again";
  }
  if (state === "waiting_user") {
    return "display_checkpoint_wait_for_user";
  }
  if (state === "completed") {
    return "display_final_report";
  }
  if (state === "needs_user" || state === "failed" || state === "interrupted") {
    return "ask_user_for_decision";
  }
  if (state === "cancelled") {
    return "ask_user_for_decision";
  }
  return checkpoint ? "display_checkpoint_wait_for_user" : "ask_user_for_decision";
}

function summarizeEvents(events = []) {
  const messages = events
    .filter((event) => event.kind === "message" && event.text)
    .map((event) => event.text);
  const commands = events
    .filter((event) => event.kind === "command" && event.text)
    .map((event) => ({ command: event.text, result: "" }));
  const verification = events
    .filter((event) => event.kind === "verification" && event.text)
    .map((event) => ({ command: event.text, result: "" }));

  return {
    summary: messages.at(-1) ?? "",
    commands,
    verification
  };
}

function resultForSession(session, { report = null, viewerUrl = null } = {}) {
  return {
    sessionId: session?.id ?? null,
    state: session?.state ?? "unknown",
    task: taskSummary(currentTask(session)),
    checkpoint: session?.checkpoint ?? null,
    report,
    tasks: (session?.tasks ?? []).map(taskSummary),
    nextAction: defaultNextAction(session?.state, session?.checkpoint),
    viewerUrl,
    error: null
  };
}

async function readReportIfPresent(session) {
  if (!session?.reportPath) {
    return null;
  }
  try {
    return await fs.readFile(session.reportPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function taskReportPath(sessionRoot, session, task) {
  return path.join(sessionRoot, session.id, "tasks", `${task.id}.md`);
}

async function safeSnapshot(reportWriter, repoPath) {
  try {
    return await reportWriter.createProjectSnapshot(repoPath);
  } catch {
    return new Map();
  }
}

function safeDiff(reportWriter, before, after) {
  try {
    return reportWriter.diffProjectSnapshot(before, after);
  } catch {
    return { created: [], modified: [], deleted: [] };
  }
}

export function createSessionManager({
  config,
  store,
  runner,
  viewer,
  reportWriter
}) {
  if (!config?.sessionRoot) {
    throw new Error("config.sessionRoot is required");
  }
  for (const [name, dependency] of Object.entries({
    store,
    runner,
    viewer,
    reportWriter
  })) {
    if (!dependency) {
      throw new Error(`${name} is required`);
    }
  }

  const runtimes = new Map();
  const startingProjects = new Set();

  async function load(sessionId) {
    if (!sessionId) {
      throw new Error("sessionId is required");
    }
    return store.loadSession(config.sessionRoot, sessionId);
  }

  async function publish(sessionId, event) {
    try {
      const publication = viewer.publish(sessionId, event);
      await Promise.resolve(publication).catch(() => {});
    } catch {
      // The viewer is diagnostic only and must never break task execution.
    }
  }

  async function appendEvent(sessionId, event) {
    try {
      await store.appendSessionEvent(config.sessionRoot, sessionId, event);
    } catch {
      // Session persistence is best-effort for streamed progress events.
    }
  }

  async function finalizeTask(runtime, rawResult) {
    if (runtime.cancelRequested) {
      return resultForSession(await load(runtime.sessionId));
    }

    let session = await load(runtime.sessionId);
    if (session.state === "cancelled") {
      return resultForSession(session);
    }

    const task = session.tasks[runtime.taskIndex];
    const after = await safeSnapshot(reportWriter, session.repoPath);
    const changedFiles = safeDiff(
      reportWriter,
      runtime.beforeSnapshot,
      after
    );
    const eventSummary = summarizeEvents(runtime.events);
    const result = {
      ...rawResult,
      summary: rawResult?.summary ?? eventSummary.summary,
      commands: rawResult?.commands ?? eventSummary.commands,
      verification: rawResult?.verification ?? eventSummary.verification,
      changedFiles
    };
    const checkpoint = reportWriter.buildTaskCheckpoint({
      session,
      task,
      taskResult: result,
      changedFiles
    });

    const hasMoreTasks = runtime.taskIndex + 1 < session.tasks.length;
    let nextState;
    let taskStatus;
    if (result.status === "completed") {
      nextState = hasMoreTasks ? "waiting_user" : "completed";
      taskStatus = "completed";
    } else if (result.status === "needs_user") {
      nextState = "needs_user";
      taskStatus = "blocked";
    } else {
      nextState = "failed";
      taskStatus = "failed";
    }

    session = transitionSession(session, nextState, {
      checkpoint,
      tasks: session.tasks.map((entry, index) =>
        index === runtime.taskIndex
          ? {
              ...entry,
              status: taskStatus,
              summary: checkpoint.summary,
              changedFiles: checkpoint.changedFiles,
              commands: checkpoint.commands,
              verification: checkpoint.verification,
              openItems: checkpoint.openItems
            }
          : entry
      )
    });
    await store.saveSession(config.sessionRoot, session);

    try {
      await reportWriter.writeTaskReport(
        config.sessionRoot,
        session,
        task,
        result
      );
    } catch {
      // REPORT.md remains the durable user-facing artifact if task trace fails.
    }

    const report = reportWriter.renderReport(session);
    try {
      await writeFileAtomic(session.reportPath, report);
    } catch {
      // Returning the checkpoint is still useful if the project report is locked.
    }

    runtime.done = true;
    const finalResult = resultForSession(session, { report });
    finalResult.error = result.error ?? null;
    runtime.finalResult = finalResult;
    runtimes.delete(session.id);
    return finalResult;
  }

  async function launchCurrentTask(session) {
    const task = currentTask(session);
    if (!task) {
      throw new Error("No task is available to run");
    }

    const reportPath = taskReportPath(config.sessionRoot, session, task);
    const beforeSnapshot = await safeSnapshot(reportWriter, session.repoPath);
    const runtime = {
      sessionId: session.id,
      taskIndex: session.currentTaskIndex,
      beforeSnapshot,
      events: [],
      cancelRequested: false,
      done: false,
      finalResult: null,
      completion: null
    };

    const runningSession = {
      ...session,
      tasks: session.tasks.map((entry, index) =>
        index === session.currentTaskIndex
          ? { ...entry, status: "running" }
          : entry
      ),
      codex: {
        ...session.codex,
        pid: null,
        startedAt: new Date().toISOString(),
        taskReportPath: reportPath
      }
    };

    const onEvent = (event) => {
      runtime.events.push(event);
      void appendEvent(session.id, event);
      void publish(session.id, event);
    };

    let execution;
    try {
      execution = await runner.startTask({
        session: runningSession,
        task,
        onEvent
      });
    } catch (error) {
      const failed = transitionSession(runningSession, "needs_user", {
        checkpoint: null
      });
      await store.saveSession(config.sessionRoot, failed);
      return {
        ...resultForSession(failed, {
          viewerUrl: viewer.urlFor(failed.id, failed.viewerToken)
        }),
        error: toErrorText(error),
        nextAction: "ask_user_for_decision"
      };
    }

    runningSession.codex.pid = execution.pid ?? null;
    await store.saveSession(config.sessionRoot, runningSession);

    const viewerUrl = viewer.urlFor(
      runningSession.id,
      runningSession.viewerToken
    );
    void Promise.resolve(
      viewer.open(runningSession.id, runningSession.viewerToken)
    ).catch(() => {});

    runtime.completion = Promise.resolve(execution.completion)
      .catch((error) => ({
        taskId: task.id,
        status: "failed",
        errorKind: "task_failed",
        error: toErrorText(error)
      }))
      .then((result) => finalizeTask(runtime, result));
    runtimes.set(runningSession.id, runtime);

    return resultForSession(runningSession, { viewerUrl });
  }

  async function start(input) {
    if (input?.checkpointMode !== "per_task") {
      throw new Error("checkpointMode must be per_task");
    }
    if (typeof input?.planMarkdown !== "string" || input.planMarkdown.trim() === "") {
      throw new Error("planMarkdown is required");
    }

    const validated = await validateProjectPath(input.repoPath);
    if (startingProjects.has(validated.projectId)) {
      throw new Error("An active session already exists for this project");
    }
    startingProjects.add(validated.projectId);

    try {
      const active = await store.findActiveSessionByProject(
        config.sessionRoot,
        validated.projectId
      );
      if (active) {
        throw new Error("An active session already exists for this project");
      }

      const planPath = path.join(validated.realPath, "PLAN.md");
      if ((await pathExists(planPath)) && input.overwritePlan !== true) {
        return {
          ...resultForSession(null),
          state: "needs_user",
          nextAction: "ask_user_for_decision",
          error:
            "PLAN.md already exists. Ask the user whether it may be overwritten."
        };
      }

      const tasks = parsePlan(input.planMarkdown);
      await writeFileAtomic(planPath, input.planMarkdown);
      let session = await store.createSession({
        sessionRoot: config.sessionRoot,
        repoPath: validated.realPath,
        projectId: validated.projectId,
        planMarkdown: input.planMarkdown,
        tasks
      });
      session = {
        ...session,
        sandbox:
          input.writeMode ??
          config.defaultSandbox ??
          "workspace-write",
        windowsSandboxMode: config.windowsSandboxMode ?? "unelevated"
      };
      session = transitionSession(session, "running", {
        currentTaskIndex: 0
      });
      await store.saveSession(config.sessionRoot, session);
      return await launchCurrentTask(session);
    } finally {
      startingProjects.delete(validated.projectId);
    }
  }

  async function watch(input) {
    const sessionId = input?.sessionId;
    const runtime = runtimes.get(sessionId);
    if (runtime && !runtime.done) {
      const waitMs = clampWaitMs(input?.waitMs);
      const completed = runtime.completion.then((result) => ({
        timedOut: false,
        result
      }));
      const timedOut = wait(waitMs).then(() => ({
        timedOut: true,
        result: null
      }));
      const outcome = await Promise.race([completed, timedOut]);
      if (!outcome.timedOut) {
        return outcome.result;
      }
    }

    let session = await load(sessionId);
    if (session.state === "running" && !runtime) {
      const pid = session.codex?.pid;
      const alive =
        pid != null && (await Promise.resolve(runner.isProcessAlive(pid)));
      if (!alive) {
        session = transitionSession(session, "interrupted", {
          codex: {
            ...session.codex,
            pid: null
          },
          tasks: session.tasks.map((entry, index) =>
            index === session.currentTaskIndex && entry.status === "running"
              ? { ...entry, status: "pending" }
              : entry
          )
        });
        await store.saveSession(config.sessionRoot, session);
      }
    }

    return resultForSession(session, {
      report: await readReportIfPresent(session),
      viewerUrl: viewer.urlFor(session.id, session.viewerToken)
    });
  }

  async function continueSession(input) {
    let session = await load(input?.sessionId);
    if (session.state !== "waiting_user") {
      throw new Error(`Cannot continue while session is ${session.state}`);
    }

    let nextIndex = session.currentTaskIndex + 1;
    while (
      nextIndex < session.tasks.length &&
      session.tasks[nextIndex].status === "completed"
    ) {
      nextIndex += 1;
    }
    if (nextIndex >= session.tasks.length) {
      throw new Error("No pending task remains");
    }

    session = transitionSession(session, "running", {
      currentTaskIndex: nextIndex
    });
    await store.saveSession(config.sessionRoot, session);
    return launchCurrentTask(session);
  }

  async function retry(input) {
    let session = await load(input?.sessionId);
    if (!["needs_user", "failed", "interrupted"].includes(session.state)) {
      throw new Error(`Cannot retry while session is ${session.state}`);
    }

    const task = currentTask(session);
    const lastErrorKind = session.checkpoint?.errorKind;
    const sandbox = session.sandbox ?? config.defaultSandbox ?? "workspace-write";
    if (lastErrorKind === "sandbox_error" && input?.allowUnsandboxed !== true) {
      throw new Error(
        "Sandbox retry requires explicit allowUnsandboxed confirmation"
      );
    }

    session = {
      ...session,
      sandbox:
        lastErrorKind === "sandbox_error" && input?.allowUnsandboxed === true
          ? "danger-full-access"
          : sandbox,
      checkpoint: null,
      tasks: session.tasks.map((entry, index) =>
        index === session.currentTaskIndex
          ? { ...entry, status: "pending" }
          : entry
      )
    };
    session = transitionSession(session, "running");
    await store.saveSession(config.sessionRoot, session);
    return launchCurrentTask(session);
  }

  async function cancel(input) {
    let session = await load(input?.sessionId);
    const runtime = runtimes.get(session.id);
    if (runtime) {
      runtime.cancelRequested = true;
      if (session.codex?.pid) {
        await runner.terminate(session.codex.pid);
      }
    }

    session = await load(session.id);
    if (session.state !== "cancelled") {
      session = transitionSession(session, "cancelled", {
        codex: {
          ...session.codex,
          pid: null
        },
        tasks: session.tasks.map((entry, index) =>
          index === session.currentTaskIndex && entry.status === "running"
            ? { ...entry, status: "pending" }
            : entry
        )
      });
      await store.saveSession(config.sessionRoot, session);
    }
    runtimes.delete(session.id);
    return resultForSession(session, {
      report: await readReportIfPresent(session),
      viewerUrl: viewer.urlFor(session.id, session.viewerToken)
    });
  }

  async function status(input) {
    const session = await load(input?.sessionId);
    return resultForSession(session, {
      report: await readReportIfPresent(session),
      viewerUrl: viewer.urlFor(session.id, session.viewerToken)
    });
  }

  async function openViewer(input) {
    const session = await load(input?.sessionId);
    const viewerUrl = viewer.urlFor(session.id, session.viewerToken);
    await viewer.open(session.id, session.viewerToken);
    return {
      ...resultForSession(session, {
        report: await readReportIfPresent(session),
        viewerUrl
      })
    };
  }

  return {
    start,
    watch,
    continue: continueSession,
    retry,
    cancel,
    status,
    openViewer
  };
}
