import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const CHECKPOINT_INSTRUCTIONS =
  "When nextAction is display_checkpoint_wait_for_user, show the 检查点 to the user and wait for the user to reply 继续.";
const FINAL_INSTRUCTIONS =
  "When nextAction is display_final_report, display the 最终报告 as a normal assistant message.";
const WATCH_INSTRUCTIONS =
  "When nextAction is call_codex_watch_again, call codex_watch again without asking the user.";

function textResult(result, text = null) {
  return {
    content: [
      {
        type: "text",
        text: text ?? JSON.stringify(result, null, 2)
      }
    ],
    structuredContent: result
  };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: message }],
    isError: true
  };
}

function checkpointText(result) {
  const taskId = result.checkpoint?.taskId ?? result.task?.id ?? "unknown";
  const taskTitle = result.task?.title ?? "";
  const files = result.checkpoint?.changedFiles ?? {};
  const changedCount = ["created", "modified", "deleted"].reduce(
    (total, key) => total + (files[key]?.length ?? 0),
    0
  );
  return [
    `检查点：${taskId} ${taskTitle}`.trim(),
    result.checkpoint?.summary || "任务已完成。",
    `文件变化：${changedCount}`,
    "请回复“继续”以执行下一项任务。"
  ].join("\n");
}

function runningText(result) {
  const taskId = result.task?.id ?? "当前任务";
  return `Codex 正在执行 ${taskId}。`;
}

function resultText(result) {
  if (
    result.nextAction === "display_final_report" ||
    result.state === "completed"
  ) {
    return result.report ?? "全部任务已完成。";
  }
  if (result.nextAction === "display_checkpoint_wait_for_user") {
    return checkpointText(result);
  }
  if (result.nextAction === "call_codex_watch_again") {
    return runningText(result);
  }
  return result.error ?? "需要用户决定下一步操作。";
}

async function sendProgress(extra, progress, message) {
  if (extra?._meta?.progressToken === undefined) {
    return;
  }
  try {
    await extra.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken: extra._meta.progressToken,
        progress,
        total: 1,
        message
      }
    });
  } catch {
    // Progress is advisory; the tool result remains authoritative.
  }
}

export function registerBridgeTools(server, manager) {
  server.registerTool(
    "codex_start",
    {
      description: [
        "Create a Codex session, write PLAN.md, and start exactly T1.",
        CHECKPOINT_INSTRUCTIONS,
        FINAL_INSTRUCTIONS,
        WATCH_INSTRUCTIONS
      ].join(" "),
      inputSchema: {
        repoPath: z.string().min(1),
        planMarkdown: z.string().min(1),
        checkpointMode: z.literal("per_task"),
        overwritePlan: z.boolean().optional(),
        writeMode: z.enum(["workspace-write", "read-only"]).optional()
      }
    },
    async (input) => {
      try {
        return textResult(await manager.start(input));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "codex_watch",
    {
      description: [
        "Wait for the current Codex task to reach a checkpoint or finish.",
        CHECKPOINT_INSTRUCTIONS,
        FINAL_INSTRUCTIONS,
        WATCH_INSTRUCTIONS
      ].join(" "),
      inputSchema: {
        sessionId: z.string().min(1),
        waitMs: z.number().int().min(0).max(600_000).optional()
      }
    },
    async (input, extra) => {
      let progress = 0;
      await sendProgress(extra, progress, "正在等待 Codex 检查点");
      const timer = setInterval(() => {
        progress += 1;
        void sendProgress(extra, progress, "Codex 仍在执行");
      }, 10_000);
      timer.unref?.();

      try {
        const result = await manager.watch(input);
        return textResult(result, resultText(result));
      } catch (error) {
        return errorResult(error);
      } finally {
        clearInterval(timer);
      }
    }
  );

  server.registerTool(
    "codex_continue",
    {
      description: [
        "After the user explicitly replies 继续, start the next pending task.",
        CHECKPOINT_INSTRUCTIONS,
        FINAL_INSTRUCTIONS,
        WATCH_INSTRUCTIONS
      ].join(" "),
      inputSchema: {
        sessionId: z.string().min(1)
      }
    },
    async (input) => {
      try {
        const result = await manager.continue(input);
        return textResult(result, resultText(result));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "codex_retry",
    {
      description:
        "Retry the current task. Unsandboxed retry requires explicit user confirmation.",
      inputSchema: {
        sessionId: z.string().min(1),
        allowUnsandboxed: z.boolean().optional()
      }
    },
    async (input) => {
      try {
        const result = await manager.retry(input);
        return textResult(result, resultText(result));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "codex_cancel",
    {
      description:
        "Cancel the current Codex process while preserving completed checkpoints.",
      inputSchema: {
        sessionId: z.string().min(1)
      }
    },
    async (input) => {
      try {
        const result = await manager.cancel(input);
        return textResult(result, resultText(result));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "codex_status",
    {
      description:
        "Read the current session state, task, checkpoint, report, and viewer URL.",
      inputSchema: {
        sessionId: z.string().min(1)
      }
    },
    async (input) => {
      try {
        const result = await manager.status(input);
        return textResult(result, resultText(result));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "codex_open_viewer",
    {
      description: "Reopen the localhost-only viewer for an existing session.",
      inputSchema: {
        sessionId: z.string().min(1)
      }
    },
    async (input) => {
      try {
        const result = await manager.openViewer(input);
        return textResult(result, result.viewerUrl ?? "Viewer opened.");
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}

export function createMcpServer({ manager }) {
  if (!manager) {
    throw new Error("manager is required");
  }

  const server = new McpServer({
    name: "claude-codex-bridge",
    version: "0.1.0"
  });
  registerBridgeTools(server, manager);
  return server;
}
