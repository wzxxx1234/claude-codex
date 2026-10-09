import test from "node:test";
import assert from "node:assert/strict";

import { normalizeCodexEvent } from "../src/event-normalizer.mjs";

test("normalizeCodexEvent turns command execution into a command event", () => {
  const event = normalizeCodexEvent(
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: ["npm", "test"],
        exit_code: 0
      }
    })
  );

  assert.equal(event.kind, "command");
  assert.equal(event.rawType, "command_execution");
  assert.match(event.text, /npm test/);
  assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test("normalizeCodexEvent turns an agent message into a message event", () => {
  const event = normalizeCodexEvent({
    type: "item.completed",
    item: { type: "agent_message", text: "Finished the task" }
  });

  assert.equal(event.kind, "message");
  assert.equal(event.text, "Finished the task");
});

test("normalizeCodexEvent returns null for malformed JSON lines", () => {
  assert.equal(normalizeCodexEvent("{not valid json"), null);
});

test("normalizeCodexEvent returns null for unknown event types", () => {
  assert.equal(
    normalizeCodexEvent(
      JSON.stringify({
        type: "item.completed",
        item: { type: "unknown_event", text: "ignore me" }
      })
    ),
    null
  );
});
