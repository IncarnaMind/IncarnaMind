import { beforeEach, describe, expect, test, vi } from "vitest";
import { createTempDataFolder, startCore } from "../helpers/core";
import { createSourceFolder, waitForProcessing, writeSourceFile } from "../helpers/documents";

const { cancels } = vi.hoisted(() => ({ cancels: vi.fn() }));

vi.mock("../../src/core/documents/processor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/documents/processor")>();
  return {
    ...actual,
    createProcessor: (handlers: Parameters<typeof actual.createProcessor>[0]) => {
      const processor = actual.createProcessor(handlers);
      return {
        ...processor,
        cancel: (id: string) => {
          cancels(id);
          processor.cancel(id);
        },
      };
    },
  };
});

describe("Unlinking a Linked folder", () => {
  beforeEach(() => cancels.mockClear());

  // Value: protects=redo/unlink cannot re-add removed Documents; fails_when=remove leaves their processing jobs alive; why_new=CI exposed the 43ms redo-unlink race; seam=public removeLinkedFolder and processor cancellation; no_claim=the complete Electron timing sequence (covered by linkFolderUndo e2e)
  test("cancels processing for every Document removed, but not one kept independently", async () => {
    const core = startCore(await createTempDataFolder());
    const folder = await createSourceFolder();
    await writeSourceFile(folder, "Term sheet.md", "The price is 4 million.\n");
    await writeSourceFile(folder, "Teaser.md", "A harbour business for sale.\n");
    await writeSourceFile(folder, "Inner/Memo.md", "The seller wants a quick close.\n");
    const linked = await core.addLinkedFolder(folder);
    await vi.waitFor(async () => expect(await core.listDocuments()).toHaveLength(3));
    const documents = await core.listDocuments();
    await waitForProcessing(
      core,
      documents.map((document) => document.id),
    );
    const teaser = documents.find((document) => document.path.endsWith("Teaser.md"));
    if (!teaser) throw new Error("Teaser was not indexed.");
    const removed = documents.filter((document) => document.id !== teaser.id);
    cancels.mockClear();
    await core.removeLinkedFolder(linked.id, { keep: [teaser.id] });

    const cancelled = cancels.mock.calls.map(([id]) => id);
    expect(cancelled).toEqual(expect.arrayContaining(removed.map((document) => document.id)));
    expect(cancelled).not.toContain(teaser.id);
    expect((await core.listDocuments()).map((document) => document.id)).toEqual([teaser.id]);
  });
});
