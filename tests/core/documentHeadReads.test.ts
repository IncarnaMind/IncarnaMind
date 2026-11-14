/**
 * Whether a Document's first pages are read while the rest is (#2308) is answered from memory: a
 * Document with no such pages costs no read of its row, so adding many Documents reads each row
 * no more often than its own processing does. Through the core, as the Library uses it, with the
 * database's row reads counted.
 */
import { describe, expect, test, vi } from "vitest";
import type { SqlValue } from "../../src/core/storage";
import { createTempDataFolder, startCore } from "../helpers/core";
import { createSourceFolder, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { classifierModel } from "../helpers/library";

const reads = { rows: 0 };
/** The one read of a Document's whole row by its id. */
const ROW =
  /^SELECT id, content_hash, name, kind, size, page_count, status,[\s\S]*FROM documents WHERE id = \? AND deleted_at IS NULL$/;

vi.mock("../../src/core/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/core/storage")>();
  return {
    ...original,
    openDatabase: (path: string) => {
      const db = original.openDatabase(path);
      return {
        ...db,
        get: (sql: string, params?: readonly SqlValue[]) => {
          if (ROW.test(sql.trim())) reads.rows += 1;
          return db.get(sql, params);
        },
      };
    },
  };
});

describe("A Document with no first pages read costs no row read (#2308)", () => {
  // protects=a text Document's three status events (queued, being read, ready) read its row 8 times in all, not 10; fails_when=each event reads the row again to learn it has no first pages; no_claim=how long a read takes.
  test("adding one Document reads its row 8 times over its 3 status events", async () => {
    const core = startCore(await createTempDataFolder());
    const path = await writeSourceFile(await createSourceFolder(), "Report 1.txt", "Report 1.");
    let events = 0;
    core.on("document.status", () => {
      events += 1;
    });
    reads.rows = 0;
    const { documents } = await core.addDocuments([path]);
    await waitForProcessing(
      core,
      documents.map((each) => each.id),
    );
    expect([events, reads.rows]).toEqual([3, 8]);
  });

  // protects=a Document with no first pages still waits to be read whole before Organize files it, and is filed once it is; fails_when=the shortcut answers as if its first pages were read; no_claim=a scan's first pages, which the scan tests cover.
  test("a Document with no first pages is filed once it is read, as before", async () => {
    const fake = classifierModel();
    const core = startCore(await createTempDataFolder(), { createChatModel: () => fake.model });
    const provider = await core.saveChatProvider({ kind: "ollama", modelId: "main-model" });
    const folder = await core.createLibraryGroup({ name: "Harbour", description: "Port work." });
    await core.saveLibrarySettings({
      ...(await core.getLibrary()).settings,
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "small" } },
      automatic: true,
    });
    const path = await writeSourceFile(await createSourceFolder(), "Quay.txt", "Quay survey.");
    const { documents } = await core.addDocuments([path]);
    const [read] = await waitForProcessing(
      core,
      documents.map((each) => each.id),
    );
    if (!read) throw new Error("Not read.");
    await vi.waitFor(async () => {
      const found = (await core.getLibrary()).assignments.find(
        (each) => each.documentId === read.id,
      );
      expect([found?.groupId, found?.status]).toEqual([folder.id, "classified"]);
    });
    expect(fake.calls).toHaveLength(1);
  });
});
