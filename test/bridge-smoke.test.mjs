import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const smokePath = path.join(projectRoot, "bin", "bridge-smoke.mjs");

const tempRoots = [];

async function createTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-smoke-"));
  tempRoots.push(root);
  return root;
}

after(async () => {
  await Promise.all(
    tempRoots.map((root) => fs.rm(root, { force: true, recursive: true }))
  );
});

function runSmoke(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [smokePath], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("smoke exits non-zero when the Codex executable is missing", async () => {
  const root = await createTempRoot();
  const result = await runSmoke({
    APPDATA: path.join(root, "Roaming"),
    CODEX_PATH: path.join(root, "missing-codex.exe"),
    LOCALAPPDATA: path.join(root, "Local"),
    PATH: ""
  });

  assert.equal(result.code, 1);
  assert.match(`${result.stdout}${result.stderr}`, /codex/i);
});

test("smoke exits zero when local paths resolve and never prints secrets", async () => {
  const root = await createTempRoot();
  const localAppData = path.join(root, "Local");
  const appData = path.join(root, "Roaming");
  const codexPath = path.join(root, "codex.exe");
  await fs.mkdir(localAppData, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  await fs.writeFile(codexPath, "stub", "utf8");

  const secret = "sk-live-must-not-be-printed-1234567890";
  const result = await runSmoke({
    ANTHROPIC_API_KEY: secret,
    APPDATA: appData,
    CODEX_BRIDGE_PROVIDER_PORT: "1",
    CODEX_PATH: codexPath,
    LOCALAPPDATA: localAppData,
    OPENAI_API_KEY: secret,
    PATH: ""
  });

  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.code, 0);
  assert.ok(!output.includes(secret), "smoke output leaked a secret value");
  assert.match(output, /codex/i);
  assert.match(output, /127\.0\.0\.1/);
});
