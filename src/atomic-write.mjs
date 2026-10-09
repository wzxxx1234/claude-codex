import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export async function writeFileAtomic(filePath, content) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });

  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );

  let handle;
  try {
    handle = await fs.open(temporaryPath, "w");
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, filePath);
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}
