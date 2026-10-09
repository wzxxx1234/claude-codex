import fs from "node:fs/promises";

const scenario = process.env.FAKE_CODEX_SCENARIO ?? "success";
const capturePath = process.env.FAKE_CODEX_CAPTURE_PATH;
const outputFile = process.env.FAKE_CODEX_OUTPUT_FILE;
const startedFile = process.env.FAKE_CODEX_STARTED_PATH;

let prompt = "";
for await (const chunk of process.stdin) {
  prompt += chunk.toString("utf8");
}

if (capturePath) {
  await fs.writeFile(capturePath, prompt, "utf8");
}
if (startedFile) {
  await fs.writeFile(startedFile, String(process.pid), "utf8");
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

if (scenario === "success") {
  if (outputFile) {
    await fs.writeFile(outputFile, "fake task complete\n", "utf8");
  }
  const commandEvent = JSON.stringify({
    type: "item.completed",
    item: {
      type: "command_execution",
      command: ["node", "-e", "console.log('ok')"],
      exit_code: 0
    }
  });
  process.stdout.write(commandEvent.slice(0, 20));
  process.stdout.write(`${commandEvent.slice(20)}\n`);
  emit({
    type: "item.completed",
    item: { type: "agent_message", text: "Task complete" }
  });
} else if (scenario === "fail") {
  emit({
    type: "item.completed",
    item: {
      type: "command_execution",
      command: ["node", "-e", "process.exit(1)"],
      exit_code: 1
    }
  });
  process.exitCode = 1;
} else if (scenario === "sandbox-error") {
  emit({
    type: "error",
    message: "helper_unknown_error: setup refresh had errors"
  });
  process.exitCode = 1;
} else if (scenario === "provider-error") {
  emit({
    type: "error",
    message: "provider connection failed at 127.0.0.1:15721"
  });
  process.exitCode = 1;
} else if (scenario === "bad-json") {
  process.stdout.write("{not valid json}\n");
  emit({
    type: "item.completed",
    item: { type: "agent_message", text: "Recovered from malformed line" }
  });
} else if (scenario === "secret-output") {
  emit({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: "api_key=sk-log-secret"
    }
  });
  process.stderr.write("Authorization: Bearer stderr-secret\n");
} else if (scenario === "hang") {
  setInterval(() => {}, 1_000);
} else {
  throw new Error(`Unknown fake Codex scenario: ${scenario}`);
}
