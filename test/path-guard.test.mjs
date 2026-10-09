import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { validateProjectPath } from "../src/path-guard.mjs";

async function withTempRoot(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-path-guard-"));
  try {
    return await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("accepts a normal project directory under the user home", async () => {
  await withTempRoot(async (root) => {
    const project = path.join(root, "projects", "word-list");
    await fs.mkdir(project, { recursive: true });

    const result = await validateProjectPath(project, {
      homeDir: root,
      protectedRoots: [path.join(root, "protected")]
    });

    assert.equal(result.realPath, project);
    assert.match(result.projectId, /^[a-f0-9]{16}$/);
  });
});

test("rejects protected roots and the home directory itself", async () => {
  await withTempRoot(async (root) => {
    const protectedRoot = path.join(root, "protected");
    const protectedChild = path.join(protectedRoot, "child");
    await fs.mkdir(protectedChild, { recursive: true });

    await assert.rejects(
      validateProjectPath(protectedRoot, {
        homeDir: root,
        protectedRoots: [protectedRoot]
      }),
      /protected/i
    );
    await assert.rejects(
      validateProjectPath(protectedChild, {
        homeDir: root,
        protectedRoots: [protectedRoot]
      }),
      /protected/i
    );
    await assert.rejects(
      validateProjectPath(root, {
        homeDir: root,
        protectedRoots: [protectedRoot]
      }),
      /home directory/i
    );
  });
});

test("rejects non-directories", async () => {
  await withTempRoot(async (root) => {
    const filePath = path.join(root, "file.txt");
    await fs.writeFile(filePath, "not a directory");

    await assert.rejects(
      validateProjectPath(filePath, {
        homeDir: root,
        protectedRoots: [path.join(root, "protected")]
      }),
      /directory/i
    );
  });
});

test("rejects a directory reached through a junction to a protected root", async (t) => {
  await withTempRoot(async (root) => {
    const protectedRoot = path.join(root, "protected");
    const junctionPath = path.join(root, "project-link");
    await fs.mkdir(protectedRoot, { recursive: true });

    try {
      await fs.symlink(protectedRoot, junctionPath, "junction");
    } catch (error) {
      t.skip(`junction creation unavailable: ${error.message}`);
      return;
    }

    await assert.rejects(
      validateProjectPath(junctionPath, {
        homeDir: root,
        protectedRoots: [protectedRoot]
      }),
      /protected/i
    );
  });
});
