import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function comparisonPath(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isSameOrDescendant(candidate, root) {
  const relative = path.relative(comparisonPath(root), comparisonPath(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isProtectedPath(candidate, protectedRoot) {
  const normalizedRoot = comparisonPath(protectedRoot);
  const normalizedCandidate = comparisonPath(candidate);
  if (path.parse(normalizedRoot).root === normalizedRoot) {
    return normalizedCandidate === normalizedRoot;
  }
  return isSameOrDescendant(normalizedCandidate, normalizedRoot);
}

export function defaultProtectedRoots(homeDir = os.homedir()) {
  const localAppData =
    process.env.LOCALAPPDATA ?? path.join(homeDir, "AppData", "Local");
  const appData = process.env.APPDATA ?? path.join(homeDir, "AppData", "Roaming");
  const programFiles =
    process.env.ProgramFiles ?? process.env.PROGRAMFILES ?? "C:\\Program Files";
  const programFilesX86 =
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";

  return [
    path.parse(homeDir).root,
    path.join(path.parse(homeDir).root, "Windows"),
    programFiles,
    programFilesX86,
    localAppData,
    appData,
    path.join(localAppData, "OpenAI", "Codex"),
    path.join(homeDir, ".codex")
  ];
}

export async function validateProjectPath(
  inputPath,
  {
    homeDir = os.homedir(),
    realpath = fs.realpath,
    protectedRoots = defaultProtectedRoots()
  } = {}
) {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    throw new Error("Project path is required");
  }

  let realPath;
  try {
    realPath = await realpath(path.resolve(inputPath));
  } catch {
    throw new Error("Project path could not be resolved");
  }

  let stats;
  try {
    stats = await fs.stat(realPath);
  } catch {
    throw new Error("Project path could not be inspected");
  }

  if (!stats.isDirectory()) {
    throw new Error("Project path must be a directory");
  }

  const normalizedHome = comparisonPath(homeDir);
  const normalizedProject = comparisonPath(realPath);
  if (normalizedProject === normalizedHome) {
    throw new Error("The home directory itself is not a project");
  }

  for (const protectedRoot of protectedRoots) {
    if (isProtectedPath(realPath, protectedRoot)) {
      throw new Error("Project path is protected");
    }
  }

  const projectId = createHash("sha256")
    .update(normalizedProject)
    .digest("hex")
    .slice(0, 16);

  return { realPath, projectId };
}
