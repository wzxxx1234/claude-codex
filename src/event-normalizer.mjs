import { redactSecrets } from "./redact.mjs";

const ITEM_KIND = {
  command_execution: "command",
  exec_command: "command",
  command: "command",
  agent_message: "message",
  assistant_message: "message",
  message: "message",
  file_change: "file",
  patch_apply: "file",
  verification: "verification",
  test_result: "verification",
  error: "error"
};

const TOP_LEVEL_KIND = {
  command_execution: "command",
  exec_command: "command",
  agent_message: "message",
  assistant_message: "message",
  message: "message",
  file_change: "file",
  patch_apply: "file",
  verification: "verification",
  test_result: "verification",
  error: "error",
  turn_failed: "error",
  thread_started: "status",
  turn_started: "status",
  turn_completed: "status"
};

function parseEvent(rawEvent) {
  if (typeof rawEvent === "string") {
    return JSON.parse(rawEvent);
  }
  return rawEvent;
}

function textFromContent(content) {
  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }
        return entry?.text ?? entry?.content ?? "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return typeof content === "string" ? content : "";
}

function extractText(event, item, kind) {
  const candidates = [
    item?.command,
    item?.text,
    item?.message,
    event?.command,
    event?.text,
    event?.message,
    event?.content
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.join(" ");
    }
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate;
    }
    const contentText = textFromContent(candidate);
    if (contentText.trim() !== "") {
      return contentText;
    }
  }

  return kind === "status" ? String(item?.type ?? event?.type ?? "status") : "";
}

export function normalizeCodexEvent(rawEvent) {
  try {
    const event = parseEvent(rawEvent);
    if (!event || typeof event !== "object") {
      return null;
    }

    const item = event.item && typeof event.item === "object" ? event.item : null;
    const itemType = typeof item?.type === "string" ? item.type : null;
    const eventType = typeof event.type === "string" ? event.type : null;
    const kind = (itemType && ITEM_KIND[itemType]) ?? TOP_LEVEL_KIND[eventType] ?? null;
    if (!kind) {
      return null;
    }

    const timestamp =
      typeof event.timestamp === "string"
        ? event.timestamp
        : new Date().toISOString();

    return {
      kind,
      text: redactSecrets(extractText(event, item, kind)),
      rawType: itemType ?? eventType,
      timestamp
    };
  } catch {
    return null;
  }
}
