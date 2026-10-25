import { describe, expect, test } from "vitest";
import type { Core, Document } from "../../src/core";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";

/*
 * Renaming a Document deletes and re-adds its Passages' search entries, after which SQLite
 * reports a row id past what a JavaScript number holds. Node 26's node:sqlite threw on it after
 * the write was done, so from about the eighth rename every write failed (#1289). Node 24's
 * doesn't throw, so on Node 24 these pass either way.
 */

async function reports(core: Core, count: number): Promise<Document[]> {
  const sources = await createTempDataFolder();
  const paths = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      writeSourceFile(
        sources,
        `report-${index + 1}.txt`,
        `Report ${index + 1}. The harbour handled ${index * 7} tonnes of cargo in the third quarter.`,
      ),
    ),
  );
  return addAndProcess(core, paths);
}

const names = (documents: readonly Document[]) => documents.map((each) => each.name).sort();

describe("Many Documents renamed in one session", () => {
  test("100 renames all land, and the writes after them still work", async () => {
    const core = startCore(await createTempDataFolder());
    const documents = await reports(core, 25);

    for (let round = 1; round <= 4; round++) {
      for (const [index, document] of documents.entries()) {
        const renamed = await core.renameDocument(document.id, `Q${round} report ${index + 1}`);
        expect(renamed.name).toBe(`Q${round} report ${index + 1}`);
      }
    }

    expect(names(await core.listDocuments())).toEqual(
      names(documents.map((each, index) => ({ ...each, name: `Q4 report ${index + 1}` }))),
    );
    expect(
      (await core.searchPassages("harbour cargo", { mode: "keyword" }))[0]?.documentName,
    ).toMatch(/^Q4 report \d+$/);
    const tag = await core.createTag({ name: "Harbour" });
    const tagged = await core.addTagToDocuments(
      documents.map((each) => each.id),
      tag.id,
    );
    expect(tagged.every((each) => each.tags.some((on) => on.tagId === tag.id))).toBe(true);
    await core.setTaggingWithAi(null, false);
    core.close();
  });

  test("50 Documents renamed, then tagged and closed, are all there when the app opens again", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir);
    const documents = await reports(core, 50);

    for (const [index, document] of documents.entries()) {
      await core.renameDocument(document.id, `Harbour report ${index + 1}`);
    }
    const tag = await core.createTag({ name: "Harbour" });
    await core.addTagToDocuments(
      documents.map((each) => each.id),
      tag.id,
    );
    core.close();

    const again = startCore(dataDir);
    const kept = await again.listDocuments();
    expect(names(kept)).toEqual(
      names(documents.map((each, index) => ({ ...each, name: `Harbour report ${index + 1}` }))),
    );
    expect(kept.every((each) => each.tags.some((on) => on.tagId === tag.id))).toBe(true);
    again.close();
  });
});
