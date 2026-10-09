import test from "node:test";
import assert from "node:assert/strict";

import { parsePlan } from "../src/plan-parser.mjs";

test("parsePlan extracts task IDs and exact bodies", () => {
  const tasks = parsePlan("## T1 First\nDo A\n\n## T2 Second\nDo B");

  assert.deepEqual(tasks.map((task) => task.id), ["T1", "T2"]);
  assert.deepEqual(tasks.map((task) => task.title), ["First", "Second"]);
  assert.deepEqual(tasks.map((task) => task.body), ["Do A", "Do B"]);
  assert.deepEqual(tasks.map((task) => task.ordinal), [0, 1]);
});

test("parsePlan rejects plans without task headings", () => {
  assert.throws(() => parsePlan("# Plan\nNo task headings"), /No tasks/i);
});

test("parsePlan rejects duplicate task IDs", () => {
  assert.throws(() => parsePlan("## T1 A\n## T1 B"), /Duplicate task/i);
});
