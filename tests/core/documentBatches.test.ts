import { describe, expect, test, vi } from "vitest";
import type { Core, DocumentBatch } from "../../src/core";
import { createTempDataFolder, startCore } from "../helpers/core";
import { createSourceFolder, writeSourceFile } from "../helpers/documents";

/*
 * A window holds the sidebar's rows while a batch of Documents is being added and lets them go
 * when the batch says it has landed (#1329). Every way an add can end has to say that, or the
 * sidebar would stay held with its new Documents hidden: `core.addDocuments` says it in a
 * `finally`, so a failure lands the batch too.
 */

function batchesOf(core: Core): DocumentBatch[] {
  const seen: DocumentBatch[] = [];
  core.on("documents.batch", (batch) => seen.push(batch));
  return seen;
}

const landed = (seen: readonly DocumentBatch[], id?: string) =>
  seen.some((each) => !each.adding && (id === undefined || each.id === id));

describe("a batch of Documents says when it has landed", () => {
  test("an add that fails before it adds anything still says it is done", async () => {
    const core = startCore(await createTempDataFolder());
    const seen = batchesOf(core);
    await expect(core.addDocuments(["not an absolute path"])).rejects.toThrow();
    await vi.waitFor(() => expect(landed(seen)).toBe(true));
    core.close();
  });

  test("an add that adds Documents says it is done when it finishes", async () => {
    const core = startCore(await createTempDataFolder());
    const sources = await createSourceFolder();
    const seen = batchesOf(core);
    const path = await writeSourceFile(sources, "Report.txt", "The harbour handled 20 tonnes.");
    const { batchId, documents } = await core.addDocuments([path]);
    await vi.waitFor(() => expect(landed(seen, batchId)).toBe(true));
    expect(seen.filter((each) => each.id === batchId).at(-1)).toMatchObject({
      adding: false,
      documentIds: documents.map((each) => each.id),
    });
    core.close();
  });
});
