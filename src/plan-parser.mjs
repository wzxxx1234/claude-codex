const TASK_HEADING = /^##\s+(T\d+)\s+(.+?)\s*$/gm;

export function parsePlan(markdown) {
  if (typeof markdown !== "string") {
    throw new Error("Plan markdown must be a string");
  }

  const headings = [...markdown.matchAll(TASK_HEADING)];
  if (headings.length === 0) {
    throw new Error("No tasks found in plan");
  }

  const seen = new Set();
  return headings.map((heading, ordinal) => {
    const id = heading[1];
    if (seen.has(id)) {
      throw new Error(`Duplicate task ID: ${id}`);
    }
    seen.add(id);

    const bodyStart = heading.index + heading[0].length;
    const bodyEnd =
      ordinal + 1 < headings.length ? headings[ordinal + 1].index : markdown.length;

    return {
      id,
      title: heading[2].trim(),
      body: markdown.slice(bodyStart, bodyEnd).trim(),
      ordinal
    };
  });
}
