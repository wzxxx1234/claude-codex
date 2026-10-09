import { spawn } from "node:child_process";

const DEFAULT_TERMINATE_TIMEOUT_MS = 10_000;

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await wait(25);
  }

  if (isProcessAlive(pid)) {
    throw new Error(`Timed out terminating process tree ${pid}`);
  }
}

async function runTaskkill(pid) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      {
        stdio: "ignore",
        windowsHide: true
      }
    );

    child.once("error", reject);
    child.once("close", () => resolve());
  });
}

export async function terminateProcessTree(
  pid,
  { timeoutMs = DEFAULT_TERMINATE_TIMEOUT_MS } = {}
) {
  if (!isProcessAlive(pid)) {
    return;
  }

  if (process.platform === "win32") {
    try {
      await runTaskkill(pid);
    } catch {
      process.kill(pid, "SIGTERM");
    }
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      process.kill(pid, "SIGTERM");
    }
  }

  await waitForProcessExit(pid, timeoutMs);
}
