import { createHash } from "node:crypto";
import { access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { createTempDataFolder, startCore } from "./core";

/** Where a core given the system's temporary folder keeps its count of changes waiting. */
const countInSystemTemp = (dataDir: string) =>
  join(
    tmpdir(),
    `incarnamind-unsaved-${createHash("sha256").update(dataDir).digest("hex").slice(0, 16)}.json`,
  );

// Half a million of these, one per test core, made each start's listing of the system's
// temporary folder hold a file-system thread for seconds, and Document reads waited (#1741).
test("a test's core keeps its count of changes waiting out of the system's temporary folder", async () => {
  const shared = await createTempDataFolder();
  onTestFinished(() => rm(countInSystemTemp(shared), { force: true }));
  startCore(shared, { paths: { tempDir: tmpdir() } });
  await access(countInSystemTemp(shared));

  const own = await createTempDataFolder();
  startCore(own);
  await expect(access(countInSystemTemp(own))).rejects.toThrow();
});
